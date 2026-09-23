# Top Holders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exact top-holder lists and exact holder counts for every token on the markets table and for any token a user opens, built from HyperSync transfer history by a paced, resumable, per-token fold inside a minute cron, with a nightly cleanup and health reporting.

**Architecture:** A new `src/lib/holders/` module: a pure fold of ERC-20 Transfer events into balance deltas, a store that applies one slice per transaction against `market.token_balances` with a per-token cursor in `market.holder_refresh`, and a runner (`runHoldersBuild`) that works a prioritised due-list under the `holders` lease for at most 50 s per invocation at one HyperSync request per 750 ms. The `LogSource` contract gains a `transfers(token, fromBlock)` method implemented on the existing HyperSync source. The holders API route serves the stored list with a status and an "as of" time and stamps a request when a token has no list; the tab renders four states. The nightly gains a `holders` prune phase; `/api/health` gains a `holders` block.

**Tech Stack:** Next.js 16 App Router, TypeScript, viem, postgres.js (`Db` in `src/lib/db/client.ts`), vitest with PGlite (`src/test/db.ts`), React Query, Vercel crons.

**Spec:** `docs/superpowers/specs/2026-09-23-top-holders-design.md`

## Global Constraints

- HyperSync requests from the builder are spaced at least 750 ms apart (80 a minute); the reader keeps its 4; the key allows 100. Exact value: `DEFAULT_REQUEST_SPACING_MS = 750`.
- One builder at a time: the `holders` lease, `leaseSec 300`, `windowSec 50`, `maxDuration = 300`, yielding to the nightly exactly as `runChainSync` does (`src/lib/chain/run.ts` lines 355–364).
- Coverage set: top `500` token ids by trade count in the last 24 h of `market.swaps`, minus the quote assets (`QUOTES` in `src/lib/chain/math/quotes.ts`, addresses lowercase) and minus tokens with `holders_count > 1_000_000`.
- Freshness: `STALE_SEC = 900` (15 min, when traded since), `FULL_PASS_SEC = 3_600` (1 h, always); ready means `cursor_block >= head - 30` (`DEFAULT_SAFETY_BLOCKS = 30`).
- A slice is one HyperSync request's transfers applied in ONE transaction with its cursor; never hold more than one slice in memory. Delta upsert chunks of 5,000 rows.
- Only non-zero balances are stored; the served list and the exact count use `balance > 0`.
- Safety valve: a token past `5_000_000` folded transfers without reaching the head is marked `skipped` and its rows deleted.
- Cleanup keeps tokens in the coverage set or requested within `7 * 86_400` s.
- Do NOT modify the reader's logic: `src/lib/chain/run.ts`, `fold.ts`, `store.ts`, `onchain.ts`, `pacing.ts`, `catchup.ts` stay untouched. Additive changes only to `src/lib/chain/types.ts` (a new type and interface method) and `src/lib/chain/hypersyncSource.ts` (the new method).
- No new dependencies. `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src` clean at the end of every task.
- Comments explain "why" and name the review item or measurement they come from, as the rest of the codebase does. Migrations are additive and reversible.
- Never print, commit or read out any `.env*` file.

---

### Task 1: Migration and the holders store

**Files:**
- Create: `supabase/migrations/20260923010000_holder_refresh_build.sql`
- Create: `src/lib/holders/store.ts`
- Test: `src/lib/holders/store.test.ts`

**Interfaces:**
- Consumes: `Db` (`src/lib/db/client.ts`), `testDb()` (`src/test/db.ts`, applies every migration under `supabase/migrations`).
- Produces (Task 3, 4, 5 rely on these exact names):
  ```ts
  export type HolderStatus = "building" | "ready" | "skipped";
  export type RefreshRow = { tokenId: string; refreshedAt: number; cursorBlock: number; requestedAt: number; status: HolderStatus; transfers: number };
  export const COVERAGE_LIMIT = 500; export const GIANT_HOLDERS = 1_000_000; export const STALE_SEC = 900;
  export const FULL_PASS_SEC = 3_600; export const REQUEST_STAMP_MIN_SEC = 60; export const KEEP_REQUESTED_SEC = 7 * 86_400;
  export const MAX_TRANSFERS_PER_TOKEN = 5_000_000; export const DELTA_CHUNK = 5_000;
  export async function coverageSet(db: Db, now: number, excludedIds: readonly string[], limit?: number): Promise<string[]>;
  export async function ensureRows(db: Db, tokenIds: readonly string[]): Promise<void>;
  export async function refreshRow(db: Db, tokenId: string): Promise<RefreshRow | null>;
  export async function dueTokens(db: Db, coverage: readonly string[], now: number): Promise<RefreshRow[]>;
  export async function applySlice(db: Db, tokenId: string, deltas: ReadonlyMap<string, bigint>, nextBlock: number, transferCount: number, now: number): Promise<void>;
  export async function markReady(db: Db, tokenId: string, now: number): Promise<number>;
  export async function markSkipped(db: Db, tokenId: string): Promise<void>;
  export async function requestBuild(db: Db, tokenId: string, now: number): Promise<boolean>;
  export async function pruneHolders(db: Db, keepIds: readonly string[], now: number): Promise<{ tokens: number; rows: number }>;
  ```

- [ ] **Step 1: Write the migration**

```sql
-- Top holders (docs/superpowers/specs/2026-09-23-top-holders-design.md, section 3): market.holder_refresh
-- becomes the per-token build state of the exact balance map in market.token_balances. Additive, defaulted,
-- reversible by dropping the four columns and the index; the table is empty on production today.
alter table market.holder_refresh
  add column if not exists cursor_block int not null default 0,
  add column if not exists requested_at int not null default 0,
  add column if not exists status text not null default 'building',
  add column if not exists transfers bigint not null default 0;
alter table market.holder_refresh drop constraint if exists holder_refresh_status_check;
alter table market.holder_refresh add constraint holder_refresh_status_check check (status in ('building', 'ready', 'skipped'));
-- The builder's first priority: opened tokens still building, newest request first (design section 4, due list 1).
create index if not exists holder_refresh_requested on market.holder_refresh (requested_at desc) where status <> 'skipped';
```

- [ ] **Step 2: Write the failing store tests**

`src/lib/holders/store.test.ts` — use the harness other store tests use (`src/lib/social/store.test.ts` is the model: `beforeAll(testDb)`, `beforeEach` deleting from the touched tables, `afterAll(db.end)`). Seed helpers: insert a token with `insert into market.tokens (id, symbol, name, decimals, ...)` — copy the minimal insert the chain store tests use (`src/lib/chain/store.test.ts`, its `seedToken`), and swaps with `insert into market.swaps (tx_hash, log_index, pool_id, token_id, ts, side, amount_token, amount_quote, price_quote, wallet)`.

Cases (each an `it`):
1. `coverageSet` orders by 24 h trade count desc, ignores trades older than 24 h, drops excluded ids and tokens with `holders_count > GIANT_HOLDERS`, honours `limit`.
2. `ensureRows` inserts `building` rows with `refreshed_at 0, cursor_block 0` for missing ids and leaves existing rows untouched (a `ready` row stays `ready`).
3. `applySlice` adds deltas to existing balances (additive upsert), inserts new wallets, deletes a wallet whose balance reaches exactly 0, keeps a wallet whose balance is still positive, advances `cursor_block` and `transfers`, and does it all in one transaction (a delta chunk larger than `DELTA_CHUNK` still lands whole: use 5,001 wallets).
4. `markReady` sets `status ready`, `refreshed_at now`, and `market.tokens.holders_count` to the count of rows with `balance > 0` (a row with a negative balance from a non-standard token is not counted), returning that count.
5. `markSkipped` deletes the token's balance rows and sets `status skipped`, `cursor_block 0`.
6. `requestBuild`: inserts a `building` row with `requested_at now` when absent (returns true); re-stamps a `building` row only when its `requested_at` is older than `REQUEST_STAMP_MIN_SEC` (returns false inside the window); stamps a `ready` row (so an opened stale list gets refreshed); never touches a `skipped` row (returns false).
7. `dueTokens` order: (1) requested tokens (`requested_at > refreshed_at`, `refreshed_at < now - STALE_SEC`, not skipped), newest request first; (2) coverage tokens `ready` with `refreshed_at < now - STALE_SEC` and a swap newer than `refreshed_at`, in coverage order; (3) coverage tokens with `refreshed_at < now - FULL_PASS_SEC` (including `building` rows with `requested_at 0`), oldest `refreshed_at` first; a token appears once; a fresh token (refreshed 5 min ago) is absent; a `skipped` token is absent.
8. `pruneHolders` deletes balance and refresh rows of tokens neither in `keepIds` nor requested within `KEEP_REQUESTED_SEC`, keeps the others, deletes orphan balance rows with no refresh row, and returns `{ tokens, rows }`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/holders/store.test.ts`
Expected: FAIL — module `./store` not found.

- [ ] **Step 4: Implement the store**

```ts
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

export async function refreshRow(db: Db, tokenId: string): Promise<RefreshRow | null> {
  const rows = await db.query<Row>(`select ${ROW_COLS} from market.holder_refresh where token_id = $1`, [tokenId]);
  return rows[0] ? shape(rows[0]) : null;
}

/** Due list 1: opened since last refreshed and stale — newest request first, bounded so one busy hour cannot starve the table. */
const REQUESTED_SQL = `select ${ROW_COLS} from market.holder_refresh
  where status <> 'skipped' and requested_at > refreshed_at and refreshed_at < $1 order by requested_at desc limit 100`;
const COVERAGE_ROWS_SQL = `select ${ROW_COLS} from market.holder_refresh where token_id = any($1::text[])`;
const TRADED_SINCE_SQL = `select r.token_id from market.holder_refresh r
  where r.token_id = any($1::text[]) and exists (select 1 from market.swaps s where s.token_id = r.token_id and s.ts > r.refreshed_at)`;

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
  const traded = new Set((await db.query<{ token_id: string }>(TRADED_SINCE_SQL, [staleIds])).map((r) => r.token_id));
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
    await t.query("update market.holder_refresh set cursor_block = $2, transfers = transfers + $3 where token_id = $1", [tokenId, nextBlock, transferCount]);
  });
}

/** The fold reached the head: status ready, refreshed now, and the token's holder count set exact (design section 6). Returns the count. */
export async function markReady(db: Db, tokenId: string, now: number): Promise<number> {
  return db.tx(async (t) => {
    await t.query("update market.holder_refresh set status = 'ready', refreshed_at = $2 where token_id = $1", [tokenId, now]);
    const rows = await t.query<{ n: number }>(
      `update market.tokens set holders_count = (select count(*)::int from market.token_balances where token_id = $1 and balance > 0)
       where id = $1 returning holders_count as n`,
      [tokenId],
    );
    return rows[0]?.n ?? 0;
  });
}

export async function markSkipped(db: Db, tokenId: string): Promise<void> {
  await db.tx(async (t) => {
    await t.query("delete from market.token_balances where token_id = $1", [tokenId]);
    await t.query("update market.holder_refresh set status = 'skipped', cursor_block = 0 where token_id = $1", [tokenId]);
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/holders/store.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260923010000_holder_refresh_build.sql src/lib/holders/store.ts src/lib/holders/store.test.ts
git commit -m "Top holders: build state on holder_refresh and the slice-applying store"
```

---

### Task 2: Transfer events from HyperSync and the pure fold

**Files:**
- Modify: `src/lib/chain/types.ts` (add `TransferEvent`, add `transfers()` to `LogSource`)
- Modify: `src/lib/chain/hypersyncSource.ts` (implement `transfers()`)
- Modify: `src/lib/chain/run.test.ts` lines 57–90 (`FakeLogSource` gains a `transfers` stub that throws "not used here")
- Create: `src/lib/holders/fold.ts`
- Test: `src/lib/holders/fold.test.ts`, `src/lib/chain/hypersyncSource.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `LogSource`, `createHyperSyncSource` and its `request` helper (`hypersyncSource.ts` lines 91–160), `HyperSyncQueryResponse`.
- Produces:
  ```ts
  // src/lib/chain/types.ts
  export type TransferEvent = { block: number; logIndex: number; from: string; to: string; value: bigint };
  export interface LogSource { /* existing head, fetch, requests, plus: */
    transfers(token: string, fromBlock: number): Promise<{ transfers: TransferEvent[]; nextBlock: number }>;
  }
  // src/lib/holders/fold.ts
  export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  export function foldTransfers(transfers: readonly TransferEvent[]): Map<string, bigint>;
  ```

- [ ] **Step 1: Write the failing fold tests**

`src/lib/holders/fold.test.ts`: (1) a mint (from zero) credits `to` only; (2) a burn (to zero) debits `from` only; (3) a transfer debits and credits; (4) a wallet whose net change in the slice is zero has NO entry; (5) mixed-case addresses fold to lowercase keys; (6) values add as bigint beyond 2^53 (use `10n ** 30n`).

- [ ] **Step 2: Write the failing HyperSync transfers test**

In `src/lib/chain/hypersyncSource.test.ts`, following the file's existing `fetchImpl` stubbing pattern: `transfers(token, fromBlock)` POSTs `/query` with `from_block`, `logs: [{ address: [token lowercase], topics: [[TRANSFER_TOPIC0]] }]` and `field_selection.log = ["block_number","log_index","topic1","topic2","data"]`; decodes `from`/`to` from the last 40 hex chars of topic1/topic2 and `value` from `data` (`"0x"` or empty data → `0n`); skips a log with a `topic3` (an ERC-721 Transfer) and a log missing topic2; returns them sorted by (block, logIndex); returns `next_block` as `nextBlock`; throws on a malformed body or `next_block <= fromBlock` exactly like `fetch()` does.

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run src/lib/holders/fold.test.ts src/lib/chain/hypersyncSource.test.ts`
Expected: FAIL — `foldTransfers` missing; `transfers is not a function`.

- [ ] **Step 4: Implement**

`src/lib/chain/types.ts` — add after `ChainEvent`:
```ts
/** One ERC-20 Transfer of one token, from HyperSync (LogSource.transfers): addresses lowercase, value as emitted. */
export type TransferEvent = { block: number; logIndex: number; from: string; to: string; value: bigint };
```
and in `LogSource`:
```ts
  /**
   * `token`'s ERC-20 Transfer events from `fromBlock` on, ascending by (block, logIndex), as many blocks as one
   * response covers (top holders, 23 Sep 2026): `nextBlock` is the first block NOT covered and is always
   * greater than `fromBlock`, or the call throws — the same contract as fetch().
   */
  transfers(token: string, fromBlock: number): Promise<{ transfers: TransferEvent[]; nextBlock: number }>;
```

`src/lib/chain/hypersyncSource.ts` — add a constant and the method beside `fetch`:
```ts
/** keccak256("Transfer(address,address,uint256)"). */
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddress = (topic: unknown): string | null =>
  typeof topic === "string" && topic.length === 66 ? `0x${topic.slice(26).toLowerCase()}` : null;

    async transfers(token: string, fromBlock: number) {
      const queryBody = {
        from_block: fromBlock,
        logs: [{ address: [token.toLowerCase()], topics: [[TRANSFER_TOPIC0]] }],
        field_selection: { log: ["block_number", "log_index", "topic1", "topic2", "data"] },
      };
      const response = (await request("/query", "POST", { "Content-Type": "application/json" }, JSON.stringify(queryBody))) as HyperSyncQueryResponse;
      if (!Array.isArray(response.data) || !Number.isInteger(response.next_block)) {
        throw new Error(`HyperSync transfers response malformed for block ${fromBlock}: missing data array or next_block`);
      }
      if (response.next_block <= fromBlock) throw new Error(`HyperSync transfers made no progress from block ${fromBlock}`);
      const transfers: TransferEvent[] = [];
      for (const chunk of response.data) {
        for (const log of chunk.logs ?? []) {
          // An ERC-721 Transfer carries the token id as a fourth topic; it is not a balance movement.
          if (log.topic3 != null) continue;
          const from = topicAddress(log.topic1);
          const to = topicAddress(log.topic2);
          if (!from || !to) continue;
          const data = typeof log.data === "string" && log.data.length > 2 ? log.data : "0x0";
          transfers.push({ block: Number(log.block_number), logIndex: Number(log.log_index), from, to, value: BigInt(data) });
        }
      }
      transfers.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
      return { transfers, nextBlock: response.next_block };
    },
```
(Read the file's `HyperSyncQueryResponse`/log types first and widen them so `topic3`, `log_index` and `data` type-check; keep `fetch()` untouched.)

`src/lib/holders/fold.ts`:
```ts
import type { TransferEvent } from "@/lib/chain/types";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Balance deltas of one slice of a token's Transfer events (design section 4, step 4): `from` loses `value`,
 * `to` gains it, the zero address (mint/burn counterparty) is never a wallet. A wallet whose net change over the
 * slice is zero gets no entry, so applySlice never writes a row it would delete in the same statement. Pure.
 */
export function foldTransfers(transfers: readonly TransferEvent[]): Map<string, bigint> {
  const deltas = new Map<string, bigint>();
  const add = (wallet: string, delta: bigint): void => {
    const key = wallet.toLowerCase();
    if (key === ZERO_ADDRESS || delta === 0n) return;
    const next = (deltas.get(key) ?? 0n) + delta;
    if (next === 0n) deltas.delete(key);
    else deltas.set(key, next);
  };
  for (const t of transfers) {
    add(t.from, -t.value);
    add(t.to, t.value);
  }
  return deltas;
}
```

`src/lib/chain/run.test.ts` `FakeLogSource`: add
```ts
  async transfers(): Promise<{ transfers: TransferEvent[]; nextBlock: number }> {
    throw new Error("FakeLogSource.transfers: not used by the reader's tests");
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/holders/fold.test.ts src/lib/chain/hypersyncSource.test.ts src/lib/chain/run.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/chain/types.ts src/lib/chain/hypersyncSource.ts src/lib/chain/hypersyncSource.test.ts src/lib/chain/run.test.ts src/lib/holders/fold.ts src/lib/holders/fold.test.ts
git commit -m "Top holders: Transfer events from HyperSync and the pure balance fold"
```

---

### Task 3: The builder, its cron route and wiring

**Files:**
- Create: `src/lib/holders/run.ts`
- Create: `src/app/api/internal/holders/route.ts`
- Modify: `src/lib/sync/state.ts` line 3 (`SyncJob` gains `"holders"`)
- Modify: `src/lib/sync/deps.ts` (add `holdersDeps()` / `setHoldersDeps()` beside `chainDeps`)
- Modify: `vercel.json` (add the cron)
- Test: `src/lib/holders/run.test.ts`, `src/app/api/internal/holders/route.test.ts` (model: `src/app/api/internal/sync/route.test.ts` if present, else the nightly route's test)

**Interfaces:**
- Consumes: Task 1's store, Task 2's `LogSource.transfers`/`foldTransfers`, `acquireLease/releaseLease/renewLease/readState/finishRun` (`src/lib/sync/state.ts`), `QUOTES` (`src/lib/chain/math/quotes.ts`).
- Produces:
  ```ts
  export const HOLDERS_JOB = "holders";
  export const DEFAULT_REQUEST_SPACING_MS = 750; export const DEFAULT_SAFETY_BLOCKS = 30;
  export type HoldersRunDeps = { source: Pick<LogSource, "head" | "transfers" | "requests"> };
  export type HoldersRunOpts = {
    owner: string; now: () => number; sleep: (ms: number) => Promise<void>; windowSec: number; leaseSec: number;
    excludedIds: readonly string[]; requestSpacingMs?: number; safetyBlocks?: number; coverageLimit?: number; maxTransfersPerToken?: number;
  };
  export type HoldersRunReport = {
    skipped: "lease" | "nightly" | null; coverage: number; due: number; tokensTouched: number; tokensReady: number; tokensSkipped: number;
    slices: number; requests: number; transfers: number; errors: number; error: string | null;
  };
  export async function runHoldersBuild(db: Db, deps: HoldersRunDeps, opts: HoldersRunOpts): Promise<HoldersRunReport>;
  // deps.ts
  export type HoldersDeps = { db: Db } & HoldersRunDeps;
  export function holdersDeps(): HoldersDeps; export function setHoldersDeps(factory: (() => HoldersDeps) | null): void;
  ```

- [ ] **Step 1: Write the failing runner tests**

`src/lib/holders/run.test.ts` with PGlite and a `FakeTransferSource` (`head`, `transfers(token, fromBlock)` served from a per-token map of `{ [fromBlock]: { transfers, nextBlock } }`, `requests` counter, optional `throwOn: Set<string>`). Fake clock as in `src/lib/chain/run.test.ts`'s `baseOpts` (`now` advancing on `sleep`). Seed tokens and swaps so the coverage set is deterministic.

Cases:
1. A requested token (row `building`, `requested_at > 0`) is built before a covered stale one; its slices are applied in order; on reaching `head - safetyBlocks` it is `ready` with an exact `holders_count`; the report counts touched/ready/slices/requests/transfers.
2. Requests are spaced: with `requestSpacingMs 750` and a fake `sleep` that records waits, consecutive calls to the source are at least 750 ms apart on the fake clock (the head read counts as the first request).
3. The window bounds work: with `windowSec` small and a token needing three slices, the invocation stops after the slices that fit, the cursor is persisted after each, the token stays `building`, and the next invocation resumes from the stored cursor (no transfer is folded twice: assert balances).
4. A source error on one token counts `errors 1`, leaves that token's cursor unchanged, and the invocation continues with the next due token.
5. The safety valve: a token whose `transfers` passes `maxTransfersPerToken` (set it to 10 in the test) without reaching the head is marked `skipped`, its rows deleted, `tokensSkipped 1`.
6. Lease held → `{ skipped: "lease" }`, nothing read; nightly lease live → `{ skipped: "nightly" }` and the holders lease released.
7. `finishRun` wrote `last_report` for job `holders` with the report's counters, and `last_error` on a thrown head() error (report.error set, lease released).
8. Covered tokens with no row get `building` rows (ensureRows) and are built in due order (3).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/holders/run.test.ts`
Expected: FAIL — `./run` not found.

- [ ] **Step 3: Implement the runner**

```ts
import type { LogSource, TransferEvent } from "@/lib/chain/types";
import type { Db } from "@/lib/db/client";
import { acquireLease, finishRun, readState, releaseLease, renewLease } from "@/lib/sync/state";
import { foldTransfers } from "./fold";
import {
  applySlice, coverageSet, dueTokens, ensureRows, markReady, markSkipped, refreshRow,
  COVERAGE_LIMIT, MAX_TRANSFERS_PER_TOKEN, type RefreshRow,
} from "./store";

/**
 * The top-holder builder (docs/superpowers/specs/2026-09-23-top-holders-design.md, section 4): one invocation
 * per cron minute under the `holders` lease, at most `windowSec` of work, one HyperSync request every
 * `requestSpacingMs` (80 a minute against the key's 100, the reader's 4 alongside). Per due token: slice from
 * the stored cursor until ready or the window ends. A thrown head() or coverage error ends the invocation
 * through finishRun(ok: false); a per-token failure is counted and skipped over.
 */
export const HOLDERS_JOB = "holders";
export const DEFAULT_REQUEST_SPACING_MS = 750;
export const DEFAULT_SAFETY_BLOCKS = 30;

export type HoldersRunDeps = { source: Pick<LogSource, "head" | "transfers" | "requests"> };
export type HoldersRunOpts = {
  owner: string; now: () => number; sleep: (ms: number) => Promise<void>; windowSec: number; leaseSec: number;
  excludedIds: readonly string[]; requestSpacingMs?: number; safetyBlocks?: number; coverageLimit?: number; maxTransfersPerToken?: number;
};
export type HoldersRunReport = {
  skipped: "lease" | "nightly" | null; coverage: number; due: number; tokensTouched: number; tokensReady: number; tokensSkipped: number;
  slices: number; requests: number; transfers: number; errors: number; error: string | null;
};

const sec = (ms: number) => Math.floor(ms / 1000);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export async function runHoldersBuild(db: Db, deps: HoldersRunDeps, opts: HoldersRunOpts): Promise<HoldersRunReport> {
  const report: HoldersRunReport = { skipped: null, coverage: 0, due: 0, tokensTouched: 0, tokensReady: 0, tokensSkipped: 0, slices: 0, requests: 0, transfers: 0, errors: 0, error: null };
  const startMs = opts.now();
  if (!(await acquireLease(db, HOLDERS_JOB, opts.owner, sec(startMs), opts.leaseSec))) return { ...report, skipped: "lease" };
  if ((await readState(db, "nightly")).leaseUntil > sec(startMs)) {
    await releaseLease(db, HOLDERS_JOB, opts.owner);
    return { ...report, skipped: "nightly" };
  }
  const endMs = startMs + opts.windowSec * 1000;
  const spacing = opts.requestSpacingMs ?? DEFAULT_REQUEST_SPACING_MS;
  const safety = opts.safetyBlocks ?? DEFAULT_SAFETY_BLOCKS;
  const maxTransfers = opts.maxTransfersPerToken ?? MAX_TRANSFERS_PER_TOKEN;
  const requestsStart = deps.source.requests;
  let lastRequestMs = -Infinity;
  let head = 0;
  const pace = async (): Promise<void> => {
    const wait = lastRequestMs + spacing - opts.now();
    if (wait > 0) await opts.sleep(wait);
    lastRequestMs = opts.now();
  };
  try {
    await pace();
    head = await deps.source.head();
    const coverage = await coverageSet(db, sec(opts.now()), opts.excludedIds, opts.coverageLimit ?? COVERAGE_LIMIT);
    report.coverage = coverage.length;
    await ensureRows(db, coverage);
    const due = await dueTokens(db, coverage, sec(opts.now()));
    report.due = due.length;
    for (const row of due) {
      if (opts.now() >= endMs) break;
      report.tokensTouched += 1;
      await buildToken(row);
      await renewLease(db, HOLDERS_JOB, opts.owner, sec(opts.now()), opts.leaseSec);
    }
    await finishRun(db, HOLDERS_JOB, { now: sec(opts.now()), ok: true, rows: report.transfers, queries: deps.source.requests - requestsStart, report: cycleReport() });
  } catch (err) {
    report.error = message(err);
    await finishRun(db, HOLDERS_JOB, { now: sec(opts.now()), ok: false, error: report.error, rows: 0, queries: deps.source.requests - requestsStart });
  } finally {
    report.requests = deps.source.requests - requestsStart;
    await releaseLease(db, HOLDERS_JOB, opts.owner);
  }
  return report;

  function cycleReport(): Record<string, number> {
    return {
      at: sec(opts.now()), coverage: report.coverage, due: report.due, tokensTouched: report.tokensTouched, tokensReady: report.tokensReady,
      tokensSkipped: report.tokensSkipped, slices: report.slices, requests: deps.source.requests - requestsStart, transfers: report.transfers, errors: report.errors,
    };
  }

  /** Slices one token from its stored cursor until ready, skipped, a failure, or the window's end. */
  async function buildToken(start: RefreshRow): Promise<void> {
    let row: RefreshRow | null = start;
    while (row && opts.now() < endMs) {
      if (row.cursorBlock >= head - safety) {
        await markReady(db, row.tokenId, sec(opts.now()));
        report.tokensReady += 1;
        return;
      }
      if (row.transfers > maxTransfers) {
        await markSkipped(db, row.tokenId);
        report.tokensSkipped += 1;
        return;
      }
      await pace();
      let slice: { transfers: TransferEvent[]; nextBlock: number };
      try {
        slice = await deps.source.transfers(row.tokenId, row.cursorBlock);
      } catch (err) {
        report.errors += 1;
        console.warn(`holders: slice failed for ${row.tokenId} from ${row.cursorBlock}: ${message(err)}`);
        return;
      }
      await applySlice(db, row.tokenId, foldTransfers(slice.transfers), slice.nextBlock, slice.transfers.length, sec(opts.now()));
      report.slices += 1;
      report.transfers += slice.transfers.length;
      row = await refreshRow(db, row.tokenId);
    }
  }
}
```

- [ ] **Step 4: Wire the job type, deps, route and cron**

`src/lib/sync/state.ts` line 3: `export type SyncJob = "market" | "nightly" | "chain" | "holders";`

`src/lib/sync/deps.ts`, after `setChainDeps`:
```ts
/** What src/app/api/internal/holders/route.ts runs the top-holder builder against: the process Db and a HyperSync source. */
export type HoldersDeps = { db: Db } & HoldersRunDeps;
let holdersOverride: (() => HoldersDeps) | null = null;
export function holdersDeps(): HoldersDeps {
  if (holdersOverride) return holdersOverride();
  return { db: getDb(), source: createHyperSyncSource() };
}
/** Tests only. */
export function setHoldersDeps(factory: (() => HoldersDeps) | null): void {
  holdersOverride = factory;
}
```
(with `import type { HoldersRunDeps } from "@/lib/holders/run";`).

`src/app/api/internal/holders/route.ts`, mirroring `src/app/api/internal/sync/route.ts` (auth, `maxDuration = 300`, `NO_STORE`, `failure`):
```ts
const QUOTE_IDS = QUOTES.map((q) => q.address);
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  try {
    const { db, source } = holdersDeps();
    const report = await runHoldersBuild(db, { source }, { owner: randomUUID(), now: Date.now, sleep, windowSec: 50, leaseSec: 300, excludedIds: QUOTE_IDS });
    return NextResponse.json(report, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}
```

`vercel.json`: add `{ "path": "/api/internal/holders", "schedule": "* * * * *" }` to `crons`.

Route test: 401 without the secret; with it, runs the builder against `setHoldersDeps` (PGlite + fake source) and returns the report JSON with `Cache-Control: no-store`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/holders src/app/api/internal/holders src/lib/sync/deps.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/holders/run.ts src/lib/holders/run.test.ts src/app/api/internal/holders/route.ts src/app/api/internal/holders/route.test.ts src/lib/sync/state.ts src/lib/sync/deps.ts vercel.json
git commit -m "Top holders: the paced, resumable builder under its own lease and minute cron"
```

---

### Task 4: Serving the list: backend, route, data source, hook, tab

**Files:**
- Modify: `src/lib/types.ts` (add `HoldersView`; `MarketsDataSource.holders` returns it)
- Modify: `src/lib/market/backend.ts` line 34 (`holders(id): Promise<HoldersView>`), `src/lib/market/dbBackend.ts` lines 13–17, 121–130, 190–206 (remove `topHolders`, `HOLDER_REFRESH_SEC`, `HOLDERS_PULLED`, the read-through; serve status/asOf; stamp requests)
- Modify: `src/app/api/tokens/[address]/holders/route.ts` (memo 5 s, CDN TTL by status)
- Modify: `src/lib/data/envio.ts` line 77, `src/lib/data/mock.ts` line 252 (return `HoldersView`)
- Modify: `src/hooks/useMarketsData.ts` line 135 (`refetchInterval` while building)
- Modify: `src/components/ActivityTabs.tsx` lines 107–140 (`HoldersTable` states)
- Test: `src/lib/market/dbBackend.test.ts`, `src/app/api/tokens/[address]/holders/route.test.ts` (create if absent), `src/lib/data/envio.test.ts`, `src/hooks/useMarketsData.test.tsx` line 57 (mock shape), `src/components/ActivityTabs.test.tsx`

**Interfaces:**
- Consumes: Task 1's `refreshRow`, `requestBuild`, `HolderStatus`, `STALE_SEC`.
- Produces:
  ```ts
  // src/lib/types.ts
  export type HoldersStatus = "ready" | "building" | "skipped";
  export interface HoldersView { holders: Holder[]; count: number; status: HoldersStatus; asOf: number | null }
  ```

- [ ] **Step 1: Write the failing tests**

- `dbBackend.test.ts` (extend the existing holders cases): (a) no refresh row → answers `status "building", asOf null, holders []`, and a `building` row now exists with `requested_at = now`; (b) a `ready` row → the stored top rows, `count` from `tokens.holders_count`, `asOf = refreshed_at`, and `requested_at` re-stamped only when the list is older than `STALE_SEC` (so an opened stale list gets refreshed) and the previous stamp is older than 60 s; (c) `skipped` → `status "skipped"`, no rows, no stamp; (d) an unknown token → `{ holders: [], count: 0, status: "building", asOf: null }` with no row written (`TOKEN_SQL` finds nothing).
- Route test: `Cache-Control` `s-maxage=60` for ready, `s-maxage=5` otherwise; the in-process memo TTL is 5 s (call twice within 5 s → one backend call).
- `envio.test.ts`: `holders()` returns the whole view.
- `useMarketsData.test.tsx`: the mock at line 57 returns `{ data: { holders, count, status, asOf } }`; `useHolders` sets `refetchInterval` 5,000 while `status === "building"` and `false` when ready (test through the query options if the file already asserts them; otherwise a render test in ActivityTabs).
- `ActivityTabs.test.tsx`: ready with rows renders them and an "as of" line; ready with none renders "No holders yet."; building renders the skeleton and "Building this token's holder list. Usually under a minute."; skipped renders "Holder list unavailable for tokens with over a million holders."

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/market/dbBackend.test.ts src/components/ActivityTabs.test.tsx src/hooks/useMarketsData.test.tsx src/lib/data/envio.test.ts`
Expected: FAIL on the new shapes.

- [ ] **Step 3: Implement**

`src/lib/types.ts`, beside `Holder`:
```ts
/** The Holders tab's answer (docs/superpowers/specs/2026-09-23-top-holders-design.md, sections 1 and 5). */
export type HoldersStatus = "ready" | "building" | "skipped";
export interface HoldersView {
  holders: Holder[];
  /** market.tokens.holders_count: exact once a list is ready, the reader's drifted count before. */
  count: number;
  status: HoldersStatus;
  /** Unix seconds the list was last brought to the chain head; null until it first is. */
  asOf: number | null;
}
```
and `holders(id: string): Promise<HoldersView>;` in `MarketsDataSource`.

`src/lib/market/dbBackend.ts` — delete `HOLDER_REFRESH_SEC`, `HOLDERS_PULLED`, `REFRESH_SQL`, `DbBackendOpts.topHolders`, the `replaceHolders` import; replace the `holders` method:
```ts
    async holders(id) {
      const token = (await db.query<TokenCols>(TOKEN_SQL, [id]))[0];
      if (!token) return { holders: [], count: 0, status: "building", asOf: null };
      const at = now();
      let row = await refreshRow(db, id);
      // The tab's open is what queues a build (design section 5): no row, or a list stale by STALE_SEC, gets a
      // request stamp (throttled inside requestBuild); a skipped token is never re-queued.
      if (!row || (row.status !== "skipped" && row.refreshedAt < at - STALE_SEC)) {
        await requestBuild(db, id, at);
        row = row ?? (await refreshRow(db, id));
      }
      const status: HoldersStatus = row?.status === "ready" ? "ready" : row?.status === "skipped" ? "skipped" : "building";
      const rows = status === "ready" ? await db.query<BalanceRow>(HOLDERS_SQL, [id]) : [];
      return { holders: shapeHolders(rows, token.decimals, BigInt(token.total_supply)), count: token.holders_count, status, asOf: row && row.refreshedAt > 0 ? row.refreshedAt : null };
    },
```
`backend.ts` line 34: `holders(id: string): Promise<HoldersView>;`.

Route: `ttlCache(\`holders:${id}\`, 5_000, ...)`, then `cached(view, view.status === "ready" ? 60 : 5)`.

`envio.ts`: `return getJson<HoldersView>(\`/api/tokens/${id}/holders\`);` — `mock.ts`: wrap its list as `{ holders, count: holders.length, status: "ready", asOf: nowSec() }`.

`useMarketsData.ts`:
```ts
export function useHolders(id: string) {
  const ds = useDataSource();
  return useQuery({
    queryKey: keys.holders(id),
    queryFn: () => ds.holders(id),
    // A list being built lands within a minute or two (design section 1): poll until it does, then stop.
    refetchInterval: (query) => (query.state.data?.status === "building" ? 5_000 : false),
  });
}
```

`ActivityTabs.tsx` `HoldersTable`: keep the header row; then
- `isPending` → skeleton (as today);
- `data.status === "building"` → skeleton plus one muted line `Building this token's holder list. Usually under a minute.`;
- `data.status === "skipped"` → one muted line `Holder list unavailable for tokens with over a million holders.`;
- ready and `data.holders.length === 0` → `No holders yet.`;
- ready → rows as today, followed by a muted line `As of {fmtAge(ageHours(data.asOf, now))} ago` (reuse `fmtAge`/`ageHours` from `@/lib/format` and the `now` the tab already has; show `just now` when under a minute).
Use the existing muted text classes in the file (`text-ink-40`, `text-[11px]`).

- [ ] **Step 4: Run the tests, then the whole suite**

Run: `npx vitest run src/lib/market src/components src/hooks src/lib/data src/app/api/tokens` then `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/market/backend.ts src/lib/market/dbBackend.ts src/lib/market/dbBackend.test.ts "src/app/api/tokens/[address]/holders/route.ts" "src/app/api/tokens/[address]/holders/route.test.ts" src/lib/data/envio.ts src/lib/data/envio.test.ts src/lib/data/mock.ts src/hooks/useMarketsData.ts src/hooks/useMarketsData.test.tsx src/components/ActivityTabs.tsx src/components/ActivityTabs.test.tsx
git commit -m "Top holders: serve the stored list with status and as-of, queue builds on open, tab states"
```

---

### Task 5: Nightly cleanup, health, docs

**Files:**
- Modify: `src/lib/sync/nightly.ts` lines 9–20 and 93–108 (phase `holders` between `prune` and `probe`; `NightlyResult.prunedHolders`)
- Modify: `src/lib/market/backend.ts` `HealthReport` (add `holders`), `src/lib/market/dbBackend.ts` `health()` and `STATE_SQL` (job `holders`)
- Modify: `README.md` (crons table / env table)
- Test: `src/lib/sync/nightly.test.ts`, `src/lib/market/dbBackend.test.ts`

**Interfaces:**
- Consumes: Task 1's `pruneHolders`, `coverageSet`; `QUOTES`.
- Produces:
  ```ts
  // HealthReport
  holders?: {
    lastCycle: { ageSec: number; coverage: number; due: number; tokensTouched: number; tokensReady: number; tokensSkipped: number; slices: number; requests: number; transfers: number; errors: number } | null;
    table: { rows: number; bytes: number };
  };
  ```

- [ ] **Step 1: Write the failing tests**

- `nightly.test.ts`: with rows for a covered token (has 24 h swaps), an off-table token requested 2 days ago, and an off-table token requested 10 days ago, a full run leaves the first two and deletes the third's balance and refresh rows; `prunedHolders` is 1; the stored phase sequence passes through `holders`; a run interrupted by the deadline inside `prune` resumes and still reaches `holders` on the next run.
- `dbBackend.test.ts` health: with a `holders` job report written through `finishRun` (fields as in Task 3's `cycleReport`), `health().holders.lastCycle` carries them with `ageSec`; without one, `lastCycle` is null; `table.rows` and `table.bytes` are numbers (rows ≥ 0; on PGlite `reltuples` may be −1 before analyze — clamp to 0).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/sync/nightly.test.ts src/lib/market/dbBackend.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`nightly.ts`: `const PHASES = ["listed", "prune", "holders", "probe"] as const;` and after the prune block:
```ts
  if (phase === "holders") {
    // Design section 7: keep the table's tokens and anything opened in the last week, drop the rest. One token
    // per statement pair inside pruneHolders, so no single delete approaches the pooler's statement timeout.
    const kept = await coverageSet(db, opts.now, QUOTE_IDS);
    const pruned = await pruneHolders(db, kept, opts.now);
    r.prunedHolders = pruned.tokens;
    phase = "probe";
    afterId = "";
    await saveCursors(db, "nightly", { phase, cursorText: "" });
  }
```
with `const QUOTE_IDS = QUOTES.map((q) => q.address);` and `prunedHolders: number` (default 0) in `NightlyResult`.

`dbBackend.ts`: `STATE_SQL` → `where job in ('chain', 'nightly', 'holders')`; a `HOLDERS_TABLE_SQL`:
```ts
const HOLDERS_TABLE_SQL = `select greatest(coalesce(reltuples, 0), 0)::bigint as rows, pg_total_relation_size('market.token_balances')::bigint as bytes
  from pg_class where oid = 'market.token_balances'::regclass`;
```
and in `health()` after `night`: read the `holders` state row, shape its `last_report` with the same null-on-missing discipline as `lastCycleFrom` (a second small helper `holdersCycleFrom`), query the table size, and add `holders: { lastCycle, table: { rows: Number(rows), bytes: Number(bytes) } }` to the returned object.

README: add the `/api/internal/holders` cron (every minute, builder) to wherever the two existing crons are documented, and one line on `HYPERSYNC_API_TOKEN` now needing the paid key (100 requests a minute) because the builder uses 80.

- [ ] **Step 4: Run the full suite, tsc and eslint**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json && npx eslint src`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/nightly.ts src/lib/sync/nightly.test.ts src/lib/market/backend.ts src/lib/market/dbBackend.ts src/lib/market/dbBackend.test.ts README.md
git commit -m "Top holders: nightly cleanup phase, health block, docs"
```

---

## Rollout (controller, after the final review)

1. Apply the migration to production with `npm run db:migrate` BEFORE pushing (the store's queries need the columns; the table is empty so it is instant).
2. Push `main`; Vercel deploys the new cron. Watch `/api/health` `holders.lastCycle` for the first cycles: `requests` about 66 per invocation, `errors` 0.
3. The one-time build of the table's tokens takes about an hour at 80 a minute. Spot-check three ready tokens against the explorer's holders page by hand.
4. Record the decision (coverage, cadence, cleanup, storage line) in the workspace README's Decision Log.
