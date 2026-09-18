import "server-only";
import type { Db } from "@/lib/db/client";
import type { Address, TraderRow, VoteDir } from "@/lib/types";

export type VoteCount = { bull: number; bear: number };
/** The board's row type is declared in `types.ts` (the page is a client component); the name still lives beside the query that fills it. */
export type { TraderRow } from "@/lib/types";

/** The public counts route's cap, and the most ids one grouped query is ever asked for. */
export const MAX_VOTE_IDS = 500;

const WATCHLIST_SQL = "select token_id from market.watchlist where wallet = $1 order by created_at desc, token_id";
const ADD_WATCH_SQL = "insert into market.watchlist (wallet, token_id, created_at) values ($1, $2, $3) on conflict (wallet, token_id) do nothing";
const DROP_WATCH_SQL = "delete from market.watchlist where wallet = $1 and token_id = $2";
const VOTES_SQL = "select token_id, dir from market.votes where wallet = $1";
const CLEAR_VOTE_SQL = "delete from market.votes where wallet = $1 and token_id = $2 and dir = $3 returning dir";
const CAST_VOTE_SQL = `insert into market.votes (wallet, token_id, dir, updated_at) values ($1, $2, $3, $4)
  on conflict (wallet, token_id) do update set dir = excluded.dir, updated_at = excluded.updated_at returning dir`;
const COUNTS_SQL = "select token_id, dir, count(*)::int as n from market.votes where token_id = any($1::text[]) group by token_id, dir";
/**
 * `amount_quote` is denominated in the pool's quote asset, so each row is priced through that asset's feed.
 * `coalesce(usd_price, 0)`: a quote with no feed (or none yet) contributes no dollars and still counts as a
 * trade, which is honest — the alternative, dropping those rows, would hide a wallet's activity entirely.
 * Display only (Global Constraint 1): nothing here is on an execution path — the board is a ranking, not
 * an amount the chain will ever see.
 */
const TRADERS_SQL = (order: string) => `select s.wallet, sum(s.amount_quote * coalesce(q.usd_price, 0)) as volume_usd,
  count(*)::int as trades, count(distinct s.token_id)::int as tokens
  from market.swaps s join market.pools p on p.id = s.pool_id join market.quotes q on q.id = p.quote_id
  where s.ts >= $1 group by s.wallet order by ${order} limit $2`;
/** Not user input: `by` is a two-value union and both clauses are written out here. The wallet tie-break keeps the board stable between reads. */
const TRADERS_ORDER: Record<"volume" | "trades", string> = {
  volume: "volume_usd desc, s.wallet",
  trades: "trades desc, s.wallet",
};

/** The wallet's starred token ids, newest first. */
export async function watchlist(db: Db, wallet: string): Promise<string[]> {
  const rows = await db.query<{ token_id: string }>(WATCHLIST_SQL, [wallet]);
  return rows.map((r) => r.token_id);
}

/** Idempotent both ways: starring twice keeps the first `created_at`, unstarring what is gone is a no-op. */
export async function setWatch(db: Db, wallet: string, tokenId: string, on: boolean, now: number): Promise<void> {
  if (on) await db.query(ADD_WATCH_SQL, [wallet, tokenId, now]);
  else await db.query(DROP_WATCH_SQL, [wallet, tokenId]);
}

export async function votes(db: Db, wallet: string): Promise<Record<string, VoteDir>> {
  const rows = await db.query<{ token_id: string; dir: VoteDir }>(VOTES_SQL, [wallet]);
  return Object.fromEntries(rows.map((r) => [r.token_id, r.dir]));
}

/**
 * The toggle the app already has: the same direction clears the vote and answers null, the other switches it.
 * One transaction rather than one statement — a `delete … returning` and an `insert … on conflict` over the same
 * primary key in a single statement is the case Postgres documents as unsupported, and the two branches here are
 * mutually exclusive anyway, so this is the same atomicity without that question.
 */
export async function toggleVote(db: Db, wallet: string, tokenId: string, dir: VoteDir, now: number): Promise<VoteDir | null> {
  return db.tx(async (t) => {
    const cleared = await t.query<{ dir: VoteDir }>(CLEAR_VOTE_SQL, [wallet, tokenId, dir]);
    if (cleared.length > 0) return null;
    const cast = await t.query<{ dir: VoteDir }>(CAST_VOTE_SQL, [wallet, tokenId, dir, now]);
    return cast[0]?.dir ?? dir;
  });
}

/** One grouped query for up to `MAX_VOTE_IDS` tokens. Every id asked about is in the answer, zeroed when nobody has voted. */
export async function voteCounts(db: Db, tokenIds: readonly string[]): Promise<Record<string, VoteCount>> {
  if (tokenIds.length > MAX_VOTE_IDS) throw new RangeError(`voteCounts takes at most ${MAX_VOTE_IDS} ids`);
  const out: Record<string, VoteCount> = {};
  for (const id of tokenIds) out[id] = { bull: 0, bear: 0 };
  if (tokenIds.length === 0) return out;
  const rows = await db.query<{ token_id: string; dir: VoteDir; n: number }>(COUNTS_SQL, [tokenIds]);
  for (const row of rows) {
    const count = out[row.token_id];
    if (count) count[row.dir] = Number(row.n);
  }
  return out;
}

/** The traders board: one grouped scan of `market.swaps` since `sinceTs`, priced through each pool's quote asset. */
export async function topTraders(db: Db, opts: { sinceTs: number; by: "volume" | "trades"; limit: number }): Promise<TraderRow[]> {
  const rows = await db.query<{ wallet: string; volume_usd: number | null; trades: number; tokens: number }>(
    TRADERS_SQL(TRADERS_ORDER[opts.by]),
    [opts.sinceTs, opts.limit],
  );
  return rows.map((r) => ({ wallet: r.wallet as Address, volumeUsd: r.volume_usd ?? 0, trades: r.trades, tokens: r.tokens }));
}
