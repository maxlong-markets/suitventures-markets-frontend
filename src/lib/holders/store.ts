import type { Db } from "@/lib/db/client";

/**
 * Build state and balance map of the top-holder lists (docs/superpowers/specs/2026-09-23-top-holders-design.md,
 * sections 3, 4, 7). `market.token_balances` holds one row per wallet with a non-zero balance for every covered
 * token — the builder (run.ts) is its ONLY writer since 23 Sep 2026; `market.holder_refresh` holds each token's
 * cursor, status and request stamp. Every function here is one statement or one transaction and touches one
 * token, so an interrupted invocation loses at most the slice it was applying.
 */

export type HolderStatus = "building" | "ready" | "skipped";
export type RefreshRow = { tokenId: string; refreshedAt: number; cursorBlock: number; requestedAt: number; status: HolderStatus; transfers: number };

/** Tokens on the markets table: the top N by trades in the last 24 h (design section 4, coverage set). */
export const COVERAGE_LIMIT = 500;
/** Tokens with more holders than this are never folded (design section 4; none is on the table today). */
export const GIANT_HOLDERS = 1_000_000;
/** A list older than this is refreshed when the token traded since (design section 4, due list 2). */
export const STALE_SEC = 900;
/** Every covered list is refreshed at least this often, trades or not (due list 3). */
export const FULL_PASS_SEC = 3_600;
/** The holders route re-stamps `requested_at` at most this often per token (design section 5). */
export const REQUEST_STAMP_MIN_SEC = 60;
/** The nightly keeps an off-table token's rows this long after its last request (design section 7). */
export const KEEP_REQUESTED_SEC = 7 * 86_400;
/** Safety valve (design section 4): a fold past this many transfers without reaching the head is skipped. */
export const MAX_TRANSFERS_PER_TOKEN = 5_000_000;
/** Rows per upsert statement inside applySlice; a slice is ~4,800 transfers, so usually one or two. */
export const DELTA_CHUNK = 5_000;

const COVERAGE_SQL = `select s.token_id
  from market.swaps s join market.tokens t on t.id = s.token_id
  where s.ts > $1 and t.holders_count <= $2 and not (s.token_id = any($3::text[]))
  group by s.token_id order by count(*) desc, s.token_id limit $4`;

export async function coverageSet(db: Db, now: number, excludedIds: readonly string[], limit = COVERAGE_LIMIT): Promise<string[]> {
  const rows = await db.query<{ token_id: string }>(COVERAGE_SQL, [now - 86_400, GIANT_HOLDERS, excludedIds.map((x) => x.toLowerCase()), limit]);
  return rows.map((r) => r.token_id);
}

export async function ensureRows(db: Db, tokenIds: readonly string[]): Promise<void> {
  if (tokenIds.length === 0) return;
  await db.query(
    `insert into market.holder_refresh (token_id, refreshed_at) select unnest($1::text[]), 0 on conflict (token_id) do nothing`,
    [tokenIds],
  );
}

type Row = { token_id: string; refreshed_at: number; cursor_block: number; requested_at: number; status: HolderStatus; transfers: string | number };
const ROW_COLS = "token_id, refreshed_at, cursor_block, requested_at, status, transfers";
const shape = (r: Row): RefreshRow => ({
  tokenId: r.token_id, refreshedAt: r.refreshed_at, cursorBlock: r.cursor_block, requestedAt: r.requested_at, status: r.status, transfers: Number(r.transfers),
});

/**
 * What requireRow throws. A type rather than a message, because the two cases mean opposite things to the
 * builder (run.ts, fix round 1): a missing `market.tokens` row is a terminal state for that one token — the
 * holders route can open a refresh row for an id the reader has never seen, and no amount of folding will
 * ever give it an exact count — while a missing `market.holder_refresh` row is the store refusing to write
 * what it just read, a broken invariant that must end the invocation. Matching on `table` keeps that
 * distinction out of the message text, which stays exactly as it was.
 */
export class MissingRowError extends Error {
  constructor(
    readonly fn: string,
    readonly table: string,
    readonly tokenId: string,
  ) {
    super(`${fn}: no ${table} row for token ${tokenId}`);
    this.name = "MissingRowError";
  }
}

/**
 * Review round 1: every writer below targets one row by primary key, and Db.query reports no affected-row count.
 * So each update returns its key and this turns "matched nothing" into an error rather than a silent no-op —
 * called inside a db.tx, the throw rolls back whatever the same transaction already wrote.
 */
function requireRow(rows: readonly unknown[], fn: string, table: string, tokenId: string): void {
  if (rows.length === 0) throw new MissingRowError(fn, table, tokenId);
}

export async function refreshRow(db: Db, tokenId: string): Promise<RefreshRow | null> {
  const rows = await db.query<Row>(`select ${ROW_COLS} from market.holder_refresh where token_id = $1`, [tokenId]);
  return rows[0] ? shape(rows[0]) : null;
}

/** Due list 1: opened since last refreshed and stale — newest request first, bounded so one busy hour cannot starve the table. */
const REQUESTED_SQL = `select ${ROW_COLS} from market.holder_refresh
  where status <> 'skipped' and requested_at > refreshed_at and refreshed_at < $1 order by requested_at desc limit 100`;
const COVERAGE_ROWS_SQL = `select ${ROW_COLS} from market.holder_refresh where token_id = any($1::text[])`;
/**
 * Due list 2's probe. The `s.ts > $2` bound (now - FULL_PASS_SEC) is what keeps this off the whole swaps history:
 * without it the planner has to walk every trade a token ever made. It costs no coverage — a token whose trade is
 * older than that has a `refreshed_at` older still (the probe only counts trades after `refreshed_at`), so due list
 * 3 already has it. It changes only which tier claims such a token, never whether it is folded.
 */
const TRADED_SINCE_SQL = `select r.token_id from market.holder_refresh r
  where r.token_id = any($1::text[]) and exists (select 1 from market.swaps s where s.token_id = r.token_id and s.ts > r.refreshed_at and s.ts > $2)`;

/**
 * The builder's work list for one invocation, in the order of design section 4: opened-and-stale first, then
 * covered tokens that traded since a list older than STALE_SEC (in coverage order, most traded first), then
 * covered tokens older than FULL_PASS_SEC (oldest first). Each token once; skipped never. Covered tokens with
 * no row must have been inserted by ensureRows before this is called.
 */
export async function dueTokens(db: Db, coverage: readonly string[], now: number): Promise<RefreshRow[]> {
  const out: RefreshRow[] = [];
  const seen = new Set<string>();
  const push = (r: RefreshRow) => { if (!seen.has(r.tokenId)) { seen.add(r.tokenId); out.push(r); } };
  for (const r of await db.query<Row>(REQUESTED_SQL, [now - STALE_SEC])) push(shape(r));
  if (coverage.length === 0) return out;
  const byId = new Map<string, RefreshRow>();
  for (const r of await db.query<Row>(COVERAGE_ROWS_SQL, [coverage])) byId.set(r.token_id, shape(r));
  const staleIds = coverage.filter((id) => { const r = byId.get(id); return r && r.status === "ready" && r.refreshedAt < now - STALE_SEC; });
  const traded = new Set((await db.query<{ token_id: string }>(TRADED_SINCE_SQL, [staleIds, now - FULL_PASS_SEC])).map((r) => r.token_id));
  for (const id of staleIds) if (traded.has(id)) push(byId.get(id)!);
  const full = coverage.map((id) => byId.get(id)).filter((r): r is RefreshRow => !!r && r.status !== "skipped" && r.refreshedAt < now - FULL_PASS_SEC);
  full.sort((a, b) => a.refreshedAt - b.refreshedAt);
  for (const r of full) push(r);
  return out;
}

/**
 * One slice, one transaction (design section 4, step 4): additive upsert of the deltas, delete of the touched
 * wallets that reached exactly zero, cursor and transfer count. A wallet whose balance goes negative (a
 * non-standard token) is kept as it is: the list and the count only ever read `balance > 0`.
 */
export async function applySlice(db: Db, tokenId: string, deltas: ReadonlyMap<string, bigint>, nextBlock: number, transferCount: number, now: number): Promise<void> {
  const wallets = [...deltas.keys()];
  await db.tx(async (t) => {
    for (let i = 0; i < wallets.length; i += DELTA_CHUNK) {
      const chunk = wallets.slice(i, i + DELTA_CHUNK);
      await t.query(
        `insert into market.token_balances (token_id, holder, balance, updated_at)
         select $1::text, holder, delta, $4::int from unnest($2::text[], $3::numeric[]) as u(holder, delta)
         on conflict (token_id, holder) do update set balance = market.token_balances.balance + excluded.balance, updated_at = excluded.updated_at`,
        [tokenId, chunk, chunk.map((w) => deltas.get(w)!.toString()), now],
      );
      await t.query("delete from market.token_balances where token_id = $1 and holder = any($2::text[]) and balance = 0", [tokenId, chunk]);
    }
    // `returning` is the only affected-row count Db.query gives us, and this update must not be allowed to miss:
    // the balances above are already written, so a silently skipped cursor would have the next pass re-fold the
    // same range and add every delta a second time. Throwing here rolls the whole slice back (see requireRow).
    requireRow(
      await t.query<{ token_id: string }>(
        "update market.holder_refresh set cursor_block = $2, transfers = transfers + $3 where token_id = $1 returning token_id",
        [tokenId, nextBlock, transferCount],
      ),
      "applySlice",
      "market.holder_refresh",
      tokenId,
    );
  });
}

/** The fold reached the head: status ready, refreshed now, and the token's holder count set exact (design section 6). Returns the count. */
export async function markReady(db: Db, tokenId: string, now: number): Promise<number> {
  return db.tx(async (t) => {
    requireRow(
      await t.query<{ token_id: string }>("update market.holder_refresh set status = 'ready', refreshed_at = $2 where token_id = $1 returning token_id", [tokenId, now]),
      "markReady",
      "market.holder_refresh",
      tokenId,
    );
    const rows = await t.query<{ n: number }>(
      `update market.tokens set holders_count = (select count(*)::int from market.token_balances where token_id = $1 and balance > 0)
       where id = $1 returning holders_count as n`,
      [tokenId],
    );
    // requestBuild can open a refresh row for a token market.tokens has never seen. Reporting 0 holders for a list
    // that just folded would be a lie the caller cannot tell from an empty token, so this fails loudly instead.
    requireRow(rows, "markReady", "market.tokens", tokenId);
    return rows[0].n;
  });
}

export async function markSkipped(db: Db, tokenId: string): Promise<void> {
  await db.tx(async (t) => {
    await t.query("delete from market.token_balances where token_id = $1", [tokenId]);
    // Without the row there is nothing to record the skip on, and the delete above would drop the balances anyway.
    requireRow(
      await t.query<{ token_id: string }>("update market.holder_refresh set status = 'skipped', cursor_block = 0 where token_id = $1 returning token_id", [tokenId]),
      "markSkipped",
      "market.holder_refresh",
      tokenId,
    );
  });
}

/**
 * The holders route's side effect (design section 5): a token with no row is inserted as building; a building or
 * ready row is re-stamped at most every REQUEST_STAMP_MIN_SEC; a skipped row is never touched. True when a stamp
 * was written.
 */
export async function requestBuild(db: Db, tokenId: string, now: number): Promise<boolean> {
  const rows = await db.query<{ token_id: string }>(
    `insert into market.holder_refresh (token_id, refreshed_at, requested_at) values ($1, 0, $2)
     on conflict (token_id) do update set requested_at = excluded.requested_at
       where market.holder_refresh.status <> 'skipped' and market.holder_refresh.requested_at < excluded.requested_at - $3
     returning token_id`,
    [tokenId, now, REQUEST_STAMP_MIN_SEC],
  );
  return rows.length > 0;
}

/** Nightly cleanup (design section 7): drop everything for tokens neither kept nor requested recently, one token per statement pair. */
export async function pruneHolders(db: Db, keepIds: readonly string[], now: number): Promise<{ tokens: number; rows: number }> {
  const victims = await db.query<{ token_id: string }>(
    "select token_id from market.holder_refresh where not (token_id = any($1::text[])) and requested_at < $2",
    [keepIds, now - KEEP_REQUESTED_SEC],
  );
  let rows = 0;
  for (const v of victims) {
    const deleted = await db.query<{ n: number }>("with d as (delete from market.token_balances where token_id = $1 returning 1) select count(*)::int as n from d", [v.token_id]);
    rows += deleted[0]?.n ?? 0;
    await db.query("delete from market.holder_refresh where token_id = $1", [v.token_id]);
  }
  const orphans = await db.query<{ n: number }>(
    "with d as (delete from market.token_balances b where not exists (select 1 from market.holder_refresh r where r.token_id = b.token_id) returning 1) select count(*)::int as n from d",
  );
  rows += orphans[0]?.n ?? 0;
  return { tokens: victims.length, rows };
}
