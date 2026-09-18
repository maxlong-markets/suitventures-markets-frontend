# Supabase Market Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror the indexer's market data into a Supabase Postgres the project owns, keep it fresh with a sync job on Vercel cron, and make the app's `/api/*` routes read that store, with the same JSON contract plus one new route.

**Architecture:** `src/lib/db` (a small `Db` interface over the `postgres` driver in production and PGlite in tests, plus a migration runner), `src/lib/sync` (an `EnvioSource` boundary with a rate limiter, idempotent SQL writers, cursor state with a lease, the market cycle, the nightly job, and the invocation runner behind two cron routes), `src/lib/market` (a `MarketBackend` interface with the M1 Envio implementation and the new database implementation, selected by an environment variable), and `src/lib/seed` (the resumable one-off loader). Routes stay thin and keep their cache headers.

**Tech Stack:** Next.js 16 route handlers on the Node runtime, `postgres` (porsager) 3.x, `@electric-sql/pglite` for tests, Vitest 4, `tsx` for scripts, Vercel cron, Supabase Pro (Postgres 17, Supavisor pooler).

**Spec:** `docs/superpowers/specs/2026-09-16-supabase-market-store-design.md`. The M1 read path it replaces is `docs/superpowers/specs/2026-09-12-m1-live-data-design.md` section 6; the M1 plan's Global Constraints about Envio (numeric strings, no `Candle.interval` filter, composite keys, the pinned exemption) still bind every Envio read in this plan.

## Amendments, 17 September 2026 (during execution)

- Task 1 gained two commits beyond its text: `eslint.config.mjs` ignores `docs/**` and `.claude/**` (the handoff script under docs/design-handoff had carried lint errors since the first commit, and tool worktrees were being linted through their build output), and `createDb()` turns a URL-parse failure into a `DbUnavailableError` without the input, because Node's URL error carries the whole connection string.
- Task 4's cycle advances the cursor after every 50-pool batch, not only after a whole page, and a batch cut short by the budget or the deadline persists its resume state (`since`, pool ids, swap and candle keysets) in `sync_state.cursor_text`, drained first by the next cycle. The page-level rule could stall for good on a page whose history outgrew one invocation, which the first cycle after the seed would have hit. Spec section 5.2 step 5 and the 5.5 table carry the amended rule.
- Vitest 4 reports a missing module as `Cannot find module`, not `Failed to resolve import`; the RED steps' wording differs, the cause is the same.
- Task 4, second round: `market.pools.synced_to` (per-pool watermark, partial index `pools_unsynced`), `markSynced()` in the writers, a batch's `since` taken from the oldest watermark in it, the Envio head time stamped after the batch, and a repair batch for pools whose watermark fell behind their activity. Without it, advancing the cursor past a batch dropped the older window of every pool behind it. The seed's finish step must set `synced_to` on every pool (Task 7 follow-up).
- Fix wave after the whole-branch review: Envio requests time out after 20 s and the sync retries at most three times, cursors are written with `greatest()`, a `head_block` mark in `sync_state` pauses both jobs while the indexer is behind the store (an Envio replay can no longer roll the store back), the market invocation yields while the nightly's lease is held and the nightly runs at 120 requests a minute in a 280 s window, `rows_written`/`queries_used` are bigint, health carries the nightly `phase` and truncates `lastError`, the seed backdates by 3600 s, the unavailable-code set is wider, `failure()` logs only name, code and message, `dedupe` sorts by key, the smoke script exercises an array-parameter upsert.
- Task 7: a resume after a page was copied before its checkpoint was saved failed on a duplicate key forever; the checkpoint is saved at phase start and the first page of a range without a stored cursor goes through the idempotent writers. The scripts README states that a fresh start needs empty tables.

## Global Constraints

- Secrets stay server-side: `DATABASE_URL`, `DATABASE_URL_DIRECT`, `CRON_SECRET`, `ENVIO_GRAPHQL_URL`, `ENVIO_GRAPHQL_KEY`. Nothing under `NEXT_PUBLIC_` for any of them. `src/lib/db/client.ts` and `src/lib/envio/client.ts` import `"server-only"`; scripts therefore run with `--conditions=react-server` (see package scripts).
- One schema, `market`, created by `supabase/migrations/20260917000000_market.sql`; the SQL in this contract is the schema, column for column. Times are unix seconds in `integer`; uint256 in `numeric(78,0)` read as strings in TypeScript; the indexer's Floats in `double precision`. `count(*)` results are read through `Number()` because the two drivers return them differently.
- Ids are the indexer's ids, lowercase. Swaps store `Swap.id` (`txHash-logIndex`) split into `(tx_hash, log_index)`. Candle intervals are the indexer's names `m1 m5 m15 h1 d1`, parsed from `Candle.id` (`<pool>-<interval>-<bucket>`); the sync never filters or selects `Candle.interval` on Envio, because every such filter fails on the deployed schema.
- Every Envio read is keyset-paginated (`order_by` plus a strict `_gt` on the last key), page size 1000, never `offset`. Every write is an upsert (`on conflict … do update`) or an insert-ignore (`on conflict do nothing`); cursors advance only after a page is fully written, so re-processing the overlap changes nothing.
- Envio budget: the minute route issues at most 150 queries per invocation, the nightly route 400, the seed 200 a minute; `withRetry` retries `EnvioUnavailableError`s that carry a 429, a 5xx or "unreachable", never a "query failed" (bad document).
- Read semantics equal M1's, field for field: `shapePairs()` in `src/lib/envio/shape.ts` is the reference; the listed pool is the primary pool when `1e-24 < price_quote < 1e18` and `swap_count > 0`, else the sane traded pool with the most swaps; a quote is stale after 259,200 s unless `aggregator = 'pinned'`; age is the listed pool's `created_at`; `tradeable` stays `true`.
- Route contracts and cache headers are unchanged: `cached(data, ttl)` with the M1 TTLs (pairs and quotes 30, candles and trades 10, holders 60, health no-store) and `failure(err)` answering 503 for `EnvioUnavailableError` and `DbUnavailableError`. The only new route is `GET /api/tokens/[address]`.
- Tests: SQL runs on PGlite through the same migrations as production (`testDb()`); Envio is replaced by `FakeSource` at the `EnvioSource` boundary; no SQL and no `fetch` is mocked below those two seams. Test files sit next to the code as `*.test.ts` (Vitest config already includes `src/**/*.test.ts`; add `scripts` nothing).
- Gates after every task: `npm test`, `npx tsc --noEmit`, `npx eslint .`, `npm run build`.
- Commit after every task with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467
  ```
- Never print, log or commit a connection string, password, key or token; `.env.local` and `.seed/` are git-ignored.
- Probed on the deployed endpoint on 16 Sep 2026 at 23:30 Manila: every document shape in this plan (two-column keysets on `Pool`, `Swap` and `Candle`, the `recent` plus `open` candle aliases in one request, id-range walks on `Swap`, `Candle` and `TokenBalance` with `balance > 0`, and every field selected) is accepted. Timings: a pool keyset page 1.5 s, a swap batch 0.8 s, everything else about 0.3 s.

## File structure

| Area | Files | Responsibility |
|---|---|---|
| Schema | `supabase/migrations/20260917000000_market.sql` | the `market` schema, one file, applied by the repo's own runner |
| Database access | `src/lib/db/client.ts`, `csv.ts`, `pglite.ts`, `migrate.ts`, `src/test/db.ts` | `Db` interface; production driver; test driver; migrations; test helper |
| Envio boundary | `src/lib/sync/source.ts`, `envioSource.ts`, `fakeSource.ts`, `limiter.ts`, `ids.ts` | the only code that knows Envio's documents; the fake used by every sync test |
| Sync | `src/lib/sync/writers.ts`, `state.ts`, `market.ts`, `nightly.ts`, `run.ts` | idempotent writes; cursors and lease; the market cycle; the nightly; the invocation runner |
| Cron routes | `src/app/api/_lib/cron.ts`, `src/lib/sync/deps.ts`, `src/app/api/internal/sync/route.ts`, `…/sync/nightly/route.ts`, `vercel.json` | auth, the routes' `Db` and source factory (swappable in tests), scheduling |
| Reads | `src/lib/market/backend.ts`, `envioBackend.ts`, `dbBackend.ts`, `dbShape.ts`, the data routes, `src/app/api/tokens/[address]/route.ts` | the backend switch; SQL readers with M1 semantics; the one new route |
| Frontend | `src/lib/types.ts`, `src/lib/data/envio.ts`, `src/lib/data/mock.ts`, `src/hooks/useMarketsData.ts` | `pair(id)` and the `usePair` fallback |
| Seed and ops | `src/lib/seed/seed.ts`, `scripts/seed/seed.mts`, `scripts/db/{migrate,smoke,parity}.mts`, `scripts/README.md` | the resumable one-off load; migrations; connectivity smoke; parity report |
| Docs | frontend `README.md`, `.env.example`, workspace `README.md` | data-layer description; variables; Decision Log D39 and D35 |

Task order: 1 and 2 are independent of each other; 3, 4 and 5 build on them in sequence; 6 and 7 build on 1 to 5; 8 stands alone. Rollout steps that are operations rather than code are in the runbook after Task 8.

---

### Task 1: Database foundation

**Files:**
- Create: `supabase/migrations/20260917000000_market.sql`, `src/lib/db/client.ts`, `src/lib/db/csv.ts`, `src/lib/db/pglite.ts`, `src/lib/db/migrate.ts`, `src/test/db.ts`, `scripts/db/migrate.mts`, `scripts/db/smoke.mts`
- Modify: `package.json` (deps and scripts; `package-lock.json` follows), `.env.example`, `.gitignore`
- Test: `src/lib/db/csv.test.ts`, `src/lib/db/migrate.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `Db`, `DbUnavailableError`, `createDb(url, opts?)`, `getDb()`, `hasDb()`, `resetDb()` from `src/lib/db/client.ts`; `csvValue`, `csvLine` from `src/lib/db/csv.ts`; `createPgliteDb()` from `src/lib/db/pglite.ts`; `migrate(db, dir?)`, `MIGRATIONS_DIR` from `src/lib/db/migrate.ts`; `testDb()` from `src/test/db.ts`. Signatures exactly as in the contract.

Decisions where the contract is silent (each one line):
- Driver APIs were checked against the published packages on 16 Sep 2026: `postgres` 3.4.9 and `@electric-sql/pglite` 0.5.8 (the current release; the design brief said 0.3) behave as the contract's notes say. `sql.unsafe(text)` without parameters runs the simple protocol (`simple: args.length === 0` in the driver), `.writable()` resolves to a Node `Writable`, `begin`/`savepoint` return the callback's value; PGlite exposes `query(text, params, { blob })`, `exec`, `transaction(cb)`, `close()`. Both drivers return `numeric` as a string; `int8` (`count(*)`) is a string in `postgres` and a number in PGlite, hence `Number()`.
- `copy` returns `rows.length` (COPY is all-or-nothing) and returns 0 without a round trip for an empty input.
- A `db.tx` called inside a transaction is a savepoint (`savepoint` in `postgres`; `SAVEPOINT`/`RELEASE`/`ROLLBACK TO` in PGlite), so nested writers keep working.
- Connection failures from the driver (codes `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `EPIPE`, `CONNECT_TIMEOUT`, `CONNECTION_CLOSED`, `CONNECTION_ENDED`, `CONNECTION_DESTROYED`, SQLSTATE classes `08` and `53`, and `57P01`) are rethrown as `DbUnavailableError` carrying only the code, so routes can answer 503 and no message can echo a host or URL.
- `csvValue` throws on objects, symbols and functions: nothing the sync writes is one, and stringifying a `Date` silently would corrupt a row.
- `end()` on a transaction-scoped `Db` is a no-op; `resetDb()` ends the dropped singleton in the background.
- Scripts open the pool with `max: 1`: the smoke script's temp table exists only on the connection that created it.

- [ ] **Step 1: Add the dependencies and the scripts**

```bash
npm install postgres@^3.4.9
npm install --save-dev @electric-sql/pglite@^0.5.8 tsx@^4.23.13
npm pkg set "scripts.db:migrate=node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/db/migrate.mts"
npm pkg set "scripts.db:smoke=node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/db/smoke.mts"
npm pkg set "scripts.db:parity=node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/db/parity.mts"
npm pkg set "scripts.seed=node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/seed/seed.mts"
```

(`npm view postgres version`, `npm view @electric-sql/pglite version` and `npm view tsx version` answered 3.4.9, 0.5.8 and 4.23.13 on 16 Sep 2026; use the current versions if they moved, keeping the caret.) `package.json` afterwards has `"postgres": "^3.4.9"` under `dependencies`, `"@electric-sql/pglite": "^0.5.8"` and `"tsx": "^4.23.13"` under `devDependencies`, and the four `db:*`/`seed` scripts exactly as in the commands above. `db:parity` and `seed` point at files Task 7 creates; a script whose file is missing is harmless until then. `--conditions=react-server` makes `server-only` resolve to its empty build so `src/lib/db/client.ts` can be imported from a script.

- [ ] **Step 2: Write the migration**

`supabase/migrations/20260917000000_market.sql` (the contract's schema, verbatim):

```sql
create schema if not exists market;

create table if not exists market.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

create table market.quotes (
  id text primary key,
  address text not null,
  symbol text not null,
  name text not null,
  decimals int not null,
  enabled boolean not null,
  usd_price double precision,
  usd_updated_at int,
  aggregator text
);

create table market.tokens (
  id text primary key,
  address text not null,
  symbol text not null,
  name text not null,
  decimals int not null,
  total_supply numeric(78,0) not null,
  holders_count int not null,
  pool_count int not null,
  origin text not null check (origin in ('LONG','Pons','Uniswap','Other','SUIT','SV')),
  primary_pool_id text,
  listed_pool_id text,
  created_at int not null,
  metadata_loaded boolean not null,
  synced_at int not null
);
create index tokens_listed_pool on market.tokens (listed_pool_id);
create index tokens_origin_listed on market.tokens (origin, listed_pool_id);

create table market.pools (
  id text primary key,
  token_id text not null,
  quote_id text not null,
  token_is_currency0 boolean not null,
  hooks text not null,
  fee int not null,
  tick_spacing int not null,
  origin text not null check (origin in ('LONG','Pons','Uniswap','Other','SUIT','SV')),
  created_at int not null,
  price_quote double precision not null,
  tvl_token numeric(78,0),
  tvl_quote numeric(78,0),
  swap_count int not null,
  last_swap_at int,
  volume_quote_all_time double precision not null,
  synced_at int not null
);
create index pools_token_last_swap on market.pools (token_id, last_swap_at desc);
create index pools_last_swap on market.pools (last_swap_at desc nulls last);

create table market.swaps (
  tx_hash text not null,
  log_index int not null,
  pool_id text not null,
  token_id text not null,
  ts int not null,
  side text not null check (side in ('buy','sell')),
  amount_token double precision not null,
  amount_quote double precision not null,
  price_quote double precision not null,
  wallet text not null,
  primary key (tx_hash, log_index)
);
create index swaps_pool_ts on market.swaps (pool_id, ts desc);

create table market.candles (
  pool_id text not null,
  interval text not null check (interval in ('m1','m5','m15','h1','d1')),
  t int not null,
  open double precision not null,
  high double precision not null,
  low double precision not null,
  close double precision not null,
  volume_quote double precision not null,
  volume_token double precision not null,
  trades int not null,
  primary key (pool_id, interval, t)
);

create table market.token_balances (
  token_id text not null,
  holder text not null,
  balance numeric(78,0) not null,
  updated_at int not null,
  primary key (token_id, holder)
);
create index token_balances_rank on market.token_balances (token_id, balance desc);

create table market.holder_refresh (
  token_id text primary key,
  refreshed_at int not null
);

create table market.sync_state (
  job text primary key,
  cursor int not null default 0,
  cursor2 int not null default 0,
  cursor_text text not null default '',
  phase text not null default '',
  last_run_at int,
  last_ok_at int,
  last_error text,
  rows_written int not null default 0,
  queries_used int not null default 0,
  lease_until int not null default 0,
  lease_owner text
);
```

- [ ] **Step 3: Write the failing CSV test**

`src/lib/db/csv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { csvLine, csvValue } from "./csv";

describe("csvValue", () => {
  it("encodes null and undefined as an empty field, which COPY reads as NULL", () => {
    expect(csvValue(null)).toBe("");
    expect(csvValue(undefined)).toBe("");
  });
  it("encodes the empty string as a quoted empty field, which COPY reads as ''", () => {
    expect(csvValue("")).toBe('""');
  });
  it("leaves plain strings alone and quotes commas, quotes and line breaks", () => {
    expect(csvValue("0xabc")).toBe("0xabc");
    expect(csvValue("a,b")).toBe('"a,b"');
    expect(csvValue('say "hi"')).toBe('"say ""hi"""');
    expect(csvValue("line\nbreak")).toBe('"line\nbreak"');
    expect(csvValue("cr\rhere")).toBe('"cr\rhere"');
  });
  it("encodes booleans as t and f", () => {
    expect(csvValue(true)).toBe("t");
    expect(csvValue(false)).toBe("f");
  });
  it("encodes numbers and bigints as decimal text", () => {
    expect(csvValue(42)).toBe("42");
    expect(csvValue(-0.5)).toBe("-0.5");
    expect(csvValue(10n ** 30n)).toBe("1000000000000000000000000000000");
  });
  it("refuses objects", () => {
    expect(() => csvValue({})).toThrow("csvValue");
    expect(() => csvValue(new Date(0))).toThrow("csvValue");
  });
});

describe("csvLine", () => {
  it("joins fields with commas and ends with a newline", () => {
    expect(csvLine([1, null, "x,y", true, ""])).toBe('1,,"x,y",t,""\n');
    expect(csvLine([])).toBe("\n");
  });
});
```

Run: `npx vitest run src/lib/db/csv.test.ts`
Expected: FAIL, "Failed to resolve import ./csv".

- [ ] **Step 4: Write csv.ts**

`src/lib/db/csv.ts`:

```ts
/**
 * CSV for COPY … WITH (FORMAT csv). Postgres reads an unquoted empty field as NULL and a quoted
 * empty field as the empty string, which is why null and "" encode differently.
 */
const NEEDS_QUOTES = /[",\r\n]/;

/** RFC 4180 field: null/undefined → empty (COPY reads it as NULL); "" → ""; booleans → t/f; bigint/number → decimal text; strings quoted when they contain , " CR or LF, with " doubled. */
export function csvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  switch (typeof v) {
    case "string":
      if (v === "") return '""';
      return NEEDS_QUOTES.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    case "boolean":
      return v ? "t" : "f";
    case "number":
    case "bigint":
      return String(v);
    default:
      throw new Error(`csvValue: cannot encode a ${typeof v}`);
  }
}

/** Fields joined by "," with a trailing "\n". */
export function csvLine(row: readonly unknown[]): string {
  return row.map(csvValue).join(",") + "\n";
}
```

Run: `npx vitest run src/lib/db/csv.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the production Db over `postgres`**

`src/lib/db/client.ts`:

```ts
import "server-only";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import postgres from "postgres";
import { csvLine } from "./csv";

export class DbUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbUnavailableError";
  }
}

export interface Db {
  /** Parameterised query ($1, $2 …). Rows are plain objects; int4 and float8 arrive as numbers, numeric as strings, bool as booleans. */
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Multi-statement SQL without parameters (DDL, migrations). */
  exec(text: string): Promise<void>;
  /** Bulk load: rows are arrays in `columns` order, sent as COPY … FROM STDIN WITH (FORMAT csv). Returns rows written. */
  copy(table: string, columns: readonly string[], rows: readonly (readonly unknown[])[]): Promise<number>;
  /** Runs fn on one connection between BEGIN and COMMIT; ROLLBACK and rethrow on failure. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/** Socket and driver codes that mean "the database cannot be reached"; SQLSTATE 08xxx (connection), 53xxx (resources) and 57P01 (admin shutdown) join them below. */
const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE",
  "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED",
]);

function unavailableCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return null;
  return UNAVAILABLE_CODES.has(code) || code.startsWith("08") || code.startsWith("53") || code === "57P01" ? code : null;
}

/** Rethrows connection failures as DbUnavailableError. Only the code travels: driver messages can carry the host. */
async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    const code = unavailableCode(err);
    if (code) throw new DbUnavailableError(`database unavailable (${code})`);
    throw err;
  }
}

type Begin = <T>(cb: (t: postgres.TransactionSql) => Promise<T>) => Promise<T>;

/** BEGIN … COMMIT on a pooled connection. The driver's return type unwraps arrays of queries; ours never are, so the cast is exact. */
function begins(sql: postgres.Sql): Begin {
  return <T>(cb: (t: postgres.TransactionSql) => Promise<T>) => sql.begin(cb) as unknown as Promise<T>;
}

/** SAVEPOINT … RELEASE inside a running transaction. */
function savepoints(t: postgres.TransactionSql): Begin {
  return <T>(cb: (s: postgres.TransactionSql) => Promise<T>) => t.savepoint(cb) as unknown as Promise<T>;
}

function wrap(sql: postgres.ISql, begin: Begin, end: () => Promise<void>): Db {
  return {
    async query<T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      // Every value we pass is a string, number, boolean, null or an array of those; the driver's parameter type is just narrower than unknown.
      return Array.from<T>(await guard(sql.unsafe<T[]>(text, params as never[])));
    },
    async exec(text) {
      // No parameters: the driver uses the simple protocol, which allows several statements.
      await guard(sql.unsafe(text));
    },
    async copy(table, columns, rows) {
      if (rows.length === 0) return 0;
      // Identifiers are constants from our own code, never user input.
      const writable = await guard(sql.unsafe(`copy ${table} (${columns.join(",")}) from stdin with (format csv)`).writable());
      await guard(pipeline(Readable.from([rows.map(csvLine).join("")]), writable));
      return rows.length;
    },
    async tx(fn) {
      return guard(begin((t) => fn(wrap(t, savepoints(t), async () => {}))));
    },
    end,
  };
}

/** porsager `postgres` with `prepare: false` (Supavisor transaction mode), `max` default 4, `idle_timeout` 20, `connect_timeout` 10. */
export function createDb(url: string, opts: { max?: number } = {}): Db {
  const sql = postgres(url, { prepare: false, max: opts.max ?? 4, idle_timeout: 20, connect_timeout: 10 });
  return wrap(sql, begins(sql), () => sql.end({ timeout: 5 }));
}

let singleton: Db | null = null;

export function hasDb(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/** Process singleton over process.env.DATABASE_URL; throws DbUnavailableError when unset. */
export function getDb(): Db {
  if (!singleton) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new DbUnavailableError("DATABASE_URL is not set");
    singleton = createDb(url);
  }
  return singleton;
}

/** Tests only: drop the singleton. */
export function resetDb(): void {
  const old = singleton;
  singleton = null;
  if (old) void old.end().catch(() => undefined);
}
```

Run: `npx tsc --noEmit`
Expected: clean. If `postgres.TransactionSql` or `postgres.Sql` is not found, the driver's `types/index.d.ts` moved them: `grep -n "interface TransactionSql\|interface Sql<" node_modules/postgres/types/index.d.ts` shows where, and the fix is the import path, not the code.

- [ ] **Step 6: Write the PGlite Db**

`src/lib/db/pglite.ts`:

```ts
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Db } from "./client";
import { csvLine } from "./csv";

/** What PGlite and its Transaction share: one statement with parameters, or several without. */
type Runner = Pick<Transaction, "query" | "exec">;
type Begin = <T>(fn: (db: Db) => Promise<T>) => Promise<T>;

function wrap(run: Runner, tx: Begin, end: () => Promise<void>): Db {
  return {
    async query<T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      return (await run.query<T>(text, [...params])).rows;
    },
    async exec(text) {
      await run.exec(text);
    },
    async copy(table, columns, rows) {
      if (rows.length === 0) return 0;
      const blob = new Blob([rows.map(csvLine).join("")], { type: "text/csv" });
      await run.query(`copy ${table} (${columns.join(",")}) from '/dev/blob' with (format csv)`, [], { blob });
      return rows.length;
    },
    tx,
    end,
  };
}

/** A tx inside a PGlite transaction: a savepoint, released on success and rolled back to on failure. */
function savepoint(t: Transaction): Begin {
  return async (fn) => {
    await t.exec("savepoint db_tx");
    try {
      const result = await fn(wrap(t, savepoint(t), async () => {}));
      await t.exec("release savepoint db_tx");
      return result;
    } catch (err) {
      await t.exec("rollback to savepoint db_tx");
      throw err;
    }
  };
}

/** In-memory PGlite behind the Db interface. `copy` uses COPY … FROM '/dev/blob' WITH (FORMAT csv) with the same csvLine output; `tx` uses pglite.transaction. Not imported by app code. */
export async function createPgliteDb(): Promise<Db> {
  const pg = new PGlite();
  await pg.waitReady;
  return wrap(
    pg,
    (fn) => pg.transaction((t) => fn(wrap(t, savepoint(t), async () => {}))),
    () => pg.close(),
  );
}
```

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Write the failing migration test**

`src/lib/db/migrate.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client";
import { MIGRATIONS_DIR, migrate } from "./migrate";
import { createPgliteDb } from "./pglite";

const MARKET = "20260917000000_market.sql";
const TABLES = ["candles", "holder_refresh", "pools", "quotes", "schema_migrations", "swaps", "sync_state", "token_balances", "tokens"];

describe("migrate", () => {
  let db: Db;
  beforeAll(async () => {
    db = await createPgliteDb();
  });
  afterAll(async () => {
    await db.end();
  });

  it("applies the repo migrations once, in name order, and records them", async () => {
    expect(MIGRATIONS_DIR).toBe("supabase/migrations");
    const applied = await migrate(db);
    expect(applied[0]).toBe(MARKET);
    expect([...applied].sort()).toEqual(applied);
    const recorded = await db.query<{ name: string }>("select name from market.schema_migrations order by name");
    expect(recorded.map((r) => r.name)).toEqual(applied);
    expect(await migrate(db)).toEqual([]);
    const tables = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'market' order by table_name",
    );
    expect(tables.map((t) => t.table_name)).toEqual(expect.arrayContaining(TABLES));
  });

  it("round-trips a COPY and reads numeric as text, int8 through Number()", async () => {
    await migrate(db); // idempotent, so this case also passes when run alone
    const sent = await db.copy("market.holder_refresh", ["token_id", "refreshed_at"], [["0xa", 1], ["0xb", 2]]);
    expect(sent).toBe(2);
    await db.copy("market.token_balances", ["token_id", "holder", "balance", "updated_at"], [["0xa", "0xh", "1" + "0".repeat(30), 5]]);
    const rows = await db.query<{ balance: string }>("select balance from market.token_balances where token_id = $1", ["0xa"]);
    expect(rows).toEqual([{ balance: "1" + "0".repeat(30) }]);
    const [count] = await db.query<{ n: number | string }>("select count(*) as n from market.holder_refresh");
    expect(Number(count.n)).toBe(2);
  });

  it("rolls a failing file back and records nothing for it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migrate-"));
    try {
      await writeFile(join(dir, "20990101000000_bad.sql"), "create table market.half (id int);\ncreate table market.broken (id int, id int);\n");
      await expect(migrate(db, dir)).rejects.toThrow();
      const half = await db.query<{ n: number | string }>(
        "select count(*) as n from information_schema.tables where table_schema = 'market' and table_name = 'half'",
      );
      expect(Number(half[0].n)).toBe(0);
      expect(await db.query("select name from market.schema_migrations where name like '%bad%'")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

Run: `npx vitest run src/lib/db/migrate.test.ts`
Expected: FAIL, "Failed to resolve import ./migrate".

- [ ] **Step 8: Write the migration runner and the test helper**

`src/lib/db/migrate.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Db } from "./client";

export const MIGRATIONS_DIR = "supabase/migrations";

/** Created before the table is read, so the first migration's own `create … if not exists` statements are no-ops. */
const BOOTSTRAP = `
create schema if not exists market;
create table if not exists market.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);`;

/** Creates schema and schema_migrations if missing, applies every *.sql in `dir` (default MIGRATIONS_DIR under process.cwd()) not yet recorded, in filename order, each inside one transaction, recording its name. Returns the names applied this run. */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const root = resolve(process.cwd(), dir);
  await db.exec(BOOTSTRAP);
  const done = new Set((await db.query<{ name: string }>("select name from market.schema_migrations")).map((r) => r.name));
  const files = (await readdir(root)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const sql = await readFile(join(root, name), "utf8");
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query("insert into market.schema_migrations (name) values ($1)", [name]);
    });
    applied.push(name);
  }
  return applied;
}
```

`src/test/db.ts`:

```ts
import type { Db } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { createPgliteDb } from "@/lib/db/pglite";

/** A fresh PGlite with all migrations applied. Call in beforeAll / beforeEach; `await db.end()` in afterAll. */
export async function testDb(): Promise<Db> {
  const db = await createPgliteDb();
  await migrate(db);
  return db;
}
```

Run: `npx vitest run src/lib/db`
Expected: PASS (csv 7 tests, migrate 3 tests). PGlite's first start downloads nothing; it loads its WASM from `node_modules`, so the migrate file takes a few seconds.

- [ ] **Step 9: Write the laptop scripts**

`scripts/db/migrate.mts`:

```ts
/** Applies supabase/migrations to the database in DATABASE_URL_DIRECT. Run: npm run db:migrate */
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";

const url = process.env.DATABASE_URL_DIRECT;
if (!url) {
  console.error("DATABASE_URL_DIRECT is not set (see .env.example)");
  process.exit(1);
}
const db = createDb(url, { max: 1 });
try {
  const applied = await migrate(db);
  console.log(applied.length ? `applied ${applied.join(", ")}` : "nothing to apply");
} finally {
  await db.end();
}
```

`scripts/db/smoke.mts`:

```ts
/** Round-trips the Db interface against DATABASE_URL_DIRECT: COPY, query, a rolled-back transaction. Prints "ok". Run: npm run db:smoke */
import assert from "node:assert/strict";
import { createDb } from "@/lib/db/client";

const url = process.env.DATABASE_URL_DIRECT;
if (!url) {
  console.error("DATABASE_URL_DIRECT is not set (see .env.example)");
  process.exit(1);
}
// max 1: a temp table lives on the connection that created it.
const db = createDb(url, { max: 1 });
try {
  await db.exec("create temp table smoke (id int primary key, label text, flag boolean, big numeric(78,0), price double precision)");
  const big = "1" + "0".repeat(30);
  const sent = await db.copy("smoke", ["id", "label", "flag", "big", "price"], [
    [1, "a,b", true, big, 0.5],
    [2, "", false, "0", 1e21],
    [3, null, null, null, null],
  ]);
  assert.equal(sent, 3);
  type Row = { id: number; label: string | null; flag: boolean | null; big: string | null; price: number | null };
  const rows = await db.query<Row>("select id, label, flag, big, price from smoke order by id");
  assert.deepEqual(rows, [
    { id: 1, label: "a,b", flag: true, big, price: 0.5 },
    { id: 2, label: "", flag: false, big: "0", price: 1e21 },
    { id: 3, label: null, flag: null, big: null, price: null },
  ]);
  await db
    .tx(async (t) => {
      await t.query("insert into smoke (id) values ($1)", [4]);
      throw new Error("rollback on purpose");
    })
    .catch((err: unknown) => {
      if (!(err instanceof Error) || err.message !== "rollback on purpose") throw err;
    });
  const [count] = await db.query<{ n: string | number }>("select count(*) as n from smoke");
  assert.equal(Number(count.n), 3);
  console.log("ok");
} finally {
  await db.end();
}
```

Run: `npx tsc --noEmit && npx eslint scripts`
Expected: clean (`tsconfig.json` includes `**/*.mts`, so both scripts are type-checked by `tsc` and by `next build`). Running them needs a database: once `DATABASE_URL_DIRECT` is in `.env.local` (rollout step 1), `npm run db:migrate` prints `applied 20260917000000_market.sql`, a second run prints `nothing to apply`, and `npm run db:smoke` prints `ok`. Neither is a gate for this task.

- [ ] **Step 10: Document the variables and ignore the seed checkpoint**

Append to `.env.example`:

```
# Market store (server-only)
DATABASE_URL=            # Supabase pooler, transaction mode, port 6543
DATABASE_URL_DIRECT=     # Supabase session pooler, port 5432; laptop scripts only
CRON_SECRET=             # 32 random bytes; Vercel sends it as a Bearer token to the cron routes
MARKET_DATA_BACKEND=     # unset = db when DATABASE_URL is set; "envio" rolls back to the M1 path
SYNC_INTERVAL_SEC=       # seconds between sync cycles inside one invocation; default 30
```

Append to `.gitignore`:

```
# Seed checkpoint (resumable state, never source)
.seed/
```

- [ ] **Step 11: Run the gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green. `git status` shows no `.env.local` and no `.seed/`; `git diff package.json` shows only the three packages and the four scripts.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json .env.example .gitignore supabase/migrations/20260917000000_market.sql src/lib/db/client.ts src/lib/db/csv.ts src/lib/db/csv.test.ts src/lib/db/pglite.ts src/lib/db/migrate.ts src/lib/db/migrate.test.ts src/test/db.ts scripts/db/migrate.mts scripts/db/smoke.mts
git commit -m "Add the market schema, the Db interface over postgres and PGlite, and the migration runner" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

### Task 2: Envio source boundary

**Files:**
- Create: `src/lib/sync/limiter.ts`, `src/lib/sync/ids.ts`, `src/lib/sync/source.ts`, `src/lib/sync/envioSource.ts`, `src/lib/sync/fakeSource.ts`
- Test: `src/lib/sync/limiter.test.ts`, `src/lib/sync/ids.test.ts`, `src/lib/sync/envioSource.test.ts`, `src/lib/sync/fakeSource.test.ts`

**Interfaces:**
- Consumes: `gql` and `EnvioUnavailableError` from `src/lib/envio/client.ts` (M1); `Numeric` from `src/lib/envio/queries.ts`.
- Produces: `Limiter`, `createLimiter`, `RetryOpts`, `withRetry` (limiter.ts); `IndexerInterval`, `INTERVALS`, `INTERVAL_SECONDS`, `bucketStart`, `candleId`, `parseCandleId`, `parseSwapId`, `openBucketIds` (ids.ts); every record, cursor type and the `EnvioSource` interface (source.ts); `createEnvioSource` (envioSource.ts); `FakeData`, `FakeSource` (fakeSource.ts). Signatures exactly as in the contract.

Decisions where the contract is silent (each one line):
- The limiter keeps its bucket in milliseconds of refill (`60000 / perMinute` per token), so the arithmetic is exact for 60, 150, 200 and 240 a minute and tests can assert exact sleeps; a non-positive rate throws.
- `withRetry` sleeps `baseMs · 2^n` after failed attempt n (1000, 2000, 4000 ms by default) and rethrows the last error after `attempts` tries.
- In `createEnvioSource` each retry attempt takes a limiter token and counts in `queries`: every attempt is a request Envio sees.
- A first page passes the sentinel keyset `k: -1, kid: ""` (every key is greater than -1, every id greater than ""), so each keyset method sends one document; `candlesFor` has two documents because the `open` alias exists only on the first page; the id-range walks have a bounded and an unbounded document.
- Methods given an empty `poolIds` or `ids` list return empty results without a request.
- `chainMeta` returns the `chain_metadata` row for chain 4663 (as the M1 health route does) and throws `EnvioUnavailableError` when it is missing.
- Ids are lowercase (contract), so `parseCandleId` and `parseSwapId` reject uppercase hex.
- `FakeSource` records the call and counts the query before throwing an armed `failOn` error; `topHolders` and `balancesPage` compare balances as BigInt; ties in `topHolders` break by holder.

- [ ] **Step 1: Write the failing limiter test**

`src/lib/sync/limiter.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { EnvioUnavailableError } from "@/lib/envio/client";
import { createLimiter, withRetry } from "./limiter";

/** A clock that only moves when the limiter sleeps or the test advances it. */
function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createLimiter", () => {
  it("hands out perMinute tokens at once, then waits for the refill", async () => {
    const c = clock();
    const limiter = createLimiter(60, c);
    for (let i = 0; i < 60; i++) await limiter.take();
    expect(c.sleeps).toEqual([]);
    await limiter.take();
    expect(c.sleeps).toEqual([1000]);
  });
  it("refills continuously and never above the bucket size", async () => {
    const c = clock();
    const limiter = createLimiter(60, c);
    for (let i = 0; i < 60; i++) await limiter.take();
    c.advance(500);
    await limiter.take();
    expect(c.sleeps).toEqual([500]);
    c.advance(600_000);
    for (let i = 0; i < 60; i++) await limiter.take();
    expect(c.sleeps).toEqual([500]);
    await limiter.take();
    expect(c.sleeps).toEqual([500, 1000]);
  });
  it("rejects a non-positive rate", () => {
    expect(() => createLimiter(0)).toThrow("perMinute");
  });
});

describe("withRetry", () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  beforeEach(() => {
    sleeps.length = 0;
  });

  it("retries 429, 5xx and unreachable with exponential backoff", async () => {
    const errors = [
      new EnvioUnavailableError("indexer responded 429"),
      new EnvioUnavailableError("indexer responded 503"),
      new EnvioUnavailableError("indexer unreachable: fetch failed"),
    ];
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (errors.length) throw errors.shift();
      return "ok";
    }, { baseMs: 10, sleep });
    expect(result).toBe("ok");
    expect(calls).toBe(4);
    expect(sleeps).toEqual([10, 20, 40]);
  });
  it("gives up after `attempts` and throws the last error", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw new EnvioUnavailableError(`indexer responded 502 (${calls})`);
    }, { attempts: 3, baseMs: 10, sleep })).rejects.toThrow("responded 502 (3)");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });
  it("rethrows a bad document, a 4xx other than 429 and any other error at once", async () => {
    let calls = 0;
    const once = (err: Error) => withRetry(async () => {
      calls++;
      throw err;
    }, { sleep });
    await expect(once(new EnvioUnavailableError("indexer query failed: unknown field"))).rejects.toThrow("query failed");
    await expect(once(new EnvioUnavailableError("indexer responded 404"))).rejects.toThrow("404");
    await expect(once(new Error("responded 503, but not from the client"))).rejects.toThrow("not from the client");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([]);
  });
});
```

Run: `npx vitest run src/lib/sync/limiter.test.ts`
Expected: FAIL, "Failed to resolve import ./limiter".

- [ ] **Step 2: Write limiter.ts**

`src/lib/sync/limiter.ts`:

```ts
import { EnvioUnavailableError } from "@/lib/envio/client";

export type Limiter = { take(): Promise<void> };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Token bucket: `perMinute` tokens, refilled continuously; take() resolves when one is available. `now` and `sleep` are injectable for tests. */
export function createLimiter(perMinute: number, deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Limiter {
  if (!(perMinute > 0)) throw new Error(`createLimiter: perMinute must be positive, got ${perMinute}`);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  // The bucket is kept in milliseconds of refill time: a full minute holds perMinute tokens.
  const msPerToken = 60_000 / perMinute;
  let creditMs = 60_000;
  let last = now();
  return {
    async take() {
      for (;;) {
        const t = now();
        creditMs = Math.min(60_000, creditMs + (t - last));
        last = t;
        if (creditMs >= msPerToken) {
          creditMs -= msPerToken;
          return;
        }
        await sleep(Math.ceil(msPerToken - creditMs));
      }
    },
  };
}

export type RetryOpts = { attempts?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> };

const RETRYABLE = /responded 429|responded 5|unreachable/;

/** Retries fn on an EnvioUnavailableError whose message contains "responded 429", "responded 5", or "unreachable"; attempts default 4, backoff baseMs·2^n (baseMs default 1000). Any other error is rethrown at once. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;
  for (let n = 0; ; n++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof EnvioUnavailableError && RETRYABLE.test(err.message);
      if (!retryable || n + 1 >= attempts) throw err;
      await sleep(baseMs * 2 ** n);
    }
  }
}
```

Run: `npx vitest run src/lib/sync/limiter.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 3: Write the failing ids test**

`src/lib/sync/ids.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { bucketStart, candleId, INTERVAL_SECONDS, INTERVALS, openBucketIds, parseCandleId, parseSwapId } from "./ids";

const POOL = "0x" + "ab".repeat(32);
const POOL2 = "0x" + "cd".repeat(32);
const TX = "0x" + "12".repeat(32);

describe("ids", () => {
  it("knows the indexer's intervals", () => {
    expect(INTERVALS).toEqual(["m1", "m5", "m15", "h1", "d1"]);
    expect(INTERVAL_SECONDS).toEqual({ m1: 60, m5: 300, m15: 900, h1: 3600, d1: 86400 });
  });
  it("floors timestamps to bucket starts", () => {
    expect(bucketStart(3_661, "m1")).toBe(3_660);
    expect(bucketStart(3_661, "h1")).toBe(3_600);
    expect(bucketStart(90_000, "d1")).toBe(86_400);
    expect(bucketStart(86_400, "d1")).toBe(86_400);
  });
  it("formats and parses candle ids", () => {
    const id = candleId(POOL, "m15", 900);
    expect(id).toBe(`${POOL}-m15-900`);
    expect(parseCandleId(id)).toEqual({ poolId: POOL, interval: "m15", bucket: 900 });
    for (const bad of ["", POOL, `${POOL}-h2-900`, `${POOL}-h1-`, `${POOL}-h1-9x`, `${POOL.toUpperCase()}-h1-900`, "0x12-h1-900"]) {
      expect(() => parseCandleId(bad)).toThrow(`bad candle id ${bad}`);
    }
  });
  it("parses swap ids", () => {
    expect(parseSwapId(`${TX}-7`)).toEqual({ txHash: TX, logIndex: 7 });
    for (const bad of [TX, `${TX}-`, `${TX}-1-2`, `${TX}-a`, "0x12-1"]) {
      expect(() => parseSwapId(bad)).toThrow(`bad swap id ${bad}`);
    }
  });
  it("lists the open h1 and d1 buckets once per pool, in input order", () => {
    // since and now in the same hour of the same day: one h1 and one d1 id per pool, a repeated pool once.
    expect(openBucketIds([POOL, POOL2, POOL], 90_010, 90_100)).toEqual([
      `${POOL}-h1-90000`, `${POOL}-d1-86400`, `${POOL2}-h1-90000`, `${POOL2}-d1-86400`,
    ]);
    // Different hours of one day: two h1 ids and one d1 id.
    expect(openBucketIds([POOL], 90_010, 93_700)).toEqual([`${POOL}-h1-90000`, `${POOL}-h1-93600`, `${POOL}-d1-86400`]);
    // Different days: four ids.
    expect(openBucketIds([POOL], 86_000, 90_100)).toEqual([`${POOL}-h1-82800`, `${POOL}-h1-90000`, `${POOL}-d1-0`, `${POOL}-d1-86400`]);
    expect(openBucketIds([], 0, 1)).toEqual([]);
  });
});
```

Run: `npx vitest run src/lib/sync/ids.test.ts`
Expected: FAIL, "Failed to resolve import ./ids".

- [ ] **Step 4: Write ids.ts**

`src/lib/sync/ids.ts`:

```ts
export type IndexerInterval = "m1" | "m5" | "m15" | "h1" | "d1";
export const INTERVALS: readonly IndexerInterval[] = ["m1", "m5", "m15", "h1", "d1"];
export const INTERVAL_SECONDS: Record<IndexerInterval, number> = { m1: 60, m5: 300, m15: 900, h1: 3600, d1: 86400 };

// Ids are the indexer's, lowercase: a pool id is 0x + 64 hex, a swap id `txHash-logIndex`.
const CANDLE_ID = /^(0x[0-9a-f]{64})-(m1|m5|m15|h1|d1)-(\d+)$/;
const SWAP_ID = /^(0x[0-9a-f]{64})-(\d+)$/;

export function bucketStart(ts: number, interval: IndexerInterval): number {
  const s = INTERVAL_SECONDS[interval];
  return Math.floor(ts / s) * s;
}

export function candleId(poolId: string, interval: IndexerInterval, bucket: number): string {
  return `${poolId}-${interval}-${bucket}`;
}

/** Throws Error(`bad candle id ${id}`) unless the id is 0x + 64 hex, "-", an interval, "-", digits. */
export function parseCandleId(id: string): { poolId: string; interval: IndexerInterval; bucket: number } {
  const m = CANDLE_ID.exec(id);
  if (!m) throw new Error(`bad candle id ${id}`);
  return { poolId: m[1], interval: m[2] as IndexerInterval, bucket: Number(m[3]) };
}

/** Throws Error(`bad swap id ${id}`) unless the id is 0x + 64 hex, "-", digits. */
export function parseSwapId(id: string): { txHash: string; logIndex: number } {
  const m = SWAP_ID.exec(id);
  if (!m) throw new Error(`bad swap id ${id}`);
  return { txHash: m[1], logIndex: Number(m[2]) };
}

/** The h1 and d1 candle ids for the buckets containing `since` and `now`, for every pool, deduplicated, in input order. */
export function openBucketIds(poolIds: readonly string[], since: number, now: number): string[] {
  const ids = new Set<string>();
  for (const poolId of poolIds) {
    for (const interval of ["h1", "d1"] as const) {
      ids.add(candleId(poolId, interval, bucketStart(since, interval)));
      ids.add(candleId(poolId, interval, bucketStart(now, interval)));
    }
  }
  return [...ids];
}
```

Run: `npx vitest run src/lib/sync/ids.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the source interface**

`src/lib/sync/source.ts` (the contract's types, verbatim):

```ts
import type { Numeric } from "@/lib/envio/queries";

export type QuoteRec = { id: string; address: string; symbol: string; name: string; decimals: number; enabled: boolean };
export type QuotePriceRec = { id: string; usdPrice: Numeric; updatedAt: number; aggregator: string };
export type PoolRec = {
  id: string; token_id: string; quote_id: string; tokenIsCurrency0: boolean; hooks: string; fee: number; tickSpacing: number;
  origin: string; createdAt: number; priceQuote: Numeric; tvlToken: string | null; tvlQuote: string | null;
  swapCount: number; lastSwapAt: number | null; volumeQuoteAllTime: Numeric;
};
export type TokenRec = {
  id: string; address: string; symbol: string; name: string; decimals: number; totalSupply: string; holdersCount: number;
  poolCount: number; origin: string; createdAt: number; primaryPool_id: string | null; metadataLoaded: boolean;
};
export type SwapRec = {
  id: string; pool_id: string; token_id: string; timestamp: number; side: "buy" | "sell";
  amountToken: Numeric; amountQuote: Numeric; priceQuote: Numeric; wallet: string; txHash: string;
};
export type CandleRec = {
  id: string; pool_id: string; t: number; open: Numeric; high: Numeric; low: Numeric; close: Numeric;
  volumeQuote: Numeric; volumeToken: Numeric; trades: number;
};
export type BalanceRec = { id: string; token_id: string; holder: string; balance: string; updatedAt: number };

export type PoolCursor = { lastSwapAt: number; id: string };
export type CreatedCursor = { createdAt: number; id: string };
export type SwapCursor = { timestamp: number; id: string };
export type CandleCursor = { t: number; id: string };

export interface EnvioSource {
  quotes(): Promise<{ quotes: QuoteRec[]; prices: QuotePriceRec[] }>;
  /** Pools with lastSwapAt >= since, ordered (lastSwapAt asc, id asc), strictly after `after`. */
  poolsSince(since: number, after: PoolCursor | null, limit: number): Promise<PoolRec[]>;
  /** Pools with createdAt >= since and lastSwapAt null, ordered (createdAt asc, id asc), strictly after `after`. */
  poolsCreatedSince(since: number, after: CreatedCursor | null, limit: number): Promise<PoolRec[]>;
  /** Swaps of the pools with timestamp >= since, ordered (timestamp asc, id asc), strictly after `after`. */
  swapsFor(poolIds: readonly string[], since: number, after: SwapCursor | null, limit: number): Promise<SwapRec[]>;
  /** `recent`: candles of the pools with t >= since, ordered (t asc, id asc), strictly after `after`. `open`: the candles whose ids are in openIds, fetched only when `after` is null (first page); otherwise []. */
  candlesFor(poolIds: readonly string[], since: number, openIds: readonly string[], after: CandleCursor | null, limit: number): Promise<{ recent: CandleRec[]; open: CandleRec[] }>;
  tokensById(ids: readonly string[]): Promise<TokenRec[]>;
  /** Non-zero balances of one token, largest first. */
  topHolders(tokenId: string, limit: number): Promise<BalanceRec[]>;
  chainMeta(): Promise<{ latestProcessedBlock: number; blockHeight: number }>;
  /** Id-range walks (seed, nightly): rows with id > afterId, and id < beforeId when given, ascending by id, at most limit. */
  tokensPage(afterId: string, limit: number): Promise<TokenRec[]>;
  poolsPage(afterId: string, limit: number): Promise<PoolRec[]>;
  swapsPage(afterId: string, beforeId: string | null, limit: number): Promise<SwapRec[]>;
  candlesPage(afterId: string, beforeId: string | null, limit: number): Promise<CandleRec[]>;
  /** Only rows with balance > 0. */
  balancesPage(afterId: string, beforeId: string | null, limit: number): Promise<BalanceRec[]>;
  /** Requests issued so far by this source. */
  readonly queries: number;
}
```

- [ ] **Step 6: Write the failing EnvioSource test**

`src/lib/sync/envioSource.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EnvioUnavailableError, type gql } from "@/lib/envio/client";
import { createEnvioSource } from "./envioSource";
import type { Limiter } from "./limiter";

type Call = { query: string; variables: Record<string, unknown> };

/** A gql double: records every document with its variables and answers from a queue (an Error entry is thrown). */
function fakeGql(responses: unknown[]) {
  const calls: Call[] = [];
  const fn = (async (query: string, variables: Record<string, unknown> = {}) => {
    calls.push({ query, variables });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  }) as typeof gql;
  return { fn, calls };
}

function countingLimiter() {
  const limiter: Limiter & { takes: number } = {
    takes: 0,
    async take() {
      limiter.takes += 1;
    },
  };
  return limiter;
}

/** Documents are compared with whitespace collapsed, so their layout in the source is free. */
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const POOL = "0x" + "ab".repeat(32);
const POOL2 = "0x" + "cd".repeat(32);
const POOL_FIELDS = "id token_id quote_id tokenIsCurrency0 hooks fee tickSpacing origin createdAt priceQuote tvlToken tvlQuote swapCount lastSwapAt volumeQuoteAllTime";
const TOKEN_FIELDS = "id address symbol name decimals totalSupply holdersCount poolCount origin createdAt primaryPool_id metadataLoaded";
const SWAP_FIELDS = "id pool_id token_id timestamp side amountToken amountQuote priceQuote wallet txHash";
const CANDLE_FIELDS = "id pool_id t open high low close volumeQuote volumeToken trades";
const BALANCE_FIELDS = "id token_id holder balance updatedAt";
const keyset = (col: string) => `{ _or: [ { ${col}: { _gt: $k } }, { ${col}: { _eq: $k }, id: { _gt: $kid } } ] }`;
const ordered = (col: string) => `order_by: [ { ${col}: asc }, { id: asc } ], limit: $limit`;

describe("createEnvioSource", () => {
  it("awaits the limiter, counts one query per request and maps quotes", async () => {
    const g = fakeGql([{ Quote: [{ id: "q" }], QuotePrice: [{ id: "q", usdPrice: "1" }] }]);
    const limiter = countingLimiter();
    const source = createEnvioSource({ gql: g.fn, limiter });
    expect(await source.quotes()).toEqual({ quotes: [{ id: "q" }], prices: [{ id: "q", usdPrice: "1" }] });
    expect(limiter.takes).toBe(1);
    expect(source.queries).toBe(1);
    expect(norm(g.calls[0].query)).toContain("Quote { id address symbol name decimals enabled }");
    expect(norm(g.calls[0].query)).toContain("QuotePrice { id usdPrice updatedAt aggregator }");
  });

  it("pages pools that traded with a (lastSwapAt, id) keyset", async () => {
    const g = fakeGql([{ Pool: [] }, { Pool: [{ id: POOL }] }]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter() });
    expect(await source.poolsSince(100, null, 1000)).toEqual([]);
    expect(await source.poolsSince(100, { lastSwapAt: 150, id: POOL }, 1000)).toEqual([{ id: POOL }]);
    const q = norm(g.calls[0].query);
    expect(q).toContain(`Pool(where: { _and: [ { lastSwapAt: { _gte: $since } }, ${keyset("lastSwapAt")} ] }, ${ordered("lastSwapAt")}) { ${POOL_FIELDS} }`);
    expect(g.calls[0].variables).toEqual({ since: 100, limit: 1000, k: -1, kid: "" });
    expect(g.calls[1].variables).toEqual({ since: 100, limit: 1000, k: 150, kid: POOL });
    expect(source.queries).toBe(2);
  });

  it("pages new pools by (createdAt, id) among the never-traded", async () => {
    const g = fakeGql([{ Pool: [] }]);
    await createEnvioSource({ gql: g.fn, limiter: countingLimiter() }).poolsCreatedSince(7, { createdAt: 9, id: POOL }, 50);
    const q = norm(g.calls[0].query);
    expect(q).toContain(`Pool(where: { _and: [ { createdAt: { _gte: $since } }, { lastSwapAt: { _is_null: true } }, ${keyset("createdAt")} ] }, ${ordered("createdAt")}) { ${POOL_FIELDS} }`);
    expect(g.calls[0].variables).toEqual({ since: 7, limit: 50, k: 9, kid: POOL });
  });

  it("pages the swaps of a pool batch by (timestamp, id)", async () => {
    const g = fakeGql([{ Swap: [] }]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter() });
    expect(await source.swapsFor([], 5, null, 10)).toEqual([]);
    await source.swapsFor([POOL, POOL2], 5, null, 10);
    expect(g.calls).toHaveLength(1);
    const q = norm(g.calls[0].query);
    expect(q).toContain(`Swap(where: { _and: [ { pool_id: { _in: $pools } }, { timestamp: { _gte: $since } }, ${keyset("timestamp")} ] }, ${ordered("timestamp")}) { ${SWAP_FIELDS} }`);
    expect(g.calls[0].variables).toEqual({ pools: [POOL, POOL2], since: 5, limit: 10, k: -1, kid: "" });
  });

  it("fetches the open h1/d1 buckets by id on the first candle page only, and never selects interval", async () => {
    const open = [`${POOL}-h1-3600`, `${POOL}-d1-0`];
    const g = fakeGql([{ recent: [{ id: "r1" }], open: [{ id: "o1" }] }, { recent: [{ id: "r2" }] }]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter() });
    expect(await source.candlesFor([POOL], 100, open, null, 1000)).toEqual({ recent: [{ id: "r1" }], open: [{ id: "o1" }] });
    expect(await source.candlesFor([POOL], 100, open, { t: 120, id: "r1" }, 1000)).toEqual({ recent: [{ id: "r2" }], open: [] });
    const first = norm(g.calls[0].query);
    const next = norm(g.calls[1].query);
    for (const q of [first, next]) {
      expect(q).toContain(`recent: Candle(where: { _and: [ { pool_id: { _in: $pools } }, { t: { _gte: $since } }, ${keyset("t")} ] }, ${ordered("t")}) { ${CANDLE_FIELDS} }`);
      expect(q).not.toContain("interval");
    }
    expect(first).toContain(`open: Candle(where: { id: { _in: $openIds } }) { ${CANDLE_FIELDS} }`);
    expect(next).not.toContain("open:");
    expect(g.calls[0].variables).toEqual({ pools: [POOL], since: 100, limit: 1000, openIds: open, k: -1, kid: "" });
    expect(g.calls[1].variables).toEqual({ pools: [POOL], since: 100, limit: 1000, k: 120, kid: "r1" });
    expect(await source.candlesFor([], 100, open, null, 1000)).toEqual({ recent: [], open: [] });
    expect(g.calls).toHaveLength(2);
  });

  it("looks tokens up by id and holders by token", async () => {
    const g = fakeGql([{ Token: [{ id: "t" }] }, { TokenBalance: [{ id: "b" }] }]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter() });
    expect(await source.tokensById([])).toEqual([]);
    expect(await source.tokensById(["0xa", "0xb"])).toEqual([{ id: "t" }]);
    expect(norm(g.calls[0].query)).toContain(`Token(where: { id: { _in: $ids } }) { ${TOKEN_FIELDS} }`);
    expect(g.calls[0].variables).toEqual({ ids: ["0xa", "0xb"] });
    expect(await source.topHolders("0xa", 100)).toEqual([{ id: "b" }]);
    expect(norm(g.calls[1].query)).toContain(`TokenBalance(where: { token_id: { _eq: $token }, balance: { _gt: "0" } }, order_by: { balance: desc }, limit: $limit) { ${BALANCE_FIELDS} }`);
    expect(g.calls[1].variables).toEqual({ token: "0xa", limit: 100 });
  });

  it("reads chain 4663 from chain_metadata and fails when it is missing", async () => {
    const rows = [{ chain_id: 1, latest_processed_block: 5, block_height: 9 }, { chain_id: 4663, latest_processed_block: 10, block_height: 12 }];
    const g = fakeGql([{ chain_metadata: rows }, { chain_metadata: [] }]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter() });
    expect(await source.chainMeta()).toEqual({ latestProcessedBlock: 10, blockHeight: 12 });
    expect(norm(g.calls[0].query)).toContain("chain_metadata { chain_id latest_processed_block block_height }");
    await expect(source.chainMeta()).rejects.toBeInstanceOf(EnvioUnavailableError);
  });

  it("walks id ranges ascending, bounding them only when beforeId is given", async () => {
    const g = fakeGql([{ Token: [] }, { Pool: [] }, { Swap: [] }, { Candle: [] }, { TokenBalance: [] }]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter() });
    await source.tokensPage("", 1000);
    await source.poolsPage("0x1", 1000);
    await source.swapsPage("0x1", "0x2", 1000);
    await source.candlesPage("0x1", null, 1000);
    await source.balancesPage("0x1", "0x2", 1000);
    const [tokens, pools, swaps, candles, balances] = g.calls.map((c) => norm(c.query));
    expect(tokens).toContain(`Token(where: { id: { _gt: $after } }, order_by: { id: asc }, limit: $limit) { ${TOKEN_FIELDS} }`);
    expect(pools).toContain(`Pool(where: { id: { _gt: $after } }, order_by: { id: asc }, limit: $limit) { ${POOL_FIELDS} }`);
    expect(swaps).toContain(`Swap(where: { id: { _gt: $after, _lt: $before } }, order_by: { id: asc }, limit: $limit) { ${SWAP_FIELDS} }`);
    expect(candles).toContain(`Candle(where: { id: { _gt: $after } }, order_by: { id: asc }, limit: $limit) { ${CANDLE_FIELDS} }`);
    expect(balances).toContain(`TokenBalance(where: { id: { _gt: $after, _lt: $before }, balance: { _gt: "0" } }, order_by: { id: asc }, limit: $limit) { ${BALANCE_FIELDS} }`);
    expect(g.calls[0].variables).toEqual({ after: "", limit: 1000 });
    expect(g.calls[2].variables).toEqual({ after: "0x1", before: "0x2", limit: 1000 });
    expect(g.calls[3].variables).toEqual({ after: "0x1", limit: 1000 });
    expect(source.queries).toBe(5);
  });

  it("does not retry when retry is false", async () => {
    const g = fakeGql([new EnvioUnavailableError("indexer responded 429")]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter(), retry: false });
    await expect(source.quotes()).rejects.toThrow("responded 429");
    expect(g.calls).toHaveLength(1);
    expect(source.queries).toBe(1);
  });
});
```

Run: `npx vitest run src/lib/sync/envioSource.test.ts`
Expected: FAIL, "Failed to resolve import ./envioSource".

- [ ] **Step 7: Write envioSource.ts**

`src/lib/sync/envioSource.ts`. The documents here are the ones the app sends; `Candle.interval` is never selected or filtered (every such filter fails on the deployed schema).

```ts
import { EnvioUnavailableError, gql as defaultGql } from "@/lib/envio/client";
import { createLimiter, withRetry, type Limiter } from "./limiter";
import type { BalanceRec, CandleRec, EnvioSource, PoolRec, QuotePriceRec, QuoteRec, SwapRec, TokenRec } from "./source";

const CHAIN_ID = 4663;
/** No lower bound: every key is greater than -1 and every id greater than "". */
const FIRST_PAGE = { k: -1, kid: "" };

const QUOTE_FIELDS = "id address symbol name decimals enabled";
const QUOTE_PRICE_FIELDS = "id usdPrice updatedAt aggregator";
const POOL_FIELDS = "id token_id quote_id tokenIsCurrency0 hooks fee tickSpacing origin createdAt priceQuote tvlToken tvlQuote swapCount lastSwapAt volumeQuoteAllTime";
const TOKEN_FIELDS = "id address symbol name decimals totalSupply holdersCount poolCount origin createdAt primaryPool_id metadataLoaded";
const SWAP_FIELDS = "id pool_id token_id timestamp side amountToken amountQuote priceQuote wallet txHash";
const CANDLE_FIELDS = "id pool_id t open high low close volumeQuote volumeToken trades";
const BALANCE_FIELDS = "id token_id holder balance updatedAt";

/** Hasura two-column keyset: rows strictly after ($k, $kid) in (col, id) order. */
const keyset = (col: string) => `{ _or: [ { ${col}: { _gt: $k } }, { ${col}: { _eq: $k }, id: { _gt: $kid } } ] }`;
const ordered = (col: string) => `order_by: [ { ${col}: asc }, { id: asc } ], limit: $limit`;

const QUOTES = `query SyncQuotes { Quote { ${QUOTE_FIELDS} } QuotePrice { ${QUOTE_PRICE_FIELDS} } }`;
const POOLS_SINCE = `query SyncPoolsSince($since: Int!, $k: Int!, $kid: String!, $limit: Int!) {
  Pool(where: { _and: [ { lastSwapAt: { _gte: $since } }, ${keyset("lastSwapAt")} ] }, ${ordered("lastSwapAt")}) { ${POOL_FIELDS} }
}`;
const POOLS_CREATED_SINCE = `query SyncPoolsCreatedSince($since: Int!, $k: Int!, $kid: String!, $limit: Int!) {
  Pool(where: { _and: [ { createdAt: { _gte: $since } }, { lastSwapAt: { _is_null: true } }, ${keyset("createdAt")} ] }, ${ordered("createdAt")}) { ${POOL_FIELDS} }
}`;
const SWAPS_FOR = `query SyncSwapsFor($pools: [String!]!, $since: Int!, $k: Int!, $kid: String!, $limit: Int!) {
  Swap(where: { _and: [ { pool_id: { _in: $pools } }, { timestamp: { _gte: $since } }, ${keyset("timestamp")} ] }, ${ordered("timestamp")}) { ${SWAP_FIELDS} }
}`;
const RECENT_CANDLES = `recent: Candle(where: { _and: [ { pool_id: { _in: $pools } }, { t: { _gte: $since } }, ${keyset("t")} ] }, ${ordered("t")}) { ${CANDLE_FIELDS} }`;
const CANDLES_FIRST = `query SyncCandlesFirst($pools: [String!]!, $since: Int!, $k: Int!, $kid: String!, $limit: Int!, $openIds: [String!]!) {
  ${RECENT_CANDLES}
  open: Candle(where: { id: { _in: $openIds } }) { ${CANDLE_FIELDS} }
}`;
const CANDLES_NEXT = `query SyncCandlesNext($pools: [String!]!, $since: Int!, $k: Int!, $kid: String!, $limit: Int!) { ${RECENT_CANDLES} }`;
const TOKENS_BY_ID = `query SyncTokensById($ids: [String!]!) { Token(where: { id: { _in: $ids } }) { ${TOKEN_FIELDS} } }`;
const TOP_HOLDERS = `query SyncTopHolders($token: String!, $limit: Int!) {
  TokenBalance(where: { token_id: { _eq: $token }, balance: { _gt: "0" } }, order_by: { balance: desc }, limit: $limit) { ${BALANCE_FIELDS} }
}`;
const CHAIN_META = "query SyncChainMeta { chain_metadata { chain_id latest_processed_block block_height } }";

/** Id-range walk: id > $after (and < $before when bounded), ascending, `extra` appended inside the where object. */
function pageDoc(entity: string, fields: string, bounded: boolean, extra = ""): string {
  const vars = bounded ? "$after: String!, $before: String!, $limit: Int!" : "$after: String!, $limit: Int!";
  const range = bounded ? "id: { _gt: $after, _lt: $before }" : "id: { _gt: $after }";
  return `query Sync${entity}Page(${vars}) { ${entity}(where: { ${range}${extra} }, order_by: { id: asc }, limit: $limit) { ${fields} } }`;
}
const BALANCE_FILTER = ', balance: { _gt: "0" }';
const PAGES = {
  Token: [pageDoc("Token", TOKEN_FIELDS, false), pageDoc("Token", TOKEN_FIELDS, true)],
  Pool: [pageDoc("Pool", POOL_FIELDS, false), pageDoc("Pool", POOL_FIELDS, true)],
  Swap: [pageDoc("Swap", SWAP_FIELDS, false), pageDoc("Swap", SWAP_FIELDS, true)],
  Candle: [pageDoc("Candle", CANDLE_FIELDS, false), pageDoc("Candle", CANDLE_FIELDS, true)],
  TokenBalance: [pageDoc("TokenBalance", BALANCE_FIELDS, false, BALANCE_FILTER), pageDoc("TokenBalance", BALANCE_FIELDS, true, BALANCE_FILTER)],
} as const;

type ChainRow = { chain_id: number; latest_processed_block: number; block_height: number };

/** Real source over the M1 `gql` client. Every request first awaits `limiter.take()` (default: 200 a minute) and runs through `withRetry` unless `retry` is false. `gql` is injectable so tests can capture documents and variables. */
export function createEnvioSource(opts: { gql?: typeof defaultGql; limiter?: Limiter; retry?: boolean } = {}): EnvioSource {
  const gql = opts.gql ?? defaultGql;
  const limiter = opts.limiter ?? createLimiter(200);
  let queries = 0;

  async function request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    // Each attempt is a request the indexer sees: it takes a token and counts.
    const once = async () => {
      await limiter.take();
      queries += 1;
      return gql<T>(query, variables);
    };
    return opts.retry === false ? once() : withRetry(once);
  }

  async function page<E extends keyof typeof PAGES, T>(entity: E, afterId: string, beforeId: string | null, limit: number): Promise<T[]> {
    const [unbounded, bounded] = PAGES[entity];
    const data = beforeId === null
      ? await request<Record<E, T[]>>(unbounded, { after: afterId, limit })
      : await request<Record<E, T[]>>(bounded, { after: afterId, before: beforeId, limit });
    return data[entity];
  }

  return {
    get queries() {
      return queries;
    },
    async quotes() {
      const d = await request<{ Quote: QuoteRec[]; QuotePrice: QuotePriceRec[] }>(QUOTES, {});
      return { quotes: d.Quote, prices: d.QuotePrice };
    },
    async poolsSince(since, after, limit) {
      const key = after ? { k: after.lastSwapAt, kid: after.id } : FIRST_PAGE;
      return (await request<{ Pool: PoolRec[] }>(POOLS_SINCE, { since, limit, ...key })).Pool;
    },
    async poolsCreatedSince(since, after, limit) {
      const key = after ? { k: after.createdAt, kid: after.id } : FIRST_PAGE;
      return (await request<{ Pool: PoolRec[] }>(POOLS_CREATED_SINCE, { since, limit, ...key })).Pool;
    },
    async swapsFor(poolIds, since, after, limit) {
      if (poolIds.length === 0) return [];
      const key = after ? { k: after.timestamp, kid: after.id } : FIRST_PAGE;
      return (await request<{ Swap: SwapRec[] }>(SWAPS_FOR, { pools: poolIds, since, limit, ...key })).Swap;
    },
    async candlesFor(poolIds, since, openIds, after, limit) {
      if (poolIds.length === 0) return { recent: [], open: [] };
      if (after === null) {
        const d = await request<{ recent: CandleRec[]; open: CandleRec[] }>(CANDLES_FIRST, { pools: poolIds, since, limit, openIds, ...FIRST_PAGE });
        return { recent: d.recent, open: d.open };
      }
      const d = await request<{ recent: CandleRec[] }>(CANDLES_NEXT, { pools: poolIds, since, limit, k: after.t, kid: after.id });
      return { recent: d.recent, open: [] };
    },
    async tokensById(ids) {
      if (ids.length === 0) return [];
      return (await request<{ Token: TokenRec[] }>(TOKENS_BY_ID, { ids })).Token;
    },
    async topHolders(tokenId, limit) {
      return (await request<{ TokenBalance: BalanceRec[] }>(TOP_HOLDERS, { token: tokenId, limit })).TokenBalance;
    },
    async chainMeta() {
      const d = await request<{ chain_metadata: ChainRow[] }>(CHAIN_META, {});
      const row = d.chain_metadata.find((c) => c.chain_id === CHAIN_ID);
      if (!row) throw new EnvioUnavailableError(`indexer has no chain_metadata row for chain ${CHAIN_ID}`);
      return { latestProcessedBlock: row.latest_processed_block, blockHeight: row.block_height };
    },
    tokensPage: (afterId, limit) => page<"Token", TokenRec>("Token", afterId, null, limit),
    poolsPage: (afterId, limit) => page<"Pool", PoolRec>("Pool", afterId, null, limit),
    swapsPage: (afterId, beforeId, limit) => page<"Swap", SwapRec>("Swap", afterId, beforeId, limit),
    candlesPage: (afterId, beforeId, limit) => page<"Candle", CandleRec>("Candle", afterId, beforeId, limit),
    balancesPage: (afterId, beforeId, limit) => page<"TokenBalance", BalanceRec>("TokenBalance", afterId, beforeId, limit),
  };
}
```

Run: `npx vitest run src/lib/sync/envioSource.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 8: Write the failing FakeSource test**

`src/lib/sync/fakeSource.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeSource } from "./fakeSource";
import type { BalanceRec, CandleRec, PoolRec, SwapRec, TokenRec } from "./source";

const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const P1 = id(1), P2 = id(2), P3 = id(3), P4 = id(4), P5 = id(5), P6 = id(6);
const pool = (o: Partial<PoolRec> & { id: string }): PoolRec => ({ token_id: "0xt", quote_id: "0xq", tokenIsCurrency0: true, hooks: "0x0", fee: 3000, tickSpacing: 60, origin: "LONG", createdAt: 0, priceQuote: "1", tvlToken: null, tvlQuote: null, swapCount: 1, lastSwapAt: 0, volumeQuoteAllTime: "0", ...o });
const swap = (o: Partial<SwapRec> & { id: string }): SwapRec => ({ pool_id: P1, token_id: "0xt", timestamp: 0, side: "buy", amountToken: "1", amountQuote: "1", priceQuote: "1", wallet: "0xw", txHash: "0xh", ...o });
const candle = (o: Partial<CandleRec> & { id: string }): CandleRec => ({ pool_id: P1, t: 0, open: "1", high: "1", low: "1", close: "1", volumeQuote: "0", volumeToken: "0", trades: 0, ...o });
const token = (o: Partial<TokenRec> & { id: string }): TokenRec => ({ address: o.id, symbol: "T", name: "T", decimals: 18, totalSupply: "0", holdersCount: 0, poolCount: 0, origin: "LONG", createdAt: 0, primaryPool_id: null, metadataLoaded: true, ...o });
const balance = (o: Partial<BalanceRec> & { id: string }): BalanceRec => ({ token_id: "0xt", holder: o.id, balance: "1", updatedAt: 0, ...o });
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

const S1 = `${id(11)}-0`, S2 = `${id(13)}-0`, S3 = `${id(12)}-0`, S4 = `${id(14)}-0`, S5 = `${id(10)}-0`;
const C1 = `${P1}-m1-100`, C2 = `${P1}-m1-200`, C3 = `${P2}-m1-200`, C4 = `${P1}-m1-50`, H1 = `${P1}-h1-0`;

function source() {
  return new FakeSource({
    pools: [
      pool({ id: P3, lastSwapAt: 200, createdAt: 30 }), pool({ id: P1, lastSwapAt: 100, createdAt: 10 }), pool({ id: P2, lastSwapAt: 200, createdAt: 20 }),
      pool({ id: P4, lastSwapAt: null, createdAt: 40 }), pool({ id: P5, lastSwapAt: null, createdAt: 5 }), pool({ id: P6, lastSwapAt: 50, createdAt: 1 }),
    ],
    swaps: [swap({ id: S1, timestamp: 10 }), swap({ id: S2, pool_id: P2, timestamp: 20 }), swap({ id: S3, timestamp: 20 }), swap({ id: S4, pool_id: P3, timestamp: 30 }), swap({ id: S5, timestamp: 5 })],
    candles: [candle({ id: C1, t: 100 }), candle({ id: C2, t: 200 }), candle({ id: C3, pool_id: P2, t: 200 }), candle({ id: C4, t: 50 }), candle({ id: H1, t: 0 })],
    tokens: [token({ id: "0xb" }), token({ id: "0xa" }), token({ id: "0xc" })],
    balances: [balance({ id: "0xh1", balance: "9" }), balance({ id: "0xh2", balance: "10" }), balance({ id: "0xh3", balance: "0" }), balance({ id: "0xh4", balance: "10" }), balance({ id: "0xh5", token_id: "0xother", balance: "99" })],
    chain: { latestProcessedBlock: 10, blockHeight: 12 },
  });
}

describe("FakeSource", () => {
  it("pages traded pools by (lastSwapAt, id) with a strict keyset", async () => {
    const s = source();
    expect(ids(await s.poolsSince(100, null, 10))).toEqual([P1, P2, P3]);
    expect(ids(await s.poolsSince(100, null, 2))).toEqual([P1, P2]);
    expect(ids(await s.poolsSince(100, { lastSwapAt: 200, id: P2 }, 10))).toEqual([P3]);
    expect(ids(await s.poolsSince(100, { lastSwapAt: 200, id: P3 }, 10))).toEqual([]);
  });
  it("pages never-traded pools by (createdAt, id)", async () => {
    const s = source();
    expect(ids(await s.poolsCreatedSince(5, null, 10))).toEqual([P5, P4]);
    expect(ids(await s.poolsCreatedSince(5, { createdAt: 5, id: P5 }, 10))).toEqual([P4]);
  });
  it("pages the swaps of the given pools by (timestamp, id)", async () => {
    const s = source();
    expect(ids(await s.swapsFor([P1, P2], 10, null, 10))).toEqual([S1, S3, S2]);
    expect(ids(await s.swapsFor([P1, P2], 10, { timestamp: 20, id: S3 }, 10))).toEqual([S2]);
    expect(ids(await s.swapsFor([P1, P2], 10, null, 1))).toEqual([S1]);
    expect(ids(await s.swapsFor([P3], 0, null, 10))).toEqual([S4]);
  });
  it("pages recent candles and returns the open buckets on the first page only", async () => {
    const s = source();
    const first = await s.candlesFor([P1], 100, [H1, `${P1}-d1-0`], null, 10);
    expect(ids(first.recent)).toEqual([C1, C2]);
    expect(ids(first.open)).toEqual([H1]);
    const next = await s.candlesFor([P1], 100, [H1], { t: 100, id: C1 }, 10);
    expect(ids(next.recent)).toEqual([C2]);
    expect(next.open).toEqual([]);
    expect(ids((await s.candlesFor([P1, P2], 200, [], null, 1)).recent)).toEqual([C2]);
  });
  it("looks up tokens, ranks holders as BigInt largest first, and reads chain metadata", async () => {
    const s = source();
    expect(ids(await s.tokensById(["0xa", "0xc", "0xz"]))).toEqual(["0xa", "0xc"]);
    expect(ids(await s.topHolders("0xt", 10))).toEqual(["0xh2", "0xh4", "0xh1"]);
    expect(ids(await s.topHolders("0xt", 2))).toEqual(["0xh2", "0xh4"]);
    expect(await s.chainMeta()).toEqual({ latestProcessedBlock: 10, blockHeight: 12 });
  });
  it("walks id ranges ascending, bounded by beforeId, balances only when non-zero", async () => {
    const s = source();
    expect(ids(await s.tokensPage("", 10))).toEqual(["0xa", "0xb", "0xc"]);
    expect(ids(await s.tokensPage("0xa", 1))).toEqual(["0xb"]);
    expect(ids(await s.poolsPage(P2, 10))).toEqual([P3, P4, P5, P6]);
    expect(ids(await s.swapsPage(S5, S4, 10))).toEqual([S1, S3, S2]);
    expect(ids(await s.swapsPage(S5, null, 10))).toEqual([S1, S3, S2, S4]);
    expect(ids(await s.candlesPage("", 2))).toEqual([H1, C1]); // "-h1-" sorts before "-m1-"
    expect(ids(await s.balancesPage("", 10))).toEqual(["0xh1", "0xh2", "0xh4", "0xh5"]);
    expect(ids(await s.balancesPage("0xh1", "0xh4", 10))).toEqual(["0xh2"]);
  });
  it("records calls, counts queries and throws an armed failure once", async () => {
    const s = source();
    await s.quotes();
    await s.tokensPage("", 1);
    s.failOn = { method: "quotes", error: new Error("boom") };
    await expect(s.quotes()).rejects.toThrow("boom");
    expect((await s.quotes()).quotes).toEqual([]);
    expect(s.calls).toEqual(["quotes", "tokensPage", "quotes", "quotes"]);
    expect(s.queries).toBe(4);
    expect(s.failOn).toBeNull();
  });
});
```

Run: `npx vitest run src/lib/sync/fakeSource.test.ts`
Expected: FAIL, "Failed to resolve import ./fakeSource".

- [ ] **Step 9: Write fakeSource.ts**

`src/lib/sync/fakeSource.ts`:

```ts
import type { BalanceRec, CandleCursor, CandleRec, CreatedCursor, EnvioSource, PoolCursor, PoolRec, QuotePriceRec, QuoteRec, SwapCursor, SwapRec, TokenRec } from "./source";

export type FakeData = {
  quotes?: QuoteRec[]; prices?: QuotePriceRec[]; pools?: PoolRec[]; tokens?: TokenRec[]; swaps?: SwapRec[];
  candles?: CandleRec[]; balances?: BalanceRec[]; chain?: { latestProcessedBlock: number; blockHeight: number };
};

type Keyed = { key: number; id: string };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Rows strictly after (key, id), ordered (key asc, id asc), at most limit. */
function keyset<T>(rows: readonly T[], key: (r: T) => number, id: (r: T) => string, after: Keyed | null, limit: number): T[] {
  return rows
    .filter((r) => after === null || key(r) > after.key || (key(r) === after.key && id(r) > after.id))
    .sort((a, b) => key(a) - key(b) || cmp(id(a), id(b)))
    .slice(0, limit);
}

/** Rows with afterId < id (< beforeId when given), ascending by id, at most limit. */
function idRange<T extends { id: string }>(rows: readonly T[], afterId: string, beforeId: string | null, limit: number): T[] {
  return rows
    .filter((r) => r.id > afterId && (beforeId === null || r.id < beforeId))
    .sort((a, b) => cmp(a.id, b.id))
    .slice(0, limit);
}

const nonZero = (b: BalanceRec) => BigInt(b.balance) > 0n;

/** In-memory EnvioSource applying exactly the filters, orderings and keysets documented on the interface. `calls` records method names in order; `failOn` makes the named method throw the given error on its next call. */
export class FakeSource implements EnvioSource {
  readonly data: Required<FakeData>;
  readonly calls: string[] = [];
  queries = 0;
  failOn: { method: keyof EnvioSource; error: Error } | null = null;

  constructor(data: FakeData) {
    this.data = {
      quotes: data.quotes ?? [], prices: data.prices ?? [], pools: data.pools ?? [], tokens: data.tokens ?? [], swaps: data.swaps ?? [],
      candles: data.candles ?? [], balances: data.balances ?? [], chain: data.chain ?? { latestProcessedBlock: 0, blockHeight: 0 },
    };
  }

  /** Records the call and counts the request before an armed failure fires, as a real request would. */
  private hit(method: keyof EnvioSource): void {
    this.calls.push(method);
    this.queries += 1;
    if (this.failOn?.method === method) {
      const { error } = this.failOn;
      this.failOn = null;
      throw error;
    }
  }

  async quotes() {
    this.hit("quotes");
    return { quotes: [...this.data.quotes], prices: [...this.data.prices] };
  }
  async poolsSince(since: number, after: PoolCursor | null, limit: number) {
    this.hit("poolsSince");
    const rows = this.data.pools.filter((p) => p.lastSwapAt !== null && p.lastSwapAt >= since);
    return keyset(rows, (p) => p.lastSwapAt ?? 0, (p) => p.id, after && { key: after.lastSwapAt, id: after.id }, limit);
  }
  async poolsCreatedSince(since: number, after: CreatedCursor | null, limit: number) {
    this.hit("poolsCreatedSince");
    const rows = this.data.pools.filter((p) => p.lastSwapAt === null && p.createdAt >= since);
    return keyset(rows, (p) => p.createdAt, (p) => p.id, after && { key: after.createdAt, id: after.id }, limit);
  }
  async swapsFor(poolIds: readonly string[], since: number, after: SwapCursor | null, limit: number) {
    this.hit("swapsFor");
    const pools = new Set(poolIds);
    const rows = this.data.swaps.filter((s) => pools.has(s.pool_id) && s.timestamp >= since);
    return keyset(rows, (s) => s.timestamp, (s) => s.id, after && { key: after.timestamp, id: after.id }, limit);
  }
  async candlesFor(poolIds: readonly string[], since: number, openIds: readonly string[], after: CandleCursor | null, limit: number) {
    this.hit("candlesFor");
    const pools = new Set(poolIds);
    const open = new Set(openIds);
    const rows = this.data.candles.filter((c) => pools.has(c.pool_id) && c.t >= since);
    return {
      recent: keyset(rows, (c) => c.t, (c) => c.id, after && { key: after.t, id: after.id }, limit),
      open: after === null ? this.data.candles.filter((c) => open.has(c.id)) : [],
    };
  }
  async tokensById(ids: readonly string[]) {
    this.hit("tokensById");
    const wanted = new Set(ids);
    return this.data.tokens.filter((t) => wanted.has(t.id));
  }
  async topHolders(tokenId: string, limit: number) {
    this.hit("topHolders");
    return this.data.balances
      .filter((b) => b.token_id === tokenId && nonZero(b))
      .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : BigInt(b.balance) < BigInt(a.balance) ? -1 : cmp(a.holder, b.holder)))
      .slice(0, limit);
  }
  async chainMeta() {
    this.hit("chainMeta");
    return { ...this.data.chain };
  }
  async tokensPage(afterId: string, limit: number) {
    this.hit("tokensPage");
    return idRange(this.data.tokens, afterId, null, limit);
  }
  async poolsPage(afterId: string, limit: number) {
    this.hit("poolsPage");
    return idRange(this.data.pools, afterId, null, limit);
  }
  async swapsPage(afterId: string, beforeId: string | null, limit: number) {
    this.hit("swapsPage");
    return idRange(this.data.swaps, afterId, beforeId, limit);
  }
  async candlesPage(afterId: string, beforeId: string | null, limit: number) {
    this.hit("candlesPage");
    return idRange(this.data.candles, afterId, beforeId, limit);
  }
  async balancesPage(afterId: string, beforeId: string | null, limit: number) {
    this.hit("balancesPage");
    return idRange(this.data.balances.filter(nonZero), afterId, beforeId, limit);
  }
}
```

Run: `npx vitest run src/lib/sync`
Expected: PASS (limiter 6, ids 5, envioSource 9, fakeSource 7 tests).

- [ ] **Step 10: Run the gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green. `grep -rn "interval" src/lib/sync/envioSource.ts` matches nothing: no document selects or filters `Candle.interval`.

- [ ] **Step 11: Commit**

```bash
git add src/lib/sync/limiter.ts src/lib/sync/limiter.test.ts src/lib/sync/ids.ts src/lib/sync/ids.test.ts src/lib/sync/source.ts src/lib/sync/envioSource.ts src/lib/sync/envioSource.test.ts src/lib/sync/fakeSource.ts src/lib/sync/fakeSource.test.ts
git commit -m "Add the EnvioSource boundary: rate limiter, retry, id parsing, the real source and the in-memory fake" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

---

### Task 3: SQL writers

**Files:**
- Create: `src/lib/sync/writers.ts`, `src/lib/sync/testRows.ts` (fixture row builders shared by the sync tests; not a test file, so Vitest does not collect it)
- Test: `src/lib/sync/writers.test.ts`

**Interfaces:**
- Consumes: `Db` from `src/lib/db/client.ts` (`query<T>(text, params)`, `exec(text)`, `tx(fn)`, `end()`); `testDb(): Promise<Db>` from `src/test/db.ts`; `parseCandleId(id)`, `parseSwapId(id)`, `candleId(poolId, interval, bucket)`, `bucketStart(ts, interval)`, `IndexerInterval` from `src/lib/sync/ids.ts`; the record types `QuoteRec`, `QuotePriceRec`, `PoolRec`, `TokenRec`, `SwapRec`, `CandleRec`, `BalanceRec` from `src/lib/sync/source.ts`.
- Produces: `upsertQuotes(db, quotes, prices)`, `upsertPools(db, pools, syncedAt)`, `upsertTokens(db, tokens, syncedAt)`, `insertSwaps(db, swaps)`, `upsertCandles(db, candles)`, `replaceHolders(db, tokenId, balances, refreshedAt)`, `recomputeListedPools(db, tokenIds | "all")`, all `Promise<number>`, exactly as in the contract; from `testRows.ts`: `hex(n, digits)`, `addr(n)`, `poolId(n)`, `txHash(n)`, the constants `T0`, `QUOTE`, `TOKEN_A`, `TOKEN_B`, `POOL_A`, `POOL_B`, `WALLET`, and the builders `quoteRec(o?)`, `priceRec(o?)`, `poolRec(o?)`, `tokenRec(o?)`, `swapRec(o?)`, `candleRec(o?)`, `balanceRec(o?)`, each taking a `Partial<…Rec>` of overrides.

Decisions where the contract is silent: booleans travel as the text `"true"`/`"false"` in a `text[]` and are cast per element (`enabled::boolean`), because the porsager driver infers the scalar `bool` type for a plain boolean array and serialises the whole array as one `f`; numbers and strings infer no type, so the server resolves them from the `::type[]` casts. Every upsert deduplicates its input by key (last row wins) because `on conflict do update` rejects a statement that touches one row twice, and the market cycle merges a candle batch's `recent` and `open` lists, which overlap. `recomputeListedPools` counts through `with u as (update … returning 1) select count(*)` so the nightly `"all"` run does not stream 130k ids back.

- [ ] **Step 1: Write the fixture builders**

`src/lib/sync/testRows.ts`:
```ts
import { bucketStart, candleId, type IndexerInterval } from "./ids";
import type { BalanceRec, CandleRec, PoolRec, QuotePriceRec, QuoteRec, SwapRec, TokenRec } from "./source";

/** Rows in the shape FakeSource serves and the writers consume. Ids are lowercase like the indexer's. */
export const hex = (n: number, digits: number) => "0x" + n.toString(16).padStart(digits, "0");
export const addr = (n: number) => hex(n, 40);
export const poolId = (n: number) => hex(n, 64);
export const txHash = (n: number) => hex(n, 64);

export const T0 = 1_789_000_000;
export const QUOTE = addr(0xa1);
export const TOKEN_A = addr(0xb1);
export const TOKEN_B = addr(0xb2);
export const POOL_A = poolId(0x11);
export const POOL_B = poolId(0x12);
export const WALLET = addr(0xc1);

export function quoteRec(o: Partial<QuoteRec> = {}): QuoteRec {
  return { id: QUOTE, address: QUOTE, symbol: "NVDA", name: "NVIDIA", decimals: 18, enabled: true, ...o };
}
export function priceRec(o: Partial<QuotePriceRec> = {}): QuotePriceRec {
  return { id: QUOTE, usdPrice: "182.5", updatedAt: T0, aggregator: addr(0xfeed), ...o };
}
export function poolRec(o: Partial<PoolRec> = {}): PoolRec {
  return {
    id: POOL_A, token_id: TOKEN_A, quote_id: QUOTE, tokenIsCurrency0: true, hooks: addr(0), fee: 3000, tickSpacing: 60,
    origin: "LONG", createdAt: T0, priceQuote: "0.000866", tvlToken: "1000000000000000000000", tvlQuote: "500000000000000000",
    swapCount: 3, lastSwapAt: T0 + 500, volumeQuoteAllTime: "12.5", ...o,
  };
}
export function tokenRec(o: Partial<TokenRec> = {}): TokenRec {
  return {
    id: TOKEN_A, address: TOKEN_A, symbol: "AI", name: "Artificial Inu", decimals: 18, totalSupply: "1000000000000000000000000000",
    holdersCount: 42, poolCount: 1, origin: "LONG", createdAt: T0, primaryPool_id: POOL_A, metadataLoaded: true, ...o,
  };
}
export function swapRec(o: Partial<SwapRec> = {}): SwapRec {
  const tx = o.txHash ?? txHash(1);
  return {
    id: `${tx}-0`, pool_id: POOL_A, token_id: TOKEN_A, timestamp: T0 + 500, side: "buy", amountToken: "1000", amountQuote: "0.866",
    priceQuote: "0.000866", wallet: WALLET, txHash: tx, ...o,
  };
}
/** The id is derived from pool, interval and t unless overridden, so it always parses. */
export function candleRec(o: Partial<CandleRec> & { interval?: IndexerInterval } = {}): CandleRec {
  const { interval = "m1", ...rest } = o;
  const pool = rest.pool_id ?? POOL_A;
  const t = rest.t ?? bucketStart(T0 + 500, interval);
  return {
    id: candleId(pool, interval, t), pool_id: pool, t, open: "0.0008", high: "0.0009", low: "0.0007", close: "0.000866",
    volumeQuote: "1.2", volumeToken: "1500", trades: 2, ...rest,
  };
}
export function balanceRec(o: Partial<BalanceRec> = {}): BalanceRec {
  const holder = o.holder ?? WALLET;
  const token = o.token_id ?? TOKEN_A;
  return { id: `${token}-${holder}`, token_id: token, holder, balance: "5000000000000000000", updatedAt: T0 + 400, ...o };
}
```

- [ ] **Step 2: Write the failing tests**

`src/lib/sync/writers.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { POOL_A, QUOTE, T0, TOKEN_A, TOKEN_B, addr, balanceRec, candleRec, poolId, poolRec, priceRec, quoteRec, swapRec, tokenRec, txHash } from "./testRows";
import { insertSwaps, recomputeListedPools, replaceHolders, upsertCandles, upsertPools, upsertQuotes, upsertTokens } from "./writers";

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
beforeEach(() => db.exec(
  "delete from market.quotes; delete from market.tokens; delete from market.pools; delete from market.swaps; delete from market.candles; delete from market.token_balances; delete from market.holder_refresh",
));

const count = async (table: string) => Number((await db.query<{ n: unknown }>(`select count(*) as n from market.${table}`))[0].n);

describe("upsertQuotes", () => {
  it("writes quotes, leaves prices null without a price row and fills them when one exists", async () => {
    const gld = addr(0xa2);
    expect(await upsertQuotes(db, [quoteRec(), quoteRec({ id: gld, address: gld, symbol: "GLD" })], [priceRec()])).toBe(2);
    const rows = await db.query("select id, usd_price, usd_updated_at, aggregator, enabled from market.quotes order by id");
    expect(rows).toEqual([
      { id: QUOTE, usd_price: 182.5, usd_updated_at: T0, aggregator: addr(0xfeed), enabled: true },
      { id: gld, usd_price: null, usd_updated_at: null, aggregator: null, enabled: true },
    ]);
  });
  it("is idempotent", async () => {
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    expect(await upsertQuotes(db, [quoteRec()], [priceRec({ usdPrice: "183" })])).toBe(1);
    expect(await db.query("select usd_price from market.quotes")).toEqual([{ usd_price: 183 }]);
    expect(await count("quotes")).toBe(1);
  });
});

describe("upsertPools", () => {
  it("converts Envio's numeric strings: doubles for prices, numeric(78,0) read back as the same string", async () => {
    expect(await upsertPools(db, [poolRec()], T0 + 1000)).toBe(1);
    const rows = await db.query("select price_quote, tvl_token, last_swap_at, token_is_currency0, synced_at from market.pools where id = $1", [POOL_A]);
    expect(rows).toEqual([{ price_quote: 0.000866, tvl_token: "1000000000000000000000", last_swap_at: T0 + 500, token_is_currency0: true, synced_at: T0 + 1000 }]);
  });
  it("updates in place, including a value that became null", async () => {
    await upsertPools(db, [poolRec()], T0);
    await upsertPools(db, [poolRec({ swapCount: 9, lastSwapAt: T0 + 900, tvlToken: null })], T0 + 1);
    expect(await db.query("select swap_count, last_swap_at, tvl_token from market.pools")).toEqual([{ swap_count: 9, last_swap_at: T0 + 900, tvl_token: null }]);
    expect(await count("pools")).toBe(1);
  });
});

describe("upsertTokens", () => {
  it("stores total_supply exactly and never touches listed_pool_id", async () => {
    await upsertTokens(db, [tokenRec()], T0);
    await db.query("update market.tokens set listed_pool_id = $1", [POOL_A]);
    expect(await upsertTokens(db, [tokenRec({ holdersCount: 43 })], T0 + 1)).toBe(1);
    expect(await db.query("select total_supply, holders_count, listed_pool_id, metadata_loaded from market.tokens")).toEqual([
      { total_supply: "1000000000000000000000000000", holders_count: 43, listed_pool_id: POOL_A, metadata_loaded: true },
    ]);
    expect(await count("tokens")).toBe(1);
  });
});

describe("insertSwaps", () => {
  it("splits the id, ignores duplicates and reports only what was inserted", async () => {
    const b = swapRec({ txHash: txHash(2), id: `${txHash(2)}-7`, timestamp: T0 + 600 });
    expect(await insertSwaps(db, [swapRec(), b])).toBe(2);
    expect(await insertSwaps(db, [b, swapRec({ txHash: txHash(3) })])).toBe(1);
    expect(await db.query("select tx_hash, log_index, amount_token from market.swaps order by tx_hash, log_index")).toEqual([
      { tx_hash: txHash(1), log_index: 0, amount_token: 1000 },
      { tx_hash: txHash(2), log_index: 7, amount_token: 1000 },
      { tx_hash: txHash(3), log_index: 0, amount_token: 1000 },
    ]);
  });
  it("rejects a malformed id", async () => {
    await expect(insertSwaps(db, [swapRec({ id: "nope" })])).rejects.toThrow("bad swap id nope");
  });
});

describe("upsertCandles", () => {
  it("parses the interval from the id and upserts on (pool_id, interval, t), last duplicate winning", async () => {
    const m1 = candleRec();
    const h1 = candleRec({ interval: "h1" });
    expect(await upsertCandles(db, [m1, h1, { ...m1, close: "0.001", trades: 5 }])).toBe(2);
    expect(await db.query("select interval, t, close, trades from market.candles order by interval, t")).toEqual([
      { interval: "h1", t: h1.t, close: 0.000866, trades: 2 },
      { interval: "m1", t: m1.t, close: 0.001, trades: 5 },
    ]);
    expect(await upsertCandles(db, [m1, h1])).toBe(2);
    expect(await count("candles")).toBe(2);
  });
  it("throws on a malformed id", async () => {
    await expect(upsertCandles(db, [candleRec({ id: `${POOL_A}-h2-100` })])).rejects.toThrow(`bad candle id ${POOL_A}-h2-100`);
  });
});

describe("replaceHolders", () => {
  it("replaces one token's rows, drops zero balances and stamps holder_refresh", async () => {
    await replaceHolders(db, TOKEN_A, [balanceRec(), balanceRec({ holder: addr(0xc2), balance: "7" })], T0);
    await replaceHolders(db, TOKEN_B, [balanceRec({ token_id: TOKEN_B, holder: addr(0xc9) })], T0);
    expect(await replaceHolders(db, TOKEN_A, [balanceRec({ holder: addr(0xc3), balance: "9" }), balanceRec({ holder: addr(0xc4), balance: "0" })], T0 + 300)).toBe(1);
    expect(await db.query("select token_id, holder, balance from market.token_balances order by token_id, holder")).toEqual([
      { token_id: TOKEN_A, holder: addr(0xc3), balance: "9" },
      { token_id: TOKEN_B, holder: addr(0xc9), balance: "5000000000000000000" },
    ]);
    expect(await db.query("select refreshed_at from market.holder_refresh where token_id = $1", [TOKEN_A])).toEqual([{ refreshed_at: T0 + 300 }]);
  });
  it("keeps the old rows and stamp when the transaction fails after the delete", async () => {
    await replaceHolders(db, TOKEN_A, [balanceRec()], T0);
    // 80 digits overflow numeric(78,0) inside the transaction, after the delete has run.
    await expect(replaceHolders(db, TOKEN_A, [balanceRec({ balance: "1".repeat(80) })], T0 + 300)).rejects.toThrow();
    expect(await db.query("select holder from market.token_balances")).toEqual([{ holder: balanceRec().holder }]);
    expect(await db.query("select refreshed_at from market.holder_refresh")).toEqual([{ refreshed_at: T0 }]);
  });
});

describe("recomputeListedPools", () => {
  const seed = async () => {
    await upsertTokens(db, [tokenRec(), tokenRec({ id: TOKEN_B, address: TOKEN_B, primaryPool_id: poolId(0x12) })], T0);
    await upsertPools(db, [
      poolRec(),                                                                                   // A's primary: sane and traded
      poolRec({ id: poolId(0x12), token_id: TOKEN_B, priceQuote: "3.4e50", swapCount: 100 }),      // B's primary: parked at a tick boundary
      poolRec({ id: poolId(0x13), token_id: TOKEN_B, swapCount: 5 }),
      poolRec({ id: poolId(0x14), token_id: TOKEN_B, swapCount: 8 }),                              // the sane pool with the most swaps
    ], T0);
  };
  const listed = async () =>
    Object.fromEntries((await db.query<{ id: string; listed_pool_id: string | null }>("select id, listed_pool_id from market.tokens")).map((r) => [r.id, r.listed_pool_id]));

  it("takes the primary when it is sane and traded, else the sane traded pool with the most swaps", async () => {
    await seed();
    expect(await recomputeListedPools(db, [TOKEN_A, TOKEN_B])).toBe(2);
    expect(await listed()).toEqual({ [TOKEN_A]: POOL_A, [TOKEN_B]: poolId(0x14) });
  });
  it("sets null when no sane traded pool exists", async () => {
    await seed();
    await db.query("update market.pools set swap_count = 0 where token_id = $1", [TOKEN_B]);
    expect(await recomputeListedPools(db, [TOKEN_B])).toBe(1);
    expect((await listed())[TOKEN_B]).toBeNull();
  });
  it('"all" touches every token and an empty list touches none', async () => {
    await seed();
    expect(await recomputeListedPools(db, "all")).toBe(2);
    expect(await listed()).toEqual({ [TOKEN_A]: POOL_A, [TOKEN_B]: poolId(0x14) });
    expect(await recomputeListedPools(db, [])).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/sync/writers.test.ts`
Expected: FAIL, `Failed to resolve import "./writers"` (the fixture module resolves; the writers do not exist).

- [ ] **Step 4: Write the writers**

`src/lib/sync/writers.ts`:
```ts
import type { Db } from "@/lib/db/client";
import { parseCandleId, parseSwapId } from "./ids";
import type { BalanceRec, CandleRec, PoolRec, QuotePriceRec, QuoteRec, SwapRec, TokenRec } from "./source";

/** Rows per statement. Each column is one array parameter, so a chunk bounds the statement's size, not its parameter count. */
const CHUNK = 1000;

function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

/** Last occurrence wins: `on conflict do update` rejects a statement that touches one row twice. */
function dedupe<T>(rows: readonly T[], key: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r);
  return [...m.values()];
}

/**
 * Booleans travel as text and are cast per element in the SELECT list: the porsager driver infers the scalar
 * bool type for a plain boolean array and serialises the whole array as one "f". Strings and numbers infer no
 * type, so the server resolves them from the `::type[]` casts. Both drivers accept a plain JS array for those.
 */
const bool = (b: boolean) => (b ? "true" : "false");

export async function upsertQuotes(db: Db, quotes: readonly QuoteRec[], prices: readonly QuotePriceRec[]): Promise<number> {
  const rows = dedupe(quotes, (q) => q.id);
  for (const c of chunks(rows)) {
    await db.query(
      `insert into market.quotes (id, address, symbol, name, decimals, enabled)
       select id, address, symbol, name, decimals, enabled::boolean
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[]) as u(id, address, symbol, name, decimals, enabled)
       on conflict (id) do update set address = excluded.address, symbol = excluded.symbol, name = excluded.name,
         decimals = excluded.decimals, enabled = excluded.enabled`,
      [c.map((q) => q.id), c.map((q) => q.address), c.map((q) => q.symbol), c.map((q) => q.name), c.map((q) => q.decimals), c.map((q) => bool(q.enabled))],
    );
  }
  // The price columns are only ever written here: a quote without a QuotePrice row keeps what it has (null at first).
  for (const c of chunks(dedupe(prices, (p) => p.id))) {
    await db.query(
      `update market.quotes q set usd_price = p.usd_price, usd_updated_at = p.usd_updated_at, aggregator = p.aggregator
       from unnest($1::text[], $2::float8[], $3::int[], $4::text[]) as p(id, usd_price, usd_updated_at, aggregator)
       where q.id = p.id`,
      [c.map((p) => p.id), c.map((p) => Number(p.usdPrice)), c.map((p) => p.updatedAt), c.map((p) => p.aggregator)],
    );
  }
  return rows.length;
}

export async function upsertPools(db: Db, pools: readonly PoolRec[], syncedAt: number): Promise<number> {
  const rows = dedupe(pools, (p) => p.id);
  for (const c of chunks(rows)) {
    await db.query(
      `insert into market.pools (id, token_id, quote_id, token_is_currency0, hooks, fee, tick_spacing, origin, created_at,
         price_quote, tvl_token, tvl_quote, swap_count, last_swap_at, volume_quote_all_time, synced_at)
       select id, token_id, quote_id, token_is_currency0::boolean, hooks, fee, tick_spacing, origin, created_at,
         price_quote, tvl_token, tvl_quote, swap_count, last_swap_at, volume_quote_all_time, $16::int
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::text[], $9::int[],
         $10::float8[], $11::numeric[], $12::numeric[], $13::int[], $14::int[], $15::float8[])
         as u(id, token_id, quote_id, token_is_currency0, hooks, fee, tick_spacing, origin, created_at,
           price_quote, tvl_token, tvl_quote, swap_count, last_swap_at, volume_quote_all_time)
       on conflict (id) do update set token_id = excluded.token_id, quote_id = excluded.quote_id,
         token_is_currency0 = excluded.token_is_currency0, hooks = excluded.hooks, fee = excluded.fee,
         tick_spacing = excluded.tick_spacing, origin = excluded.origin, created_at = excluded.created_at,
         price_quote = excluded.price_quote, tvl_token = excluded.tvl_token, tvl_quote = excluded.tvl_quote,
         swap_count = excluded.swap_count, last_swap_at = excluded.last_swap_at,
         volume_quote_all_time = excluded.volume_quote_all_time, synced_at = excluded.synced_at`,
      [
        c.map((p) => p.id), c.map((p) => p.token_id), c.map((p) => p.quote_id), c.map((p) => bool(p.tokenIsCurrency0)),
        c.map((p) => p.hooks), c.map((p) => p.fee), c.map((p) => p.tickSpacing), c.map((p) => p.origin), c.map((p) => p.createdAt),
        c.map((p) => Number(p.priceQuote)), c.map((p) => p.tvlToken), c.map((p) => p.tvlQuote), c.map((p) => p.swapCount),
        c.map((p) => p.lastSwapAt), c.map((p) => Number(p.volumeQuoteAllTime)), syncedAt,
      ],
    );
  }
  return rows.length;
}

/** `listed_pool_id` is deliberately absent: it belongs to recomputeListedPools and survives every upsert. */
export async function upsertTokens(db: Db, tokens: readonly TokenRec[], syncedAt: number): Promise<number> {
  const rows = dedupe(tokens, (t) => t.id);
  for (const c of chunks(rows)) {
    await db.query(
      `insert into market.tokens (id, address, symbol, name, decimals, total_supply, holders_count, pool_count, origin,
         primary_pool_id, created_at, metadata_loaded, synced_at)
       select id, address, symbol, name, decimals, total_supply, holders_count, pool_count, origin,
         primary_pool_id, created_at, metadata_loaded::boolean, $13::int
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::numeric[], $7::int[], $8::int[], $9::text[],
         $10::text[], $11::int[], $12::text[])
         as u(id, address, symbol, name, decimals, total_supply, holders_count, pool_count, origin, primary_pool_id, created_at, metadata_loaded)
       on conflict (id) do update set address = excluded.address, symbol = excluded.symbol, name = excluded.name,
         decimals = excluded.decimals, total_supply = excluded.total_supply, holders_count = excluded.holders_count,
         pool_count = excluded.pool_count, origin = excluded.origin, primary_pool_id = excluded.primary_pool_id,
         created_at = excluded.created_at, metadata_loaded = excluded.metadata_loaded, synced_at = excluded.synced_at`,
      [
        c.map((t) => t.id), c.map((t) => t.address), c.map((t) => t.symbol), c.map((t) => t.name), c.map((t) => t.decimals),
        c.map((t) => t.totalSupply), c.map((t) => t.holdersCount), c.map((t) => t.poolCount), c.map((t) => t.origin),
        c.map((t) => t.primaryPool_id), c.map((t) => t.createdAt), c.map((t) => bool(t.metadataLoaded)), syncedAt,
      ],
    );
  }
  return rows.length;
}

export async function insertSwaps(db: Db, swaps: readonly SwapRec[]): Promise<number> {
  let inserted = 0;
  for (const c of chunks(swaps)) {
    const keys = c.map((s) => parseSwapId(s.id));
    const rows = await db.query<{ tx_hash: string }>(
      `insert into market.swaps (tx_hash, log_index, pool_id, token_id, ts, side, amount_token, amount_quote, price_quote, wallet)
       select * from unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::int[], $6::text[], $7::float8[], $8::float8[], $9::float8[], $10::text[])
         as u(tx_hash, log_index, pool_id, token_id, ts, side, amount_token, amount_quote, price_quote, wallet)
       on conflict (tx_hash, log_index) do nothing
       returning tx_hash`,
      [
        keys.map((k) => k.txHash), keys.map((k) => k.logIndex), c.map((s) => s.pool_id), c.map((s) => s.token_id), c.map((s) => s.timestamp),
        c.map((s) => s.side), c.map((s) => Number(s.amountToken)), c.map((s) => Number(s.amountQuote)), c.map((s) => Number(s.priceQuote)), c.map((s) => s.wallet),
      ],
    );
    inserted += rows.length;
  }
  return inserted;
}

export async function upsertCandles(db: Db, candles: readonly CandleRec[]): Promise<number> {
  const rows = dedupe(candles, (c) => c.id).map((c) => ({ ...c, interval: parseCandleId(c.id).interval }));
  for (const c of chunks(rows)) {
    await db.query(
      `insert into market.candles (pool_id, interval, t, open, high, low, close, volume_quote, volume_token, trades)
       select * from unnest($1::text[], $2::text[], $3::int[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[], $9::float8[], $10::int[])
         as u(pool_id, interval, t, open, high, low, close, volume_quote, volume_token, trades)
       on conflict (pool_id, interval, t) do update set open = excluded.open, high = excluded.high, low = excluded.low,
         close = excluded.close, volume_quote = excluded.volume_quote, volume_token = excluded.volume_token, trades = excluded.trades`,
      [
        c.map((x) => x.pool_id), c.map((x) => x.interval), c.map((x) => x.t), c.map((x) => Number(x.open)), c.map((x) => Number(x.high)),
        c.map((x) => Number(x.low)), c.map((x) => Number(x.close)), c.map((x) => Number(x.volumeQuote)), c.map((x) => Number(x.volumeToken)), c.map((x) => x.trades),
      ],
    );
  }
  return rows.length;
}

export async function replaceHolders(db: Db, tokenId: string, balances: readonly BalanceRec[], refreshedAt: number): Promise<number> {
  const rows = dedupe(balances.filter((b) => BigInt(b.balance) > 0n), (b) => b.holder);
  return db.tx(async (t) => {
    await t.query("delete from market.token_balances where token_id = $1", [tokenId]);
    for (const c of chunks(rows)) {
      await t.query(
        `insert into market.token_balances (token_id, holder, balance, updated_at)
         select $1::text, holder, balance, updated_at from unnest($2::text[], $3::numeric[], $4::int[]) as u(holder, balance, updated_at)`,
        [tokenId, c.map((b) => b.holder), c.map((b) => b.balance), c.map((b) => b.updatedAt)],
      );
    }
    await t.query(
      `insert into market.holder_refresh (token_id, refreshed_at) values ($1, $2)
       on conflict (token_id) do update set refreshed_at = excluded.refreshed_at`,
      [tokenId, refreshedAt],
    );
    return rows.length;
  });
}

/** Spec section 6: the primary pool when sane and traded, else the sane traded pool with the most swaps, else null. */
const LISTED_POOL = `coalesce(
  (select p.id from market.pools p where p.id = t.primary_pool_id and p.swap_count > 0 and p.price_quote > 1e-24 and p.price_quote < 1e18),
  (select p.id from market.pools p where p.token_id = t.id and p.swap_count > 0 and p.price_quote > 1e-24 and p.price_quote < 1e18
     order by p.swap_count desc, p.last_swap_at desc nulls last, p.id limit 1))`;

export async function recomputeListedPools(db: Db, tokenIds: readonly string[] | "all"): Promise<number> {
  if (tokenIds !== "all" && tokenIds.length === 0) return 0;
  const where = tokenIds === "all" ? "" : "where t.id = any($1::text[])";
  const params = tokenIds === "all" ? [] : [[...tokenIds]];
  const [row] = await db.query<{ n: unknown }>(
    `with u as (update market.tokens t set listed_pool_id = ${LISTED_POOL} ${where} returning 1) select count(*) as n from u`,
    params,
  );
  return Number(row.n);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/sync/writers.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Run the gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/sync/writers.ts src/lib/sync/writers.test.ts src/lib/sync/testRows.ts
git commit -m "Add the SQL writers for the market store" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

### Task 4: State, lease and the market cycle

**Files:**
- Create: `src/lib/sync/state.ts`, `src/lib/sync/market.ts`
- Test: `src/lib/sync/state.test.ts`, `src/lib/sync/market.test.ts`

**Interfaces:**
- Consumes: `Db` and `testDb()` (Task 1); `EnvioSource`, the cursor types `PoolCursor`, `CreatedCursor`, `SwapCursor`, `CandleCursor`, `PoolRec`, and `FakeSource` (`new FakeSource(data)`, `.calls`, `.queries`, `.failOn`) (Task 2); `openBucketIds(poolIds, since, now)` from `src/lib/sync/ids.ts`; every writer from Task 3; the builders from `src/lib/sync/testRows.ts`.
- Produces: `SyncJob`, `SyncState`, `readState(db, job)`, `acquireLease(db, job, owner, now, ttlSec): Promise<boolean>`, `releaseLease(db, job, owner)`, `saveCursors(db, job, patch)`, `finishRun(db, job, { now, ok, error?, rows, queries })` from `state.ts`; `OVERLAP_SEC`, `CANDLE_LOOKBACK_SEC`, `PAGE_LIMIT`, `POOL_BATCH`, `TOKEN_BATCH`, `CycleOpts`, `CycleResult`, `runMarketCycle(db, source, opts): Promise<CycleResult>` from `market.ts`, exactly as in the contract.

Decisions where the contract is silent: every state function first runs the insert-ignore that creates the default row, so each is safe to call on a fresh database; `since` is clamped at 0 (`Math.max(0, cursor − OVERLAP_SEC)`); the budget and deadline are checked before every Envio request and never after one, so a cycle never issues the request that would exceed them; a page's pools are upserted before its swaps and candles, so a cycle that runs out of budget mid-page leaves those pool rows behind (idempotent, re-written when the page repeats) and the cursor untouched.

- [ ] **Step 1: Write the failing state tests**

`src/lib/sync/state.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { acquireLease, finishRun, readState, releaseLease, saveCursors } from "./state";

const NOW = 1_789_000_000;
let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
beforeEach(() => db.exec("delete from market.sync_state"));

describe("sync_state", () => {
  it("returns the default row on first read", async () => {
    expect(await readState(db, "market")).toEqual({
      job: "market", cursor: 0, cursor2: 0, cursorText: "", phase: "", lastRunAt: null, lastOkAt: null, lastError: null,
      rowsWritten: 0, queriesUsed: 0, leaseUntil: 0, leaseOwner: null,
    });
  });
  it("gives the lease to one owner at a time and frees it once lease_until has passed", async () => {
    expect(await acquireLease(db, "market", "a", NOW, 120)).toBe(true);
    expect(await acquireLease(db, "market", "b", NOW + 60, 120)).toBe(false);
    expect(await readState(db, "market")).toMatchObject({ leaseOwner: "a", leaseUntil: NOW + 120 });
    expect(await acquireLease(db, "market", "b", NOW + 121, 120)).toBe(true);
    expect(await readState(db, "market")).toMatchObject({ leaseOwner: "b", leaseUntil: NOW + 241 });
  });
  it("is released only by its owner", async () => {
    await acquireLease(db, "market", "a", NOW, 120);
    await releaseLease(db, "market", "b");
    expect((await readState(db, "market")).leaseOwner).toBe("a");
    await releaseLease(db, "market", "a");
    expect(await readState(db, "market")).toMatchObject({ leaseOwner: null, leaseUntil: 0 });
    expect(await acquireLease(db, "market", "b", NOW, 120)).toBe(true);
  });
  it("saves a partial cursor patch", async () => {
    await saveCursors(db, "nightly", { cursor: 5, phase: "tokens" });
    await saveCursors(db, "nightly", { cursorText: "0xabc" });
    await saveCursors(db, "nightly", {});
    expect(await readState(db, "nightly")).toMatchObject({ cursor: 5, cursor2: 0, cursorText: "0xabc", phase: "tokens" });
  });
  it("records ok and failed runs and accumulates the counters", async () => {
    await finishRun(db, "market", { now: NOW, ok: true, rows: 10, queries: 3 });
    expect(await readState(db, "market")).toMatchObject({ lastRunAt: NOW, lastOkAt: NOW, lastError: null, rowsWritten: 10, queriesUsed: 3 });
    await finishRun(db, "market", { now: NOW + 30, ok: false, error: "indexer responded 429", rows: 2, queries: 1 });
    expect(await readState(db, "market")).toMatchObject({ lastRunAt: NOW + 30, lastOkAt: NOW, lastError: "indexer responded 429", rowsWritten: 12, queriesUsed: 4 });
    await finishRun(db, "market", { now: NOW + 60, ok: true, rows: 0, queries: 0 });
    expect(await readState(db, "market")).toMatchObject({ lastOkAt: NOW + 60, lastError: null });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/sync/state.test.ts`
Expected: FAIL, `Failed to resolve import "./state"`.

- [ ] **Step 3: Write the state module**

`src/lib/sync/state.ts`:
```ts
import type { Db } from "@/lib/db/client";

export type SyncJob = "market" | "nightly";
export type SyncState = {
  job: SyncJob; cursor: number; cursor2: number; cursorText: string; phase: string;
  lastRunAt: number | null; lastOkAt: number | null; lastError: string | null;
  rowsWritten: number; queriesUsed: number; leaseUntil: number; leaseOwner: string | null;
};

type Row = {
  job: SyncJob; cursor: number; cursor2: number; cursor_text: string; phase: string; last_run_at: number | null;
  last_ok_at: number | null; last_error: string | null; rows_written: number; queries_used: number; lease_until: number; lease_owner: string | null;
};

/** Every function starts here, so each works on a database that has never seen the job. */
const ensureRow = (db: Db, job: SyncJob) => db.query("insert into market.sync_state (job) values ($1) on conflict (job) do nothing", [job]);

export async function readState(db: Db, job: SyncJob): Promise<SyncState> {
  await ensureRow(db, job);
  const [r] = await db.query<Row>(
    "select job, cursor, cursor2, cursor_text, phase, last_run_at, last_ok_at, last_error, rows_written, queries_used, lease_until, lease_owner from market.sync_state where job = $1",
    [job],
  );
  return {
    job: r.job, cursor: r.cursor, cursor2: r.cursor2, cursorText: r.cursor_text, phase: r.phase, lastRunAt: r.last_run_at,
    lastOkAt: r.last_ok_at, lastError: r.last_error, rowsWritten: r.rows_written, queriesUsed: r.queries_used, leaseUntil: r.lease_until, leaseOwner: r.lease_owner,
  };
}

/** One conditional UPDATE: atomic, so two invocations racing for the row cannot both win. */
export async function acquireLease(db: Db, job: SyncJob, owner: string, now: number, ttlSec: number): Promise<boolean> {
  await ensureRow(db, job);
  const rows = await db.query(
    "update market.sync_state set lease_until = $3::int, lease_owner = $2::text where job = $1 and lease_until < $4::int returning job",
    [job, owner, now + ttlSec, now],
  );
  return rows.length === 1;
}

export async function releaseLease(db: Db, job: SyncJob, owner: string): Promise<void> {
  await db.query("update market.sync_state set lease_until = 0, lease_owner = null where job = $1 and lease_owner = $2::text", [job, owner]);
}

export async function saveCursors(db: Db, job: SyncJob, patch: { cursor?: number; cursor2?: number; cursorText?: string; phase?: string }): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [job];
  const add = (column: string, cast: string, v: unknown) => { params.push(v); sets.push(`${column} = $${params.length}::${cast}`); };
  if (patch.cursor !== undefined) add("cursor", "int", patch.cursor);
  if (patch.cursor2 !== undefined) add("cursor2", "int", patch.cursor2);
  if (patch.cursorText !== undefined) add("cursor_text", "text", patch.cursorText);
  if (patch.phase !== undefined) add("phase", "text", patch.phase);
  if (sets.length === 0) return;
  await ensureRow(db, job);
  await db.query(`update market.sync_state set ${sets.join(", ")} where job = $1`, params);
}

export async function finishRun(db: Db, job: SyncJob, r: { now: number; ok: boolean; error?: string; rows: number; queries: number }): Promise<void> {
  await ensureRow(db, job);
  await db.query(
    `update market.sync_state set last_run_at = $2::int,
       last_ok_at = case when $3::boolean then $2::int else last_ok_at end,
       last_error = case when $3::boolean then null else $4::text end,
       rows_written = rows_written + $5::int, queries_used = queries_used + $6::int
     where job = $1`,
    [job, r.now, r.ok, r.error ?? null, r.rows, r.queries],
  );
}
```

- [ ] **Step 4: Run the state tests**

Run: `npx vitest run src/lib/sync/state.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing market-cycle tests**

`src/lib/sync/market.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { FakeSource, type FakeData } from "./fakeSource";
import { bucketStart, openBucketIds } from "./ids";
import { CANDLE_LOOKBACK_SEC, PAGE_LIMIT, runMarketCycle, type CycleOpts } from "./market";
import { readState, saveCursors } from "./state";
import { POOL_A, POOL_B, T0, TOKEN_A, TOKEN_B, candleRec, poolId, poolRec, priceRec, quoteRec, swapRec, tokenRec, txHash } from "./testRows";

const NOW = T0 + 1000;
let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
beforeEach(() => db.exec(
  "delete from market.quotes; delete from market.tokens; delete from market.pools; delete from market.swaps; delete from market.candles; delete from market.sync_state",
));

const count = async (table: string) => Number((await db.query<{ n: unknown }>(`select count(*) as n from market.${table}`))[0].n);
const cycle = (source: FakeSource, over: Partial<CycleOpts> = {}) =>
  runMarketCycle(db, source, { now: NOW, queryBudget: 150, deadlineMs: Date.now() + 60_000, ...over });

/** One traded pool (A, last swap T0+500) with two swaps and two candles, and one pool (B) created at T0+700 that never traded. */
const base = (): FakeData => ({
  quotes: [quoteRec()],
  prices: [priceRec()],
  tokens: [tokenRec(), tokenRec({ id: TOKEN_B, address: TOKEN_B, primaryPool_id: POOL_B })],
  pools: [poolRec(), poolRec({ id: POOL_B, token_id: TOKEN_B, lastSwapAt: null, swapCount: 0, createdAt: T0 + 700 })],
  swaps: [swapRec(), swapRec({ txHash: txHash(2), timestamp: T0 + 450 })],
  candles: [candleRec(), candleRec({ interval: "h1" })],
});
const full = { pages: 2, pools: 1, swaps: 2, candles: 2, tokens: 2, newPools: 1, queries: 7, cursor: T0 + 500, cursor2: T0 + 700, exhausted: false };
const nothing = { pages: 0, pools: 0, swaps: 0, candles: 0, tokens: 0, newPools: 0, queries: 0, cursor: 0, cursor2: 0, exhausted: true };

describe("runMarketCycle", () => {
  it("writes quotes, pools, swaps, candles, tokens and listed pools, and leaves both cursors at the maxima seen", async () => {
    const src = new FakeSource(base());
    expect(await cycle(src)).toEqual(full);
    expect(src.calls).toEqual(["quotes", "poolsSince", "swapsFor", "candlesFor", "tokensById", "poolsCreatedSince", "tokensById"]);
    expect(await db.query("select usd_price from market.quotes")).toEqual([{ usd_price: 182.5 }]);
    expect(await db.query("select id, listed_pool_id from market.tokens order by id")).toEqual([
      { id: TOKEN_A, listed_pool_id: POOL_A },
      { id: TOKEN_B, listed_pool_id: null },
    ]);
    expect([await count("pools"), await count("swaps"), await count("candles")]).toEqual([2, 2, 2]);
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 500, cursor2: T0 + 700 });
  });

  it("re-processes the overlap without writing anything new, and never moves a cursor backwards", async () => {
    const src = new FakeSource(base());
    await cycle(src);
    expect(await cycle(src)).toEqual({ ...full, swaps: 0 });
    expect([await count("pools"), await count("swaps"), await count("candles"), await count("tokens")]).toEqual([2, 2, 2, 2]);
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 500, cursor2: T0 + 700 });
  });

  it("stops before the request that would exceed the budget and leaves the cursor at the last completed page", async () => {
    const src = new FakeSource(base());
    // quotes and one pool page fit; the page's swaps do not, so nothing of that page is committed to the cursor.
    expect(await cycle(src, { queryBudget: 2 })).toEqual({ ...nothing, queries: 2 });
    expect(src.calls).toEqual(["quotes", "poolsSince"]);
    expect(await readState(db, "market")).toMatchObject({ cursor: 0, cursor2: 0 });
  });

  it("keeps the cursor of a completed page when the next page runs out of budget", async () => {
    // 1001 pools of one token: page one is 1000 pools = 20 pool batches × 2 requests + quotes + page + tokens = 43 requests.
    const pools = Array.from({ length: 1001 }, (_, i) => poolRec({ id: poolId(0x100 + i), lastSwapAt: T0 + i }));
    const src = new FakeSource({ ...base(), pools, swaps: [], candles: [] });
    const r = await cycle(src, { queryBudget: 44 });
    expect(r).toMatchObject({ pages: 1, pools: 1000, queries: 44, cursor: T0 + 999, exhausted: true });
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 999 });
  });

  it("returns at once past the deadline", async () => {
    const src = new FakeSource(base());
    expect(await cycle(src, { deadlineMs: Date.now() - 1 })).toEqual(nothing);
    expect(src.calls).toEqual([]);
  });

  it("asks for candles from since minus the lookback with the batch's open h1 and d1 bucket ids", async () => {
    await saveCursors(db, "market", { cursor: T0 + 400 });
    const src = new FakeSource(base());
    const spy = vi.spyOn(src, "candlesFor");
    await cycle(src);
    const since = T0 + 400 - 120;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith([POOL_A], since - CANDLE_LOOKBACK_SEC, openBucketIds([POOL_A], since, NOW), null, PAGE_LIMIT);
  });

  it("keyset-continues swaps and candles while pages come back full", async () => {
    const m1 = bucketStart(T0, "m1");
    const src = new FakeSource({
      ...base(),
      swaps: Array.from({ length: PAGE_LIMIT + 1 }, (_, i) => swapRec({ txHash: txHash(i + 1), timestamp: T0 + i })),
      candles: Array.from({ length: PAGE_LIMIT + 1 }, (_, i) => candleRec({ t: m1 + 60 * i })),
    });
    expect(await cycle(src)).toMatchObject({ swaps: PAGE_LIMIT + 1, candles: PAGE_LIMIT + 1, exhausted: false });
    expect(src.calls.filter((c) => c === "swapsFor")).toHaveLength(2);
    expect(src.calls.filter((c) => c === "candlesFor")).toHaveLength(2);
    expect([await count("swaps"), await count("candles")]).toEqual([PAGE_LIMIT + 1, PAGE_LIMIT + 1]);
  });

  it("throws on a source failure after persisting the pages completed before it", async () => {
    const src = new FakeSource(base());
    src.failOn = { method: "poolsCreatedSince", error: new Error("indexer responded 503") };
    await expect(cycle(src)).rejects.toThrow("indexer responded 503");
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 500, cursor2: 0 });
    expect(await count("swaps")).toBe(2);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/lib/sync/market.test.ts`
Expected: FAIL, `Failed to resolve import "./market"`.

- [ ] **Step 7: Write the market cycle**

`src/lib/sync/market.ts`:
```ts
import type { Db } from "@/lib/db/client";
import { openBucketIds } from "./ids";
import type { CandleCursor, CreatedCursor, EnvioSource, PoolCursor, PoolRec, SwapCursor } from "./source";
import { readState, saveCursors } from "./state";
import { insertSwaps, recomputeListedPools, upsertCandles, upsertPools, upsertQuotes, upsertTokens } from "./writers";

export const OVERLAP_SEC = 120;
export const CANDLE_LOOKBACK_SEC = 900;
export const PAGE_LIMIT = 1000;
export const POOL_BATCH = 50;
export const TOKEN_BATCH = 100;
export type CycleOpts = { now: number; queryBudget: number; deadlineMs: number };
export type CycleResult = {
  pages: number; pools: number; swaps: number; candles: number; tokens: number; newPools: number;
  queries: number; cursor: number; cursor2: number; exhausted: boolean;
};

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * One market cycle (spec 5.2): quotes; pages of pools with lastSwapAt >= cursor − OVERLAP_SEC, each page written
 * (pools, then swaps and candles in POOL_BATCH batches, then tokens in TOKEN_BATCH batches and recomputeListedPools)
 * before saveCursors({cursor: page's last lastSwapAt}); then new pools by cursor2 the same way. Stops with
 * exhausted = true, cursors untouched for the unfinished page, when source.queries − start reaches queryBudget or
 * Date.now() passes deadlineMs. Throws after persisting completed pages when the source or the database fails.
 */
export async function runMarketCycle(db: Db, source: EnvioSource, opts: CycleOpts): Promise<CycleResult> {
  const start = source.queries;
  const state = await readState(db, "market");
  const r: CycleResult = { pages: 0, pools: 0, swaps: 0, candles: 0, tokens: 0, newPools: 0, queries: 0, cursor: state.cursor, cursor2: state.cursor2, exhausted: false };
  /** Checked before every request, never after one: the cycle does not issue the request that would go over. */
  const canQuery = () => source.queries - start < opts.queryBudget && Date.now() < opts.deadlineMs;
  const finish = (exhausted: boolean) => {
    r.exhausted = exhausted;
    r.queries = source.queries - start;
    return r;
  };

  /** The tokens behind `pools`, TOKEN_BATCH ids per lookup, each batch followed by the listed-pool recompute. */
  const writeTokens = async (pools: readonly PoolRec[]): Promise<boolean> => {
    for (const ids of batches([...new Set(pools.map((p) => p.token_id))], TOKEN_BATCH)) {
      if (!canQuery()) return false;
      r.tokens += await upsertTokens(db, await source.tokensById(ids), opts.now);
      await recomputeListedPools(db, ids);
    }
    return true;
  };

  /** Swaps and candles of `pools` since `since`, POOL_BATCH pools per request, each keyset-paged until a short page. */
  const writeActivity = async (pools: readonly PoolRec[], since: number): Promise<boolean> => {
    for (const ids of batches(pools.map((p) => p.id), POOL_BATCH)) {
      let sAfter: SwapCursor | null = null;
      for (;;) {
        if (!canQuery()) return false;
        const swaps = await source.swapsFor(ids, since, sAfter, PAGE_LIMIT);
        if (swaps.length > 0) r.swaps += await insertSwaps(db, swaps);
        if (swaps.length < PAGE_LIMIT) break;
        const last = swaps[swaps.length - 1];
        sAfter = { timestamp: last.timestamp, id: last.id };
      }
      // `recent` catches every m1, m5 and m15 bucket that could have changed; `open` looks up the h1 and d1
      // buckets containing since and now by id, on the first page only. The two overlap; the writer deduplicates.
      const openIds = openBucketIds(ids, since, opts.now);
      let cAfter: CandleCursor | null = null;
      for (;;) {
        if (!canQuery()) return false;
        const { recent, open } = await source.candlesFor(ids, since - CANDLE_LOOKBACK_SEC, openIds, cAfter, PAGE_LIMIT);
        if (recent.length + open.length > 0) r.candles += await upsertCandles(db, [...recent, ...open]);
        if (recent.length < PAGE_LIMIT) break;
        const last = recent[recent.length - 1];
        cAfter = { t: last.t, id: last.id };
      }
    }
    return true;
  };

  // 1. Quotes: one request, upserted whole.
  if (!canQuery()) return finish(true);
  const { quotes, prices } = await source.quotes();
  await upsertQuotes(db, quotes, prices);

  // 2. Pools that traded since the cursor minus the overlap. A page is fully written before the cursor moves,
  //    so a cycle that stops mid-page repeats that page next time; every write is idempotent.
  const since = Math.max(0, r.cursor - OVERLAP_SEC);
  let after: PoolCursor | null = null;
  for (;;) {
    if (!canQuery()) return finish(true);
    const page = await source.poolsSince(since, after, PAGE_LIMIT);
    if (page.length === 0) break;
    await upsertPools(db, page, opts.now);
    if (!(await writeActivity(page, since)) || !(await writeTokens(page))) return finish(true);
    const last = page[page.length - 1];
    r.cursor = Math.max(r.cursor, last.lastSwapAt ?? r.cursor);
    await saveCursors(db, "market", { cursor: r.cursor });
    r.pages += 1;
    r.pools += page.length;
    if (page.length < PAGE_LIMIT) break;
    after = { lastSwapAt: last.lastSwapAt ?? since, id: last.id };
  }

  // 3. Pools created since cursor2 that never traded: their rows and tokens; there are no swaps or candles under them.
  const since2 = Math.max(0, r.cursor2 - OVERLAP_SEC);
  let after2: CreatedCursor | null = null;
  for (;;) {
    if (!canQuery()) return finish(true);
    const page = await source.poolsCreatedSince(since2, after2, PAGE_LIMIT);
    if (page.length === 0) break;
    await upsertPools(db, page, opts.now);
    if (!(await writeTokens(page))) return finish(true);
    const last = page[page.length - 1];
    r.cursor2 = Math.max(r.cursor2, last.createdAt);
    await saveCursors(db, "market", { cursor2: r.cursor2 });
    r.pages += 1;
    r.newPools += page.length;
    if (page.length < PAGE_LIMIT) break;
    after2 = { createdAt: last.createdAt, id: last.id };
  }
  return finish(false);
}
```

- [ ] **Step 8: Run the market tests**

Run: `npx vitest run src/lib/sync/market.test.ts src/lib/sync/state.test.ts`
Expected: PASS, 13 tests. The 1001-row cases take a second or two on PGlite.

- [ ] **Step 9: Run the gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add src/lib/sync/state.ts src/lib/sync/state.test.ts src/lib/sync/market.ts src/lib/sync/market.test.ts
git commit -m "Add sync state with a lease and the market cycle" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

### Task 5: Nightly, runner, cron routes

**Files:**
- Create: `src/lib/sync/nightly.ts`, `src/lib/sync/run.ts`, `src/lib/sync/deps.ts`, `src/app/api/_lib/cron.ts`, `src/app/api/internal/sync/route.ts`, `src/app/api/internal/sync/nightly/route.ts`
- Modify: `vercel.json`, `src/app/api/_lib/respond.ts`
- Test: `src/lib/sync/nightly.test.ts`, `src/lib/sync/run.test.ts`, `src/app/api/_lib/cron.test.ts`, `src/app/api/_lib/respond.test.ts`, `src/app/api/internal/sync/route.test.ts`, `src/app/api/internal/sync/nightly/route.test.ts`

**Interfaces:**
- Consumes: `Db`, `DbUnavailableError`, `getDb()`, `resetDb()` (Task 1); `EnvioSource`, `createEnvioSource()`, `FakeSource` (Task 2); the writers (Task 3); `PAGE_LIMIT`, `CycleOpts`, `CycleResult`, `runMarketCycle` and `SyncJob`, `readState`, `acquireLease`, `releaseLease`, `saveCursors`, `finishRun` (Task 4); `failure()` from `respond.ts`; the builders from `testRows.ts`.
- Produces: `NightlyResult`, `runNightly(db, source, opts)`; `RunOpts`, `RunReport`, `runSync(db, source, opts)`; `isCronAuthorized(req)`; the two GET handlers; and `SyncDeps`, `syncDeps(): SyncDeps`, `setSyncDeps(factory | null)` from `src/lib/sync/deps.ts`.

Decisions where the contract is silent: `RunOpts.now` returns unix milliseconds like `Date.now`; the runner measures the window on that clock and hands each cycle `deadlineMs = Date.now() + remaining`, because the cycle watches the real clock while tests inject a fake one. The routes obtain their `Db` and `EnvioSource` from `src/lib/sync/deps.ts`, whose `syncDeps()` returns `{ db: getDb(), source: createEnvioSource() }` unless a test has installed a factory with `setSyncDeps()`; the 503 test leaves the real factory in place with `DATABASE_URL` unset, so the production path is what answers. A stored nightly phase of `""` or anything unknown starts from `"tokens"`. The nightly route passes `intervalSec` 250 (unused: one pass per invocation). `failure()` logs a `DbUnavailableError` message with `console.warn` like the indexer branch; Task 1's messages never carry a connection string. A cycle that throws after completing some pages records `rows: 0` for that run: `rows_written` is a diagnostic counter, the cursors are the record of what was written, and the completed pages are already persisted.

- [ ] **Step 1: Write the failing nightly test**

`src/lib/sync/nightly.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { FakeSource } from "./fakeSource";
import { runNightly } from "./nightly";
import { readState, saveCursors } from "./state";
import { POOL_A, POOL_B, T0, TOKEN_A, TOKEN_B, poolRec, tokenRec } from "./testRows";

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
beforeEach(() => db.exec("delete from market.tokens; delete from market.pools; delete from market.sync_state"));

const source = () => new FakeSource({
  tokens: [tokenRec(), tokenRec({ id: TOKEN_B, address: TOKEN_B, primaryPool_id: POOL_B })],
  pools: [poolRec(), poolRec({ id: POOL_B, token_id: TOKEN_B })],
});
const nightly = (src: FakeSource, queryBudget = 240) => runNightly(db, src, { now: T0 + 1000, queryBudget, deadlineMs: Date.now() + 60_000 });
const listed = () => db.query("select id, listed_pool_id from market.tokens order by id");

describe("runNightly", () => {
  it("walks tokens, then pools, recomputes every listed pool and ends with an empty phase", async () => {
    const src = source();
    expect(await nightly(src)).toEqual({ done: true, phase: "", tokens: 2, pools: 2, listed: 2, queries: 2 });
    expect(src.calls).toEqual(["tokensPage", "poolsPage"]);
    expect(await listed()).toEqual([{ id: TOKEN_A, listed_pool_id: POOL_A }, { id: TOKEN_B, listed_pool_id: POOL_B }]);
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "" });
  });
  it("stops at the budget with done false and the next call continues from the stored phase", async () => {
    const src = source();
    expect(await nightly(src, 1)).toEqual({ done: false, phase: "pools", tokens: 2, pools: 0, listed: 0, queries: 1 });
    expect(await readState(db, "nightly")).toMatchObject({ phase: "pools", cursorText: "" });
    expect(await nightly(src, 1)).toEqual({ done: true, phase: "", tokens: 0, pools: 2, listed: 2, queries: 1 });
  });
  it("resumes a phase after the stored cursor id", async () => {
    await saveCursors(db, "nightly", { phase: "pools", cursorText: POOL_A });
    const src = source();
    expect(await nightly(src)).toMatchObject({ done: true, tokens: 0, pools: 1 });
    expect(src.calls).toEqual(["poolsPage"]);
    expect(await db.query("select id from market.pools")).toEqual([{ id: POOL_B }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/sync/nightly.test.ts`
Expected: FAIL, `Failed to resolve import "./nightly"`.

- [ ] **Step 3: Write the nightly job**

`src/lib/sync/nightly.ts`:
```ts
import type { Db } from "@/lib/db/client";
import { PAGE_LIMIT, type CycleOpts } from "./market";
import type { EnvioSource } from "./source";
import { readState, saveCursors } from "./state";
import { recomputeListedPools, upsertPools, upsertTokens } from "./writers";

export type NightlyResult = { done: boolean; phase: string; tokens: number; pools: number; listed: number; queries: number };

const PHASES = ["tokens", "pools", "listed"] as const;
type Phase = (typeof PHASES)[number];

/**
 * Phases in order, persisted in sync_state.nightly.phase with cursor_text = last id of the completed page:
 * "tokens" (tokensPage walk, upsertTokens), "pools" (poolsPage walk, upsertPools), "listed" (recomputeListedPools "all"),
 * then phase "" and done = true. Resumes from the stored phase and cursor; stops early (done = false) at the budget or deadline.
 */
export async function runNightly(db: Db, source: EnvioSource, opts: CycleOpts): Promise<NightlyResult> {
  const start = source.queries;
  const state = await readState(db, "nightly");
  const r: NightlyResult = { done: false, phase: state.phase, tokens: 0, pools: 0, listed: 0, queries: 0 };
  const canQuery = () => source.queries - start < opts.queryBudget && Date.now() < opts.deadlineMs;
  const finish = (done: boolean, phase: string) => {
    r.done = done;
    r.phase = phase;
    r.queries = source.queries - start;
    return r;
  };
  // "" is a finished run, so the next one starts over; a known phase resumes after the last id it stored.
  let phase: Phase = (PHASES as readonly string[]).includes(state.phase) ? (state.phase as Phase) : "tokens";
  let afterId = phase === state.phase ? state.cursorText : "";

  /** One id-ordered walk to the end of a table, persisting the last id after every page. False when the budget ran out. */
  const walk = async <T extends { id: string }>(name: "tokens" | "pools", page: (after: string) => Promise<T[]>, write: (rows: T[]) => Promise<number>) => {
    for (;;) {
      if (!canQuery()) return false;
      const rows = await page(afterId);
      if (rows.length > 0) {
        r[name] += await write(rows);
        afterId = rows[rows.length - 1].id;
        await saveCursors(db, "nightly", { phase: name, cursorText: afterId });
      }
      if (rows.length < PAGE_LIMIT) return true;
    }
  };

  if (phase === "tokens") {
    if (!(await walk("tokens", (a) => source.tokensPage(a, PAGE_LIMIT), (rows) => upsertTokens(db, rows, opts.now)))) return finish(false, "tokens");
    phase = "pools";
    afterId = "";
    await saveCursors(db, "nightly", { phase, cursorText: "" });
  }
  if (phase === "pools") {
    if (!(await walk("pools", (a) => source.poolsPage(a, PAGE_LIMIT), (rows) => upsertPools(db, rows, opts.now)))) return finish(false, "pools");
    phase = "listed";
    await saveCursors(db, "nightly", { phase, cursorText: "" });
  }
  // No Envio request in this phase, so no budget check: one statement over the whole table.
  r.listed = await recomputeListedPools(db, "all");
  await saveCursors(db, "nightly", { phase: "", cursorText: "" });
  return finish(true, "");
}
```

- [ ] **Step 4: Run the nightly test**

Run: `npx vitest run src/lib/sync/nightly.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing runner test**

`src/lib/sync/run.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { FakeSource } from "./fakeSource";
import { runSync, type RunOpts } from "./run";
import { acquireLease, readState } from "./state";
import { T0, poolRec, priceRec, quoteRec, tokenRec } from "./testRows";

const NOW_MS = (T0 + 1000) * 1000;
let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
beforeEach(() => db.exec("delete from market.quotes; delete from market.tokens; delete from market.pools; delete from market.sync_state"));

/** A clock that only moves when the runner sleeps, and a log of how long it slept. */
function opts(over: Partial<RunOpts> = {}): RunOpts & { slept: number[] } {
  let t = NOW_MS;
  const slept: number[] = [];
  return {
    job: "market", owner: "me", now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; },
    windowSec: 55, intervalSec: 30, queryBudget: 150, leaseSec: 120, slept, ...over,
  };
}
/** Quotes only: a market cycle costs three requests (quotes, an empty pool page, an empty new-pool page). */
const source = () => new FakeSource({ quotes: [quoteRec()], prices: [priceRec()] });

describe("runSync", () => {
  it("skips when another owner holds the lease", async () => {
    await acquireLease(db, "market", "other", T0 + 1000, 120);
    const src = source();
    expect(await runSync(db, src, opts())).toEqual({ job: "market", skipped: "lease", cycles: 0, results: [], error: null });
    expect(src.calls).toEqual([]);
    expect((await readState(db, "market")).leaseOwner).toBe("other");
  });
  it("runs cycles 30 s apart inside a 55 s window and shares one budget across them", async () => {
    const o = opts({ queryBudget: 5 });
    const report = await runSync(db, source(), o);
    expect(report).toMatchObject({ job: "market", skipped: null, cycles: 2, error: null });
    expect(o.slept).toEqual([30_000]);
    expect(report.results[0]).toMatchObject({ queries: 3, exhausted: false });
    expect(report.results[1]).toMatchObject({ queries: 2, exhausted: true });
    expect(await readState(db, "market")).toMatchObject({ queriesUsed: 5, lastOkAt: T0 + 1030, lastError: null, leaseOwner: null, leaseUntil: 0 });
  });
  it("records an error through finishRun, ends the invocation and still releases the lease", async () => {
    const src = source();
    src.failOn = { method: "quotes", error: new Error("indexer responded 503") };
    const o = opts();
    expect(await runSync(db, src, o)).toEqual({ job: "market", skipped: null, cycles: 0, results: [], error: "indexer responded 503" });
    expect(o.slept).toEqual([]);
    expect(await readState(db, "market")).toMatchObject({ lastRunAt: T0 + 1000, lastOkAt: null, lastError: "indexer responded 503", leaseOwner: null });
  });
  it("runs the nightly job once", async () => {
    const src = new FakeSource({ tokens: [tokenRec()], pools: [poolRec()] });
    const o = opts({ job: "nightly", windowSec: 250, queryBudget: 400, leaseSec: 300 });
    const report = await runSync(db, src, o);
    expect(report).toMatchObject({ job: "nightly", cycles: 1, error: null });
    expect(report.results[0]).toMatchObject({ done: true, phase: "", tokens: 1, pools: 1, listed: 1 });
    expect(o.slept).toEqual([]);
    expect(await readState(db, "nightly")).toMatchObject({ rowsWritten: 3, queriesUsed: 2, leaseOwner: null });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/lib/sync/run.test.ts`
Expected: FAIL, `Failed to resolve import "./run"`.

- [ ] **Step 7: Write the runner**

`src/lib/sync/run.ts`:
```ts
import type { Db } from "@/lib/db/client";
import { runMarketCycle, type CycleResult } from "./market";
import { runNightly, type NightlyResult } from "./nightly";
import type { EnvioSource } from "./source";
import { acquireLease, finishRun, releaseLease, type SyncJob } from "./state";

export type RunOpts = {
  job: SyncJob; owner: string; now: () => number; sleep: (ms: number) => Promise<void>;
  windowSec: number; intervalSec: number; queryBudget: number; leaseSec: number;
};
export type RunReport = {
  job: SyncJob; skipped: "lease" | null; cycles: number;
  results: (CycleResult | NightlyResult)[]; error: string | null;
};

const sec = (ms: number) => Math.floor(ms / 1000);
const rowsOf = (r: CycleResult | NightlyResult) =>
  "done" in r ? r.tokens + r.pools + r.listed : r.pools + r.swaps + r.candles + r.tokens + r.newPools;

/**
 * Takes the lease (or reports skipped: "lease"); market: runs cycles until windowSec has elapsed, sleeping so cycles
 * start intervalSec apart, sharing one queryBudget across the invocation; nightly: one runNightly. Every cycle ends
 * with finishRun (ok or error); the first error ends the invocation. Always releases the lease.
 */
export async function runSync(db: Db, source: EnvioSource, opts: RunOpts): Promise<RunReport> {
  const report: RunReport = { job: opts.job, skipped: null, cycles: 0, results: [], error: null };
  const startMs = opts.now();
  if (!(await acquireLease(db, opts.job, opts.owner, sec(startMs), opts.leaseSec))) return { ...report, skipped: "lease" };
  const endMs = startMs + opts.windowSec * 1000;
  let budget = opts.queryBudget;
  try {
    for (;;) {
      const cycleStartMs = opts.now();
      const before = source.queries;
      // The cycle watches the real clock; hand it the window's remainder as measured on the injected one.
      const cycleOpts = { now: sec(cycleStartMs), queryBudget: budget, deadlineMs: Date.now() + Math.max(0, endMs - cycleStartMs) };
      let result: CycleResult | NightlyResult;
      try {
        result = opts.job === "market" ? await runMarketCycle(db, source, cycleOpts) : await runNightly(db, source, cycleOpts);
      } catch (err) {
        report.error = err instanceof Error ? err.message : String(err);
        await finishRun(db, opts.job, { now: sec(opts.now()), ok: false, error: report.error, rows: 0, queries: source.queries - before });
        break;
      }
      report.results.push(result);
      report.cycles += 1;
      budget -= result.queries;
      await finishRun(db, opts.job, { now: sec(opts.now()), ok: true, rows: rowsOf(result), queries: result.queries });
      const nextMs = cycleStartMs + opts.intervalSec * 1000;
      if (opts.job === "nightly" || budget <= 0 || nextMs >= endMs) break;
      await opts.sleep(Math.max(0, nextMs - opts.now()));
    }
  } finally {
    await releaseLease(db, opts.job, opts.owner);
  }
  return report;
}
```

- [ ] **Step 8: Run the runner test**

Run: `npx vitest run src/lib/sync/run.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Write the failing cron-auth and respond tests**

`src/app/api/_lib/cron.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCronAuthorized } from "./cron";

const req = (auth?: string) => new Request("http://localhost/api/internal/sync", { headers: auth === undefined ? {} : { authorization: auth } });
afterEach(() => vi.unstubAllEnvs());

describe("isCronAuthorized", () => {
  it("refuses everything while CRON_SECRET is unset", () => {
    vi.stubEnv("CRON_SECRET", undefined);
    expect(isCronAuthorized(req("Bearer s3cret"))).toBe(false);
  });
  it("refuses a missing, wrong, longer or bare token", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isCronAuthorized(req())).toBe(false);
    expect(isCronAuthorized(req("Bearer nope!!"))).toBe(false);
    expect(isCronAuthorized(req("Bearer s3cret1"))).toBe(false);
    expect(isCronAuthorized(req("s3cret"))).toBe(false);
  });
  it("accepts exactly Bearer <CRON_SECRET>", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isCronAuthorized(req("Bearer s3cret"))).toBe(true);
  });
});
```

`src/app/api/_lib/respond.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { DbUnavailableError } from "@/lib/db/client";
import { EnvioUnavailableError } from "@/lib/envio/client";
import { failure } from "./respond";

afterEach(() => vi.restoreAllMocks());

describe("failure", () => {
  it("answers 503 no-store with a retry hint for a database outage", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = failure(new DbUnavailableError("DATABASE_URL is not set"));
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("15");
    await expect(res.json()).resolves.toEqual({ error: "database unavailable" });
  });
  it("still answers 503 for the indexer and 500 for anything else", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(failure(new EnvioUnavailableError("indexer responded 429")).status).toBe(503);
    expect(failure(new Error("boom")).status).toBe(500);
  });
});
```

Run: `npx vitest run src/app/api/_lib`
Expected: FAIL: `cron.test.ts` cannot find `./cron`; in `respond.test.ts` the database case gets 500, not 503.

- [ ] **Step 10: Write cron.ts and change respond.ts**

`src/app/api/_lib/cron.ts`:
```ts
import { timingSafeEqual } from "node:crypto";

/** True only when CRON_SECRET is set and the Authorization header equals `Bearer <CRON_SECRET>` (constant-time compare). */
export function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  // timingSafeEqual throws on unequal lengths; the length itself is not a secret.
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

In `src/app/api/_lib/respond.ts`, replace the first import block:
```ts
import { NextResponse } from "next/server";
import { EnvioUnavailableError } from "@/lib/envio/client";
```
with:
```ts
import { NextResponse } from "next/server";
import { DbUnavailableError } from "@/lib/db/client";
import { EnvioUnavailableError } from "@/lib/envio/client";
```
and in `failure`, after the `EnvioUnavailableError` branch and before `console.error(err);`, insert:
```ts
  if (err instanceof DbUnavailableError) {
    console.warn(`database unavailable: ${err.message}`);
    return NextResponse.json({ error: "database unavailable" }, { status: 503, headers: { ...headers, "Retry-After": "15" } });
  }
```

Run: `npx vitest run src/app/api/_lib src/app/api/health`
Expected: PASS (the health test's module mock is unaffected: it mocks `@/lib/envio/client`, not `@/lib/db/client`).

- [ ] **Step 11: Write the failing route tests**

`src/app/api/internal/sync/route.test.ts`:
```ts
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetDb, type Db } from "@/lib/db/client";
import { setSyncDeps } from "@/lib/sync/deps";
import { FakeSource } from "@/lib/sync/fakeSource";
import { POOL_A, poolRec, priceRec, quoteRec, tokenRec } from "@/lib/sync/testRows";
import { testDb } from "@/test/db";
import { GET } from "./route";

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
afterEach(() => { setSyncDeps(null); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const call = (auth?: string) => GET(new Request("http://localhost/api/internal/sync", { headers: auth ? { authorization: auth } : {} }));

describe("GET /api/internal/sync", () => {
  it("answers 401 without the cron secret", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await call();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });
  it("answers 503 when DATABASE_URL is unset", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("DATABASE_URL", undefined);
    resetDb();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ error: "database unavailable" });
  });
  it("runs one market cycle against the injected store and source and answers the report", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("SYNC_INTERVAL_SEC", "60"); // one cycle per invocation, so the route never sleeps inside the test
    const source = new FakeSource({ quotes: [quoteRec()], prices: [priceRec()], pools: [poolRec()], tokens: [tokenRec()] });
    setSyncDeps(() => ({ db, source }));
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const report = await res.json();
    expect(report).toMatchObject({ job: "market", skipped: null, cycles: 1, error: null });
    expect(report.results[0]).toMatchObject({ pools: 1, tokens: 1, exhausted: false });
    expect(await db.query("select listed_pool_id from market.tokens")).toEqual([{ listed_pool_id: POOL_A }]);
  });
});
```

`src/app/api/internal/sync/nightly/route.test.ts`:
```ts
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetDb, type Db } from "@/lib/db/client";
import { setSyncDeps } from "@/lib/sync/deps";
import { FakeSource } from "@/lib/sync/fakeSource";
import { POOL_A, poolRec, tokenRec } from "@/lib/sync/testRows";
import { testDb } from "@/test/db";
import { GET } from "./route";

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
afterEach(() => { setSyncDeps(null); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const call = (auth?: string) => GET(new Request("http://localhost/api/internal/sync/nightly", { headers: auth ? { authorization: auth } : {} }));

describe("GET /api/internal/sync/nightly", () => {
  it("answers 401 without the cron secret", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await call("Bearer wrong!");
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });
  it("answers 503 when DATABASE_URL is unset", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("DATABASE_URL", undefined);
    resetDb();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "database unavailable" });
  });
  it("runs the nightly pass against the injected store and source", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const source = new FakeSource({ tokens: [tokenRec()], pools: [poolRec()] });
    setSyncDeps(() => ({ db, source }));
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const report = await res.json();
    expect(report).toMatchObject({ job: "nightly", skipped: null, cycles: 1, error: null });
    expect(report.results[0]).toMatchObject({ done: true, phase: "", tokens: 1, pools: 1, listed: 1 });
    expect(await db.query("select listed_pool_id from market.tokens")).toEqual([{ listed_pool_id: POOL_A }]);
  });
});
```

Run: `npx vitest run src/app/api/internal`
Expected: FAIL, `Failed to resolve import "@/lib/sync/deps"` and `./route`.

- [ ] **Step 12: Write the deps module, the two routes and vercel.json**

`src/lib/sync/deps.ts`:
```ts
import { getDb, type Db } from "@/lib/db/client";
import { createEnvioSource } from "./envioSource";
import type { EnvioSource } from "./source";

export type SyncDeps = { db: Db; source: EnvioSource };
let override: (() => SyncDeps) | null = null;

/** What a cron route runs against: the process Db (getDb throws DbUnavailableError without DATABASE_URL) and the real source. */
export function syncDeps(): SyncDeps {
  return override ? override() : { db: getDb(), source: createEnvioSource() };
}
/** Tests only: substitute PGlite and a FakeSource; null restores the defaults. */
export function setSyncDeps(factory: (() => SyncDeps) | null): void {
  override = factory;
}
```

`src/app/api/internal/sync/route.ts`:
```ts
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { syncDeps } from "@/lib/sync/deps";
import { runSync } from "@/lib/sync/run";
import { isCronAuthorized } from "../../_lib/cron";
import { failure } from "../../_lib/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** SYNC_INTERVAL_SEC, default 30. An empty or malformed value is the default, never zero. */
function intervalSec(): number {
  const n = Number(process.env.SYNC_INTERVAL_SEC);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  try {
    const { db, source } = syncDeps();
    const report = await runSync(db, source, {
      job: "market", owner: randomUUID(), now: Date.now, sleep,
      windowSec: 55, intervalSec: intervalSec(), queryBudget: 150, leaseSec: 120,
    });
    return NextResponse.json(report, { headers: NO_STORE });
  } catch (err) {
    // failure() answers 503 for DbUnavailableError; a cycle's own errors are inside the report, not thrown.
    return failure(err);
  }
}
```

`src/app/api/internal/sync/nightly/route.ts`:
```ts
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { syncDeps } from "@/lib/sync/deps";
import { runSync } from "@/lib/sync/run";
import { isCronAuthorized } from "../../../_lib/cron";
import { failure } from "../../../_lib/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  try {
    const { db, source } = syncDeps();
    // One pass per invocation: the runner breaks after a nightly result, so intervalSec is never used.
    const report = await runSync(db, source, {
      job: "nightly", owner: randomUUID(), now: Date.now, sleep,
      windowSec: 250, intervalSec: 250, queryBudget: 400, leaseSec: 300,
    });
    return NextResponse.json(report, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}
```

`vercel.json` (whole file):
```json
{
  "framework": "nextjs",
  "crons": [
    { "path": "/api/internal/sync", "schedule": "* * * * *" },
    { "path": "/api/internal/sync/nightly", "schedule": "0 3 * * *" }
  ]
}
```

- [ ] **Step 13: Run the route tests**

Run: `npx vitest run src/app/api/internal src/app/api/_lib`
Expected: PASS, 11 tests.

- [ ] **Step 14: Run the gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green; the build lists `/api/internal/sync` and `/api/internal/sync/nightly` as dynamic routes.

- [ ] **Step 15: Commit**

```bash
git add src/lib/sync/nightly.ts src/lib/sync/nightly.test.ts src/lib/sync/run.ts src/lib/sync/run.test.ts src/lib/sync/deps.ts \
  src/app/api/_lib/cron.ts src/app/api/_lib/cron.test.ts src/app/api/_lib/respond.ts src/app/api/_lib/respond.test.ts \
  src/app/api/internal/sync/route.ts src/app/api/internal/sync/route.test.ts \
  src/app/api/internal/sync/nightly/route.ts src/app/api/internal/sync/nightly/route.test.ts vercel.json
git commit -m "Add the nightly job, the sync runner and the cron routes" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

### Task 6: Backends, route flip, token route, frontend pair

**Files:**
- Create: `src/lib/market/backend.ts`, `src/lib/market/envioBackend.ts`, `src/lib/market/dbShape.ts`, `src/lib/market/dbBackend.ts`, `src/app/api/tokens/[address]/route.ts`
- Modify: `src/lib/envio/shape.ts` (export `toOrigin`, `units`), `src/app/api/pairs/route.ts`, `src/app/api/quotes/route.ts`, `src/app/api/health/route.ts`, `src/app/api/tokens/[address]/{candles,trades,holders}/route.ts`, `src/lib/types.ts`, `src/lib/data/envio.ts`, `src/lib/data/mock.ts`, `src/hooks/useMarketsData.ts`
- Test: `src/lib/market/backend.test.ts`, `src/lib/market/envioBackend.test.ts`, `src/lib/market/dbBackend.test.ts` (PGlite), `src/app/api/health/route.test.ts` (rewritten to the seam), `src/app/api/tokens/[address]/route.test.ts`

**Interfaces:**
- Consumes: `Db`, `resetDb`, `getDb` (`src/lib/db/client.ts`); `testDb()` (`src/test/db.ts`); `EnvioSource`, `BalanceRec`, `PoolRec`, `TokenRec`, `SwapRec`, `CandleRec`, `QuoteRec`, `QuotePriceRec` (`src/lib/sync/source.ts`); `FakeSource` (`src/lib/sync/fakeSource.ts`); `createEnvioSource` (`src/lib/sync/envioSource.ts`); `IndexerInterval` (`src/lib/sync/ids.ts`); `upsertQuotes`, `upsertPools`, `upsertTokens`, `insertSwaps`, `upsertCandles`, `replaceHolders`, `recomputeListedPools` (`src/lib/sync/writers.ts`); `readState`, `saveCursors`, `finishRun` (`src/lib/sync/state.ts`); M1's `loadPairs`, `PAIRS_TTL`, `PAIRS_LIMIT`, `PairsScope`, the query documents, `ttlCache`, `gql`, `EnvioUnavailableError`, and every `shape.ts` function.
- Produces: `HealthReport`, `MarketBackend`, `getBackend()`, `resetBackend()`; `createEnvioBackend()`; `createDbBackend(db, source, now?)`, `HOLDER_REFRESH_SEC`; `PairRow`, `PAIR_SELECT`, `pairFromRow()`; `MarketsDataSource.pair(id)`; `GET /api/tokens/[address]`. Task 7's parity script uses `createDbBackend` and `createEnvioBackend`.

Decisions where the contract is silent, each in one line:
- Route tests substitute the backend with `vi.mock("@/lib/market/backend")` and a `vi.hoisted` fake; `resetBackend()` is used only by `backend.test.ts` for the selection rule. No test-only setter in production code.
- The pairs memo stays inside each backend: `createEnvioBackend().pairs` is `loadPairs` (key `pairs:${scope}`) and `createDbBackend().pairs` memoises under `pairs:db:${scope}` with the same TTL, so `quotes()` reuses the cached pair set exactly as M1 does while the two backends never share an entry (the parity script loads both in one process); every other route keeps its own `ttlCache` key.
- The launchpad scope filters `t.origin in ('LONG','Pons')` (index `tokens_origin_listed`); the indexer keeps a token's origin equal to its pools' origin, so this equals M1's filter.
- `getBackend()` builds the source with `createEnvioSource({ retry: false })`: a holders refresh or a health probe must answer now, and the stored rows (or `lag: null`) are the fallback.
- `db` health: `ok` = the database answered, `sync_state.market.last_ok_at` is within 300 s, and every quote with a feed is fresh; indexer lag is informational (a failing `chainMeta()` gives `lag: null` and a warning).
- `usePair` overrides `isPending` as well as `isLoading`, because `TokenView` reads `isPending` for its skeleton; otherwise a deep link would flash "No token" before the fallback answers.
- Only `health` has a route test today; the other five flipped routes stay one-liners over the seam and keep having none. Health's envio-specific cases (lag, unreachable) move to `envioBackend.test.ts`.

- [ ] **Step 1: Export the two helpers from shape.ts and write the types and the row mapper**

In `src/lib/envio/shape.ts` change two lines, nothing else:

```ts
export function toOrigin(s: string): Origin {
```
```ts
export function units(raw: string | null, decimals: number): number | null {
```

`src/lib/market/backend.ts`:

```ts
import type { PairsScope } from "@/lib/envio/pairs";
import type { IndexerInterval } from "@/lib/sync/ids";
import type { Candle, Holder, QuoteAsset, TokenPair, Trade } from "@/lib/types";
import { getDb } from "@/lib/db/client";
import { createEnvioSource } from "@/lib/sync/envioSource";
import { createDbBackend } from "./dbBackend";
import { createEnvioBackend } from "./envioBackend";

export type HealthReport = {
  ok: boolean; backend: "db" | "envio";
  lag: number | null; // indexer block lag as in M1
  quotes: { id: string; ageSec: number; stale: boolean }[];
  db?: { latencyMs: number };
  sync?: { lastOkAgeSec: number | null; cursorAgeSec: number | null; lastError: string | null };
  nightly?: { lastOkAgeSec: number | null; lastError: string | null };
  error?: string;
};

/** Every reader throws on failure except `health()`, which reports it: the health route memoises outcomes, never exceptions. */
export interface MarketBackend {
  readonly kind: "db" | "envio";
  pairs(scope: PairsScope): Promise<TokenPair[]>;
  pair(id: string): Promise<TokenPair | null>;
  quotes(): Promise<QuoteAsset[]>;
  candles(id: string, interval: IndexerInterval): Promise<Candle[]>;
  trades(id: string): Promise<Trade[]>;
  holders(id: string): Promise<{ holders: Holder[]; count: number }>;
  health(): Promise<HealthReport>;
}

let instance: MarketBackend | null = null;

/** `envio` when MARKET_DATA_BACKEND === "envio" or no DATABASE_URL; otherwise `db`. Memoised per process. */
export function getBackend(): MarketBackend {
  if (instance) return instance;
  const envio = process.env.MARKET_DATA_BACKEND === "envio" || !process.env.DATABASE_URL;
  // No retry on the read path: a holders refresh or a health probe answers now; stored rows are the fallback.
  instance = envio ? createEnvioBackend() : createDbBackend(getDb(), createEnvioSource({ retry: false }));
  return instance;
}

export function resetBackend(): void {
  instance = null;
}
```

`src/lib/market/dbShape.ts`:

```ts
import { feeTierLabel, hookLabel, isStale, toOrigin, units, type WindowStats } from "@/lib/envio/shape";
import type { TokenPair } from "@/lib/types";

export type PairRow = {
  id: string; symbol: string; name: string; address: string; decimals: number; total_supply: string; holders_count: number;
  pool_id: string; quote_id: string; pool_origin: string; hooks: string; fee: number; pool_created_at: number;
  price_quote: number; tvl_token: string | null; tvl_quote: string | null;
  quote_symbol: string; quote_decimals: number; usd_price: number | null; usd_updated_at: number | null; aggregator: string | null;
};

/** One row per listed token. numeric(78,0) columns are cast to text so both drivers hand back strings. */
export const PAIR_SELECT = `
select t.id, t.symbol, t.name, t.address, t.decimals, t.total_supply::text as total_supply, t.holders_count,
  p.id as pool_id, p.quote_id, p.origin as pool_origin, p.hooks, p.fee, p.created_at as pool_created_at,
  p.price_quote, p.tvl_token::text as tvl_token, p.tvl_quote::text as tvl_quote,
  q.symbol as quote_symbol, q.decimals as quote_decimals, q.usd_price, q.usd_updated_at, q.aggregator
from market.tokens t
join market.pools p on p.id = t.listed_pool_id
join market.quotes q on q.id = p.quote_id`;

/** Same arithmetic and field order as shapePairs(); `stats` from windowStats() keyed by pool id. */
export function pairFromRow(row: PairRow, stats: WindowStats | undefined, nowSec: number): TokenPair {
  const priceQuote = row.price_quote;
  // usdMap(): no feed row, or a feed older than 3 days that is not pinned, is no USD price at all.
  const fresh = row.usd_price !== null && row.usd_updated_at !== null
    && !isStale({ updatedAt: row.usd_updated_at, aggregator: row.aggregator ?? "" }, nowSec);
  const q = fresh ? row.usd_price : null;
  const usdPrice = q ?? 0; // stale or unknown quote: USD figures read 0, liquidity null
  const priceUsd = priceQuote * usdPrice;
  const supply = Number(BigInt(row.total_supply)) / 10 ** row.decimals;
  const tvlQuote = units(row.tvl_quote, row.quote_decimals);
  const tvlToken = units(row.tvl_token, row.decimals);
  const liquidity = q === null || tvlQuote === null || tvlToken === null ? null : (tvlQuote + tvlToken * priceQuote) * q;
  const ref1 = stats?.ref1h ?? undefined;
  const ref24 = stats?.ref24h ?? undefined;
  const origin = toOrigin(row.pool_origin);
  return {
    id: row.id,
    ticker: row.symbol,
    name: row.name,
    address: row.address as `0x${string}`,
    logoUrl: `/api/tokens/${row.id}/logo`,
    quote: row.quote_symbol,
    origin,
    tradeable: true, // Quoter simulation lands in M2
    priceUsd,
    priceQuote,
    change1h: ref1 !== undefined && ref1 > 0 ? (priceQuote / ref1 - 1) * 100 : null,
    change24h: ref24 !== undefined && ref24 > 0 ? (priceQuote / ref24 - 1) * 100 : null,
    vol24h: (stats?.vol24h ?? 0) * usdPrice,
    mcap: priceUsd * supply,
    fdv: priceUsd * supply,
    liquidity,
    stale: q === null,
    holders: row.holders_count,
    createdAt: row.pool_created_at * 1000,
    bull: 0,
    bear: 0,
    poolId: row.pool_id as `0x${string}`,
    hook: hookLabel(origin),
    feeTier: feeTierLabel(row.fee),
  };
}
```

- [ ] **Step 2: Write the failing backend tests**

`src/lib/market/backend.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "@/lib/db/client";
import { getBackend, resetBackend } from "./backend";

describe("getBackend", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetBackend();
    resetDb();
  });

  it("uses Envio when DATABASE_URL is unset", () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("MARKET_DATA_BACKEND", "");
    expect(getBackend().kind).toBe("envio");
  });

  it("uses the store when DATABASE_URL is set, and memoises", () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/market"); // never connected: the driver is lazy
    vi.stubEnv("MARKET_DATA_BACKEND", "");
    const b = getBackend();
    expect(b.kind).toBe("db");
    expect(getBackend()).toBe(b);
  });

  it("rolls back to Envio when MARKET_DATA_BACKEND is envio", () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/market");
    vi.stubEnv("MARKET_DATA_BACKEND", "envio");
    expect(getBackend().kind).toBe("envio");
  });
});
```

`src/lib/market/envioBackend.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTtlCache } from "@/lib/envio/cache";
import { gql } from "@/lib/envio/client";
import { AI, NOW, POOL, aiTokenBroken, prices, windowRows } from "@/lib/envio/fixtures";
import { TOKEN_QUERY } from "@/lib/envio/queries";
import { shapePairs, usdMap, windowStats } from "@/lib/envio/shape";
import { createEnvioBackend } from "./envioBackend";

// EnvioUnavailableError is re-exported because _lib/respond imports it from the same module.
vi.mock("@/lib/envio/client", () => ({ gql: vi.fn(), EnvioUnavailableError: class EnvioUnavailableError extends Error {} }));
const gqlMock = vi.mocked(gql);
const healthy = {
  chain_metadata: [{ chain_id: 4663, latest_processed_block: 1_000, block_height: 1_000 }],
  QuotePrice: [{ id: "0xquote", updatedAt: NOW - 60, aggregator: "0xfeed" }],
};

describe("createEnvioBackend", () => {
  const backend = createEnvioBackend();
  beforeEach(() => {
    clearTtlCache();
    gqlMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pair() shapes one token from TOKEN_QUERY plus its resolved pool's h1 window", async () => {
    gqlMock.mockImplementation(async (query) => {
      if (query === TOKEN_QUERY) return { Token: [aiTokenBroken], QuotePrice: prices } as never;
      if (query.startsWith("query Window")) return { w0: windowRows } as never;
      throw new Error(`unexpected query ${query.slice(0, 30)}`);
    });
    const pair = await backend.pair(AI);
    // The broken primary is skipped for the sane fallback, exactly as the pairs list does it.
    expect(pair).toEqual(shapePairs([aiTokenBroken], usdMap(prices, NOW), windowStats(windowRows, NOW))[0]);
    expect(pair!.poolId).toBe(POOL);
    expect(gqlMock.mock.calls[1]![0]).toContain(`pool_id: { _eq: "${POOL}" }`);
  });

  it("pair() is null for an unknown token and asks nothing more", async () => {
    gqlMock.mockResolvedValue({ Token: [], QuotePrice: [] });
    expect(await backend.pair(AI)).toBeNull();
    expect(gqlMock).toHaveBeenCalledTimes(1);
  });

  it("health() reports the lag and quote ages, and not ok when the chain lags", async () => {
    gqlMock.mockResolvedValue(healthy);
    expect(await backend.health()).toEqual({ ok: true, backend: "envio", lag: 0, quotes: [{ id: "0xquote", ageSec: 60, stale: false }] });
    gqlMock.mockResolvedValue({ ...healthy, chain_metadata: [{ chain_id: 4663, latest_processed_block: 1_000, block_height: 2_000 }] });
    expect(await backend.health()).toMatchObject({ ok: false, lag: 1_000 });
  });

  it("health() reports an unreachable indexer instead of throwing", async () => {
    gqlMock.mockRejectedValue(new Error("indexer unreachable: fetch failed"));
    expect(await backend.health()).toEqual({ ok: false, backend: "envio", lag: null, quotes: [], error: "indexer unavailable" });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
```

`src/lib/market/dbBackend.test.ts` (the parity proof at unit level: the same rows as sync records into PGlite and as M1 `TokenRow`s into `shapePairs()`, then `toEqual`):

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import type { CandleRow, PoolRow, QuotePriceRow, QuoteRow, SwapRow, TokenRow, WindowRow } from "@/lib/envio/queries";
import { shapeCandles, shapeHolders, shapePairs, shapeQuotes, shapeTrades, usdMap, windowStats } from "@/lib/envio/shape";
import { FakeSource } from "@/lib/sync/fakeSource";
import type { BalanceRec, CandleRec, PoolRec, QuotePriceRec, QuoteRec, SwapRec, TokenRec } from "@/lib/sync/source";
import { finishRun, readState, saveCursors } from "@/lib/sync/state";
import { insertSwaps, recomputeListedPools, replaceHolders, upsertCandles, upsertPools, upsertQuotes, upsertTokens } from "@/lib/sync/writers";
import { testDb } from "@/test/db";
import { createDbBackend } from "./dbBackend";

const NOW = 1_789_547_000; // not on an hour boundary, like real life
const H = (t: number) => Math.floor(t / 3600) * 3600;
const addr = (c: string) => `0x${c.repeat(40)}`;
const poolId = (c: string) => `0x${c.repeat(64)}`;
const NVDA = addr("1"), USDG = addr("2"), DEAD = addr("3"), NOFEED = addr("4");
const A = addr("a"), B = addr("b"), C = addr("c"), D = addr("d"), E = addr("e");
const PA = poolId("a"), PB_BROKEN = poolId("1"), PB = poolId("b"), PC = poolId("c"), PD = poolId("d"), PE = poolId("e");
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const SUPPLY = "1000000000000000000000000000";

const quotes: QuoteRec[] = [
  { id: NVDA, address: NVDA, symbol: "NVDA", name: "NVIDIA", decimals: 18, enabled: true },
  { id: USDG, address: USDG, symbol: "USDG", name: "Global Dollar", decimals: 6, enabled: true },
  { id: DEAD, address: DEAD, symbol: "DEAD", name: "Dead feed", decimals: 18, enabled: true },
  { id: NOFEED, address: NOFEED, symbol: "GLD", name: "No feed", decimals: 18, enabled: true },
];
// Hasura sends every Float as a string; the writers convert, the M1 shaping does too.
const prices: QuotePriceRec[] = [
  { id: NVDA, usdPrice: "120.5", updatedAt: NOW - 60, aggregator: "0xfeed" },
  { id: USDG, usdPrice: "1", updatedAt: NOW - 8_500_000, aggregator: "pinned" }, // 99 days old, never stale
  { id: DEAD, usdPrice: "50", updatedAt: NOW - 400_000, aggregator: "0xfeed" }, // 4 days old: stale
];
function poolRec(id: string, token: string, quote: string, over: Partial<PoolRec> = {}): PoolRec {
  return {
    id, token_id: token, quote_id: quote, tokenIsCurrency0: true, hooks: addr("9"), fee: 3000, tickSpacing: 60, origin: "LONG",
    createdAt: NOW - 5_000_000, priceQuote: "0.000866", tvlToken: "1000000000000000000000000", tvlQuote: "10000000000000000000000",
    swapCount: 10, lastSwapAt: NOW - 100, volumeQuoteAllTime: "1", ...over,
  };
}
const pools: PoolRec[] = [
  poolRec(PA, A, NVDA),
  // B: the primary is parked at a tick boundary and traded most recently; the sane fallback decides both listing and order.
  poolRec(PB_BROKEN, B, USDG, { origin: "Pons", priceQuote: "3.4e50", swapCount: 5, lastSwapAt: NOW - 10 }),
  poolRec(PB, B, USDG, { origin: "Pons", priceQuote: "0.5", swapCount: 3, lastSwapAt: NOW - 200, tvlQuote: "5000000" }),
  poolRec(PC, C, DEAD, { origin: "Uniswap", lastSwapAt: NOW - 1000, tvlToken: null, tvlQuote: null }),
  poolRec(PD, D, NVDA, { origin: "Other", swapCount: 0, lastSwapAt: null }), // never traded: not listed
  poolRec(PE, E, NOFEED, { fee: 8388608, lastSwapAt: NOW - 2000 }),
];
function tokenRec(id: string, symbol: string, origin: string, primary: string, over: Partial<TokenRec> = {}): TokenRec {
  return {
    id, address: id, symbol, name: `${symbol} token`, decimals: 18, totalSupply: SUPPLY, holdersCount: 42, poolCount: 1,
    origin, createdAt: NOW - 5_000_000, primaryPool_id: primary, metadataLoaded: true, ...over,
  };
}
const tokens: TokenRec[] = [
  tokenRec(A, "AAA", "LONG", PA), tokenRec(B, "BBB", "Pons", PB_BROKEN, { poolCount: 2 }), tokenRec(C, "CCC", "Uniswap", PC),
  tokenRec(D, "DDD", "Other", PD), tokenRec(E, "EEE", "LONG", PE),
];
const candle = (pool: string, interval: string, t: number, open: number, close: number, vol: number): CandleRec => ({
  id: `${pool}-${interval}-${t}`, pool_id: pool, t, open: String(open), high: String(Math.max(open, close)), low: String(Math.min(open, close)),
  close: String(close), volumeQuote: String(vol), volumeToken: "1", trades: 1,
});
const candles: CandleRec[] = [
  candle(PA, "h1", H(NOW), 0.0009, 0.00087, 10), candle(PA, "h1", H(NOW - 3600), 0.00088, 0.0009, 8.6),
  candle(PA, "h1", H(NOW - 86400), 0.001, 0.00095, 0), candle(PA, "h1", H(NOW - 30 * 3600), 0.0011, 0.001, 999),
  candle(PA, "m5", Math.floor(NOW / 300) * 300, 5, 5, 5), // must never reach the window stats
  candle(PB, "h1", H(NOW - 3600), 0.4, 0.5, 2),
  candle(PA, "m15", NOW - 1800, 0.00095, 0.0009, 4), candle(PA, "m15", NOW - 900, 0.0009, 0.0009, 3),
];
const swap = (n: number, ts: number, side: "buy" | "sell"): SwapRec => ({
  id: `${poolId(String(n))}-${n}`, pool_id: PA, token_id: A, timestamp: ts, side, amountToken: "15749", amountQuote: "13.6",
  priceQuote: "0.000865", wallet: addr("5"), txHash: poolId(String(n)),
});
const swaps = [swap(1, NOW - 90, "buy"), swap(2, NOW - 30, "sell"), swap(3, NOW - 60, "buy")];
const bal = (holder: string, balance: string): BalanceRec => ({ id: `${A}-${holder}`, token_id: A, holder, balance, updatedAt: NOW - 100 });
const stored = [bal(addr("6"), "500000000000000000000000000"), bal(POOL_MANAGER, "100000000000000000000000000")];
const pulled = [bal(addr("7"), "900000000000000000000000000"), bal(addr("6"), "400000000000000000000000000")];

// The same fixtures as M1 receives them from Hasura, so shapePairs() can be the oracle.
const quoteOf = new Map(quotes.map((q) => [q.id, { symbol: q.symbol, decimals: q.decimals }]));
const poolById = new Map(pools.map((p) => [p.id, p]));
const poolRow = (p: PoolRec): PoolRow => ({
  id: p.id, quote_id: p.quote_id, tokenIsCurrency0: p.tokenIsCurrency0, hooks: p.hooks, fee: p.fee, tickSpacing: p.tickSpacing, origin: p.origin,
  createdAt: p.createdAt, priceQuote: p.priceQuote, tvlToken: p.tvlToken, tvlQuote: p.tvlQuote, swapCount: p.swapCount, lastSwapAt: p.lastSwapAt,
  quote: quoteOf.get(p.quote_id)!,
});
const tokenRow = (t: TokenRec, fallback?: string): TokenRow => ({
  id: t.id, address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, totalSupply: t.totalSupply, holdersCount: t.holdersCount,
  origin: t.origin, createdAt: t.createdAt, primaryPool: poolRow(poolById.get(t.primaryPool_id!)!),
  fallbackPool: fallback ? [poolRow(poolById.get(fallback)!)] : undefined,
});
const m1Prices: QuotePriceRow[] = prices;
const m1Window: WindowRow[] = candles.filter((c) => c.id.includes("-h1-")).map((c) => ({ pool_id: c.pool_id, t: c.t, open: c.open, close: c.close, volumeQuote: c.volumeQuote }));
const candleRow = (c: CandleRec): CandleRow => ({ t: c.t, open: c.open, high: c.high, low: c.low, close: c.close, volumeQuote: c.volumeQuote });
const swapRow = (s: SwapRec): SwapRow => ({ timestamp: s.timestamp, side: s.side, amountToken: s.amountToken, priceQuote: s.priceQuote, wallet: s.wallet, txHash: s.txHash });
const balanceRow = (b: BalanceRec) => ({ holder: b.holder, balance: b.balance });
/** What M1 lists, in M1's order: the listed pool's last swap, newest first. D never traded and is absent. */
const expected = shapePairs([tokenRow(tokens[0]!), tokenRow(tokens[1]!, PB), tokenRow(tokens[2]!), tokenRow(tokens[4]!)], usdMap(m1Prices, NOW), windowStats(m1Window, NOW));

describe("createDbBackend reads", () => {
  let db: Db;
  let source: FakeSource;
  let now = NOW;
  const backend = () => createDbBackend(db, source, () => now);
  const topHolderCalls = () => source.calls.filter((c) => c === "topHolders").length;

  beforeAll(async () => {
    db = await testDb();
    await upsertQuotes(db, quotes, prices);
    await upsertTokens(db, tokens, NOW);
    await upsertPools(db, pools, NOW);
    await insertSwaps(db, swaps);
    await upsertCandles(db, candles);
    await replaceHolders(db, A, stored, NOW - 10); // refreshed just now
    await recomputeListedPools(db, "all");
    source = new FakeSource({ balances: pulled, chain: { latestProcessedBlock: 995, blockHeight: 1000 } });
  });
  afterAll(() => db.end());
  beforeEach(() => {
    clearTtlCache(); // pairs() memoises per scope, like loadPairs
    now = NOW;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("pairs('all') equals shapePairs() over the same rows, field for field, ordered by the listed pool's last swap", async () => {
    const out = await backend().pairs("all");
    expect(out.map((p) => p.id)).toEqual([A, B, C, E]);
    expect(out).toEqual(expected);
    // Spot checks so a wrong oracle cannot hide a wrong reader.
    expect(out[0]!.priceUsd).toBeCloseTo(0.000866 * 120.5, 12);
    expect(out[0]!.change1h).toBeCloseTo((0.000866 / 0.00088 - 1) * 100, 9);
    expect(out[0]!.vol24h).toBeCloseTo(18.6 * 120.5, 6);
    expect(out[1]).toMatchObject({ poolId: PB, origin: "Pons", quote: "USDG", stale: false, liquidity: 5 + 1_000_000 * 0.5 });
    expect(out[2]).toMatchObject({ stale: true, priceUsd: 0, liquidity: null, change1h: null, hook: "None" });
    expect(out[3]).toMatchObject({ stale: true, feeTier: "Dynamic", createdAt: (NOW - 5_000_000) * 1000 });
  });

  it("pairs('launchpad') keeps LONG and Pons tokens only", async () => {
    expect((await backend().pairs("launchpad")).map((p) => p.id)).toEqual([A, B, E]);
  });

  it("pair() answers one listed token and null for an unlisted or unknown one", async () => {
    expect(await backend().pair(B)).toEqual(expected[1]);
    expect(await backend().pair(D)).toBeNull();
    expect(await backend().pair(addr("f"))).toBeNull();
  });

  it("quotes() equals shapeQuotes() over the store's quotes, counting the pairs of pairs('all')", async () => {
    const m1Quotes: QuoteRow[] = quotes.map((q) => ({ id: q.id, symbol: q.symbol, name: q.name, decimals: q.decimals, address: q.address }));
    const out = await backend().quotes();
    expect(out).toEqual(shapeQuotes(m1Quotes, expected, usdMap(m1Prices, NOW), m1Prices, NOW));
    expect(out.map((q) => q.symbol).sort()).toEqual(["DEAD", "GLD", "NVDA", "USDG"]);
    expect(out.find((q) => q.symbol === "USDG")).toMatchObject({ usdPrice: 1, stale: false }); // pinned: never stale
    expect(out.find((q) => q.symbol === "GLD")).toMatchObject({ usdPrice: 0, stale: true }); // no feed row at all
  });

  it("candles() serves the listed pool's interval oldest-first in USD and ms, empty without a usable USD price", async () => {
    const m15 = candles.filter((c) => c.id.includes("-m15-"));
    expect(await backend().candles(A, "m15")).toEqual(shapeCandles(m15.map(candleRow), () => 120.5));
    expect(await backend().candles(C, "m15")).toEqual([]); // stale quote: an empty chart beats a chart on the floor
    expect(await backend().candles(D, "m15")).toEqual([]); // no listed pool
  });

  it("trades() serves the 50 newest swaps priced in USD", async () => {
    expect(await backend().trades(A)).toEqual(shapeTrades([swaps[1]!, swaps[2]!, swaps[0]!].map(swapRow), 120.5, "AAA"));
    expect(await backend().trades(D)).toEqual([]);
  });

  it("holders() serves stored rows without asking Envio while the refresh is fresh", async () => {
    const before = topHolderCalls();
    expect(await backend().holders(A)).toEqual({ holders: shapeHolders(stored.map(balanceRow), 18, BigInt(SUPPLY)), count: 42 });
    expect(topHolderCalls()).toBe(before);
    expect(await backend().holders(addr("f"))).toEqual({ holders: [], count: 0 });
  });

  it("holders() re-pulls the top 100 and replaces the rows once the refresh is older than 300 s", async () => {
    now = NOW + 301; // refreshed at NOW - 10: 311 s ago
    const before = topHolderCalls();
    expect(await backend().holders(A)).toEqual({ holders: shapeHolders(pulled.map(balanceRow), 18, BigInt(SUPPLY)), count: 42 });
    expect(topHolderCalls()).toBe(before + 1);
    expect(await db.query("select refreshed_at from market.holder_refresh where token_id = $1", [A])).toEqual([{ refreshed_at: NOW + 301 }]);
  });

  it("holders() serves the stored rows when Envio fails, without stamping a refresh", async () => {
    now = NOW + 700; // stale again
    source.failOn = { method: "topHolders", error: new Error("indexer unreachable: fetch failed") };
    expect(await backend().holders(A)).toEqual({ holders: shapeHolders(pulled.map(balanceRow), 18, BigInt(SUPPLY)), count: 42 });
    expect(await db.query("select refreshed_at from market.holder_refresh where token_id = $1", [A])).toEqual([{ refreshed_at: NOW + 301 }]);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe("createDbBackend limits", () => {
  it("caps pairs at 500, candles at the 300 newest and trades at 50", async () => {
    const db = await testDb();
    clearTtlCache();
    const hex = (i: number, len: number) => `0x${i.toString(16).padStart(len, "0")}`;
    const n = 505;
    await upsertQuotes(db, [quotes[0]!], [prices[0]!]);
    await upsertTokens(db, Array.from({ length: n }, (_, i) => tokenRec(hex(i + 1, 40), `T${i}`, "LONG", hex(i + 1, 64))), NOW);
    await upsertPools(db, Array.from({ length: n }, (_, i) => poolRec(hex(i + 1, 64), hex(i + 1, 40), NVDA, { lastSwapAt: NOW - i })), NOW);
    await recomputeListedPools(db, "all");
    await upsertCandles(db, Array.from({ length: 310 }, (_, i) => candle(hex(1, 64), "m1", NOW - 60 * i, 1, 1, 1)));
    await insertSwaps(db, Array.from({ length: 60 }, (_, i) => ({ ...swap(1, NOW - i, "buy"), id: `${hex(1, 64)}-${i}`, pool_id: hex(1, 64), token_id: hex(1, 40), txHash: hex(1, 64) })));
    const backend = createDbBackend(db, new FakeSource({}), () => NOW);
    const pairs = await backend.pairs("all");
    expect(pairs).toHaveLength(500);
    expect(pairs[0]!.id).toBe(hex(1, 40)); // newest swap first
    const c = await backend.candles(hex(1, 40), "m1");
    expect(c).toHaveLength(300);
    expect(c[0]!.t).toBe((NOW - 60 * 299) * 1000); // the 300 newest, then oldest first
    expect(await backend.trades(hex(1, 40))).toHaveLength(50);
    await db.end();
  });
});

describe("createDbBackend health", () => {
  let db: Db;
  let source: FakeSource;
  let now = NOW;
  const backend = () => createDbBackend(db, source, () => now);

  beforeAll(async () => {
    db = await testDb();
    await upsertQuotes(db, [quotes[0]!, quotes[3]!], [prices[0]!]); // one fed quote, one without a feed
    source = new FakeSource({ chain: { latestProcessedBlock: 995, blockHeight: 1000 } });
  });
  afterAll(() => db.end());
  beforeEach(() => {
    now = NOW;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("is not ok before the sync has ever succeeded, and still reports everything it knows", async () => {
    const h = await backend().health();
    expect(h).toMatchObject({
      ok: false, backend: "db", lag: 5, quotes: [{ id: NVDA, ageSec: 60, stale: false }],
      sync: { lastOkAgeSec: null, cursorAgeSec: null, lastError: null }, nightly: { lastOkAgeSec: null, lastError: null },
    });
    expect(h.db!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("is ok once the market sync succeeded within 300 s", async () => {
    await readState(db, "market");
    await readState(db, "nightly");
    await saveCursors(db, "market", { cursor: NOW - 120 });
    await finishRun(db, "market", { now: NOW - 30, ok: true, rows: 10, queries: 4 });
    await finishRun(db, "nightly", { now: NOW - 3600, ok: true, rows: 0, queries: 0 });
    expect(await backend().health()).toMatchObject({
      ok: true, sync: { lastOkAgeSec: 30, cursorAgeSec: 120, lastError: null }, nightly: { lastOkAgeSec: 3600, lastError: null },
    });
  });

  it("carries the last error, and turns not ok when the last success is older than 300 s", async () => {
    await finishRun(db, "market", { now: NOW, ok: false, error: "indexer responded 429", rows: 0, queries: 1 });
    expect(await backend().health()).toMatchObject({ ok: true, sync: { lastOkAgeSec: 30, lastError: "indexer responded 429" } });
    now = NOW + 400;
    expect((await backend().health()).ok).toBe(false);
  });

  it("keeps serving with lag null when the indexer cannot be asked", async () => {
    source.failOn = { method: "chainMeta", error: new Error("indexer unreachable: fetch failed") };
    expect(await backend().health()).toMatchObject({ ok: true, lag: null });
  });

  it("answers not ok with no report when the database does not answer", async () => {
    const broken: Db = { ...db, query: async () => { throw new Error("connection refused"); } };
    expect(await createDbBackend(broken, source, () => now).health()).toEqual({ ok: false, backend: "db", lag: null, quotes: [], error: "database unavailable" });
  });
});
```

- [ ] **Step 3: Run the new tests to see them fail**

Run: `npx vitest run src/lib/market`
Expected: FAIL, each file with `Failed to resolve import "./envioBackend"` / `'./dbBackend'` (backend.ts imports both).

- [ ] **Step 4: Move the six route bodies behind the interface**

`src/lib/market/envioBackend.ts`:

```ts
import { gql } from "@/lib/envio/client";
import { loadPairs } from "@/lib/envio/pairs";
import {
  CANDLES_QUERY, HEALTH_QUERY, HOLDERS_QUERY, QUOTES_QUERY, TOKEN_QUERY, TRADES_QUERY, windowQuery,
  type BalanceRow, type CandleRow, type QuotePriceRow, type QuoteRow, type SwapRow, type TokenRow, type WindowRow,
} from "@/lib/envio/queries";
import { isStale, resolvePool, shapeCandles, shapeHolders, shapePairs, shapeQuotes, shapeTrades, usdMap, windowStats } from "@/lib/envio/shape";
import { nowSec } from "@/lib/time";
import type { HealthReport, MarketBackend } from "./backend";

const CHAIN_ID = 4663;
const MAX_LAG = 500;
type TokenRows = { Token: TokenRow[]; QuotePrice: QuotePriceRow[] };
type HealthRows = {
  chain_metadata: { chain_id: number; latest_processed_block: number; block_height: number }[];
  QuotePrice: { id: string; updatedAt: number; aggregator: string }[];
};
/** The same window as `loadWindowRows` in pairs.ts: h1 candles from a day before the 24h bucket. */
const windowSince = (now: number) => Math.floor((now - 86400) / 3600) * 3600 - 86400;

/** The M1 route bodies, unchanged, behind the interface. `pairs` keeps its memo inside `loadPairs`. */
export function createEnvioBackend(): MarketBackend {
  return {
    kind: "envio",
    pairs: (scope) => loadPairs(scope),
    async pair(id) {
      const now = nowSec();
      const t = await gql<TokenRows>(TOKEN_QUERY, { id });
      const token = t.Token[0];
      const pool = token ? resolvePool(token) : null;
      if (!token || !pool) return null;
      const w = await gql<Record<string, WindowRow[]>>(windowQuery([pool.id], windowSince(now)));
      return shapePairs([token], usdMap(t.QuotePrice, now), windowStats(Object.values(w).flat(), now))[0] ?? null;
    },
    async quotes() {
      const now = nowSec();
      const [q, pairs] = await Promise.all([gql<{ Quote: QuoteRow[]; QuotePrice: QuotePriceRow[] }>(QUOTES_QUERY), loadPairs()]);
      return shapeQuotes(q.Quote, pairs, usdMap(q.QuotePrice, now), q.QuotePrice, now);
    },
    async candles(id, interval) {
      const now = nowSec();
      const t = await gql<TokenRows>(TOKEN_QUERY, { id });
      const token = t.Token[0];
      const pool = token ? resolvePool(token) : null;
      if (!pool) return [];
      const rows = await gql<{ Candle: CandleRow[] }>(CANDLES_QUERY, { pool: pool.id, like: `${pool.id}-${interval}-%`, limit: 300 });
      // One current USD price per quote in M1; per-candle history is an M6 refinement.
      const usd = usdMap(t.QuotePrice, now).get(pool.quote_id) ?? null;
      return shapeCandles(rows.Candle, () => usd);
    },
    async trades(id) {
      const t = await gql<TokenRows>(TOKEN_QUERY, { id });
      const token = t.Token[0];
      const pool = token ? resolvePool(token) : null;
      if (!token || !pool) return [];
      const rows = await gql<{ Swap: SwapRow[] }>(TRADES_QUERY, { pool: pool.id });
      return shapeTrades(rows.Swap, usdMap(t.QuotePrice, nowSec()).get(pool.quote_id) ?? null, token.symbol);
    },
    async holders(id) {
      const t = await gql<TokenRows>(TOKEN_QUERY, { id });
      const token = t.Token[0];
      if (!token) return { holders: [], count: 0 };
      const rows = await gql<{ TokenBalance: BalanceRow[] }>(HOLDERS_QUERY, { token: id });
      return { holders: shapeHolders(rows.TokenBalance, token.decimals, BigInt(token.totalSupply)), count: token.holdersCount };
    },
    async health(): Promise<HealthReport> {
      try {
        const h = await gql<HealthRows>(HEALTH_QUERY);
        const chain = h.chain_metadata.find((c) => c.chain_id === CHAIN_ID);
        const now = nowSec();
        const quotes = h.QuotePrice.map((q) => ({ id: q.id, ageSec: now - q.updatedAt, stale: isStale(q, now) }));
        const lag = chain ? chain.block_height - chain.latest_processed_block : null;
        return { ok: lag !== null && lag < MAX_LAG && quotes.every((q) => !q.stale), backend: "envio", lag, quotes };
      } catch (err) {
        // Logged, never echoed: the indexer's error text is not for the public.
        console.warn(`health check failed: ${String(err)}`);
        return { ok: false, backend: "envio", lag: null, quotes: [], error: "indexer unavailable" };
      }
    },
  };
}
```

- [ ] **Step 5: Write the store backend**

`src/lib/market/dbBackend.ts`:

```ts
import type { Db } from "@/lib/db/client";
import { ttlCache } from "@/lib/envio/cache";
import { PAIRS_LIMIT, PAIRS_TTL, type PairsScope } from "@/lib/envio/pairs";
import type { BalanceRow, CandleRow, QuotePriceRow, QuoteRow, SwapRow, WindowRow } from "@/lib/envio/queries";
import { isStale, shapeCandles, shapeHolders, shapeQuotes, shapeTrades, usdMap, windowStats } from "@/lib/envio/shape";
import type { BalanceRec, EnvioSource } from "@/lib/sync/source";
import { replaceHolders } from "@/lib/sync/writers";
import { nowSec } from "@/lib/time";
import type { HealthReport, MarketBackend } from "./backend";
import { PAIR_SELECT, pairFromRow, type PairRow } from "./dbShape";

/** A token's stored top holders are re-pulled from Envio when older than this (spec 5.4). */
export const HOLDER_REFRESH_SEC = 300;
const SYNC_OK_WITHIN_SEC = 300;
const HOLDERS_SHOWN = 10;
const HOLDERS_PULLED = 100;
const TRADES_LIMIT = 50;
const CANDLES_LIMIT = 300;
/** The same window as `loadWindowRows` in pairs.ts: h1 candles from a day before the 24h bucket. */
const windowSince = (now: number) => Math.floor((now - 86400) / 3600) * 3600 - 86400;

type QuoteCols = { usd_price: number | null; usd_updated_at: number | null; aggregator: string | null };
type ListedRow = { symbol: string; pool_id: string; quote_id: string } & QuoteCols;
type TokenCols = { decimals: number; total_supply: string; holders_count: number };
type StateRow = { job: string; cursor: number; last_ok_at: number | null; last_error: string | null };

/** usdMap() for one stored quote: null without a feed row or when the feed is stale. */
function quoteUsd(q: QuoteCols, now: number): number | null {
  if (q.usd_price === null || q.usd_updated_at === null) return null;
  return isStale({ updatedAt: q.usd_updated_at, aggregator: q.aggregator ?? "" }, now) ? null : q.usd_price;
}

const ORDER = `order by p.last_swap_at desc nulls last, p.id limit ${PAIRS_LIMIT}`;
const PAIRS_SQL: Record<PairsScope, string> = {
  all: `${PAIR_SELECT} ${ORDER}`,
  // A token's origin equals its pools' origin (the indexer keeps them equal); tokens_origin_listed carries this.
  launchpad: `${PAIR_SELECT} where t.origin in ('LONG', 'Pons') ${ORDER}`,
};
const WINDOW_SQL = `select pool_id, t, open, close, volume_quote as "volumeQuote" from market.candles
  where pool_id = any($1::text[]) and interval = 'h1' and t >= $2 order by t`;
const LISTED_SQL = `select t.symbol, p.id as pool_id, p.quote_id, q.usd_price, q.usd_updated_at, q.aggregator
  from market.tokens t join market.pools p on p.id = t.listed_pool_id join market.quotes q on q.id = p.quote_id where t.id = $1`;
const TOKEN_SQL = `select decimals, total_supply::text as total_supply, holders_count from market.tokens where id = $1`;
const CANDLES_SQL = `select t, open, high, low, close, volume_quote as "volumeQuote" from market.candles
  where pool_id = $1 and interval = $2 order by t desc limit ${CANDLES_LIMIT}`;
const TRADES_SQL = `select ts as timestamp, side, amount_token as "amountToken", price_quote as "priceQuote", wallet, tx_hash as "txHash"
  from market.swaps where pool_id = $1 order by ts desc limit ${TRADES_LIMIT}`;
const HOLDERS_SQL = `select holder, balance::text as balance from market.token_balances
  where token_id = $1 and balance > 0 order by balance desc limit ${HOLDERS_SHOWN}`;
const REFRESH_SQL = `select refreshed_at from market.holder_refresh where token_id = $1`;
const QUOTES_SQL = `select id, address, symbol, name, decimals, usd_price, usd_updated_at, aggregator from market.quotes order by id`;
const STATE_SQL = `select job, cursor, last_ok_at, last_error from market.sync_state where job in ('market', 'nightly')`;
const QUOTE_AGES_SQL = `select id, usd_updated_at, aggregator from market.quotes where usd_updated_at is not null order by id`;

/** SQL readers with M1's semantics (spec section 8). `now` is injectable for the tests. */
export function createDbBackend(db: Db, source: EnvioSource, now: () => number = nowSec): MarketBackend {
  async function shapeRows(rows: PairRow[], at: number) {
    if (rows.length === 0) return [];
    const win = await db.query<WindowRow>(WINDOW_SQL, [rows.map((r) => r.pool_id), windowSince(at)]);
    const stats = windowStats(win, at);
    return rows.map((r) => pairFromRow(r, stats.get(r.pool_id), at));
  }
  const listed = async (id: string) => (await db.query<ListedRow>(LISTED_SQL, [id]))[0] ?? null;

  const backend: MarketBackend = {
    kind: "db",
    // The memo lives here under its own key: quotes() reuses the pair set exactly as M1 does, and the
    // Envio backend's `pairs:${scope}` entry stays separate so the parity script can hold both in one process.
    pairs: (scope) => ttlCache(`pairs:db:${scope}`, PAIRS_TTL * 1000, async () => shapeRows(await db.query<PairRow>(PAIRS_SQL[scope]), now())),
    async pair(id) {
      const rows = await db.query<PairRow>(`${PAIR_SELECT} where t.id = $1`, [id]);
      return (await shapeRows(rows, now()))[0] ?? null;
    },
    async quotes() {
      const at = now();
      const [rows, pairs] = await Promise.all([db.query<QuoteRow & QuoteCols>(QUOTES_SQL), backend.pairs("all")]);
      const prices: QuotePriceRow[] = rows.flatMap((q) =>
        q.usd_price === null || q.usd_updated_at === null ? [] : [{ id: q.id, usdPrice: q.usd_price, updatedAt: q.usd_updated_at, aggregator: q.aggregator ?? "" }],
      );
      return shapeQuotes(rows, pairs, usdMap(prices, at), prices, at);
    },
    async candles(id, interval) {
      const l = await listed(id);
      if (!l) return [];
      const rows = await db.query<CandleRow>(CANDLES_SQL, [l.pool_id, interval]);
      const usd = quoteUsd(l, now()); // one current USD price per quote, as in M1
      return shapeCandles(rows, () => usd);
    },
    async trades(id) {
      const l = await listed(id);
      if (!l) return [];
      return shapeTrades(await db.query<SwapRow>(TRADES_SQL, [l.pool_id]), quoteUsd(l, now()), l.symbol);
    },
    async holders(id) {
      const token = (await db.query<TokenCols>(TOKEN_SQL, [id]))[0];
      if (!token) return { holders: [], count: 0 };
      const at = now();
      const refreshedAt = (await db.query<{ refreshed_at: number }>(REFRESH_SQL, [id]))[0]?.refreshed_at ?? null;
      if (refreshedAt === null || at - refreshedAt > HOLDER_REFRESH_SEC) {
        let fresh: BalanceRec[] | undefined;
        try {
          fresh = await source.topHolders(id, HOLDERS_PULLED);
        } catch (err) {
          console.warn(`holders refresh failed for ${id}: ${String(err)}`); // the stored rows still serve
        }
        if (fresh) await replaceHolders(db, id, fresh, at);
      }
      const rows = await db.query<BalanceRow>(HOLDERS_SQL, [id]);
      return { holders: shapeHolders(rows, token.decimals, BigInt(token.total_supply)), count: token.holders_count };
    },
    async health(): Promise<HealthReport> {
      const at = now();
      const t0 = Date.now();
      let states: StateRow[];
      try {
        states = await db.query<StateRow>(STATE_SQL);
      } catch (err) {
        console.warn(`health check failed: ${String(err)}`);
        return { ok: false, backend: "db", lag: null, quotes: [], error: "database unavailable" };
      }
      const latencyMs = Date.now() - t0;
      const market = states.find((s) => s.job === "market");
      const nightly = states.find((s) => s.job === "nightly");
      const ages = await db.query<{ id: string; usd_updated_at: number; aggregator: string | null }>(QUOTE_AGES_SQL);
      const quotes = ages.map((q) => ({ id: q.id, ageSec: at - q.usd_updated_at, stale: isStale({ updatedAt: q.usd_updated_at, aggregator: q.aggregator ?? "" }, at) }));
      let lag: number | null = null;
      try {
        const m = await source.chainMeta();
        lag = m.blockHeight - m.latestProcessedBlock;
      } catch (err) {
        console.warn(`indexer lag unavailable: ${String(err)}`); // informational: the store still serves
      }
      const sync = {
        lastOkAgeSec: market?.last_ok_at != null ? at - market.last_ok_at : null,
        cursorAgeSec: market && market.cursor > 0 ? at - market.cursor : null,
        lastError: market?.last_error ?? null,
      };
      const night = { lastOkAgeSec: nightly?.last_ok_at != null ? at - nightly.last_ok_at : null, lastError: nightly?.last_error ?? null };
      const ok = sync.lastOkAgeSec !== null && sync.lastOkAgeSec <= SYNC_OK_WITHIN_SEC && quotes.every((q) => !q.stale);
      return { ok, backend: "db", lag, quotes, db: { latencyMs }, sync, nightly: night };
    },
  };
  return backend;
}
```

- [ ] **Step 6: Run the backend tests**

Run: `npx vitest run src/lib/market`
Expected: PASS (3 files). If `pairs('all') equals shapePairs()` fails on a single float, the reader and the oracle disagree on a conversion: fix the reader (`pairFromRow` or the SQL), never the oracle.

- [ ] **Step 7: Flip the six routes to the seam and rewrite the health test**

`src/app/api/pairs/route.ts`:

```ts
import { PAIRS_TTL, type PairsScope } from "@/lib/envio/pairs";
import { getBackend } from "@/lib/market/backend";
import { cached, failure } from "../_lib/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const scope: PairsScope = new URL(req.url).searchParams.get("scope") === "launchpad" ? "launchpad" : "all";
  try {
    return cached(await getBackend().pairs(scope), PAIRS_TTL);
  } catch (err) {
    return failure(err);
  }
}
```

`src/app/api/quotes/route.ts`:

```ts
import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import { cached, failure } from "../_lib/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const TTL = 30;

export async function GET() {
  try {
    return cached(await ttlCache("quotes", TTL * 1000, () => getBackend().quotes()), TTL);
  } catch (err) {
    return failure(err);
  }
}
```

`src/app/api/tokens/[address]/candles/route.ts`:

```ts
import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import type { IndexerInterval } from "@/lib/sync/ids";
import { badRequest, cached, failure, isAddress } from "../../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 10;
const INTERVALS: Record<string, IndexerInterval> = { "1m": "m1", "5m": "m5", "15m": "m15", "1h": "h1", "1d": "d1" };

export async function GET(req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  // Validate before the cache: an unbounded key space is a memory leak, and a bad id is a 400.
  if (!isAddress(id)) return badRequest("bad address");
  const key = new URL(req.url).searchParams.get("interval") ?? "15m";
  // hasOwn, not a truthiness check: `?interval=constructor` would otherwise reach the backend.
  if (!Object.hasOwn(INTERVALS, key)) return badRequest("bad interval");
  const interval = INTERVALS[key]!;
  try {
    return cached(await ttlCache(`candles:${id}:${interval}`, TTL * 1000, () => getBackend().candles(id, interval)), TTL);
  } catch (err) {
    return failure(err);
  }
}
```

`src/app/api/tokens/[address]/trades/route.ts`:

```ts
import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import { badRequest, cached, failure, isAddress } from "../../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 10;

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  if (!isAddress(id)) return badRequest("bad address");
  try {
    return cached(await ttlCache(`trades:${id}`, TTL * 1000, () => getBackend().trades(id)), TTL);
  } catch (err) {
    return failure(err);
  }
}
```

`src/app/api/tokens/[address]/holders/route.ts`:

```ts
import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import { badRequest, cached, failure, isAddress } from "../../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 60;

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  if (!isAddress(id)) return badRequest("bad address");
  try {
    return cached(await ttlCache(`holders:${id}`, TTL * 1000, () => getBackend().holders(id)), TTL);
  } catch (err) {
    return failure(err);
  }
}
```

`src/app/api/health/route.ts`:

```ts
import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/envio/cache";
import { getBackend, type HealthReport } from "@/lib/market/backend";

export const dynamic = "force-dynamic";
/** Short: a monitor polling this must not be able to drive the indexer's or the database's budget. */
const TTL_MS = 5_000;

/**
 * Memoises the *outcome*, never an exception. `ttlCache` keeps serving the last good value when a
 * reload throws, so a loader that threw would pin this route at the last healthy answer for the
 * whole outage. Backends report their own failures; this catch covers a backend that throws anyway.
 */
function load(): Promise<HealthReport> {
  return ttlCache("health", TTL_MS, async () => {
    const backend = getBackend();
    try {
      return await backend.health();
    } catch (err) {
      console.warn(`health check failed: ${String(err)}`);
      return { ok: false, backend: backend.kind, lag: null, quotes: [], error: "health check failed" };
    }
  });
}

export async function GET() {
  // Always no-store: a cached health answer is worse than no health answer.
  const result = await load();
  return NextResponse.json(result, { status: result.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
```

`src/app/api/health/route.test.ts` (replaces the file; the indexer-specific cases now live in `envioBackend.test.ts`):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTtlCache } from "@/lib/envio/cache";
import type { HealthReport } from "@/lib/market/backend";
import { GET } from "./route";

// The backend is the seam: the route only memoises its outcome and picks the status.
const { health } = vi.hoisted(() => ({ health: vi.fn<() => Promise<HealthReport>>() }));
vi.mock("@/lib/market/backend", () => ({ getBackend: () => ({ kind: "envio", health }) }));

const NOW_SEC = 1_789_547_000;
const healthy: HealthReport = { ok: true, backend: "envio", lag: 0, quotes: [{ id: "0xquote", ageSec: 60, stale: false }] };
const down: HealthReport = { ok: false, backend: "envio", lag: null, quotes: [], error: "indexer unavailable" };

describe("GET /api/health", () => {
  beforeEach(() => {
    clearTtlCache();
    health.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("answers 503 no-store when the backend reports not ok", async () => {
    health.mockResolvedValue(down);
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual(down);
  });

  it("caches the outcome for the window instead of re-asking on every request", async () => {
    health.mockResolvedValue(down);
    expect((await GET()).status).toBe(503);
    expect((await GET()).status).toBe(503);
    // The point of Ruling 23: an outage must not cost one probe per request.
    expect(health).toHaveBeenCalledTimes(1);
  });

  it("answers 200 with the report while healthy", async () => {
    health.mockResolvedValue(healthy);
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(healthy);
  });

  it("re-asks once the window expires and reports the new outcome", async () => {
    health.mockResolvedValue(healthy);
    expect((await GET()).status).toBe(200);
    health.mockResolvedValue(down);
    expect((await GET()).status).toBe(200); // inside the window: nothing asked
    vi.advanceTimersByTime(6_000);
    expect((await GET()).status).toBe(503);
    expect(health).toHaveBeenCalledTimes(2);
  });

  it("turns a throwing backend into a 503 without caching an exception", async () => {
    health.mockRejectedValue(new Error("boom"));
    const res = await GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ ok: false, backend: "envio", lag: null, quotes: [], error: "health check failed" });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
```

Run: `npx vitest run src/app/api`
Expected: PASS (health, logo, _lib, internal).

- [ ] **Step 8: Write the failing token route test**

`src/app/api/tokens/[address]/route.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTtlCache } from "@/lib/envio/cache";
import { EnvioUnavailableError } from "@/lib/envio/client";
import type { TokenPair } from "@/lib/types";
import { GET } from "./route";

const { pair } = vi.hoisted(() => ({ pair: vi.fn<(id: string) => Promise<TokenPair | null>>() }));
vi.mock("@/lib/market/backend", () => ({ getBackend: () => ({ kind: "db", pair }) }));

const ADDR = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const CACHE = "public, s-maxage=30, stale-while-revalidate=60";
const call = (address: string) => GET(new Request(`http://localhost:3000/api/tokens/${address}`), { params: Promise.resolve({ address }) });
const found = { id: ADDR, ticker: "AI", name: "Artificial Inu" } as TokenPair;

describe("GET /api/tokens/[address]", () => {
  beforeEach(() => {
    clearTtlCache();
    pair.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("rejects a malformed address before touching the backend", async () => {
    const res = await call("not-an-address");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad address" });
    expect(pair).not.toHaveBeenCalled();
  });

  it("answers 404 with the list's cache header for an unknown token, and memoises that answer", async () => {
    pair.mockResolvedValue(null);
    const res = await call(ADDR);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "unknown token" });
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
    expect((await call(ADDR)).status).toBe(404);
    expect(pair).toHaveBeenCalledTimes(1); // ttlCache stores null as a value
  });

  it("answers the pair, lowercasing the path segment", async () => {
    pair.mockResolvedValue(found);
    const res = await call(ADDR.toUpperCase().replace("0X", "0x"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
    await expect(res.json()).resolves.toEqual(found);
    expect(pair).toHaveBeenCalledWith(ADDR);
  });

  it("answers 503 when the backend's source is unavailable", async () => {
    pair.mockRejectedValue(new EnvioUnavailableError("indexer responded 503"));
    const res = await call(ADDR);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("15");
  });
});
```

Run: `npx vitest run "src/app/api/tokens/[address]/route.test.ts"`
Expected: FAIL with `Failed to resolve import "./route"`.

- [ ] **Step 9: Write the token route**

`src/app/api/tokens/[address]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import { badRequest, cached, failure, isAddress } from "../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 30;

/** One TokenPair by address, listed or not: the token page's fallback when the 500-row list does not carry it. */
export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  if (!isAddress(id)) return badRequest("bad address");
  try {
    const pair = await ttlCache(`pair:${id}`, TTL * 1000, () => getBackend().pair(id));
    if (!pair) {
      // Unknown is a fact for the next 30 s too, so the CDN may hold it as long as the list.
      return NextResponse.json({ error: "unknown token" }, { status: 404, headers: { "Cache-Control": `public, s-maxage=${TTL}, stale-while-revalidate=60` } });
    }
    return cached(pair, TTL);
  } catch (err) {
    return failure(err);
  }
}
```

Run: `npx vitest run "src/app/api/tokens/[address]/route.test.ts"`
Expected: PASS (4 tests).

- [ ] **Step 10: Frontend: `pair(id)` on the data sources and the `usePair` fallback**

`src/lib/types.ts`, in `MarketsDataSource` right after `pairs(): Promise<TokenPair[]>;`:

```ts
  /** One token by address, listed or not; null when the source does not know it. */
  pair(id: string): Promise<TokenPair | null>;
```

`src/lib/data/envio.ts`, after the `pairs()` method:

```ts
  async pair(id: string): Promise<TokenPair | null> {
    const key = id.toLowerCase();
    const res = await fetch(`/api/tokens/${key}`, { cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`/api/tokens/${key}: ${res.status}`);
    return (await res.json()) as TokenPair;
  }
```

`src/lib/data/mock.ts`: the private lookup that throws is renamed so the interface method can take its name. Run `sed -i '' 's/this\.pair(id)/this.pairOrThrow(id)/g' src/lib/data/mock.ts` (five call sites: candles, trades, holders, quoteSwap, vote), then replace the method:

```ts
  private pair(id: string): TokenPair {
    const key = id.toLowerCase();
    const found = this.pairList.find((p) => p.id === key);
    if (!found) throw new Error(`Unknown pair: ${id}`);
    return found;
  }
```
with
```ts
  private pairOrThrow(id: string): TokenPair {
    const key = id.toLowerCase();
    const found = this.pairList.find((p) => p.id === key);
    if (!found) throw new Error(`Unknown pair: ${id}`);
    return found;
  }

  /** The list's own row, or null: the mock never knows a token outside its seed. */
  async pair(id: string): Promise<TokenPair | null> {
    await this.delay();
    const found = this.pairList.find((p) => p.id === id.toLowerCase());
    return found ? { ...found } : null;
  }
```

`src/hooks/useMarketsData.ts`: add `pair: (id: string) => ["pair", id] as const,` to `keys` after `pairs`, and replace `usePair`:

```ts
export function usePair(id: string) {
  const ds = useDataSource();
  const query = usePairs();
  const key = id.toLowerCase();
  const listed: TokenPair | undefined = query.data?.find((p) => p.id === key);
  // Only once the list has settled without the id: a token outside the 500-row window still has a page.
  const fallback = useQuery({
    queryKey: keys.pair(key),
    queryFn: () => ds.pair(key),
    staleTime: 30_000,
    enabled: !query.isPending && listed === undefined,
  });
  const pair: TokenPair | undefined = listed ?? fallback.data ?? undefined;
  // TokenView reads isPending for its skeleton; both flags cover both queries, so a deep link
  // never flashes "No token" while the fallback is still in flight.
  return { ...query, pair, isPending: query.isPending || fallback.isLoading, isLoading: query.isLoading || fallback.isLoading };
}
```

`fallback.isLoading` (pending and fetching) is the right flag: a disabled query is `isPending` forever, so `isPending` alone would never settle for a listed token.

- [ ] **Step 11: Gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green. `npm run build` lists `/api/tokens/[address]` next to its three children. Then `NEXT_PUBLIC_DATA_SOURCE=mock npm run dev`, open `/t/0x2e8c31162b855a2ffa90f6f8634643ad6f111e18` (AI, in the seed) and `/t/0x00000000000000000000000000000000000000aa` (not in the seed): the first renders, the second shows the skeleton briefly, then "No token at 0x0000…00aa." with no flash in between.

- [ ] **Step 12: Commit**

```bash
git add src/lib/market src/lib/envio/shape.ts src/app/api/pairs/route.ts src/app/api/quotes/route.ts src/app/api/health/route.ts src/app/api/health/route.test.ts "src/app/api/tokens/[address]/route.ts" "src/app/api/tokens/[address]/route.test.ts" "src/app/api/tokens/[address]/candles/route.ts" "src/app/api/tokens/[address]/trades/route.ts" "src/app/api/tokens/[address]/holders/route.ts" src/lib/types.ts src/lib/data/envio.ts src/lib/data/mock.ts src/hooks/useMarketsData.ts
git commit -m "Read market data through a MarketBackend, store or Envio, and add GET /api/tokens/[address]" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

### Task 7: Seed and parity

**Files:**
- Create: `src/lib/seed/seed.ts`, `scripts/seed/seed.mts`, `scripts/db/parity.mts`, `scripts/README.md`
- Modify: `package.json` (only if a script line from the contract is missing)
- Test: `src/lib/seed/seed.test.ts` (PGlite + FakeSource)

**Interfaces:**
- Consumes: `Db`, `createDb` (`src/lib/db/client.ts`); `testDb()`; `EnvioSource`, the record types, `FakeSource`; `createEnvioSource`, `createLimiter`; `parseCandleId`, `parseSwapId` (`src/lib/sync/ids.ts`); `upsertQuotes`, `upsertTokens`, `upsertPools`, `insertSwaps`, `upsertCandles`, `recomputeListedPools`; `readState`, `saveCursors`, `finishRun`; Task 6's `createDbBackend`, `createEnvioBackend`.
- Produces: `SeedPhase`, `SEED_PHASES`, `HOLDERS_KEPT`, `Checkpoint`, `newCheckpoint`, `idRanges`, `SeedOpts`, `runSeed`; `npm run seed`, `npm run db:parity`.

Decisions where the contract is silent:
- `idRanges(n)` splits on the first hex digit after `0x`, so `n` is clamped to 1..16; the first range's lower bound is `"0x0"` and each `to` is the next range's `from`.
- A range that has finished stores the sentinel `"done"` in `checkpoint.ranges`; a resume skips it without a query. Ranges are cleared when a phase completes.
- COPY has no `on conflict`, and a process can die between a page's COPY and its checkpoint save; therefore the first page of a *resumed* range goes through the idempotent writer (`insertSwaps`, `upsertCandles`, a local `upsertBalances`) and every later page COPYs.
- Checkpoint saves are serialised through a promise chain so three workers never interleave writes of the one file.
- `parity.mts` prints the report and exits 0 either way: tokens that traded after the last cycle always differ, so an exit code could not mean "clean".

- [ ] **Step 1: Write the failing seed tests**

`src/lib/seed/seed.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { FakeSource } from "@/lib/sync/fakeSource";
import type { BalanceRec, CandleRec, PoolRec, SwapRec, TokenRec } from "@/lib/sync/source";
import { readState } from "@/lib/sync/state";
import { testDb } from "@/test/db";
import { idRanges, newCheckpoint, runSeed, SEED_PHASES, type Checkpoint } from "./seed";

const NOW = 1_789_547_000;
const hex = (c: string, len: number) => `0x${c.repeat(len)}`;
const count = async (db: Db, table: string) => Number((await db.query<{ n: unknown }>(`select count(*) as n from market.${table}`))[0]!.n);

describe("idRanges", () => {
  it("splits the hex space into contiguous prefix ranges, the last open-ended", () => {
    expect(idRanges(3)).toEqual([
      { key: "r0", from: "0x0", to: "0x5" }, { key: "r1", from: "0x5", to: "0xa" }, { key: "r2", from: "0xa", to: null },
    ]);
  });
  it("places every 0x id in exactly one range for any worker count", () => {
    const ids = ["0x0000", "0x4fff", "0x5000", "0x9abc", "0xa000", "0xffff"];
    for (const n of [1, 2, 3, 5, 16, 40]) {
      const ranges = idRanges(n);
      expect(ranges).toHaveLength(Math.min(n, 16));
      expect(ranges[0]!.from).toBe("0x0");
      expect(ranges[ranges.length - 1]!.to).toBeNull();
      for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.from).toBe(ranges[i - 1]!.to);
      for (const id of ids) expect(ranges.filter((r) => id > r.from && (r.to === null || id < r.to))).toHaveLength(1);
    }
  });
});

const TOKEN_A = hex("1", 40), TOKEN_B = hex("c", 40), POOL_A = hex("1", 64), POOL_B = hex("c", 64), QUOTE = hex("9", 40);
const token = (id: string, pool: string): TokenRec => ({
  id, address: id, symbol: "T", name: "T", decimals: 18, totalSupply: "1000", holdersCount: 3, poolCount: 1, origin: "LONG",
  createdAt: NOW - 100, primaryPool_id: pool, metadataLoaded: true,
});
const pool = (id: string, tokenId: string): PoolRec => ({
  id, token_id: tokenId, quote_id: QUOTE, tokenIsCurrency0: true, hooks: hex("0", 40), fee: 3000, tickSpacing: 60, origin: "LONG",
  createdAt: NOW - 100, priceQuote: "1", tvlToken: null, tvlQuote: null, swapCount: 2, lastSwapAt: NOW - 50, volumeQuoteAllTime: "1",
});
const swap = (tx: string): SwapRec => ({
  id: `${tx}-0`, pool_id: POOL_A, token_id: TOKEN_A, timestamp: NOW, side: "buy", amountToken: "1", amountQuote: "1", priceQuote: "1", wallet: hex("5", 40), txHash: tx,
});
const candle = (poolId: string, t: number): CandleRec => ({ id: `${poolId}-m1-${t}`, pool_id: poolId, t, open: "1", high: "1", low: "1", close: "1", volumeQuote: "1", volumeToken: "1", trades: 1 });
const balance = (tokenId: string, holder: string, bal: string): BalanceRec => ({ id: `${tokenId}-${holder}`, token_id: tokenId, holder, balance: bal, updatedAt: NOW });
// Ids spread over the three ranges of idRanges(3): 0x0-0x4, 0x5-0x9, 0xa-0xf. Page limit 2 forces multi-page ranges.
const data = {
  quotes: [{ id: QUOTE, address: QUOTE, symbol: "Q", name: "Q", decimals: 18, enabled: true }],
  prices: [{ id: QUOTE, usdPrice: "1", updatedAt: NOW, aggregator: "pinned" }],
  tokens: [token(TOKEN_A, POOL_A), token(TOKEN_B, POOL_B)],
  pools: [pool(POOL_A, TOKEN_A), pool(POOL_B, TOKEN_B)],
  swaps: [swap(hex("1", 64)), swap(hex("7", 64)), swap(hex("c", 64)), swap(hex("d", 64)), swap(hex("e", 64))],
  candles: [candle(POOL_A, NOW - 60), candle(POOL_A, NOW), candle(POOL_B, NOW - 60), candle(POOL_B, NOW)],
  balances: [balance(TOKEN_A, hex("a", 40), "300"), balance(TOKEN_A, hex("b", 40), "200"), balance(TOKEN_A, hex("c", 40), "100"), balance(TOKEN_B, hex("d", 40), "50")],
  chain: { latestProcessedBlock: 1, blockHeight: 1 },
};
const seedOpts = (checkpoint: Checkpoint, saves: Checkpoint[]) => ({
  checkpoint, save: async (c: Checkpoint) => { saves.push(c); }, workers: 3, pageLimit: 2, holdersKept: 2, log: () => {}, now: () => NOW + 1000,
});

describe("runSeed", () => {
  let db: Db;
  beforeAll(async () => { db = await testDb(); });
  afterAll(() => db.end());

  it("runs every phase, saves the checkpoint after each page, and finishes the store", async () => {
    const saves: Checkpoint[] = [];
    const cp = await runSeed(db, new FakeSource(data), seedOpts(newCheckpoint(NOW), saves));
    expect(cp.done).toEqual([...SEED_PHASES]);
    expect(cp.phase).toBe("finish");
    for (const [table, n] of [["quotes", 1], ["tokens", 2], ["pools", 2], ["swaps", 5], ["candles", 4]] as const) expect(await count(db, table)).toBe(n);
    // Trimmed to holdersKept per token: A keeps its two largest, B its one.
    expect(await db.query("select holder from market.token_balances where token_id = $1 order by balance desc", [TOKEN_A])).toEqual([{ holder: hex("a", 40) }, { holder: hex("b", 40) }]);
    expect(await count(db, "token_balances")).toBe(3);
    expect(await db.query("select id, listed_pool_id from market.tokens order by id")).toEqual([{ id: TOKEN_A, listed_pool_id: POOL_A }, { id: TOKEN_B, listed_pool_id: POOL_B }]);
    const market = await readState(db, "market");
    expect([market.cursor, market.cursor2]).toEqual([NOW - 600, NOW - 600]);
    expect((await readState(db, "nightly")).lastOkAt).toBe(NOW + 1000);
    // Swaps walk: r0 one page, r1 one page, r2 two pages (0xc,0xd then 0xe); each page saved with its last id.
    const swapSaves = saves.filter((c) => c.phase === "swaps");
    expect(swapSaves.some((c) => c.ranges.r2 === `${hex("d", 64)}-0`)).toBe(true);
    expect(swapSaves.some((c) => c.ranges.r0 === "done" && c.ranges.r1 === "done" && c.ranges.r2 === "done")).toBe(true);
  });

  it("resumes from a mid-phase checkpoint without re-reading completed phases or ranges", async () => {
    const fresh = await testDb();
    const source = new FakeSource(data);
    const checkpoint: Checkpoint = { startedAt: NOW, phase: "swaps", ranges: { r0: "done", r1: "done", r2: `${hex("c", 64)}-0` }, done: ["quotes", "tokens", "pools"] };
    const cp = await runSeed(fresh, source, seedOpts(checkpoint, []));
    expect(source.calls.filter((c) => c === "quotes" || c === "tokensPage" || c === "poolsPage")).toEqual([]);
    // r2 after 0xc…: one full page (0xd, 0xe), then the short page that ends it.
    expect(source.calls.filter((c) => c === "swapsPage")).toHaveLength(2);
    expect(await fresh.query("select tx_hash from market.swaps order by tx_hash")).toEqual([{ tx_hash: hex("d", 64) }, { tx_hash: hex("e", 64) }]);
    expect(cp.done).toEqual([...SEED_PHASES]);
    expect(await count(fresh, "candles")).toBe(4);
    await fresh.end();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/seed`
Expected: FAIL with `Failed to resolve import "./seed"`.

- [ ] **Step 3: Write the seed**

`src/lib/seed/seed.ts`:

```ts
import type { Db } from "@/lib/db/client";
import { parseCandleId, parseSwapId } from "@/lib/sync/ids";
import type { BalanceRec, CandleRec, EnvioSource, PoolRec, SwapRec, TokenRec } from "@/lib/sync/source";
import { finishRun, readState, saveCursors } from "@/lib/sync/state";
import { insertSwaps, recomputeListedPools, upsertCandles, upsertPools, upsertQuotes, upsertTokens } from "@/lib/sync/writers";

export type SeedPhase = "quotes" | "tokens" | "pools" | "swaps" | "candles" | "balances" | "finish";
export const SEED_PHASES: readonly SeedPhase[] = ["quotes", "tokens", "pools", "swaps", "candles", "balances", "finish"];
export const HOLDERS_KEPT = 100;
/** The market cursors start this far before the seed began, so the first cycles replay what moved during it. */
const CURSOR_BACKDATE_SEC = 600;
/** A range's checkpoint value once its walk has ended; never a valid id, so a resume skips it outright. */
const RANGE_DONE = "done";
const HEX = "0123456789abcdef";

export type Checkpoint = { startedAt: number; phase: SeedPhase; ranges: Record<string, string>; done: SeedPhase[] };

export function newCheckpoint(startedAt: number): Checkpoint {
  return { startedAt, phase: "quotes", ranges: {}, done: [] };
}

/**
 * n hex-prefix ranges over ids starting with "0x": from "0x0"-style exclusive lower bounds to exclusive
 * upper bounds, the last open-ended. Split on the first hex digit, so n is clamped to 1..16.
 */
export function idRanges(n: number): { key: string; from: string; to: string | null }[] {
  const count = Math.min(16, Math.max(1, Math.floor(n)));
  const out: { key: string; from: string; to: string | null }[] = [];
  for (let i = 0; i < count; i++) {
    const to = i === count - 1 ? null : `0x${HEX[Math.floor(((i + 1) * 16) / count)]}`;
    out.push({ key: `r${i}`, from: `0x${HEX[Math.floor((i * 16) / count)]}`, to });
  }
  return out;
}

export type SeedOpts = {
  checkpoint: Checkpoint; save: (c: Checkpoint) => Promise<void>; workers: number; pageLimit: number;
  holdersKept?: number; log: (line: string) => void; now: () => number;
};

type Range = { key: string; from: string; to: string | null };
type PageFn<R> = (afterId: string, beforeId: string | null, limit: number) => Promise<R[]>;
type WriteFn<R> = (rows: R[], idempotent: boolean) => Promise<number>;

const SWAP_COLS = ["tx_hash", "log_index", "pool_id", "token_id", "ts", "side", "amount_token", "amount_quote", "price_quote", "wallet"];
const swapRow = (s: SwapRec) => {
  const { txHash, logIndex } = parseSwapId(s.id);
  return [txHash, logIndex, s.pool_id, s.token_id, s.timestamp, s.side, Number(s.amountToken), Number(s.amountQuote), Number(s.priceQuote), s.wallet];
};
const CANDLE_COLS = ["pool_id", "interval", "t", "open", "high", "low", "close", "volume_quote", "volume_token", "trades"];
const candleRow = (c: CandleRec) => [c.pool_id, parseCandleId(c.id).interval, c.t, Number(c.open), Number(c.high), Number(c.low), Number(c.close), Number(c.volumeQuote), Number(c.volumeToken), c.trades];
const BALANCE_COLS = ["token_id", "holder", "balance", "updated_at"];
const balanceRow = (b: BalanceRec) => [b.token_id, b.holder, b.balance, b.updatedAt];

/** The one balance writer the sync does not need: an upsert for a page re-read after a resume. */
async function upsertBalances(db: Db, rows: readonly BalanceRec[]): Promise<number> {
  if (rows.length === 0) return 0;
  await db.query(
    `insert into market.token_balances (token_id, holder, balance, updated_at)
     select * from unnest($1::text[], $2::text[], $3::numeric[], $4::int[])
     on conflict (token_id, holder) do update set balance = excluded.balance, updated_at = excluded.updated_at`,
    [rows.map((b) => b.token_id), rows.map((b) => b.holder), rows.map((b) => b.balance), rows.map((b) => b.updatedAt)],
  );
  return rows.length;
}

/**
 * Runs the phases from checkpoint.phase; big tables walk `idRanges(workers)` concurrently with COPY per page
 * and save the last id per range after each page; "finish" trims balances to holdersKept per token, recomputes
 * every listed pool, sets sync_state.market cursor and cursor2 to startedAt − 600, and marks nightly ok.
 */
export async function runSeed(db: Db, source: EnvioSource, opts: SeedOpts): Promise<Checkpoint> {
  const cp: Checkpoint = { ...opts.checkpoint, ranges: { ...opts.checkpoint.ranges }, done: [...opts.checkpoint.done] };
  const kept = opts.holdersKept ?? HOLDERS_KEPT;
  const t0 = opts.now();
  let pages = 0;
  let rows = 0;
  // Saves are serialised: concurrent range workers must never interleave writes of the checkpoint file.
  let saving: Promise<void> = Promise.resolve();
  const save = () => (saving = saving.then(() => opts.save({ ...cp, ranges: { ...cp.ranges }, done: [...cp.done] })));
  const log = (phase: SeedPhase, key: string) => opts.log(`${phase} ${key} pages=${pages} rows=${rows} queries=${source.queries} elapsed=${opts.now() - t0}s`);

  async function walk<R extends { id: string }>(phase: SeedPhase, range: Range, page: PageFn<R>, write: WriteFn<R>) {
    const start = cp.ranges[range.key];
    if (start === RANGE_DONE) return;
    let after = start ?? range.from;
    // A resumed range may re-read the page whose COPY landed before its checkpoint was saved.
    let idempotent = start !== undefined;
    for (;;) {
      const batch = await page(after, range.to, opts.pageLimit);
      if (batch.length > 0) {
        rows += await write(batch, idempotent);
        idempotent = false;
        after = batch[batch.length - 1]!.id;
        cp.ranges[range.key] = after;
        pages += 1;
        await save();
        log(phase, range.key);
      }
      if (batch.length < opts.pageLimit) break;
    }
    cp.ranges[range.key] = RANGE_DONE;
    await save();
  }
  const single: Range = { key: "all", from: "0x0", to: null };
  const ranged = <R extends { id: string }>(phase: SeedPhase, page: PageFn<R>, copy: (batch: R[]) => Promise<number>, upsert: (batch: R[]) => Promise<number>) =>
    Promise.all(idRanges(opts.workers).map((r) => walk(phase, r, page, (batch, idempotent) => (idempotent ? upsert(batch) : copy(batch)))));

  for (const phase of SEED_PHASES.slice(SEED_PHASES.indexOf(cp.phase))) {
    if (cp.done.includes(phase)) continue;
    cp.phase = phase;
    switch (phase) {
      case "quotes": {
        const { quotes, prices } = await source.quotes();
        rows += await upsertQuotes(db, quotes, prices);
        pages += 1;
        log(phase, single.key);
        break;
      }
      case "tokens":
        await walk<TokenRec>(phase, single, (after, _before, limit) => source.tokensPage(after, limit), (batch) => upsertTokens(db, batch, opts.now()));
        break;
      case "pools":
        await walk<PoolRec>(phase, single, (after, _before, limit) => source.poolsPage(after, limit), (batch) => upsertPools(db, batch, opts.now()));
        break;
      case "swaps":
        await ranged<SwapRec>(phase, (a, b, l) => source.swapsPage(a, b, l), (batch) => db.copy("market.swaps", SWAP_COLS, batch.map(swapRow)), (batch) => insertSwaps(db, batch));
        break;
      case "candles":
        await ranged<CandleRec>(phase, (a, b, l) => source.candlesPage(a, b, l), (batch) => db.copy("market.candles", CANDLE_COLS, batch.map(candleRow)), (batch) => upsertCandles(db, batch));
        break;
      case "balances":
        await ranged<BalanceRec>(phase, (a, b, l) => source.balancesPage(a, b, l), (batch) => db.copy("market.token_balances", BALANCE_COLS, batch.map(balanceRow)), (batch) => upsertBalances(db, batch));
        break;
      case "finish": {
        await db.query(
          `delete from market.token_balances b using (
             select token_id, holder, row_number() over (partition by token_id order by balance desc, holder) as rn
             from market.token_balances) r
           where r.token_id = b.token_id and r.holder = b.holder and r.rn > $1`,
          [kept],
        );
        await recomputeListedPools(db, "all");
        await readState(db, "market"); // inserts the default row when missing
        await saveCursors(db, "market", { cursor: cp.startedAt - CURSOR_BACKDATE_SEC, cursor2: cp.startedAt - CURSOR_BACKDATE_SEC });
        await readState(db, "nightly");
        await finishRun(db, "nightly", { now: opts.now(), ok: true, rows: 0, queries: 0 });
        log(phase, single.key);
        break;
      }
    }
    cp.done.push(phase);
    cp.ranges = {};
    await save();
  }
  await saving;
  return cp;
}
```

- [ ] **Step 4: Run the seed tests**

Run: `npx vitest run src/lib/seed`
Expected: PASS (4 tests).

- [ ] **Step 5: The scripts**

`scripts/seed/seed.mts` (extensionless relative imports: `tsc --noEmit` covers `**/*.mts` and rejects `.ts` suffixes; tsx resolves the `@/` alias inside `src` from tsconfig):

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createDb } from "../../src/lib/db/client";
import { newCheckpoint, runSeed, type Checkpoint } from "../../src/lib/seed/seed";
import { createEnvioSource } from "../../src/lib/sync/envioSource";
import { createLimiter } from "../../src/lib/sync/limiter";

const CHECKPOINT = ".seed/checkpoint.json"; // git-ignored; delete it to start over
const url = process.env.DATABASE_URL_DIRECT;
if (!url) {
  console.error("DATABASE_URL_DIRECT is not set in .env.local");
  process.exit(1);
}

async function loadCheckpoint(): Promise<Checkpoint> {
  try {
    const cp = JSON.parse(await readFile(CHECKPOINT, "utf8")) as Checkpoint;
    console.log(`resuming: phase ${cp.phase}, done ${cp.done.join(",") || "-"}`);
    return cp;
  } catch {
    return newCheckpoint(Math.floor(Date.now() / 1000));
  }
}

const db = createDb(url, { max: 4 });
const source = createEnvioSource({ limiter: createLimiter(200) });
try {
  const cp = await runSeed(db, source, {
    checkpoint: await loadCheckpoint(),
    save: async (c) => {
      await mkdir(".seed", { recursive: true });
      await writeFile(CHECKPOINT, JSON.stringify(c, null, 2));
    },
    workers: 3,
    pageLimit: 1000,
    log: (line) => console.log(line),
    now: () => Math.floor(Date.now() / 1000),
  });
  console.log(`seed complete: ${cp.done.join(", ")}`);
  for (const table of ["quotes", "tokens", "pools", "swaps", "candles", "token_balances"]) {
    const [row] = await db.query<{ n: unknown }>(`select count(*) as n from market.${table}`);
    console.log(`${table}: ${Number(row?.n ?? 0)}`);
  }
} finally {
  await db.end();
}
```

`scripts/db/parity.mts`:

```ts
import { createDb } from "../../src/lib/db/client";
import type { PairsScope } from "../../src/lib/envio/pairs";
import { createDbBackend } from "../../src/lib/market/dbBackend";
import { createEnvioBackend } from "../../src/lib/market/envioBackend";
import { createEnvioSource } from "../../src/lib/sync/envioSource";
import type { TokenPair } from "../../src/lib/types";

const TOLERANCE = 0.001; // 0.1 %
const url = process.env.DATABASE_URL_DIRECT;
if (!url) {
  console.error("DATABASE_URL_DIRECT is not set in .env.local");
  process.exit(1);
}

function differs(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    if (a === b) return false;
    return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) > TOLERANCE;
  }
  return a !== b; // strings, booleans, null against a number
}

function report(scope: PairsScope, envio: TokenPair[], store: TokenPair[]): void {
  const e = new Map(envio.map((p) => [p.id, p]));
  const s = new Map(store.map((p) => [p.id, p]));
  const missingInStore = [...e.keys()].filter((id) => !s.has(id));
  const missingOnEnvio = [...s.keys()].filter((id) => !e.has(id));
  let fields = 0;
  for (const [id, a] of e) {
    const b = s.get(id);
    if (!b) continue;
    for (const key of Object.keys(a) as (keyof TokenPair)[]) {
      if (!differs(a[key], b[key])) continue;
      fields += 1;
      console.log(`${scope} ${id} ${key}: envio=${String(a[key])} store=${String(b[key])}`);
    }
  }
  for (const id of missingInStore) console.log(`${scope} ${id}: missing in the store`);
  for (const id of missingOnEnvio) console.log(`${scope} ${id}: missing on Envio`);
  console.log(`${scope}: envio=${envio.length} store=${store.length} missingInStore=${missingInStore.length} missingOnEnvio=${missingOnEnvio.length} fieldDifferences=${fields}`);
}

const db = createDb(url, { max: 2 });
const store = createDbBackend(db, createEnvioSource());
const envio = createEnvioBackend();
try {
  for (const scope of ["all", "launchpad"] as const) {
    const [a, b] = await Promise.all([envio.pairs(scope), store.pairs(scope)]);
    report(scope, a, b);
  }
} finally {
  await db.end();
}
```

`scripts/README.md`:

```markdown
# Database scripts

All four run from the repo root through `node --env-file-if-exists=.env.local --conditions=react-server --import tsx`
(see `package.json`). They read `DATABASE_URL_DIRECT`, the Supabase session pooler on port 5432, never the
app's `DATABASE_URL`. Never paste a connection string into a terminal, a chat, a commit or this file: it
lives in `.env.local` only.

| Command | What it does |
|---|---|
| `npm run db:migrate` | Applies every `supabase/migrations/*.sql` not yet recorded in `market.schema_migrations`, in filename order, and prints the names applied. |
| `npm run db:smoke` | One round trip; prints `ok`. Run it after changing `.env.local`. |
| `npm run seed` | The one-off load from Envio: quotes, tokens, pools, then swaps, candles and balances by id ranges with three workers at 200 queries a minute, then the finish phase (top 100 holders per token, listed pools, sync cursors). About eight hours. |
| `npm run db:parity` | Loads `pairs("all")` and `pairs("launchpad")` through both backends and prints every token missing on either side, every field differing by more than 0.1 % (numbers) or at all (strings), then the counts. |

Seed, on a laptop that must not sleep:

    caffeinate -i npm run seed

It prints one line per page: `swaps r2 pages=1234 rows=1234000 queries=1240 elapsed=372s`. Progress is
checkpointed to `.seed/checkpoint.json` after every page. If it stops for any reason, run the same command
again: it resumes at the saved phase and range cursors and re-reads at most one page per range. Delete
`.seed/checkpoint.json` to start from scratch; the writes are idempotent, so a restart only costs time.

Run `npm run db:parity` once the sync has run for an hour (rollout step R5) and again a day after the flip.
The only expected differences are tokens that traded after the last sync cycle.
```

- [ ] **Step 6: Verify the package scripts**

Task 1 added all four script lines. Run `npm pkg get scripts.db:migrate scripts.db:smoke scripts.db:parity scripts.seed` and compare with the contract; only if `db:parity` or `seed` is missing, add exactly:

```bash
npm pkg set scripts.db:parity="node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/db/parity.mts"
npm pkg set scripts.seed="node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/seed/seed.mts"
```

Then, with `DATABASE_URL_DIRECT` absent from `.env.local` (comment it out temporarily if it is set; never print it; `--env-file-if-exists` tolerates a missing file), `npm run seed` and `npm run db:parity` must print `DATABASE_URL_DIRECT is not set in .env.local` and exit 1.

- [ ] **Step 7: Gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green (`tsc` covers `scripts/**/*.mts`).

- [ ] **Step 8: Commit**

```bash
git add src/lib/seed scripts/seed/seed.mts scripts/db/parity.mts scripts/README.md package.json
git commit -m "Resumable seed from Envio into the market store, and the parity report" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

### Task 8: Documentation and Decision Log

**Files:**
- Modify (frontend repo): `README.md` (Data layer and Layout sections), `.env.example` (final check)
- Modify (workspace repo `/Users/kobs/Desktop/SuitVenturesMarket`, its own commit): `README.md` (section 4 table, section 7 rows D35 and D39, section 10 bullet)
- Test: none (documentation); the four gates still run before the frontend commit

**Interfaces:**
- Consumes: nothing from other tasks; the text describes what Tasks 1 to 7 ship.
- Produces: the client-facing record of D39 and the amended D35; the runbook (after this task) points at both.

Decision where the spec is silent: the workspace README's section 10 has no "Envio pause takes the table down" bullet today (its risks are audit, testnet, LONG or Pons changes, Pons hook parameters, fee leakage, thin pools, stock tokens, non-custodial), so the replacement text is added as a new bullet after "LONG or Pons changes". Section 6 needs no edit: Supabase is already listed under service accounts.

- [ ] **Step 1: Frontend README, the Data layer and Layout sections**

In `README.md` replace everything from the line `## Data layer` up to the line before `## Stubs still to wire (M2)` with:

```markdown
## Data layer

Everything the UI renders comes through `MarketsDataSource`
(`src/lib/types.ts`), never from literals.

- `MockDataSource` (`src/lib/data/mock.ts`) — deterministic, seeded with the
  handoff's eight real pairs plus eight placeholders. Default.
- `EnvioDataSource` (`src/lib/data/envio.ts`) — live data, read through this
  app's own route handlers. Select it with `NEXT_PUBLIC_DATA_SOURCE=envio`.

### The store

Live market data lives in a Postgres schema `market` on a Supabase project the
app owns (`supabase/migrations/`), mirrored from the Envio indexer. The route
handlers under `src/app/api` read that store; Envio is the ingest engine and is
queried only by the sync job, the holders read-through refresh and the health
probe.

- **Sync** (`src/lib/sync`): `GET /api/internal/sync` runs every minute on
  Vercel cron (`vercel.json`) and pulls what moved since its cursor — quotes,
  the pools that traded, their swaps and candles, their tokens — in cycles about
  30 s apart; `GET /api/internal/sync/nightly` re-pulls every token and pool at
  03:00 UTC. Both require `Authorization: Bearer <CRON_SECRET>`, take a lease in
  `market.sync_state` so invocations never overlap, and record their last run,
  last success and last error there. Every write is an upsert, so re-processing
  the overlap changes nothing.
- **Backend switch** (`src/lib/market`): route handlers call `getBackend()`,
  which is the store implementation when `DATABASE_URL` is set and the M1 Envio
  implementation otherwise, or whenever `MARKET_DATA_BACKEND=envio` (the
  rollback path). Both produce the same JSON, field for field: `shapePairs()`
  in `src/lib/envio/shape.ts` is the reference and `npm run db:parity` checks it.
- **Routes**: `/api/pairs`, `/api/quotes` and
  `/api/tokens/[address]/{candles,trades,holders}` keep their contract and cache
  headers. `GET /api/tokens/[address]` is new: one `TokenPair` (or 404) for a
  token outside the 500-row list, so deep links work. `GET /api/health` reports
  the backend, database latency, sync age and last error, indexer lag (chain
  head minus last processed block) and which quote-asset USD prices are stale.
- **Scripts** (`scripts/`, see `scripts/README.md`): `npm run db:migrate`,
  `npm run db:smoke`, `npm run seed` (the resumable one-off load) and
  `npm run db:parity`. They read `DATABASE_URL_DIRECT` (session pooler) from
  `.env.local`, never the app's `DATABASE_URL`.

Live mode needs these variables; all but the first are server-only:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_DATA_SOURCE` | `envio` |
| `DATABASE_URL` | Supabase pooler, transaction mode, port 6543 |
| `CRON_SECRET` | 32 random bytes; Vercel sends it as a Bearer token to the cron routes |
| `MARKET_DATA_BACKEND` | unset (the store) or `envio` to roll back to the M1 path |
| `SYNC_INTERVAL_SEC` | optional; seconds between sync cycles inside one invocation, default 30 |
| `ENVIO_GRAPHQL_URL` | the indexer's GraphQL endpoint |
| `ENVIO_GRAPHQL_KEY` | the endpoint API key from Envio Cloud's Security tab (not the HyperSync token) |

Preview deployments get no database variable and stay on the mock source.
Both sources share the swap math in `src/lib/quote.ts` — a constant-product
approximation until the v4 Quoter lands in M2.

`GET /api/tokens/[address]/logo` proxies the token's logo, resolved per token
from the contract's `logo()` (Pons), its `tokenURI()` JSON (LONG) or
DexScreener, and cached; the optional server-only `ROBINHOOD_RPC_URL` picks the
RPC those reads use, defaulting to the public one.

Watchlist and votes are browser-local in live mode
(`src/lib/data/localStore.ts`, `localStorage` keyed by wallet address): they do
not follow the wallet to another device, and vote counts read 0 until the
signed API lands in M2.

Two methods were added beyond the handoff interface: `votes(address)` (the
caller's current vote per token address) and `pair(id)` (one token by address,
listed or not) — see the comments in `types.ts`.

```

In the `## Layout` block, after the `src/lib/data` line, add:

```
src/lib/db         Db interface (postgres driver, PGlite in tests), migrations
src/lib/sync       Envio source boundary, writers, cursor state, market cycle, nightly
src/lib/market     MarketBackend: the store implementation and the M1 Envio one
src/lib/seed       the resumable one-off loader
scripts            migrate, smoke, seed, parity (laptop, session pooler)
supabase           migrations for the market schema
```

- [ ] **Step 2: `.env.example` final check**

Run `grep -c '^DATABASE_URL=\|^DATABASE_URL_DIRECT=\|^CRON_SECRET=\|^MARKET_DATA_BACKEND=\|^SYNC_INTERVAL_SEC=' .env.example`. Expected: `5`. If it is not, append exactly the contract's block at the end of the file:

```
# Market store (server-only)
DATABASE_URL=            # Supabase pooler, transaction mode, port 6543
DATABASE_URL_DIRECT=     # Supabase session pooler, port 5432; laptop scripts only
CRON_SECRET=             # 32 random bytes; Vercel sends it as a Bearer token to the cron routes
MARKET_DATA_BACKEND=     # unset = db when DATABASE_URL is set; "envio" rolls back to the M1 path
SYNC_INTERVAL_SEC=       # seconds between sync cycles inside one invocation; default 30
```

Every value stays empty. `grep -n 'postgres://' .env.example` must print nothing.

- [ ] **Step 3: Workspace README edits**

In `/Users/kobs/Desktop/SuitVenturesMarket/README.md`, four edits, each matching the existing table columns.

Section 4, Infrastructure table. The Indexer row ends with `Medium if the first backfill shows more. |`; change that ending to:

```
Medium if the first backfill shows more. Read by the sync job only (D39). |
```

Insert this row directly after the Indexer row:

```
| Market store | Supabase Postgres (Pro), schema `market` | Mirror of the indexer's tokens, pools, swaps, candles, top holders and quote prices, written by a sync job on Vercel cron every minute and a nightly re-pull; the route handlers read only this store, so a paused or replaced indexer costs freshness, never the table (D39). Not exposed through PostgREST. |
```

Section 7, Decision log. Replace the D35 row:

```
| D35 | Social layer | Sep 13, 2026. Rankings derived from chain data: the preset views and a top traders board by 24h volume and trade count. A watchlist and one bullish or bearish vote per token, tied to a connected wallet through a signed message and stored in Supabase, the only data the app keeps that is not on-chain. | P |
```
with
```
| D35 | Social layer | Sep 13, 2026. Rankings derived from chain data: the preset views and a top traders board by 24h volume and trade count. A watchlist and one bullish or bearish vote per token, tied to a connected wallet through a signed message and stored in Supabase, the only data the app keeps that is not on-chain. Updated Sep 16, 2026 (K): Supabase holds the market data mirror as well as watchlists and votes (D39); the part that is not on-chain is still only the user data. | P, K |
```

Add after the D38 row:

```
| D39 | Market data store | Sep 16, 2026. Market data is mirrored into a Supabase Postgres the project owns (schema `market`), fed by a sync job that reads the Envio indexer every minute; the app reads only its own store. Envio is the ingest engine and can be paused, re-synced or replaced behind it with no visible change beyond freshness. Costs USD 25 a month plus disk. Amends D35. | K |
```

Section 10, Risks. After the bullet that starts `- **LONG or Pons changes.**` add:

```
- **Envio pause freezes prices until it is back.** The app reads its own store (D39), so a paused, re-syncing or replaced indexer costs freshness, not the table: prices, volumes and candles stop moving until the sync resumes, and `/api/health` shows the sync age. Rebuilding the indexer behind the sync is invisible to visitors.
```

Check: `grep -c '^| D39 ' README.md` prints `1`; `grep -c 'Updated Sep 16, 2026 (K)' README.md` prints `1`; `grep -c 'Read by the sync job only' README.md` prints `1`; `grep -c 'Envio pause freezes prices' README.md` prints `1`.

- [ ] **Step 4: Gates and the two commits**

Frontend repo (documentation only, the gates still run):

```bash
npm test && npx tsc --noEmit && npx eslint . && npm run build
git add README.md .env.example
git commit -m "Describe the market store, the sync and the backend switch in the README" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

Workspace repo, README only (`git status` there shows the frontend submodule pointer modified; it is not part of this commit, so never `git add -A`):

```bash
cd /Users/kobs/Desktop/SuitVenturesMarket
git add README.md
git commit -m "Decision Log: D39 market data store, D35 amended; Supabase infrastructure row and the Envio-pause risk" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```


---

## Rollout runbook (operations, after the tasks are merged)

These steps are done by Kobe and Claude in the session, not by implementer subagents. Each is a checkbox so the ledger can track it.

- [x] **R0. Freeze the migration.** (In force since R2 on 17 Sep 2026.) After R2 the file `supabase/migrations/20260917000000_market.sql` is never edited again; every later change is a new file (the runner tracks filenames only).
- [x] **R1. Supabase org and project.** Done 17 Sep 2026: org `SuitVentures`, project `suitventures-markets` (ref `lcunlwgppdvjwvnfuexw`, Postgres 17.6); the session and transaction poolers live on `aws-0-us-east-1.pooler.supabase.com` (the `aws-1` host does not know the tenant); `DATABASE_URL_DIRECT` is in `.env.local`, `DATABASE_URL` is derived from it at R4. The Deployment Protection check is still open for R4. Kobe creates the org `SuitVentures` on Pro in the Supabase dashboard (card required). Claude runs `supabase orgs list`, then `PW="$(openssl rand -base64 24)"` and `supabase projects create suitventures-markets --org-id <id> --region us-east-1 --db-password "$PW"`; the variable is used once more to assemble the two connection strings and then `unset PW`. Nothing prints it. From the dashboard's Connect panel Claude copies the two pooler strings (transaction 6543, session 5432), writes `DATABASE_URL_DIRECT` into `.env.local` (mode 600) and keeps `DATABASE_URL` for step R4. Postgres 17. Do not add `market` to the exposed schemas. Confirm Vercel's Deployment Protection does not block the cron requests (or add the protection bypass), since the two sync routes are reachable only by cron.
- [x] **R2. Migrate and smoke.** Done 17 Sep 2026: applied once, smoke `ok`. `npm run db:migrate` then `npm run db:smoke` from the frontend repo. Expected: the migration name printed once, then `ok` (the smoke also round-trips an array-parameter upsert with a hostile token name inside a rolled-back transaction, so the writer path is proven before the seed).
- [ ] **R3. Seed overnight.** Preconditions checked 17 Sep 2026: health `lag` 4; every session through Supabase's pooler starts with `statement_timeout = 2min` (server default, not a role setting, and startup parameters are not forwarded), so the finish step runs its trim and recompute inside one transaction under `set local statement_timeout = 0`. Measured 17 Sep: the indexer returns at most 1000 rows a page whatever `limit` says and answers parallel pages at the speed of one (about 2 s each), so three workers reached only 1.4 pages a second; the seed now walks 16 ranges (one per hex digit) with 8 pooled connections, which keeps the 200-a-minute limiter busy. Two tokens (OZLE, OBOL) carry Envio-computed supplies of 79 and 80 digits, beyond uint256: the amount columns are plain numeric since `20260917110000_amounts_unbounded.sql`. First check `/api/health` reports a small indexer `lag` (the seed backdates its watermark by an hour, so the indexer must be less than an hour behind when the walks start) and that the session role has no `statement_timeout` that would cut the holders trim. Then `caffeinate -i npm run seed` with the laptop on power. Expected order: quotes, tokens, pools in a few minutes; swaps about 4.5 h; candles about 2 h; balances about 1.5 h; finish in minutes. If it stops, rerun the same command; it resumes from `.seed/checkpoint.json`. In the morning check counts: `select count(*) from market.swaps` (about 52 M plus a day), `market.candles`, `market.token_balances`, and `select * from market.sync_state`.
- [ ] **R1a. Disk sizing (learned 18 Sep 2026).** The store is far larger than the plan assumed: `market.swaps` measures about 460 bytes a row with its primary key, so 13.7 M rows already took 6.3 GB and the full table plus its rebuilt `swaps_pool_ts` index needs roughly 15 to 30 GB depending on the final count, before candles and balances. On an 8 GB disk Supabase's monitor flipped the project to read-only at about 95 % usage, auto-grew the disk, and lifted read-only again — and a disk can only grow once every six hours, so the next fill would leave the project read-only for hours. Size the disk to at least 60 GB before the seed (about USD 7 a month at Supabase's per-GB rate), and pause the seed rather than let it hit the ceiling. The Free-tier read-only override (`alter role postgres set default_transaction_read_only = off`) was reset by the compute resize; it is not needed on Pro once the disk is sized.
- [ ] **R1b. Trade retention (decided 18 Sep 2026, Kobe).** Measured on the copy: trading on this chain began 11 Jun 2026 and runs at about one million trades a day, so the full history is ~55 M rows (24 GB + 8 GB index) and grows ~15 GB a month — no disk size makes "keep everything" viable. The store keeps the **last 10 days of trades** (~14 M rows, ~8 GB with the index): the seed writes only swaps with `timestamp >= startedAt - 10 days`, and a nightly `prune` phase deletes older rows in batches (BRIN index on `ts`). Candles stay for all time; holders are unaffected; the trades tab shows a token's last 50 trades within the window. The rows copied before the decision are replaced: `npm run db:reset-swaps` empties the table and points the checkpoint at the start of the swaps phase, then the seed resumes. Byte-compact rows (bytea hashes and addresses, about −60 %) are an M5 option that would allow a 3–4 week window on the same disk.
- [ ] **R3a. Rebuild the trades index before anything reads the store.** On 18 Sep 2026 the seed slowed to a tenth of its pace once Supabase's burstable disk allowance ran out on the Micro tier (a row count took 31 s; every COPY session sat in `IO DataFileRead`). The amplifier was `swaps_pool_ts`: each copied row forced a random index page read and write while the table itself appended sequentially. The index was dropped for the bulk load. It MUST be recreated before R4, and the trades route depends on it: `create index concurrently swaps_pool_ts on market.swaps (pool_id, ts desc);` (run from the session pooler with `set statement_timeout = 0` first; expect tens of minutes on the throttled disk). Verify with `select indexname from pg_indexes where schemaname = 'market' and tablename = 'swaps'`.
- [ ] **R4. Vercel variables, sync on, reads unchanged.** `vercel env add DATABASE_URL production` (sensitive, the transaction-mode string), `vercel env add CRON_SECRET production` (sensitive, `openssl rand -hex 32`), `vercel env add MARKET_DATA_BACKEND production` with value `envio`. `vercel env add SESSION_SECRET production` (sensitive, `openssl rand -hex 32`) — the social layer's cookie key (M4). Adding it is not a precondition for this step: while it is unset the session routes answer 503, the star and vote gates stay closed and every read on the site is unaffected, so it can land in this pass or a later one. The social tables ship as their own migration, since R0 froze the original file: `npm run db:migrate` applies every `supabase/migrations/*.sql` not yet recorded in `market.schema_migrations`, which on 19 Sep 2026 is three files — `20260918120000_pools_routable.sql`, `20260918200000_swaps_ts_brin.sql` and `20260919000000_social.sql` — because the M3 and retention migrations were never applied to this project; run it before the deploy, not after (the user routes answer 500 rather than 503 against a database that has `DATABASE_URL` but no social tables), and run it **after** the seed rather than beside it, since the BRIN build is inside the runner's own transaction and so is bounded by the pooler's 2-minute statement timeout. Push main; Vercel deploys with the crons. Watch `/api/internal/sync` invocations in the Vercel dashboard and `/api/health` for an hour: `sync.lastOkAgeSec` under 60 most of the time (an occasional 60 to 90 s reading is the lease skip at a minute boundary, not a fault), `nightly.phase` empty after 03:00 UTC, Envio's usage page showing the sync alone. Two readings are expected, not faults: around 03:00 UTC `ok` can be false for a few minutes while the market job yields to the nightly (the 300 s threshold is tight against a full 280 s nightly window; raising it to 360 s is an M2 option), and a chain reorg that lowers the indexer's processed block trips the head-block guard for one minute, showing `lastError: indexer behind the store` once.
- [ ] **R5. Parity.** `npm run db:parity`. Expected: no field difference above 0.1 %; the only tokens missing on either side are those that traded after the last cycle and, on the Envio side, tokens beyond M1's 7-day recovery window that the store lists anyway. Fix anything else before the flip.
- [ ] **R6. Flip.** `vercel env rm MARKET_DATA_BACKEND production`, redeploy (empty commit or `vercel redeploy`). Run `explain analyze` on the pairs query once against the seeded table (the 500 ms bar assumes the `pools_last_swap` + `tokens_listed_pool` nested loop). Check `/api/health` reports `backend: "db"`, `/api/pairs` answers in under 500 ms from a cold function, the table and a token page render, a deep link to a token outside the top 500 renders through `/api/tokens/{address}`.
- [ ] **R6a. Re-seed rule.** The cursors are monotonic, so a re-seed onto a rolled-back or truncated store must first reset `sync_state` (`update market.sync_state set cursor = 0, cursor2 = 0, cursor_text = '', phase = '', head_block = 0`) with both crons paused; the seed's finish then sets them forward again. Expect `/api/health` to read not-ok for about a minute after a nightly that used its whole 280 s window, because the market job records nothing while it yields.
- [ ] **R7. Rollback path verified once.** Set `MARKET_DATA_BACKEND=envio`, redeploy, confirm `backend: "envio"`, remove it again, redeploy. The sync keeps running either way.
- [ ] **R8. Tell the client.** One line: market data now lives in the project's own database, refreshed every 30 seconds from the indexer; hosting adds USD 25 a month. Workspace README already carries D39 (Task 8).

## Acceptance

- `/api/pairs`, `/api/quotes`, `/api/tokens/{address}/{candles,trades,holders}` return the same JSON shapes as before the change; `/api/tokens/{address}` is new.
- `/api/health` shows `backend: "db"`, database latency, sync age under 60 s over an hour of observation, and the indexer lag as before.
- Envio's usage shows only the sync job, the holders read-through and the health probe: under 150 queries a minute at peak.
- The parity report is empty apart from tokens newer than the last cycle.
- `MARKET_DATA_BACKEND=envio` restores the M1 path without a code change.
- All gates green at every task commit: `npm test`, `npx tsc --noEmit`, `npx eslint .`, `npm run build`.

## Decisions still with Kobe

- Create the Supabase org on Pro (R1). Recommended: a separate `SuitVentures` org so it transfers whole at M5.
- The M2 target moves to the week of Sep 22; the client hears it from Kobe.
