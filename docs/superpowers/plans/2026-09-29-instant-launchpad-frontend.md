# Instant Launchpad Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give MaxLong Markets the frontend half of the instant launchpad: the reader folds the `SVLaunchpad` contract's three events into three new `market.*` tables, launched tokens list with the `SV` badge from their launch block, one write route pins a creator's image and metadata on Filebase, `/launch` signs and sends the one launch transaction, and the token page carries the launch facts, the fee panel and the indexing wait.

**Architecture:** The HyperSync source adds the launchpad as a second `logs` selection in the same per-minute request (only while `NEXT_PUBLIC_LAUNCHPAD_ADDRESS` is set) and selects each log's `address`, so `decodeLog` routes by address, then topic0. Three new `ChainEvent` kinds reach the pure fold, which labels a launch's pool and token `SV` in the same batch and returns launch, fee and payout rows; `applyFold` writes them in its one transaction with the cursor. Reads stay on the existing single-token response (a `launch` block, fees summed on read). The only new route is `POST /api/launch/upload`; every other action is a wallet transaction written in `src/lib/launch.ts`, the mirror of `src/lib/swap.ts`.

**Tech Stack:** Next.js 16.3.5 App Router, React 19.2.8, TypeScript 5, viem 2.56 and wagmi 3.7, TanStack Query 5, Tailwind v4, postgres.js behind `Db` (`src/lib/db/client.ts`), vitest 4 with PGlite (`src/test/db.ts`) and jsdom (`src/test/dom.tsx`), `sharp` 0.35 and `aws4fetch` 1.0 (both new direct dependencies, Task 5).

**Spec (binding):** `docs/superpowers/specs/2026-09-28-instant-launchpad-design.md`. This plan implements sections 5, 6, 7, 8.2, 9 (steps 5 and 6), 10 and 13, and the frontend script named in 8.3. Sections 3 and 4 are the contract this plan consumes. Settled input: `.superpowers/sdd/2026-09-29-instant-launchpad/brief.md`. Every path, export, signature and SQL below was checked against the repo at `ab2d430`.

## Global Constraints

- **Gates after every task, in this order, all clean:** `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src`. Tasks that touch a route or a page (Tasks 5, 6, 8 and 9; Task 9 is also the final task) also run `npm run build`. "Clean" means no errors and no new warnings. A task is not done until its gates pass on its own worktree.
- **Next.js 16 has breaking changes (AGENTS.md).** Before writing any route or page code, read the relevant guide in `node_modules/next/dist/docs/`: `01-app/01-getting-started/15-route-handlers.md`, `01-app/03-api-reference/03-file-conventions/route.md`, `.../page.md` (params and `searchParams` are Promises), and `.../02-route-segment-config/{runtime,maxDuration}.md`. Match the existing routes: `export const dynamic = "force-dynamic"`, handlers take `(req: Request, ctx: { params: Promise<…> })`.
- **SQL is tested on PGlite, never mocked.** Every statement a task adds runs in a test through `testDb()` from `src/test/db.ts`.
- **House SQL conventions, verbatim from spec 5.1:** "snake_case, lower-case hex ids as `text`, raw chain integers as `numeric` read back as text, `int` unix seconds, enumerations as `text` with a check, no foreign keys."
- **Migrations:** one file, `supabase/migrations/20260929000000_launches.sql`, exactly spec 5.1. Kobe applies it himself with `npm run db:migrate` before any push. No agent runs a migration against any real database.
- **Environment:** variable names only, never values, anywhere in code, tests, commits or docs. Never read, print, edit or commit `.env`, `.env.local` or `.env.fork`. `.env.example` gains names with empty placeholders (Task 9).
- **The launchpad ABI is hand-transcribed** from spec 4.2 into `src/lib/launch/abi.ts` (Task 2), with `src/lib/launch/abi.test.ts` pinning every function selector and every event topic0 against the spec's canonical signatures.
- **No test may need the contract deployed.** Every chain read and write is mocked or injected; `NEXT_PUBLIC_LAUNCHPAD_ADDRESS` is unset in the suite and every feature degrades to "not live" without it.
- **Raw chain amounts travel as `bigint` or decimal strings.** A `number` holds an amount only for display (`fmtAmt`, `fmtUsd`, `fmtPrice` in `src/lib/format.ts`).
- **Copy rules (Kobe, brief section 5):** plain words, no em-dashes, no parenthetical asides, numbers in tables. No screen may say or imply that every buyer pays the same price (spec 1).
- **Line numbers cited are those at `ab2d430`.** An earlier task shifts later numbers; every edit quotes the text it replaces, so match on text, never on the number.
- **No commits by the planner.** Each task ends with its own commit, made by that task's implementer in its worktree.

## Model routing

| Role | Model | Why |
|---|---|---|
| Implementer, one per task, in its own git worktree | Opus | The tasks move money-adjacent code and SQL; the plan carries the design, the implementer must still read the files it edits |
| Test and gate runner | Sonnet | Mechanical: run the four gates, report failures verbatim |
| Reviewer, one per task, then one for the whole branch | Opus | Checks the diff against this plan and the spec, not against itself |

Tasks run **sequentially**: each worktree branches from the previous task's commit.

| Task | Depends on |
|---|---|
| 1 Data: migration and stores | none |
| 2 The launchpad's interface: ABI, address, currency config | none (runs after 1 for a linear history) |
| 3 Reader: source, decode, fold, store, run, health | 1, 2 |
| 4 Listing window, table order, `launch` block, Liquidity row | 1, 3 |
| 5 Upload route | 1, 2 |
| 6 Orphan clean-up and launch logos | 1, 5 |
| 7 Launch writes, form arithmetic, upload client, hooks | 2, 5 |
| 8 `/launch` page and nav | 7 |
| 9 Token page, SV filter, README and `.env.example` | 4, 7 |

## Review Focus

The five inputs the spec implies but its test list does not pin, most likely to bite first. Each has a test in the task named.

1. **A name or symbol in multi-byte characters at the byte limit.** Eight rocket emoji are 32 bytes and must be accepted by the route and the form; nine must be refused by both with the same rule. Tests: Task 5 (`fields.test.ts`), Task 8 (form counter and reason).
2. **A currency with no USD price.** The form must work in the currency's own units end to end (presets, custom value, preview) and the token page must show the opening valuation in the quote. Tests: Task 8 (form in AMC), Task 9 (Info rows in the quote).
3. **A launch whose metadata URI is not `ipfs://<CID>`** (made outside the app, or with a path after the CID). The fold must store `metadata_cid = ''`, no upload may attach to it, and nothing may throw. Test: Task 3 (`fold.launch.test.ts`).
4. **Launch pressed twice while the first press is still in flight.** Exactly one upload and one transaction. Test: Task 8.
5. **The uncollected-fees read failing** (RPC error). The panel must say it could not read them and keep Collect usable, never show zeros with "Nothing to collect yet." Test: Task 9 (`LaunchFeesPanel.test.tsx`).

## File structure

New files, one responsibility each:

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/20260929000000_launches.sql` | Three tables, two pool indexes | 1 |
| `src/lib/launch/store.ts`, `store.test.ts` | Launch, fee-event and payout writes; upload attach; launch health counts | 1 |
| `src/lib/launch/uploads.ts`, `uploads.test.ts` | Upload budget, the locked insert, clean-up queries | 1 |
| `src/lib/launch/abi.ts`, `abi.test.ts` | `svLaunchpadAbi`, the whole interface of spec 4.2 plus three foreign errors | 2 |
| `src/lib/launch/address.ts`, `address.test.ts` | `LAUNCHPAD_ADDRESS`, `hasLaunchpad()` | 2 |
| `src/lib/launch/currencyConfig.ts`, `currencyConfig.test.ts`, `scripts/launch/currency-config.mts` | The deploy config the contracts script reads (spec 8.3) | 2 |
| `src/lib/chain/fold.launch.test.ts` | The fold's launchpad cases | 3 |
| `src/lib/launch/read.ts` | `readLaunchInfo`: the `launch` block with fees summed on read | 4 |
| `src/lib/market/dbBackend.launch.test.ts` | Listing window, order, scope, `launch` block | 4 |
| `src/lib/launch/fields.ts`, `fields.test.ts` | Field rules shared by the route and the form; metadata JSON | 5 |
| `src/lib/launch/image.ts`, `image.test.ts` | Magic bytes, `sharp` format check, re-encode | 5 |
| `src/lib/launch/filebase.ts`, `filebase.test.ts` | Filebase S3 PUT and DELETE through `aws4fetch` | 5 |
| `src/app/api/launch/upload/route.ts`, `route.test.ts` | `POST /api/launch/upload` | 5 |
| `src/lib/launch/cleanup.ts`, `cleanup.test.ts` | The nightly `"uploads"` phase | 6 |
| `src/lib/launch/gateway.ts`, `gateway.test.ts` | The Filebase gateway base URL | 6 |
| `src/lib/launch/math.ts`, `math.test.ts` | Presets, first-buy cap, token estimate, USD conversion, salt | 7 |
| `src/lib/launch.ts`, `launch.test.ts` | Every launchpad wallet write, error mapping, revert replay | 7 |
| `src/lib/launch/client.ts`, `client.test.ts` | The browser's upload call and its messages | 7 |
| `src/hooks/useLaunchpad.ts` | The launchpad's contract reads for the form and the fee panel | 7 |
| `src/components/CurrencySelect.tsx` | Single-select currency popover | 8 |
| `src/components/LaunchForm.tsx`, `LaunchForm.test.tsx` | The form, summary, reasons and submit steps | 8 |
| `src/app/launch/page.tsx`, `page.test.tsx` | `/launch`, with the not-live card | 8 |
| `src/components/TopBar.test.tsx` | The nav entry | 8 |
| `src/components/LaunchFeesPanel.tsx`, `LaunchFeesPanel.test.tsx` | Uncollected, collected, owed, collect, claim, change payout | 9 |
| `src/components/TokenHeader.test.tsx` | The "LAUNCHED HERE" chip | 9 |

Modified files: `src/lib/db/migrate.test.ts`, `src/lib/chain/{types,abi,decode,hypersyncSource,fold,store,run}.ts` and their tests, `src/lib/sync/{writers,nightly,run,deps,market}.ts`, `src/lib/seed/seed.ts`, `src/lib/market/{backend,dbBackend,dbShape}.ts`, `src/lib/types.ts`, `src/lib/logos/resolve.ts`, `src/app/api/tokens/[address]/logo/route.ts`, `src/app/api/internal/sync/nightly/route.ts`, `src/lib/social/rateLimit.ts`, `src/context/AppState.tsx`, `src/components/{SignModal,TopBar,TokenView,TokenHeader,ActivityTabs}.tsx`, `src/app/t/[address]/page.tsx`, `src/hooks/useMarketsData.ts`, `src/lib/markets.ts`, `package.json`, `.env.example`, `README.md`, `scripts/README.md`, and the tests named in each task.

---

### Task 1: Data: the migration and the launch stores

**Files:**
- Create: `supabase/migrations/20260929000000_launches.sql`
- Modify: `src/lib/db/migrate.test.ts:10` (the `TABLES` list) and append one test
- Modify: `src/lib/chain/types.ts` (append the three row types after `FoldResult`, line 214)
- Create: `src/lib/launch/store.ts`, `src/lib/launch/store.test.ts`
- Create: `src/lib/launch/uploads.ts`, `src/lib/launch/uploads.test.ts`

**Interfaces:**
- Consumes: `Db` (`src/lib/db/client.ts:14-25`: `query`, `exec`, `tx`), `testDb()` (`src/test/db.ts:6`), `migrate(db)` (`src/lib/db/migrate.ts`).
- Produces:
  ```ts
  // src/lib/chain/types.ts
  export type LaunchRow = { tokenId: string; poolId: string; quoteId: string; creator: string; payout: string; hook: string;
    tokenIsCurrency0: boolean; creatorShareBps: number; openTick: number; openingValuation: bigint; liquidity: bigint;
    tokensInPool: bigint; firstBuyIn: bigint; firstBuyTokens: bigint; routerFee: bigint; creationFee: bigint;
    name: string; symbol: string; metadataUri: string; metadataCid: string; block: number; logIndex: number; txHash: string; timestamp: number };
  export type LaunchFeesRow = { txHash: string; logIndex: number; tokenId: string; payout: string; tokenPayout: bigint;
    tokenPlatform: bigint; quotePayout: bigint; quotePlatform: bigint; timestamp: number; block: number };
  export type PayoutRow = { tokenId: string; payout: string; block: number; logIndex: number };
  // src/lib/launch/store.ts
  export async function insertLaunches(db: Db, rows: readonly LaunchRow[], now: number): Promise<number>;
  export async function attachUploads(db: Db, tokenIds: readonly string[], now: number): Promise<void>;
  export async function insertLaunchFees(db: Db, rows: readonly LaunchFeesRow[]): Promise<number>;
  export async function applyPayouts(db: Db, rows: readonly PayoutRow[], now: number): Promise<number>;
  export async function launchHealth(db: Db): Promise<{ missingUploads: number; deletedUploads: number }>;
  // src/lib/launch/uploads.ts
  export const UPLOADS_PER_HOUR = 5; export const UPLOADS_PER_DAY = 20;
  export type UploadRow = { wallet: string; imageCid: string; metadataCid: string; imageKey: string; metadataKey: string;
    name: string; symbol: string; description: string; website: string; x: string; telegram: string };
  export type UploadCounts = { hour: number; day: number };
  export type UploadStatus = "pending" | "refused";
  export async function uploadCounts(db: Db, wallet: string, now: number): Promise<UploadCounts>;
  export function overLimit(c: UploadCounts): boolean;
  export async function recordUpload(db: Db, row: UploadRow, now: number): Promise<UploadStatus>;
  export type CleanableUpload = { id: number; imageCid: string; metadataCid: string; imageKey: string; metadataKey: string };
  export async function cleanableUploads(db: Db, cutoff: number, limit: number): Promise<CleanableUpload[]>;
  export async function objectNeeded(db: Db, kind: "image" | "metadata", cid: string, exceptId: number, cutoff: number): Promise<boolean>;
  export async function markUploadDeleted(db: Db, id: number): Promise<void>;
  ```

- [ ] **Step 1: Write the failing migration test**

Edit `src/lib/db/migrate.test.ts`. Line 10 today is:

```ts
const TABLES = ["candles", "holder_refresh", "pools", "quotes", "schema_migrations", "swaps", "sync_state", "token_balances", "tokens"];
```

Replace it with:

```ts
const TABLES = [
  "candles", "holder_refresh", "launch_fee_events", "launch_uploads", "launches", "pools", "quotes", "schema_migrations", "swaps",
  "sync_state", "token_balances", "tokens",
];
```

Then add this test inside `describe("migrate", …)`, after the "round-trips a COPY" test:

```ts
  it("creates the instant launchpad's three tables, their checks and every index spec 5.1 names", async () => {
    await migrate(db); // idempotent, so this case also passes when run alone
    const columns = async (table: string) =>
      db.query<{ column_name: string; data_type: string }>(
        "select column_name, data_type from information_schema.columns where table_schema = 'market' and table_name = $1 order by ordinal_position",
        [table],
      );
    const launches = await columns("launches");
    expect(launches.map((c) => c.column_name)).toEqual([
      "token_id", "pool_id", "quote_id", "creator", "payout", "token_is_currency0", "creator_share_bps", "open_tick",
      "opening_valuation", "liquidity", "tokens_in_pool", "first_buy_in", "first_buy_tokens", "router_fee", "creation_fee",
      "hook", "name", "symbol", "metadata_uri", "metadata_cid", "image_cid", "description", "website", "x", "telegram",
      "launch_block", "launch_log_index", "launch_tx", "launched_at", "payout_block", "payout_log_index", "hidden", "updated_at",
    ]);
    // Raw chain integers are numeric, never int or float, so a uint256 round-trips as its exact digits.
    for (const name of ["opening_valuation", "liquidity", "tokens_in_pool", "first_buy_in", "first_buy_tokens", "router_fee", "creation_fee"]) {
      expect(launches.find((c) => c.column_name === name)?.data_type).toBe("numeric");
    }
    expect((await columns("launch_fee_events")).map((c) => c.column_name)).toEqual([
      "tx_hash", "log_index", "token_id", "payout", "token_payout", "token_platform", "quote_payout", "quote_platform", "block", "ts",
    ]);
    expect((await columns("launch_uploads")).map((c) => c.column_name)).toEqual([
      "id", "wallet", "image_cid", "metadata_cid", "image_key", "metadata_key", "name", "symbol", "description", "website", "x",
      "telegram", "status", "created_at", "used_at", "token_id",
    ]);
    const indexes = await db.query<{ indexname: string }>("select indexname from pg_indexes where schemaname = 'market' order by indexname");
    expect(indexes.map((i) => i.indexname)).toEqual(
      expect.arrayContaining([
        "launches_creator", "launches_metadata_cid", "launch_fee_events_token", "launch_uploads_wallet_created",
        "launch_uploads_metadata_cid", "launch_uploads_image_cid", "launch_uploads_cleanable", "pools_activity", "pools_sv_unswapped",
      ]),
    );
    // The status enumeration and the tick-spacing check are enforced by the database, not only by the code.
    await expect(
      db.query(
        `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, status, created_at)
         values ('0xa', 'i', 'm', 'ik', 'mk', 'N', 'S', 'lost', 1)`,
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `insert into market.launches (token_id, pool_id, quote_id, creator, payout, token_is_currency0, creator_share_bps, open_tick,
           opening_valuation, liquidity, tokens_in_pool, first_buy_in, first_buy_tokens, router_fee, creation_fee, hook, name, symbol,
           metadata_uri, launch_block, launch_log_index, launch_tx, launched_at, payout_block, payout_log_index, updated_at)
         values ('0xt', '0xp', '0xq', '0xc', '0xc', true, 7000, 150, 1, 1, 1, 0, 0, 0, 0, '0x0', 'N', 'S', '', 1, 0, '0xtx', 1, 1, 0, 1)`,
      ),
    ).rejects.toThrow();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/db/migrate.test.ts`
Expected: FAIL. The first test misses `launch_fee_events`, `launch_uploads` and `launches`; the new one finds no columns.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260929000000_launches.sql`, spec 5.1 verbatim:

```sql
-- Instant launchpad (spec 2026-09-28-instant-launchpad-design.md, section 5). Additive: three new tables and one index.

create table market.launches (
  token_id text primary key,                 -- lower-case token address, the key of market.tokens
  pool_id text not null,
  quote_id text not null,
  creator text not null,
  payout text not null,
  token_is_currency0 boolean not null,
  creator_share_bps int not null check (creator_share_bps between 0 and 10000),
  open_tick int not null check (open_tick % 200 = 0),
  opening_valuation numeric not null,        -- V', raw quote units for the whole supply
  liquidity numeric not null,
  tokens_in_pool numeric not null,
  first_buy_in numeric not null,
  first_buy_tokens numeric not null,
  router_fee numeric not null,
  creation_fee numeric not null,
  hook text not null,
  name text not null,
  symbol text not null,
  metadata_uri text not null,
  metadata_cid text not null default '',     -- from metadata_uri when it is ipfs://<cid>, else ''
  image_cid text not null default '',        -- the rest copied from market.launch_uploads, '' without a match
  description text not null default '',
  website text not null default '',
  x text not null default '',
  telegram text not null default '',
  launch_block int not null,
  launch_log_index int not null,
  launch_tx text not null,
  launched_at int not null,
  -- No fee totals here (amended 29 Sep 2026): they are summed on read from market.launch_fee_events (5.5).
  payout_block int not null,                 -- the last PayoutChanged applied, as (block, log index)
  payout_log_index int not null,
  hidden boolean not null default false,     -- moderation: no image, description or links anywhere
  updated_at int not null,
  check (opening_valuation > 0 and liquidity > 0 and tokens_in_pool > 0),
  check (first_buy_in >= 0 and first_buy_tokens >= 0 and router_fee >= 0 and creation_fee >= 0)
);
create index launches_creator on market.launches (creator);
create index launches_metadata_cid on market.launches (metadata_cid) where metadata_cid <> '';

-- One row per FeesCollected log (amended 29 Sep 2026): the primary key makes a re-applied batch a no-op. Fee totals
-- are never stored; the single-token read sums this table through launch_fee_events_token.
create table market.launch_fee_events (
  tx_hash text not null,
  log_index int not null,
  token_id text not null,
  payout text not null,
  token_payout numeric not null check (token_payout >= 0),
  token_platform numeric not null check (token_platform >= 0),
  quote_payout numeric not null check (quote_payout >= 0),
  quote_platform numeric not null check (quote_platform >= 0),
  block int not null,
  ts int not null,
  primary key (tx_hash, log_index)
);
create index launch_fee_events_token on market.launch_fee_events (token_id, ts desc);

create table market.launch_uploads (
  id bigint generated always as identity primary key, -- one row per accepted upload, so every one counts
  wallet text not null,
  image_cid text not null,
  metadata_cid text not null,
  image_key text not null,                   -- Filebase object keys, for the orphan clean-up
  metadata_key text not null,
  name text not null,
  symbol text not null,
  description text not null default '',
  website text not null default '',
  x text not null default '',
  telegram text not null default '',
  -- 'refused': pinned, then refused by the locked recount (section 6 step 12); not counted, cleaned like 'pending'
  status text not null default 'pending' check (status in ('pending', 'used', 'deleted', 'refused')),
  created_at int not null,
  used_at int not null default 0,
  token_id text not null default ''
);
create index launch_uploads_wallet_created on market.launch_uploads (wallet, created_at desc);
create index launch_uploads_metadata_cid on market.launch_uploads (metadata_cid);
create index launch_uploads_image_cid on market.launch_uploads (image_cid);
create index launch_uploads_cleanable on market.launch_uploads (created_at) where status in ('pending', 'refused');

-- The markets table now orders by coalesce(last_swap_at, created_at) so an unswapped launch in its first 24 hours
-- is not cut off (5.4).
create index if not exists pools_activity on market.pools ((coalesce(last_swap_at, created_at)) desc);

-- Backs the per-cycle query for SV pools whose 24-hour listing window has closed (5.4).
create index pools_sv_unswapped on market.pools (created_at) where origin = 'SV' and swap_count = 0;
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/db/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the row types**

Append to `src/lib/chain/types.ts`, after the closing `};` of `FoldResult` (line 214):

```ts

/**
 * One `Launched` event, shaped for market.launches (instant launchpad design, section 5.2). `metadataCid` is the part
 * after `ipfs://` when `metadataUri` matches `^ipfs://[A-Za-z0-9]{46,128}$`, else "".
 */
export type LaunchRow = {
  tokenId: string; poolId: string; quoteId: string; creator: string; payout: string; hook: string;
  tokenIsCurrency0: boolean; creatorShareBps: number; openTick: number; openingValuation: bigint; liquidity: bigint;
  tokensInPool: bigint; firstBuyIn: bigint; firstBuyTokens: bigint; routerFee: bigint; creationFee: bigint;
  name: string; symbol: string; metadataUri: string; metadataCid: string;
  block: number; logIndex: number; txHash: string; timestamp: number;
};

/** One `FeesCollected` log, the key of market.launch_fee_events. Platform amounts are the event's total minus its payout amount. */
export type LaunchFeesRow = {
  txHash: string; logIndex: number;
  tokenId: string; payout: string; tokenPayout: bigint; tokenPlatform: bigint; quotePayout: bigint; quotePlatform: bigint;
  timestamp: number; block: number;
};

/** The last `PayoutChanged` of a token in a batch, applied only over an older (block, log index). */
export type PayoutRow = { tokenId: string; payout: string; block: number; logIndex: number };
```

- [ ] **Step 6: Write the failing store tests**

Create `src/lib/launch/store.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LaunchFeesRow, LaunchRow } from "@/lib/chain/types";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { applyPayouts, attachUploads, insertLaunchFees, insertLaunches, launchHealth } from "./store";

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(() => db.exec("delete from market.launches; delete from market.launch_fee_events; delete from market.launch_uploads"));

const T0 = 1_790_000_000;
const TOKEN = "0x" + "a1".repeat(20);
const TOKEN_B = "0x" + "a2".repeat(20);
const CREATOR = "0x" + "c1".repeat(20);
const PAYOUT = "0x" + "c2".repeat(20);
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const POOL = "0x" + "11".repeat(32);
const TX = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const META_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const OTHER_META_CID = "bafkreid7qoywk77r7rj3slobqfekdvs57qwuwh5d2z3sqsw52iabe3mqne";
const IMAGE_CID = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";
const NEWER_IMAGE_CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

function launchRow(o: Partial<LaunchRow> = {}): LaunchRow {
  return {
    tokenId: TOKEN, poolId: POOL, quoteId: USDG, creator: CREATOR, payout: CREATOR, hook: "0x" + "0".repeat(40),
    tokenIsCurrency0: true, creatorShareBps: 7000, openTick: -398_400, openingValuation: 4_995_430_000n,
    liquidity: 2_240_000_000_000_000_000n, tokensInPool: 999_999_999_999_999_999_700_000_000n, firstBuyIn: 0n, firstBuyTokens: 0n,
    routerFee: 0n, creationFee: 0n, name: "Tailor's Chalk", symbol: "CHALK", metadataUri: `ipfs://${META_CID}`, metadataCid: META_CID,
    block: 100, logIndex: 7, txHash: TX(1), timestamp: T0, ...o,
  };
}
function feeRow(o: Partial<LaunchFeesRow> = {}): LaunchFeesRow {
  return {
    txHash: TX(9), logIndex: 2, tokenId: TOKEN, payout: CREATOR, tokenPayout: 700n, tokenPlatform: 300n, quotePayout: 7_000_000n,
    quotePlatform: 3_000_000n, timestamp: T0 + 600, block: 160, ...o,
  };
}
/** One market.launch_uploads row, written straight: the route's own insert is uploads.ts's business. */
async function upload(o: { metadataCid?: string; imageCid?: string; status?: string; createdAt?: number; website?: string } = {}): Promise<number> {
  const [row] = await db.query<{ id: number | string }>(
    `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, description, website, x, telegram, status, created_at)
     values ($1, $2, $3, 'launch/img/k.webp', 'launch/meta/k.json', 'Tailor''s Chalk', 'CHALK', 'Chalk for tailors.', $4, 'https://x.com/chalk', '', $5, $6)
     returning id`,
    [CREATOR, o.imageCid ?? IMAGE_CID, o.metadataCid ?? META_CID, o.website ?? "", o.status ?? "pending", o.createdAt ?? T0 - 60],
  );
  return Number(row!.id);
}
const launch = async (tokenId = TOKEN) =>
  (await db.query<Record<string, unknown>>(
    `select payout, payout_block, payout_log_index, opening_valuation::text as opening_valuation, tokens_in_pool::text as tokens_in_pool,
       image_cid, description, website, x, telegram, updated_at from market.launches where token_id = $1`,
    [tokenId],
  ))[0];
const uploadRows = () => db.query<{ id: number | string; status: string; used_at: number; token_id: string }>(
  "select id, status, used_at, token_id from market.launch_uploads order by id",
);

describe("insertLaunches", () => {
  it("inserts a launch once, keyed by token: a replayed Launched changes nothing, and the payout position starts at the launch's own", async () => {
    expect(await insertLaunches(db, [launchRow()], T0 + 10)).toBe(1);
    expect(await insertLaunches(db, [launchRow({ payout: PAYOUT, openingValuation: 1n })], T0 + 20)).toBe(0);
    expect(await launch()).toMatchObject({
      payout: CREATOR, payout_block: 100, payout_log_index: 7, opening_valuation: "4995430000",
      tokens_in_pool: "999999999999999999700000000", image_cid: "", updated_at: T0 + 10,
    });
  });
});

describe("attachUploads", () => {
  it("copies the newest live upload's image and links onto the launch and marks every pending upload of that CID used", async () => {
    const older = await upload({ createdAt: T0 - 600 });
    const newer = await upload({ imageCid: NEWER_IMAGE_CID, website: "https://chalk.test", createdAt: T0 - 60 });
    const unrelated = await upload({ metadataCid: OTHER_META_CID });
    await insertLaunches(db, [launchRow()], T0);
    await attachUploads(db, [TOKEN], T0 + 5);
    expect(await launch()).toMatchObject({
      image_cid: NEWER_IMAGE_CID, description: "Chalk for tailors.", website: "https://chalk.test", x: "https://x.com/chalk",
      telegram: "", updated_at: T0 + 5,
    });
    expect((await uploadRows()).map((r) => [Number(r.id), r.status, r.used_at, r.token_id])).toEqual([
      [older, "used", T0 + 5, TOKEN],
      [newer, "used", T0 + 5, TOKEN],
      [unrelated, "pending", 0, ""],
    ]);
  });

  it("never copies from, nor revives, a deleted upload: that launch shows no image and the health count says so", async () => {
    const gone = await upload({ status: "deleted" });
    await insertLaunches(db, [launchRow()], T0);
    await attachUploads(db, [TOKEN], T0 + 5);
    expect(await launch()).toMatchObject({ image_cid: "", website: "" });
    expect((await uploadRows()).map((r) => [Number(r.id), r.status])).toEqual([[gone, "deleted"]]);
    expect(await launchHealth(db)).toEqual({ missingUploads: 1, deletedUploads: 1 });
  });

  it("leaves a launch whose URI carried no ipfs CID alone", async () => {
    await upload({ metadataCid: "" });
    await insertLaunches(db, [launchRow({ metadataUri: "https://example.test/meta.json", metadataCid: "" })], T0);
    await attachUploads(db, [TOKEN], T0 + 5);
    expect(await launch()).toMatchObject({ image_cid: "" });
    expect((await uploadRows())[0]!.status).toBe("pending");
    expect(await launchHealth(db)).toEqual({ missingUploads: 0, deletedUploads: 0 });
  });

  it("does nothing for an empty list", async () => {
    await expect(attachUploads(db, [], T0)).resolves.toBeUndefined();
  });
});

describe("insertLaunchFees", () => {
  it("inserts one row per log and nothing when the same logs come again", async () => {
    const rows = [feeRow(), feeRow({ logIndex: 5, tokenId: TOKEN_B })];
    expect(await insertLaunchFees(db, rows)).toBe(2);
    expect(await insertLaunchFees(db, rows)).toBe(0);
    const stored = await db.query<{ token_payout: string; quote_platform: string }>(
      "select token_payout::text as token_payout, quote_platform::text as quote_platform from market.launch_fee_events order by log_index",
    );
    expect(stored).toEqual([
      { token_payout: "700", quote_platform: "3000000" },
      { token_payout: "700", quote_platform: "3000000" },
    ]);
  });
});

describe("applyPayouts", () => {
  it("moves the payout only forward by (block, log index): an older change is a no-op, a newer one wins", async () => {
    await insertLaunches(db, [launchRow()], T0);
    expect(await applyPayouts(db, [{ tokenId: TOKEN, payout: PAYOUT, block: 120, logIndex: 3 }], T0 + 1)).toBe(1);
    expect(await applyPayouts(db, [{ tokenId: TOKEN, payout: CREATOR, block: 120, logIndex: 2 }], T0 + 2)).toBe(0);
    expect(await applyPayouts(db, [{ tokenId: TOKEN, payout: PAYOUT, block: 120, logIndex: 3 }], T0 + 3)).toBe(0);
    expect(await launch()).toMatchObject({ payout: PAYOUT, payout_block: 120, payout_log_index: 3, updated_at: T0 + 1 });
    expect(await applyPayouts(db, [{ tokenId: TOKEN, payout: CREATOR, block: 121, logIndex: 0 }], T0 + 4)).toBe(1);
    expect(await launch()).toMatchObject({ payout: CREATOR, payout_block: 121, payout_log_index: 0 });
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run src/lib/launch/store.test.ts`
Expected: FAIL with "Failed to resolve import "./store"".

- [ ] **Step 8: Write the launch store**

Create `src/lib/launch/store.ts`:

```ts
import "server-only";

import type { LaunchFeesRow, LaunchRow, PayoutRow } from "@/lib/chain/types";
import type { Db } from "@/lib/db/client";

/**
 * The instant launchpad's writes into market.launches and market.launch_fee_events (design section 5.2), all called from
 * inside `applyFold`'s one transaction, so a throw rolls the batch back with the cursor. Every statement is idempotent:
 * the launch and fee inserts do nothing on conflict, the payout update is gated by the (block, log index) it replaces.
 */

/** Rows per statement, as src/lib/sync/writers.ts's CHUNK: each column is one array parameter. */
const CHUNK = 1000;
function chunk<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}
/** Booleans travel as text and are cast per element: see src/lib/sync/writers.ts's `bool` for why. */
const bool = (b: boolean) => (b ? "true" : "false");

export async function insertLaunches(db: Db, rows: readonly LaunchRow[], now: number): Promise<number> {
  let inserted = 0;
  for (const c of chunk(rows)) {
    const out = await db.query<{ token_id: string }>(
      `insert into market.launches (token_id, pool_id, quote_id, creator, payout, token_is_currency0, creator_share_bps, open_tick,
         opening_valuation, liquidity, tokens_in_pool, first_buy_in, first_buy_tokens, router_fee, creation_fee, hook, name, symbol,
         metadata_uri, metadata_cid, launch_block, launch_log_index, launch_tx, launched_at, payout_block, payout_log_index, updated_at)
       select token_id, pool_id, quote_id, creator, payout, token_is_currency0::boolean, creator_share_bps, open_tick,
         opening_valuation, liquidity, tokens_in_pool, first_buy_in, first_buy_tokens, router_fee, creation_fee, hook, name, symbol,
         metadata_uri, metadata_cid, launch_block, launch_log_index, launch_tx, launched_at, launch_block, launch_log_index, $25::int
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::int[],
         $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[], $14::numeric[], $15::numeric[], $16::text[],
         $17::text[], $18::text[], $19::text[], $20::text[], $21::int[], $22::int[], $23::text[], $24::int[])
         as u(token_id, pool_id, quote_id, creator, payout, token_is_currency0, creator_share_bps, open_tick, opening_valuation,
           liquidity, tokens_in_pool, first_buy_in, first_buy_tokens, router_fee, creation_fee, hook, name, symbol, metadata_uri,
           metadata_cid, launch_block, launch_log_index, launch_tx, launched_at)
       on conflict (token_id) do nothing
       returning token_id`,
      [
        c.map((r) => r.tokenId), c.map((r) => r.poolId), c.map((r) => r.quoteId), c.map((r) => r.creator), c.map((r) => r.payout),
        c.map((r) => bool(r.tokenIsCurrency0)), c.map((r) => r.creatorShareBps), c.map((r) => r.openTick),
        c.map((r) => r.openingValuation.toString()), c.map((r) => r.liquidity.toString()), c.map((r) => r.tokensInPool.toString()),
        c.map((r) => r.firstBuyIn.toString()), c.map((r) => r.firstBuyTokens.toString()), c.map((r) => r.routerFee.toString()),
        c.map((r) => r.creationFee.toString()), c.map((r) => r.hook), c.map((r) => r.name), c.map((r) => r.symbol),
        c.map((r) => r.metadataUri), c.map((r) => r.metadataCid), c.map((r) => r.block), c.map((r) => r.logIndex),
        c.map((r) => r.txHash), c.map((r) => r.timestamp), now,
      ],
    );
    inserted += out.length;
  }
  return inserted;
}

/**
 * Links and the image CID reach a launch from market.launch_uploads by metadata CID (design 5.2 step 2): the newest
 * upload that is not `deleted` wins, then every `pending` upload of that CID becomes `used` by this token. A deleted
 * upload's objects are gone, so it is never copied from and never revived; its launch shows no image and health counts it.
 */
export async function attachUploads(db: Db, tokenIds: readonly string[], now: number): Promise<void> {
  if (tokenIds.length === 0) return;
  const ids = [...tokenIds];
  await db.query(
    `update market.launches l set image_cid = u.image_cid, description = u.description, website = u.website,
       x = u.x, telegram = u.telegram, updated_at = $2::int
     from (select distinct on (metadata_cid) * from market.launch_uploads
           where status <> 'deleted'
             and metadata_cid in (select metadata_cid from market.launches where token_id = any($1::text[]))
           order by metadata_cid, id desc) u
     where l.token_id = any($1::text[]) and l.metadata_cid <> '' and u.metadata_cid = l.metadata_cid`,
    [ids, now],
  );
  await db.query(
    `update market.launch_uploads u set status = 'used', used_at = $2::int, token_id = l.token_id
     from market.launches l
     where l.token_id = any($1::text[]) and l.metadata_cid <> '' and u.metadata_cid = l.metadata_cid
       and u.status = 'pending'`,
    [ids, now],
  );
}

/** One row per FeesCollected log and nothing else (design 5.2 step 3): no totals are stored, so a re-applied batch inserts nothing. */
export async function insertLaunchFees(db: Db, rows: readonly LaunchFeesRow[]): Promise<number> {
  let inserted = 0;
  for (const c of chunk(rows)) {
    const out = await db.query<{ tx_hash: string }>(
      `insert into market.launch_fee_events (tx_hash, log_index, token_id, payout, token_payout, token_platform,
         quote_payout, quote_platform, block, ts)
       select * from unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[],
         $8::numeric[], $9::int[], $10::int[])
       on conflict (tx_hash, log_index) do nothing
       returning tx_hash`,
      [
        c.map((r) => r.txHash), c.map((r) => r.logIndex), c.map((r) => r.tokenId), c.map((r) => r.payout),
        c.map((r) => r.tokenPayout.toString()), c.map((r) => r.tokenPlatform.toString()), c.map((r) => r.quotePayout.toString()),
        c.map((r) => r.quotePlatform.toString()), c.map((r) => r.block), c.map((r) => r.timestamp),
      ],
    );
    inserted += out.length;
  }
  return inserted;
}

/** Last-write-wins by position (design 5.2 step 4): the stored (block, log index) makes a replay a no-op. */
export async function applyPayouts(db: Db, rows: readonly PayoutRow[], now: number): Promise<number> {
  let updated = 0;
  for (const c of chunk(rows)) {
    const out = await db.query<{ token_id: string }>(
      `update market.launches l set payout = u.payout, payout_block = u.block, payout_log_index = u.log_index, updated_at = $5::int
       from unnest($1::text[], $2::text[], $3::int[], $4::int[]) as u(token_id, payout, block, log_index)
       where l.token_id = u.token_id and (l.payout_block, l.payout_log_index) < (u.block, u.log_index)
       returning l.token_id`,
      [c.map((r) => r.tokenId), c.map((r) => r.payout), c.map((r) => r.block), c.map((r) => r.logIndex), now],
    );
    updated += out.length;
  }
  return updated;
}

/**
 * Health's `launches` block (design section 13): launches that carry a metadata CID but no image, which is how a launch
 * whose upload was already cleaned up shows, and the uploads the nightly clean-up has removed.
 */
export async function launchHealth(db: Db): Promise<{ missingUploads: number; deletedUploads: number }> {
  const [row] = await db.query<{ missing: number | string; deleted: number | string }>(
    `select (select count(*) from market.launches where metadata_cid <> '' and image_cid = '') as missing,
            (select count(*) from market.launch_uploads where status = 'deleted') as deleted`,
  );
  return { missingUploads: Number(row!.missing), deletedUploads: Number(row!.deleted) };
}
```

- [ ] **Step 9: Run the store tests to verify they pass**

Run: `npx vitest run src/lib/launch/store.test.ts`
Expected: PASS.

- [ ] **Step 10: Write the failing upload-bookkeeping tests**

Create `src/lib/launch/uploads.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import {
  UPLOADS_PER_DAY, UPLOADS_PER_HOUR, cleanableUploads, markUploadDeleted, objectNeeded, overLimit, recordUpload, uploadCounts,
  type UploadRow,
} from "./uploads";

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(() => db.exec("delete from market.launch_uploads"));

const NOW = 1_790_000_000;
const WALLET = "0x" + "c1".repeat(20);
const OTHER = "0x" + "c2".repeat(20);
const META = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const IMAGE = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";

function row(o: Partial<UploadRow> = {}): UploadRow {
  return {
    wallet: WALLET, imageCid: IMAGE, metadataCid: META, imageKey: "launch/img/aa.webp", metadataKey: "launch/meta/bb.json",
    name: "Tailor's Chalk", symbol: "CHALK", description: "", website: "", x: "", telegram: "", ...o,
  };
}
async function seed(status: string, createdAt: number, o: Partial<UploadRow> = {}): Promise<number> {
  const r = row(o);
  const [out] = await db.query<{ id: number | string }>(
    `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, status, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [r.wallet, r.imageCid, r.metadataCid, r.imageKey, r.metadataKey, r.name, r.symbol, status, createdAt],
  );
  return Number(out!.id);
}

describe("uploadCounts and overLimit", () => {
  it("counts this wallet's pending, used and deleted rows over the last hour and day, never refused ones or other wallets", async () => {
    await seed("pending", NOW - 60);
    await seed("used", NOW - 3000);
    await seed("deleted", NOW - 7200);
    await seed("refused", NOW - 60);
    await seed("pending", NOW - 90_000); // older than a day
    await seed("pending", NOW - 60, { wallet: OTHER });
    expect(await uploadCounts(db, WALLET, NOW)).toEqual({ hour: 2, day: 3 });
  });

  it("refuses at 5 an hour and at 20 a day", () => {
    expect([UPLOADS_PER_HOUR, UPLOADS_PER_DAY]).toEqual([5, 20]);
    expect(overLimit({ hour: 4, day: 19 })).toBe(false);
    expect(overLimit({ hour: 5, day: 5 })).toBe(true);
    expect(overLimit({ hour: 0, day: 20 })).toBe(true);
  });
});

describe("recordUpload", () => {
  it("stores the row pending under the limit and refused at it, and a refused row never counts", async () => {
    for (let i = 0; i < 4; i += 1) await seed("pending", NOW - 100 - i);
    expect(await recordUpload(db, row(), NOW)).toBe("pending");
    expect(await recordUpload(db, row(), NOW)).toBe("refused");
    expect(await uploadCounts(db, WALLET, NOW)).toEqual({ hour: 5, day: 5 });
    const stored = await db.query<{ status: string; created_at: number; wallet: string }>(
      "select status, created_at, wallet from market.launch_uploads where created_at = $1 order by id",
      [NOW],
    );
    expect(stored).toEqual([
      { status: "pending", created_at: NOW, wallet: WALLET },
      { status: "refused", created_at: NOW, wallet: WALLET },
    ]);
  });

  it("makes two parallel uploads from one wallet count each other: at 4, exactly one is accepted", async () => {
    for (let i = 0; i < 4; i += 1) await seed("pending", NOW - 100 - i);
    // PGlite runs one transaction at a time, so the outcome alone would pass without the lock. Record every statement
    // each transaction issues, so a missing pg_advisory_xact_lock fails this test (on Postgres, it is what serialises them).
    const statements: string[] = [];
    const realTx = db.tx.bind(db);
    vi.spyOn(db, "tx").mockImplementation(<T,>(fn: (t: Db) => Promise<T>) =>
      realTx((t) => fn({ ...t, query: (sql: string, params?: readonly unknown[]) => { statements.push(sql); return t.query(sql, params); } } as Db)),
    );
    const results = await Promise.all([recordUpload(db, row(), NOW), recordUpload(db, row(), NOW)]);
    vi.restoreAllMocks();
    expect([...results].sort()).toEqual(["pending", "refused"]);
    expect((await uploadCounts(db, WALLET, NOW)).hour).toBe(5);
    const locks = statements.flatMap((sql, i) => (sql.includes("pg_advisory_xact_lock(hashtext($1))") ? [i] : []));
    expect(locks).toHaveLength(2);
    // Each transaction takes the lock before its recount and its insert.
    for (const i of locks) expect(statements[i + 1]).toContain("count(*)");
  });
});

describe("the clean-up queries", () => {
  it("lists pending and refused rows older than the cut-off, oldest first, up to the limit", async () => {
    const a = await seed("pending", NOW - 5000);
    const b = await seed("refused", NOW - 4000);
    await seed("used", NOW - 6000);
    await seed("deleted", NOW - 6000);
    await seed("pending", NOW - 10); // after the cut-off
    const c = await seed("pending", NOW - 3000);
    expect((await cleanableUploads(db, NOW - 1000, 10)).map((r) => r.id)).toEqual([a, b, c]);
    expect((await cleanableUploads(db, NOW - 1000, 2)).map((r) => r.id)).toEqual([a, b]);
    expect((await cleanableUploads(db, NOW - 1000, 1))[0]).toEqual({
      id: a, imageCid: IMAGE, metadataCid: META, imageKey: "launch/img/aa.webp", metadataKey: "launch/meta/bb.json",
    });
  });

  it("keeps an object another row still needs: a used row, or a pending or refused row newer than the cut-off", async () => {
    const stale = await seed("pending", NOW - 5000);
    expect(await objectNeeded(db, "metadata", META, stale, NOW - 1000)).toBe(false);
    await seed("pending", NOW - 4500); // also stale: does not protect
    expect(await objectNeeded(db, "metadata", META, stale, NOW - 1000)).toBe(false);
    await seed("refused", NOW - 10); // fresh
    expect(await objectNeeded(db, "metadata", META, stale, NOW - 1000)).toBe(true);
    expect(await objectNeeded(db, "image", IMAGE, stale, NOW - 1000)).toBe(true);
    expect(await objectNeeded(db, "image", "bafyother", stale, NOW - 1000)).toBe(false);
    await db.exec("delete from market.launch_uploads");
    const lone = await seed("pending", NOW - 5000);
    await seed("used", NOW - 9000, { imageCid: "bafyimg2" });
    expect(await objectNeeded(db, "metadata", META, lone, NOW - 1000)).toBe(true);
  });

  it("marks a row deleted", async () => {
    const id = await seed("pending", NOW - 5000);
    await markUploadDeleted(db, id);
    expect(await db.query("select status from market.launch_uploads where id = $1", [id])).toEqual([{ status: "deleted" }]);
  });
});
```

- [ ] **Step 11: Run it to verify it fails**

Run: `npx vitest run src/lib/launch/uploads.test.ts`
Expected: FAIL with "Failed to resolve import "./uploads"".

- [ ] **Step 12: Write the upload bookkeeping**

Create `src/lib/launch/uploads.ts`:

```ts
import "server-only";

import type { Db } from "@/lib/db/client";

/**
 * market.launch_uploads bookkeeping (instant launchpad design, section 6). A row exists only after both pins succeeded,
 * so the persistent limits count successful uploads, never attempts; `refused` rows (pinned, then refused by the locked
 * recount) are not counted and are cleaned like stale `pending` ones.
 */
export const UPLOADS_PER_HOUR = 5;
export const UPLOADS_PER_DAY = 20;

export type UploadRow = {
  wallet: string; imageCid: string; metadataCid: string; imageKey: string; metadataKey: string;
  name: string; symbol: string; description: string; website: string; x: string; telegram: string;
};
export type UploadCounts = { hour: number; day: number };
export type UploadStatus = "pending" | "refused";
export type CleanableUpload = { id: number; imageCid: string; metadataCid: string; imageKey: string; metadataKey: string };

const COUNTS_SQL = `select count(*) filter (where created_at > $2::int - 3600) as hour, count(*) as day
  from market.launch_uploads
  where wallet = $1 and status in ('pending', 'used', 'deleted') and created_at > $2::int - 86400`;

export async function uploadCounts(db: Db, wallet: string, now: number): Promise<UploadCounts> {
  const [row] = await db.query<{ hour: number | string; day: number | string }>(COUNTS_SQL, [wallet.toLowerCase(), now]);
  return { hour: Number(row!.hour), day: Number(row!.day) };
}

export function overLimit(c: UploadCounts): boolean {
  return c.hour >= UPLOADS_PER_HOUR || c.day >= UPLOADS_PER_DAY;
}

/**
 * Step 12 of the route: one short transaction under a per-wallet advisory lock, so two parallel uploads from one wallet
 * count each other. Over the limit the row is still written, as `refused`, so the nightly clean-up can remove its objects.
 */
export async function recordUpload(db: Db, row: UploadRow, now: number): Promise<UploadStatus> {
  const wallet = row.wallet.toLowerCase();
  return db.tx(async (t) => {
    await t.query("select pg_advisory_xact_lock(hashtext($1))", [wallet]);
    const status: UploadStatus = overLimit(await uploadCounts(t, wallet, now)) ? "refused" : "pending";
    await t.query(
      `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, description,
         website, x, telegram, status, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::int)`,
      [wallet, row.imageCid, row.metadataCid, row.imageKey, row.metadataKey, row.name, row.symbol, row.description,
        row.website, row.x, row.telegram, status, now],
    );
    return status;
  });
}

export async function cleanableUploads(db: Db, cutoff: number, limit: number): Promise<CleanableUpload[]> {
  const rows = await db.query<{ id: number | string; image_cid: string; metadata_cid: string; image_key: string; metadata_key: string }>(
    `select id, image_cid, metadata_cid, image_key, metadata_key from market.launch_uploads
     where status in ('pending', 'refused') and created_at < $1::int
     order by created_at, id limit $2::int`,
    [cutoff, limit],
  );
  return rows.map((r) => ({ id: Number(r.id), imageCid: r.image_cid, metadataCid: r.metadata_cid, imageKey: r.image_key, metadataKey: r.metadata_key }));
}

/**
 * Whether an object must stay pinned (design section 6, orphans step 3): another row with the same CID is `used`, or is
 * `pending` or `refused` and not older than the cut-off. Object keys are content hashes, so one object can back many rows.
 */
export async function objectNeeded(db: Db, kind: "image" | "metadata", cid: string, exceptId: number, cutoff: number): Promise<boolean> {
  const column = kind === "image" ? "image_cid" : "metadata_cid";
  const [row] = await db.query<{ needed: boolean }>(
    `select exists (select 1 from market.launch_uploads where ${column} = $1 and id <> $2
       and (status = 'used' or (status in ('pending', 'refused') and created_at >= $3::int))) as needed`,
    [cid, exceptId, cutoff],
  );
  return row!.needed;
}

export async function markUploadDeleted(db: Db, id: number): Promise<void> {
  await db.query("update market.launch_uploads set status = 'deleted' where id = $1", [id]);
}
```

- [ ] **Step 13: Run the task's tests and the gates**

Run: `npx vitest run src/lib/db src/lib/launch`
Expected: PASS.
Then run the three gates: `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src`. All clean.

- [ ] **Step 14: Commit**

```bash
git add supabase/migrations/20260929000000_launches.sql src/lib/db/migrate.test.ts src/lib/chain/types.ts src/lib/launch/store.ts src/lib/launch/store.test.ts src/lib/launch/uploads.ts src/lib/launch/uploads.test.ts
git commit -m "Launchpad: the launches, fee-event and upload tables, and the stores that write them"
```

---

### Task 2: The launchpad's interface: ABI, address and the deploy currency config

**Files:**
- Modify: `src/lib/chain/abi.ts` (append `LAUNCHPAD_EVENTS_ABI` and `LAUNCH_TOPIC0` after line 29)
- Create: `src/lib/launch/abi.ts`, `src/lib/launch/abi.test.ts`
- Create: `src/lib/launch/address.ts`, `src/lib/launch/address.test.ts`
- Create: `src/lib/launch/currencyConfig.ts`, `src/lib/launch/currencyConfig.test.ts`
- Create: `scripts/launch/currency-config.mts`
- Modify: `package.json:17` (one script after `chain:gapfill`)

**Interfaces:**
- Consumes: viem `toEventSelector`; `QUOTES`, `type QuoteRow` (`src/lib/chain/math/quotes.ts:4-12, 57`); `USDG` (`src/lib/chain/math/constants.ts:5`); `Address` (`src/lib/types.ts:11`).
- Produces:
  ```ts
  // src/lib/chain/abi.ts
  export const LAUNCHPAD_EVENTS_ABI: readonly [LaunchedEvent, FeesCollectedEvent, PayoutChangedEvent] /* as const */;
  export const LAUNCH_TOPIC0: { launched: Hex; feesCollected: Hex; payoutChanged: Hex };
  // src/lib/launch/abi.ts
  export const svLaunchpadAbi /* as const: every function, the three activity events, the eight setting events, every error */;
  // src/lib/launch/address.ts
  export function parseLaunchpadAddress(raw: string | undefined): Address | undefined;
  export const LAUNCHPAD_ADDRESS: Address | undefined;
  export function hasLaunchpad(): boolean;
  // src/lib/launch/currencyConfig.ts
  export const MIN_USD = 5_000; export const MAX_USD = 10_000_000; export const CREATION_FEE = "0";
  export const REFERENCE_PRICE_DECIMALS = 8; // documentation only, never written to the file
  export type CurrencyPriceSource = "chainlink" | "pinned" | "reference";
  // Key order is the contracts script's canonical order: address, symbol, decimals, priceSource, chainlinkProxy, chainlinkDecimals, referenceUsdPrice
  export type CurrencyConfigRow = { address: string; symbol: string; decimals: number; priceSource: CurrencyPriceSource;
    chainlinkProxy: string; chainlinkDecimals: number; referenceUsdPrice: string };
  export type CurrencyConfigFile = { minUsd: number; maxUsd: number; creationFee: string; currencies: CurrencyConfigRow[] };
  export function currencyConfig(rows: readonly QuoteRow[]): CurrencyConfigFile;
  // npm run launch:currencies -- --out <path> [--force]
  ```

The ABI below is spec 4.2's `ISVLaunchpad` transcribed in the interface's order: the anyone functions, the owner setters, the views, the three activity events (in `src/lib/chain/abi.ts`, spread in here so the reader and the writer can never disagree), the eight setting events, the 24 custom errors, and three foreign errors that bubble up through a launch: v4's `PoolAlreadyInitialized()`, Permit2's `InvalidNonce()` and `SignatureExpired(uint256)` (spec 7.2). Parameter names follow the interface; where it names none, the name is the obvious one and appears in no selector.

- [ ] **Step 1: Write the failing ABI test**

Create `src/lib/launch/abi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeErrorResult, encodeEventTopics,
  encodeFunctionData, toEventSelector, toFunctionSelector, type Hex,
} from "viem";
import { LAUNCHPAD_EVENTS_ABI, LAUNCH_TOPIC0 } from "@/lib/chain/abi";
import type { Address } from "@/lib/types";
import { svLaunchpadAbi } from "./abi";

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const C = "0x3333333333333333333333333333333333333333" as Address;
const SALT = `0x${"ab".repeat(32)}` as Hex;
const POOL_ID = `0x${"cd".repeat(32)}` as Hex;

/** Spec 4.2's canonical signatures, typed out here so the selectors are pinned independently of how abi.ts spells them. */
const EVENTS: ReadonlyArray<readonly [string, string]> = [
  ["Launched", "Launched(address,address,address,(bytes32,address,address,bool,int24,uint256,uint128,uint256,uint256,uint256,uint256,uint256,uint16,string,string,string))"],
  ["FeesCollected", "FeesCollected(address,address,uint256,uint256,uint256,uint256)"],
  ["PayoutChanged", "PayoutChanged(address,address,address)"],
  ["FeeWalletChanged", "FeeWalletChanged(address)"],
  ["RouterFeeChanged", "RouterFeeChanged(uint16)"],
  ["CreatorShareChanged", "CreatorShareChanged(uint16)"],
  ["FirstBuyCapChanged", "FirstBuyCapChanged(uint16)"],
  ["DailyLaunchLimitChanged", "DailyLaunchLimitChanged(uint8)"],
  ["LauncherGateChanged", "LauncherGateChanged(address)"],
  ["HookChanged", "HookChanged(address)"],
  ["CurrencyChanged", "CurrencyChanged(address,uint256,uint256,uint256)"],
];

type EventName = Extract<(typeof svLaunchpadAbi)[number], { type: "event" }>["name"];

describe("the launchpad's events (spec 4.2)", () => {
  it("carries exactly the eleven events, each with its Solidity signature's topic0", () => {
    const names = svLaunchpadAbi.filter((i) => i.type === "event").map((i) => i.name).sort();
    expect(names).toEqual(EVENTS.map(([name]) => name).sort());
    for (const [name, canonical] of EVENTS) {
      expect(encodeEventTopics({ abi: svLaunchpadAbi, eventName: name as EventName })[0]).toBe(toEventSelector(canonical));
    }
  });

  it("pins the three activity topics the reader filters on, to the digit", () => {
    expect(LAUNCH_TOPIC0).toEqual({
      launched: "0xb706006cc55fa62f2e1d800d1523c84da203937d74f39f8d10907d6f76fadfca",
      feesCollected: "0x3dafb2014fe30c40450cebb7865f8a48a63be8e7876aff5e38f3cba37b285263",
      payoutChanged: "0xd64e38e8ecb2ec71967e9aa3a68ee54619b91ff17757987e66aed49b5073ae13",
    });
    expect(LAUNCHPAD_EVENTS_ABI.map((e) => e.name)).toEqual(["Launched", "FeesCollected", "PayoutChanged"]);
  });

  it("round-trips a Launched log, its one tuple decoded field by field", () => {
    const data = {
      poolId: POOL_ID, payout: B, hook: C, tokenIsCurrency0: true, openTick: -398_400, openingValuation: 4_995_430_000n,
      liquidity: 2_240_000_000_000_000_000n, tokensInPool: 10n ** 27n - 300n, firstBuyIn: 99_500_000n, firstBuyTokens: 19n * 10n ** 24n,
      routerFee: 500_000n, creationFee: 0n, creatorShareBps: 7000, name: "Tailor's Chalk", symbol: "CHALK", metadataUri: "ipfs://bafy",
    };
    const topics = encodeEventTopics({ abi: svLaunchpadAbi, eventName: "Launched", args: { token: A, creator: B, quote: C } });
    const encoded = encodeAbiParameters([LAUNCHPAD_EVENTS_ABI[0].inputs[3]], [data]);
    const decoded = decodeEventLog({ abi: svLaunchpadAbi, topics: topics as [Hex, ...Hex[]], data: encoded });
    expect(decoded.eventName).toBe("Launched");
    expect(decoded.args).toEqual({ token: A, creator: B, quote: C, data });
  });
});

describe("the launchpad's functions (spec 4.2, in the interface's order)", () => {
  it("carries exactly the interface's functions, each encoding with the selector of its canonical signature", () => {
    const params = {
      name: "Tailor's Chalk", symbol: "CHALK", metadataUri: "ipfs://bafy", quote: A, valuation: 5n, firstBuy: 0n,
      minFirstBuyTokens: 0n, payout: B, salt: SALT, deadline: 9n,
    };
    const permit = { permitted: { token: A, amount: 5n }, nonce: 7n, deadline: 9n };
    const f = svLaunchpadAbi;
    const cases: ReadonlyArray<readonly [string, Hex]> = [
      ["launch((string,string,string,address,uint256,uint256,uint256,address,bytes32,uint256),((address,uint256),uint256,uint256),bytes)",
        encodeFunctionData({ abi: f, functionName: "launch", args: [params, permit, "0xabcd"] })],
      ["collectFees(address)", encodeFunctionData({ abi: f, functionName: "collectFees", args: [A] })],
      ["claim(address,address)", encodeFunctionData({ abi: f, functionName: "claim", args: [A, B] })],
      ["setPayout(address,address)", encodeFunctionData({ abi: f, functionName: "setPayout", args: [A, B] })],
      ["unlockCallback(bytes)", encodeFunctionData({ abi: f, functionName: "unlockCallback", args: ["0x"] })],
      ["setFeeWallet(address)", encodeFunctionData({ abi: f, functionName: "setFeeWallet", args: [A] })],
      ["setRouterFee(uint16)", encodeFunctionData({ abi: f, functionName: "setRouterFee", args: [50] })],
      ["setCreatorShare(uint16)", encodeFunctionData({ abi: f, functionName: "setCreatorShare", args: [7000] })],
      ["setFirstBuyCap(uint16)", encodeFunctionData({ abi: f, functionName: "setFirstBuyCap", args: [2000] })],
      ["setDailyLaunchLimit(uint8)", encodeFunctionData({ abi: f, functionName: "setDailyLaunchLimit", args: [5] })],
      ["setLauncherGate(address)", encodeFunctionData({ abi: f, functionName: "setLauncherGate", args: [A] })],
      ["setHook(address)", encodeFunctionData({ abi: f, functionName: "setHook", args: [A] })],
      ["setCurrency(address,uint256,uint256,uint256)", encodeFunctionData({ abi: f, functionName: "setCurrency", args: [A, 1n, 2n, 0n] })],
      ["getLaunch(address)", encodeFunctionData({ abi: f, functionName: "getLaunch", args: [A] })],
      ["poolKeyOf(address)", encodeFunctionData({ abi: f, functionName: "poolKeyOf", args: [A] })],
      ["uncollectedFees(address)", encodeFunctionData({ abi: f, functionName: "uncollectedFees", args: [A] })],
      ["predictToken(address,bytes32,string,string)", encodeFunctionData({ abi: f, functionName: "predictToken", args: [A, SALT, "N", "S"] })],
      ["openingFor(address,address,uint256)", encodeFunctionData({ abi: f, functionName: "openingFor", args: [A, B, 5n] })],
      ["isAllowedLauncher(address)", encodeFunctionData({ abi: f, functionName: "isAllowedLauncher", args: [A] })],
      ["launchesToday(address)", encodeFunctionData({ abi: f, functionName: "launchesToday", args: [A] })],
      ["currency(address)", encodeFunctionData({ abi: f, functionName: "currency", args: [A] })],
      ["owed(address,address)", encodeFunctionData({ abi: f, functionName: "owed", args: [A, B] })],
      ["launchCount()", encodeFunctionData({ abi: f, functionName: "launchCount" })],
      ["feeWallet()", encodeFunctionData({ abi: f, functionName: "feeWallet" })],
      ["routerFeeBps()", encodeFunctionData({ abi: f, functionName: "routerFeeBps" })],
      ["creatorShareBps()", encodeFunctionData({ abi: f, functionName: "creatorShareBps" })],
      ["firstBuyCapBps()", encodeFunctionData({ abi: f, functionName: "firstBuyCapBps" })],
      ["dailyLaunchLimit()", encodeFunctionData({ abi: f, functionName: "dailyLaunchLimit" })],
      ["launcherGate()", encodeFunctionData({ abi: f, functionName: "launcherGate" })],
      ["hook()", encodeFunctionData({ abi: f, functionName: "hook" })],
      ["POOL_MANAGER()", encodeFunctionData({ abi: f, functionName: "POOL_MANAGER" })],
      ["PERMIT2()", encodeFunctionData({ abi: f, functionName: "PERMIT2" })],
    ];
    for (const [canonical, data] of cases) expect(data.slice(0, 10)).toBe(toFunctionSelector(canonical));
    const names = f.filter((i) => i.type === "function").map((i) => i.name).sort();
    expect(names).toEqual(cases.map(([canonical]) => canonical.slice(0, canonical.indexOf("("))).sort());
    // The one selector the wallet signs against, pinned to the digit as well.
    expect(cases[0]![1].slice(0, 10)).toBe("0x7d74140f");
  });

  it("decodes the struct-returning views in spec 4.2's struct order", () => {
    // Each tuple is typed out here in the spec's field order, NOT taken from abi.ts: encoding with the ABI's own outputs
    // and decoding with them again would pass whatever order abi.ts happened to use.
    const f = svLaunchpadAbi;
    const ZERO = "0x0000000000000000000000000000000000000000" as Address;
    const launch = { creator: A, launchedAt: 1_790_000_000n, creatorShareBps: 7000, tokenIsCurrency0: false, payout: B, openTick: 398_400, quote: C, hook: ZERO, liquidity: 12n };
    const encodedLaunch = encodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "creator", type: "address" }, { name: "launchedAt", type: "uint64" }, { name: "creatorShareBps", type: "uint16" },
        { name: "tokenIsCurrency0", type: "bool" }, { name: "payout", type: "address" }, { name: "openTick", type: "int24" },
        { name: "quote", type: "address" }, { name: "hook", type: "address" }, { name: "liquidity", type: "uint128" },
      ] }],
      [launch],
    );
    expect(decodeFunctionResult({ abi: f, functionName: "getLaunch", data: encodedLaunch })).toEqual(launch);

    const fees = { tokenFees: 10n, quoteFees: 20n, tokenToPayout: 7n, quoteToPayout: 14n, tokenToFeeWallet: 3n, quoteToFeeWallet: 6n };
    const encodedFees = encodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "tokenFees", type: "uint256" }, { name: "quoteFees", type: "uint256" }, { name: "tokenToPayout", type: "uint256" },
        { name: "quoteToPayout", type: "uint256" }, { name: "tokenToFeeWallet", type: "uint256" }, { name: "quoteToFeeWallet", type: "uint256" },
      ] }],
      [fees],
    );
    expect(decodeFunctionResult({ abi: f, functionName: "uncollectedFees", data: encodedFees })).toEqual(fees);

    const config = { minValuation: 5_000_000_000n, maxValuation: 10_000_000_000_000n, creationFee: 0n };
    const encodedConfig = encodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "minValuation", type: "uint256" }, { name: "maxValuation", type: "uint256" }, { name: "creationFee", type: "uint256" },
      ] }],
      [config],
    );
    expect(decodeFunctionResult({ abi: f, functionName: "currency", data: encodedConfig })).toEqual(config);

    const opening = encodeAbiParameters(
      [{ type: "int24" }, { type: "uint160" }, { type: "uint256" }],
      [-398_400, 179_000_000_000_000_000_000n, 4_995_430_000n],
    );
    expect(decodeFunctionResult({ abi: f, functionName: "openingFor", data: opening })).toEqual([-398_400, 179_000_000_000_000_000_000n, 4_995_430_000n]);

    const key = { currency0: A, currency1: B, fee: 10_000, tickSpacing: 200, hooks: ZERO };
    const encodedKey = encodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
      ] }],
      [key],
    );
    expect(decodeFunctionResult({ abi: f, functionName: "poolKeyOf", data: encodedKey })).toEqual(key);
  });

  it("carries every custom error of spec 4.2 and the three foreign ones a launch can bubble up, so a revert reads by name", () => {
    const errors = svLaunchpadAbi.filter((i) => i.type === "error").map((i) => i.name).sort();
    expect(errors).toEqual([
      "BadName", "BadPayout", "BadSymbol", "BoundsOutOfRange", "CurrencyNotAllowed", "DailyLimitReached", "Expired", "FeeTooHigh",
      "FirstBuyTooLarge", "FirstBuyTooSmall", "HookNotAllowed", "InvalidNonce", "NotAllowedToLaunch", "NotPayout", "NotPoolManager",
      "NothingOwed", "NothingToCollect", "PermitMismatch", "PoolAlreadyInitialized", "RenounceDisabled", "SignatureExpired",
      "UnexpectedCallback", "UnknownLaunch", "UriTooLong", "ValuationOutOfRange", "ZeroAddress", "BpsTooHigh",
    ].sort());
    const data = encodeErrorResult({ abi: svLaunchpadAbi, errorName: "ValuationOutOfRange", args: [1n, 2n, 3n] });
    expect(data.slice(0, 10)).toBe(toFunctionSelector("ValuationOutOfRange(uint256,uint256,uint256)"));
    expect(decodeErrorResult({ abi: svLaunchpadAbi, data })).toMatchObject({ errorName: "ValuationOutOfRange", args: [1n, 2n, 3n] });
    expect(encodeErrorResult({ abi: svLaunchpadAbi, errorName: "PoolAlreadyInitialized" })).toBe(toFunctionSelector("PoolAlreadyInitialized()"));
    expect(encodeErrorResult({ abi: svLaunchpadAbi, errorName: "FirstBuyTooSmall", args: [1n, 2n] }).slice(0, 10)).toBe(
      toFunctionSelector("FirstBuyTooSmall(uint256,uint256)"),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/launch/abi.test.ts`
Expected: FAIL with "Failed to resolve import "./abi"" (and `LAUNCHPAD_EVENTS_ABI` is not exported by `@/lib/chain/abi`).

- [ ] **Step 3: Write the event half in the reader's ABI module**

Append to `src/lib/chain/abi.ts`, after the closing `} as const;` of `TOPIC0` (line 29):

```ts

/**
 * The instant launchpad's three activity events (instant launchpad design, section 4.2), transcribed from
 * `ISVLaunchpad.sol`. The reader decodes these and nothing else from the launchpad: its setting events are left out of
 * the HyperSync filter. `src/lib/launch/abi.ts` spreads this array into the whole interface, so the reader and the
 * wallet code can never disagree; `src/lib/launch/abi.test.ts` pins every topic0. `Launched` carries one tuple,
 * `LaunchedData`, because sixteen loose values would not fit the contract's legacy code generator (spec 14.8).
 */
export const LAUNCHPAD_EVENTS_ABI = [
  {
    type: "event",
    name: "Launched",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "quote", type: "address", indexed: true },
      {
        name: "data",
        type: "tuple",
        indexed: false,
        components: [
          { name: "poolId", type: "bytes32" },
          { name: "payout", type: "address" },
          { name: "hook", type: "address" },
          { name: "tokenIsCurrency0", type: "bool" },
          { name: "openTick", type: "int24" },
          { name: "openingValuation", type: "uint256" },
          { name: "liquidity", type: "uint128" },
          { name: "tokensInPool", type: "uint256" },
          { name: "firstBuyIn", type: "uint256" },
          { name: "firstBuyTokens", type: "uint256" },
          { name: "routerFee", type: "uint256" },
          { name: "creationFee", type: "uint256" },
          { name: "creatorShareBps", type: "uint16" },
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "metadataUri", type: "string" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "FeesCollected",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "payout", type: "address", indexed: true },
      { name: "tokenFees", type: "uint256", indexed: false },
      { name: "quoteFees", type: "uint256", indexed: false },
      { name: "tokenToPayout", type: "uint256", indexed: false },
      { name: "quoteToPayout", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PayoutChanged",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "previous", type: "address", indexed: true },
      { name: "payout", type: "address", indexed: true },
    ],
  },
] as const;

/** topic0 of each launchpad activity event: the source's second log selection and decode.ts's dispatch key off these. */
export const LAUNCH_TOPIC0 = {
  launched: toEventSelector(LAUNCHPAD_EVENTS_ABI[0]),
  feesCollected: toEventSelector(LAUNCHPAD_EVENTS_ABI[1]),
  payoutChanged: toEventSelector(LAUNCHPAD_EVENTS_ABI[2]),
} as const;
```

- [ ] **Step 4: Write the whole interface**

Create `src/lib/launch/abi.ts`:

```ts
import { LAUNCHPAD_EVENTS_ABI } from "@/lib/chain/abi";

/**
 * `ISVLaunchpad` (instant launchpad design, section 4.2), hand-transcribed in the interface's order: the anyone functions,
 * the owner setters, the views, the activity events (shared with the reader through `LAUNCHPAD_EVENTS_ABI`), the setting
 * events and every custom error. Three foreign errors ride along so a revert that bubbles up from another contract
 * during a launch reads by name (spec 7.2): v4's `PoolAlreadyInitialized()`, Permit2's `InvalidNonce()` and
 * `SignatureExpired(uint256)`. `abi.test.ts` pins every selector and topic0 against the spec's canonical signatures, so a
 * fragment that drifts from the contract fails the suite here instead of a transaction.
 */

const LAUNCH_PARAMS = [
  { name: "name", type: "string" },
  { name: "symbol", type: "string" },
  { name: "metadataUri", type: "string" },
  { name: "quote", type: "address" },
  { name: "valuation", type: "uint256" },
  { name: "firstBuy", type: "uint256" },
  { name: "minFirstBuyTokens", type: "uint256" },
  { name: "payout", type: "address" },
  { name: "salt", type: "bytes32" },
  { name: "deadline", type: "uint256" },
] as const;

const PERMIT_TRANSFER_FROM = [
  {
    name: "permitted",
    type: "tuple",
    components: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

const LAUNCH = [
  { name: "creator", type: "address" },
  { name: "launchedAt", type: "uint64" },
  { name: "creatorShareBps", type: "uint16" },
  { name: "tokenIsCurrency0", type: "bool" },
  { name: "payout", type: "address" },
  { name: "openTick", type: "int24" },
  { name: "quote", type: "address" },
  { name: "hook", type: "address" },
  { name: "liquidity", type: "uint128" },
] as const;

const POOL_KEY = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

const PENDING_FEES = [
  { name: "tokenFees", type: "uint256" },
  { name: "quoteFees", type: "uint256" },
  { name: "tokenToPayout", type: "uint256" },
  { name: "quoteToPayout", type: "uint256" },
  { name: "tokenToFeeWallet", type: "uint256" },
  { name: "quoteToFeeWallet", type: "uint256" },
] as const;

const CURRENCY_CONFIG = [
  { name: "minValuation", type: "uint256" },
  { name: "maxValuation", type: "uint256" },
  { name: "creationFee", type: "uint256" },
] as const;

export const svLaunchpadAbi = [
  // ---- anyone -------------------------------------------------------------------------------------------------
  {
    type: "function",
    name: "launch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "p", type: "tuple", components: LAUNCH_PARAMS },
      { name: "permit", type: "tuple", components: PERMIT_TRANSFER_FROM },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "token", type: "address" }],
  },
  { type: "function", name: "collectFees", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }], outputs: [] },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "currency", type: "address" },
      { name: "to", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setPayout",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "payout", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "unlockCallback",
    stateMutability: "nonpayable",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [{ name: "", type: "bytes" }],
  },
  // ---- owner only ---------------------------------------------------------------------------------------------
  { type: "function", name: "setFeeWallet", stateMutability: "nonpayable", inputs: [{ name: "wallet", type: "address" }], outputs: [] },
  { type: "function", name: "setRouterFee", stateMutability: "nonpayable", inputs: [{ name: "bps", type: "uint16" }], outputs: [] },
  { type: "function", name: "setCreatorShare", stateMutability: "nonpayable", inputs: [{ name: "bps", type: "uint16" }], outputs: [] },
  { type: "function", name: "setFirstBuyCap", stateMutability: "nonpayable", inputs: [{ name: "bps", type: "uint16" }], outputs: [] },
  { type: "function", name: "setDailyLaunchLimit", stateMutability: "nonpayable", inputs: [{ name: "limit", type: "uint8" }], outputs: [] },
  { type: "function", name: "setLauncherGate", stateMutability: "nonpayable", inputs: [{ name: "gate", type: "address" }], outputs: [] },
  { type: "function", name: "setHook", stateMutability: "nonpayable", inputs: [{ name: "hook", type: "address" }], outputs: [] },
  {
    type: "function",
    name: "setCurrency",
    stateMutability: "nonpayable",
    inputs: [
      { name: "quote", type: "address" },
      { name: "minValuation", type: "uint256" },
      { name: "maxValuation", type: "uint256" },
      { name: "creationFee", type: "uint256" },
    ],
    outputs: [],
  },
  // ---- views --------------------------------------------------------------------------------------------------
  {
    type: "function",
    name: "getLaunch",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "tuple", components: LAUNCH }],
  },
  {
    type: "function",
    name: "poolKeyOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "tuple", components: POOL_KEY }],
  },
  {
    type: "function",
    name: "uncollectedFees",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "tuple", components: PENDING_FEES }],
  },
  {
    type: "function",
    name: "predictToken",
    stateMutability: "view",
    inputs: [
      { name: "creator", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "openingFor",
    stateMutability: "pure",
    inputs: [
      { name: "token", type: "address" },
      { name: "quote", type: "address" },
      { name: "valuation", type: "uint256" },
    ],
    outputs: [
      { name: "openTick", type: "int24" },
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "snappedValuation", type: "uint256" },
    ],
  },
  { type: "function", name: "isAllowedLauncher", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "launchesToday", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "currency",
    stateMutability: "view",
    inputs: [{ name: "quote", type: "address" }],
    outputs: [{ name: "", type: "tuple", components: CURRENCY_CONFIG }],
  },
  {
    type: "function",
    name: "owed",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "currency", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  { type: "function", name: "launchCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "feeWallet", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "routerFeeBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "function", name: "creatorShareBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "function", name: "firstBuyCapBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "function", name: "dailyLaunchLimit", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "launcherGate", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "hook", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "POOL_MANAGER", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "PERMIT2", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  // ---- events -------------------------------------------------------------------------------------------------
  ...LAUNCHPAD_EVENTS_ABI,
  { type: "event", name: "FeeWalletChanged", inputs: [{ name: "wallet", type: "address", indexed: true }] },
  { type: "event", name: "RouterFeeChanged", inputs: [{ name: "bps", type: "uint16", indexed: false }] },
  { type: "event", name: "CreatorShareChanged", inputs: [{ name: "bps", type: "uint16", indexed: false }] },
  { type: "event", name: "FirstBuyCapChanged", inputs: [{ name: "bps", type: "uint16", indexed: false }] },
  { type: "event", name: "DailyLaunchLimitChanged", inputs: [{ name: "limit", type: "uint8", indexed: false }] },
  { type: "event", name: "LauncherGateChanged", inputs: [{ name: "gate", type: "address", indexed: true }] },
  { type: "event", name: "HookChanged", inputs: [{ name: "hook", type: "address", indexed: true }] },
  {
    type: "event",
    name: "CurrencyChanged",
    inputs: [
      { name: "quote", type: "address", indexed: true },
      { name: "minValuation", type: "uint256", indexed: false },
      { name: "maxValuation", type: "uint256", indexed: false },
      { name: "creationFee", type: "uint256", indexed: false },
    ],
  },
  // ---- errors -------------------------------------------------------------------------------------------------
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "RenounceDisabled", inputs: [] },
  { type: "error", name: "Expired", inputs: [] },
  { type: "error", name: "NotAllowedToLaunch", inputs: [] },
  { type: "error", name: "DailyLimitReached", inputs: [] },
  { type: "error", name: "BadName", inputs: [] },
  { type: "error", name: "BadSymbol", inputs: [] },
  { type: "error", name: "UriTooLong", inputs: [] },
  { type: "error", name: "CurrencyNotAllowed", inputs: [] },
  {
    type: "error",
    name: "ValuationOutOfRange",
    inputs: [
      { name: "valuation", type: "uint256" },
      { name: "min", type: "uint256" },
      { name: "max", type: "uint256" },
    ],
  },
  { type: "error", name: "PermitMismatch", inputs: [] },
  {
    type: "error",
    name: "FirstBuyTooLarge",
    inputs: [
      { name: "tokensOut", type: "uint256" },
      { name: "cap", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "FirstBuyTooSmall",
    inputs: [
      { name: "tokensOut", type: "uint256" },
      { name: "min", type: "uint256" },
    ],
  },
  { type: "error", name: "BadPayout", inputs: [] },
  { type: "error", name: "FeeTooHigh", inputs: [] },
  { type: "error", name: "BpsTooHigh", inputs: [] },
  { type: "error", name: "BoundsOutOfRange", inputs: [] },
  { type: "error", name: "HookNotAllowed", inputs: [] },
  { type: "error", name: "UnknownLaunch", inputs: [] },
  { type: "error", name: "NotPayout", inputs: [] },
  { type: "error", name: "NothingToCollect", inputs: [] },
  { type: "error", name: "NothingOwed", inputs: [] },
  { type: "error", name: "NotPoolManager", inputs: [] },
  { type: "error", name: "UnexpectedCallback", inputs: [] },
  // Foreign errors a launch can bubble up (spec 7.2): v4's PoolManager, then Permit2.
  { type: "error", name: "PoolAlreadyInitialized", inputs: [] },
  { type: "error", name: "InvalidNonce", inputs: [] },
  { type: "error", name: "SignatureExpired", inputs: [{ name: "signatureDeadline", type: "uint256" }] },
] as const;
```

- [ ] **Step 5: Run the ABI test to verify it passes**

Run: `npx vitest run src/lib/launch/abi.test.ts src/lib/chain/abi.test.ts`
Expected: PASS. The existing `abi.test.ts` still passes: `POOL_MANAGER_EVENTS_ABI` is untouched.

- [ ] **Step 6: Write the failing address test**

Create `src/lib/launch/address.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseLaunchpadAddress } from "./address";

describe("parseLaunchpadAddress", () => {
  it("is undefined for an unset, empty or malformed value, so the launchpad reads as not live", () => {
    expect(parseLaunchpadAddress(undefined)).toBeUndefined();
    expect(parseLaunchpadAddress("")).toBeUndefined(); // an unset NEXT_PUBLIC_* reaches the bundle as ""
    expect(parseLaunchpadAddress("0x1234")).toBeUndefined();
    expect(parseLaunchpadAddress("5555555555555555555555555555555555555555")).toBeUndefined();
  });
  it("keeps a well-formed address as given", () => {
    expect(parseLaunchpadAddress("0x5555555555555555555555555555555555555555")).toBe("0x5555555555555555555555555555555555555555");
    expect(parseLaunchpadAddress("0xAbCdEf0000000000000000000000000000000000")).toBe("0xAbCdEf0000000000000000000000000000000000");
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run src/lib/launch/address.test.ts`
Expected: FAIL with "Failed to resolve import "./address"".

- [ ] **Step 8: Write the address module**

Create `src/lib/launch/address.ts`:

```ts
import type { Address } from "@/lib/types";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** An address, or undefined for anything else: an unset `NEXT_PUBLIC_*` reaches the bundle as "". */
export function parseLaunchpadAddress(raw: string | undefined): Address | undefined {
  return raw !== undefined && ADDRESS.test(raw) ? (raw as Address) : undefined;
}

/**
 * The SVLaunchpad (instant launchpad design, section 5.2), read by the browser and the reader alike, validated like
 * `SVROUTER_ADDRESS` in `src/lib/chain.ts:87-89`. `process.env.NEXT_PUBLIC_…` is substituted at build time and must be
 * read by direct member access, as below. Unset: the reader skips its second log selection, `/launch` shows "not live
 * yet", and the upload route answers 503.
 */
export const LAUNCHPAD_ADDRESS: Address | undefined = parseLaunchpadAddress(process.env.NEXT_PUBLIC_LAUNCHPAD_ADDRESS);

export function hasLaunchpad(): boolean {
  return LAUNCHPAD_ADDRESS !== undefined;
}
```

- [ ] **Step 9: Run it to verify it passes**

Run: `npx vitest run src/lib/launch/address.test.ts`
Expected: PASS.

- [ ] **Step 10: Write the failing currency-config test**

Spec 8.3: "The config file is generated once by a frontend script, `scripts/launch/currency-config.mts`, from `quotes.json`, so the allowlist is always a subset of the currencies the reader recognises, with `referenceUsdPrice` blank for Kobe to fill in the 29 rows without a feed. Top level: `minUsd: 5000`, `maxUsd: 10000000`, `creationFee: 0`." The deploy script turns each row into a price: a Chainlink read for the 24 feed rows, `answer = 1` with `feedDecimals = 0` for USDG, and `referenceUsdPrice` as an 8-decimal integer for the rest, refusing to run while any is zero. So "blank" is written as `"0"`, and each row says which source applies.

**The file's schema is fixed by the contracts repo's deploy script** (branch `feat/instant-launchpad`, already built and reviewed), which parses exactly this, in this key order:

```json
{
  "minUsd": 5000,
  "maxUsd": 10000000,
  "creationFee": "0",
  "currencies": [
    { "address": "0x…", "symbol": "AAPL", "decimals": 18, "priceSource": "chainlink", "chainlinkProxy": "0x…", "chainlinkDecimals": 8, "referenceUsdPrice": "0" }
  ]
}
```

`creationFee` is a raw integer string; `referenceUsdPrice` is an 8-decimal integer string, `"0"` meaning not filled in; `chainlinkProxy` is the zero address and `chainlinkDecimals` 0 when a row has no feed; only USDG is `"pinned"`. There is no top-level decimals key: 8 is a documented constant only.

Create `src/lib/launch/currencyConfig.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { USDG } from "@/lib/chain/math/constants";
import { QUOTES } from "@/lib/chain/math/quotes";
import { CREATION_FEE, MAX_USD, MIN_USD, REFERENCE_PRICE_DECIMALS, currencyConfig } from "./currencyConfig";

const ZERO = "0x0000000000000000000000000000000000000000";

describe("currencyConfig (spec 8.3, the contracts script's canonical schema)", () => {
  const file = currencyConfig(QUOTES);

  it("carries the DEFAULT bounds and a zero creation fee, as a string, at the top level, and nothing else", () => {
    expect([MIN_USD, MAX_USD, CREATION_FEE, REFERENCE_PRICE_DECIMALS]).toEqual([5_000, 10_000_000, "0", 8]);
    expect(Object.keys(file)).toEqual(["minUsd", "maxUsd", "creationFee", "currencies"]);
    expect(file).toMatchObject({ minUsd: 5_000, maxUsd: 10_000_000, creationFee: "0" });
  });

  it("lists all 54 quotes.json rows, sorted by symbol, lowercase: 24 on a feed, USDG alone pinned, 29 waiting for a reference price", () => {
    expect(file.currencies).toHaveLength(54);
    expect(file.currencies.map((c) => c.symbol)).toEqual([...file.currencies.map((c) => c.symbol)].sort());
    const by = (source: string) => file.currencies.filter((c) => c.priceSource === source);
    expect(by("chainlink")).toHaveLength(24);
    const pinned = by("pinned");
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatchObject({ address: USDG, symbol: "USDG", decimals: 6, priceSource: "pinned", chainlinkProxy: ZERO, chainlinkDecimals: 0, referenceUsdPrice: "0" });
    expect(by("reference")).toHaveLength(29);
    for (const c of by("reference")) expect([c.chainlinkProxy, c.chainlinkDecimals, c.referenceUsdPrice]).toEqual([ZERO, 0, "0"]);
    for (const c of file.currencies) {
      expect(Object.keys(c)).toEqual(["address", "symbol", "decimals", "priceSource", "chainlinkProxy", "chainlinkDecimals", "referenceUsdPrice"]);
      expect(c.address).toBe(c.address.toLowerCase());
      expect(c.chainlinkProxy).toBe(c.chainlinkProxy.toLowerCase());
    }
    expect(file.currencies.find((c) => c.symbol === "AAPL")).toMatchObject({
      address: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9", symbol: "AAPL", decimals: 18, priceSource: "chainlink",
      chainlinkProxy: "0x6b22a786baa607d76728168703a39ea9c99f2cd0", chainlinkDecimals: 8, referenceUsdPrice: "0",
    });
  });
});
```

- [ ] **Step 11: Run it to verify it fails**

Run: `npx vitest run src/lib/launch/currencyConfig.test.ts`
Expected: FAIL with "Failed to resolve import "./currencyConfig"".

- [ ] **Step 12: Write the generator and its script**

Create `src/lib/launch/currencyConfig.ts`:

```ts
import { USDG, ZERO_ADDRESS } from "@/lib/chain/math/constants";
import type { QuoteRow } from "@/lib/chain/math/quotes";

/**
 * The launchpad's deploy config (instant launchpad design, section 8.3): every quote the reader recognises, so the
 * contract's allowlist can never hold a currency whose pools the reader would ignore. The contracts repo's
 * `script/DeployLaunchpad.s.sol` reads it from `script/config/launch-currencies.json`. DEFAULT bounds (spec 12):
 * USD 5,000 to 10,000,000 per currency, pending MAXLONG's confirmation.
 */
export const MIN_USD = 5_000;
export const MAX_USD = 10_000_000;
/** Raw quote units, as a string: the contracts script parses an integer string. */
export const CREATION_FEE = "0";
/**
 * Documentation only, never written to the file: `referenceUsdPrice` is an integer string with this many decimals, so
 * USD 300.25 is "30025000000"; "0" means "not filled in yet" and the deploy script refuses to run on it.
 */
export const REFERENCE_PRICE_DECIMALS = 8;

export type CurrencyPriceSource = "chainlink" | "pinned" | "reference";
/** Key order is the contracts script's canonical order; the object literal below builds it in exactly this order. */
export type CurrencyConfigRow = {
  address: string;
  symbol: string;
  decimals: number;
  /** chainlink: read `latestRoundData` on the proxy; pinned: USDG at exactly 1 (the only pinned row); reference: `referenceUsdPrice`. */
  priceSource: CurrencyPriceSource;
  /** The zero address unless priceSource is "chainlink". */
  chainlinkProxy: string;
  /** 0 unless priceSource is "chainlink". */
  chainlinkDecimals: number;
  referenceUsdPrice: string;
};
export type CurrencyConfigFile = {
  minUsd: number;
  maxUsd: number;
  creationFee: string;
  currencies: CurrencyConfigRow[];
};

export function currencyConfig(rows: readonly QuoteRow[]): CurrencyConfigFile {
  const currencies = rows
    .map((q): CurrencyConfigRow => {
      const address = q.address.toLowerCase();
      const pinned = address === USDG;
      const feed = !pinned && q.chainlinkProxy !== null && q.chainlinkDecimals !== null;
      return {
        address,
        symbol: q.symbol,
        decimals: q.decimals,
        priceSource: pinned ? "pinned" : feed ? "chainlink" : "reference",
        chainlinkProxy: feed ? q.chainlinkProxy!.toLowerCase() : ZERO_ADDRESS,
        chainlinkDecimals: feed ? q.chainlinkDecimals! : 0,
        referenceUsdPrice: "0",
      };
    })
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return { minUsd: MIN_USD, maxUsd: MAX_USD, creationFee: CREATION_FEE, currencies };
}
```

`ZERO_ADDRESS` already exists at `src/lib/chain/math/constants.ts:4` and is lowercase.

Create `scripts/launch/currency-config.mts`:

```ts
/**
 * Writes the launchpad's deploy config (instant launchpad design, section 8.3) from src/lib/chain/math/config/quotes.json.
 *
 *   npm run launch:currencies -- --out ../SuitVenturesMarket-contracts/script/config/launch-currencies.json
 *
 * Run once. It refuses to overwrite an existing file unless --force is given, because Kobe fills the 29 reference
 * prices into that file by hand and a second run must never wipe them. Reads no environment and touches no network.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { QUOTES } from "@/lib/chain/math/quotes";
import { currencyConfig } from "@/lib/launch/currencyConfig";

function parseArgs(argv: readonly string[]): { out: string; force: boolean } {
  const at = argv.indexOf("--out");
  const out = at >= 0 ? argv[at + 1] : undefined;
  if (!out) throw new Error("usage: npm run launch:currencies -- --out <path> [--force]");
  return { out: resolve(out), force: argv.includes("--force") };
}

const { out, force } = parseArgs(process.argv.slice(2));
if (existsSync(out) && !force) {
  console.error(`${out} already exists; pass --force to overwrite it (the reference prices in it would be lost)`);
  process.exit(1);
}
const file = currencyConfig(QUOTES);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
const count = (source: string) => file.currencies.filter((c) => c.priceSource === source).length;
console.log(`wrote ${file.currencies.length} currencies to ${out}: ${count("chainlink")} on a feed, ${count("pinned")} pinned, ${count("reference")} waiting for a reference price`);
```

Edit `package.json`. After the line

```json
    "chain:gapfill": "node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/chain/gapfill-candles.mts",
```

add

```json
    "launch:currencies": "node --conditions=react-server --import tsx scripts/launch/currency-config.mts",
```

(no `--env-file`: the script reads no environment).

- [ ] **Step 13: Run it to verify it passes, then try the script once into the scratch directory**

Run: `npx vitest run src/lib/launch/currencyConfig.test.ts`
Expected: PASS.
Run: `npm run launch:currencies -- --out .launch-currencies.check.json && npm run launch:currencies -- --out .launch-currencies.check.json; rm -f .launch-currencies.check.json`
Expected: the first run prints `wrote 54 currencies … 24 on a feed, 1 pinned, 29 waiting for a reference price`; the second exits 1 with "already exists".

- [ ] **Step 14: Run the gates**

Run: `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src`. All clean.

- [ ] **Step 15: Commit**

```bash
git add src/lib/chain/abi.ts src/lib/launch/abi.ts src/lib/launch/abi.test.ts src/lib/launch/address.ts src/lib/launch/address.test.ts src/lib/launch/currencyConfig.ts src/lib/launch/currencyConfig.test.ts scripts/launch/currency-config.mts package.json
git commit -m "Launchpad: the contract interface, its address, and the currency config the deploy reads"
```

---

### Task 3: Reader: the launchpad's logs through source, decode, fold, store, report and health

**Files:**
- Modify: `src/lib/chain/types.ts:55` (three event kinds, the `ChainEvent` union) and `:176-214` (`FoldResult` gains four fields)
- Modify: `src/lib/chain/decode.ts` (whole file: `RawLog.address`, routing by address then topic0)
- Modify: `src/lib/chain/decode.test.ts:3` (imports), `:28-34` (`BASE`), and append one `describe`
- Modify: `src/lib/chain/hypersyncSource.ts:1` (imports), `:5-11` (option), `:53-62` (`HyperSyncLog`), `:151` (resolve the launchpad), `:222-232` (query body), `:263-281` (address on every log)
- Modify: `src/lib/chain/hypersyncSource.test.ts:3` (imports), `:27-44` (`swapLog`), `:144-166` (the pinned body), and append tests
- Modify: `src/lib/chain/fold.ts` (imports `:83-94`, `FoldContext` `:122-134`, `foldEvents` `:162-200`, `newTokenCandidates` `:225-239`, `recomputePrimaryPool` `:342-347`, `handleInitialize` `:384`; three new handlers)
- Create: `src/lib/chain/fold.launch.test.ts`
- Modify: `src/lib/chain/store.ts:5` (imports), `:129` (`loadFoldState`), `:380-382` (`applyFold`)
- Modify: `src/lib/chain/store.test.ts` (imports, `beforeEach`, `result()`; append one `describe`)
- Modify: `src/lib/chain/run.ts:111-129` (`ChainRunReport`), `:196-201` (`emptyReport`), `:444-475` (sum and store `launchEvents`)
- Modify: `src/lib/chain/run.test.ts:8` (imports), `:44-49` (`seedToken`), the two exact reports at `:193-197` and `:229-233`; append one test
- Modify: `src/lib/market/backend.ts:15-19` (`lastCycle.launchEvents`) and `:39` (`launches`)
- Modify: `src/lib/market/dbBackend.ts:6` (import), `:161-166` (`lastCycleFrom`), `:321-322` (health's `launches`)
- Modify: `src/lib/market/dbBackend.test.ts` (one health test)

**Interfaces:**
- Consumes: `LAUNCHPAD_EVENTS_ABI`, `LAUNCH_TOPIC0` (Task 2, `src/lib/chain/abi.ts`); `LAUNCHPAD_ADDRESS` (Task 2); `LaunchRow`, `LaunchFeesRow`, `PayoutRow`, `insertLaunches`, `attachUploads`, `insertLaunchFees`, `applyPayouts`, `launchHealth` (Task 1).
- Produces:
  ```ts
  // src/lib/chain/types.ts
  export type LaunchedEvent = ChainEventBase & { kind: "launched"; token: string; creator: string; quote: string; poolId: string;
    payout: string; hook: string; tokenIsCurrency0: boolean; openTick: number; openingValuation: bigint; liquidity: bigint;
    tokensInPool: bigint; firstBuyIn: bigint; firstBuyTokens: bigint; routerFee: bigint; creationFee: bigint; creatorShareBps: number;
    name: string; symbol: string; metadataUri: string };
  export type LaunchFeesEvent = ChainEventBase & { kind: "launchFees"; token: string; payout: string; tokenFees: bigint;
    quoteFees: bigint; tokenToPayout: bigint; quoteToPayout: bigint };
  export type PayoutChangedEvent = ChainEventBase & { kind: "payoutChanged"; token: string; previous: string; payout: string };
  export type ChainEvent = InitializeEvent | SwapEvent | ModifyLiquidityEvent | LaunchedEvent | LaunchFeesEvent | PayoutChangedEvent;
  // FoldResult gains: launches: LaunchRow[]; launchFees: LaunchFeesRow[]; payouts: PayoutRow[]; launchEvents: number;
  // src/lib/chain/decode.ts
  export type RawLog = { address: string; blockNumber: number; logIndex: number; txHash: string; topics: string[]; data: string; timestamp: number; txFrom: string | null };
  export type DecodeOptions = { launchpad?: string | null };
  export function decodeLog(raw: RawLog, opts?: DecodeOptions): ChainEvent | null;
  // src/lib/chain/hypersyncSource.ts: HyperSyncSourceOptions gains `launchpad?: string | null` (undefined reads LAUNCHPAD_ADDRESS, null means none)
  // src/lib/chain/run.ts: ChainRunReport gains `launchEvents: number`; the stored last_report gains `launchEvents`
  // src/lib/market/backend.ts: HealthReport.sync.lastCycle gains `launchEvents: number`; HealthReport gains `launches?: { missingUploads: number; deletedUploads: number }`
  ```

- [ ] **Step 1: Add the event kinds and the result fields**

Edit `src/lib/chain/types.ts`. Replace line 55:

```ts
export type ChainEvent = InitializeEvent | SwapEvent | ModifyLiquidityEvent;
```

with:

```ts
/**
 * The instant launchpad's three activity events (instant launchpad design, section 5.2), decoded from the launchpad's
 * own address. Addresses lowercase; on-chain integers bigint except ticks and bps. `launched` carries its pool id, the
 * other two do not: code that reads `poolId` must first narrow to a pool event.
 */
export type LaunchedEvent = ChainEventBase & {
  kind: "launched";
  token: string; creator: string; quote: string; poolId: string; payout: string; hook: string;
  tokenIsCurrency0: boolean; openTick: number; openingValuation: bigint; liquidity: bigint; tokensInPool: bigint;
  firstBuyIn: bigint; firstBuyTokens: bigint; routerFee: bigint; creationFee: bigint; creatorShareBps: number;
  name: string; symbol: string; metadataUri: string;
};
export type LaunchFeesEvent = ChainEventBase & {
  kind: "launchFees";
  token: string; payout: string; tokenFees: bigint; quoteFees: bigint; tokenToPayout: bigint; quoteToPayout: bigint;
};
export type PayoutChangedEvent = ChainEventBase & { kind: "payoutChanged"; token: string; previous: string; payout: string };

export type ChainEvent = InitializeEvent | SwapEvent | ModifyLiquidityEvent | LaunchedEvent | LaunchFeesEvent | PayoutChangedEvent;
```

In the same file, inside `FoldResult`, after the line `  skippedLiquidity: number;` (the last field, just before the type's closing `};`), add:

```ts
  /** One row per `Launched` in the batch (instant launchpad design, section 5.2). */
  launches: LaunchRow[];
  /** One row per `FeesCollected` log, never summed in the fold: totals are summed on read (spec 5.5). */
  launchFees: LaunchFeesRow[];
  /** The last `PayoutChanged` per token in the batch. */
  payouts: PayoutRow[];
  /** launched + launchFees + payoutChanged events folded, for health (spec section 13). */
  launchEvents: number;
```

- [ ] **Step 2: Write the failing decoder tests**

Edit `src/lib/chain/decode.test.ts`. Replace line 3:

```ts
import { POOL_MANAGER_EVENTS_ABI } from "./abi";
```

with:

```ts
import { LAUNCHPAD_EVENTS_ABI, POOL_MANAGER, POOL_MANAGER_EVENTS_ABI } from "./abi";
```

Replace lines 28-34 (`BASE`):

```ts
const BASE: Omit<RawLog, "topics" | "data"> = {
  blockNumber: 68_500_000,
  logIndex: 7,
  txHash: TX_HASH,
  timestamp: 1_700_000_000,
  txFrom: TX_FROM,
};
```

with:

```ts
const BASE: Omit<RawLog, "topics" | "data"> = {
  address: POOL_MANAGER.toUpperCase().replace("0X", "0x"), // mixed case: routing by address must lowercase too
  blockNumber: 68_500_000,
  logIndex: 7,
  txHash: TX_HASH,
  timestamp: 1_700_000_000,
  txFrom: TX_FROM,
};
```

Append at the end of the file:

```ts
describe("decodeLog routes by address, then topic0 (instant launchpad design, section 5.2)", () => {
  const LAUNCHPAD = "0x" + "5a".repeat(20);
  const TOKEN = "0x" + "7a".repeat(20);
  const CREATOR = "0x" + "c1".repeat(20);
  const PAYOUT = "0x" + "c2".repeat(20);
  const QUOTE = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  const ZERO = "0x" + "0".repeat(40);
  const LAUNCH_POOL = ("0x" + "CD".repeat(32)) as `0x${string}`;
  const DATA = {
    poolId: LAUNCH_POOL, payout: CREATOR as `0x${string}`, hook: ZERO as `0x${string}`, tokenIsCurrency0: false, openTick: 398_400,
    openingValuation: 4_995_430_000n, liquidity: 2_240_000_000_000_000_000n, tokensInPool: 10n ** 27n - 300n, firstBuyIn: 99_500_000n,
    firstBuyTokens: 19_000_000n * 10n ** 18n, routerFee: 500_000n, creationFee: 0n, creatorShareBps: 7000,
    name: "Tailor's Chalk", symbol: "CHALK", metadataUri: "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
  };
  const launchedLog = () => ({
    topics: topicsOf(
      encodeEventTopics({
        abi: LAUNCHPAD_EVENTS_ABI, eventName: "Launched",
        args: { token: TOKEN as `0x${string}`, creator: CREATOR as `0x${string}`, quote: QUOTE as `0x${string}` },
      }),
    ),
    data: encodeAbiParameters([LAUNCHPAD_EVENTS_ABI[0].inputs[3]], [DATA]),
  });

  it("decodes Launched from the launchpad's address, the struct flattened, addresses lowercase, amounts bigint", () => {
    const event = decodeLog({ ...BASE, address: LAUNCHPAD.toUpperCase().replace("0X", "0x"), ...launchedLog() }, { launchpad: LAUNCHPAD });
    expect(event).toEqual({
      kind: "launched", block: BASE.blockNumber, logIndex: BASE.logIndex, timestamp: BASE.timestamp,
      txHash: TX_HASH.toLowerCase(), txFrom: TX_FROM.toLowerCase(),
      token: TOKEN, creator: CREATOR, quote: QUOTE, poolId: LAUNCH_POOL.toLowerCase(), payout: CREATOR, hook: ZERO,
      tokenIsCurrency0: false, openTick: 398_400, openingValuation: 4_995_430_000n, liquidity: 2_240_000_000_000_000_000n,
      tokensInPool: 10n ** 27n - 300n, firstBuyIn: 99_500_000n, firstBuyTokens: 19_000_000n * 10n ** 18n, routerFee: 500_000n,
      creationFee: 0n, creatorShareBps: 7000, name: "Tailor's Chalk", symbol: "CHALK", metadataUri: DATA.metadataUri,
    });
  });

  it("decodes FeesCollected and PayoutChanged", () => {
    const fees = decodeLog(
      {
        ...BASE, address: LAUNCHPAD,
        topics: topicsOf(encodeEventTopics({ abi: LAUNCHPAD_EVENTS_ABI, eventName: "FeesCollected", args: { token: TOKEN as `0x${string}`, payout: PAYOUT as `0x${string}` } })),
        data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [1000n, 10_000_000n, 700n, 7_000_000n]),
      },
      { launchpad: LAUNCHPAD },
    );
    expect(fees).toMatchObject({ kind: "launchFees", token: TOKEN, payout: PAYOUT, tokenFees: 1000n, quoteFees: 10_000_000n, tokenToPayout: 700n, quoteToPayout: 7_000_000n });
    const moved = decodeLog(
      {
        ...BASE, address: LAUNCHPAD,
        topics: topicsOf(
          encodeEventTopics({
            abi: LAUNCHPAD_EVENTS_ABI, eventName: "PayoutChanged",
            args: { token: TOKEN as `0x${string}`, previous: CREATOR as `0x${string}`, payout: PAYOUT as `0x${string}` },
          }),
        ),
        data: "0x",
      },
      { launchpad: LAUNCHPAD },
    );
    expect(moved).toMatchObject({ kind: "payoutChanged", token: TOKEN, previous: CREATOR, payout: PAYOUT });
  });

  it("drops a PoolManager topic0 from the launchpad address, and a launchpad topic0 from any other address", () => {
    const swapTopics = topicsOf(encodeEventTopics({ abi: POOL_MANAGER_EVENTS_ABI, eventName: "Swap", args: { id: POOL_ID, sender: SENDER } }));
    const swapData = encodeAbiParameters(
      [{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }],
      [1n, -1n, 1n, 1n, 0, 0],
    );
    expect(decodeLog({ ...BASE, address: LAUNCHPAD, topics: swapTopics, data: swapData }, { launchpad: LAUNCHPAD })).toBeNull();
    expect(decodeLog({ ...BASE, address: "0x" + "99".repeat(20), ...launchedLog() }, { launchpad: LAUNCHPAD })).toBeNull();
    expect(decodeLog({ ...BASE, ...launchedLog() }, { launchpad: LAUNCHPAD })).toBeNull(); // a launchpad topic0 from the PoolManager
  });

  it("decodes nothing from the launchpad while no launchpad is configured", () => {
    expect(decodeLog({ ...BASE, address: LAUNCHPAD, ...launchedLog() })).toBeNull();
    expect(decodeLog({ ...BASE, address: LAUNCHPAD, ...launchedLog() }, { launchpad: null })).toBeNull();
  });
});
```

(`POOL_ID`, `SENDER`, `TX_HASH`, `TX_FROM` and `topicsOf` are the file's existing fixtures, lines 8-26.)

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/lib/chain/decode.test.ts`
Expected: FAIL. `Launched` decodes to `null` (no launchpad branch) and the PoolManager-shaped swap from the launchpad address decodes as a swap.

- [ ] **Step 4: Write the decoder**

Replace the whole of `src/lib/chain/decode.ts` with:

```ts
import { decodeEventLog, type Hex } from "viem";
import { LAUNCH_TOPIC0, LAUNCHPAD_EVENTS_ABI, POOL_MANAGER, POOL_MANAGER_EVENTS_ABI, TOPIC0 } from "./abi";
import type { ChainEvent, ChainEventBase } from "./types";

/**
 * What `hypersyncSource.ts` hands to `decodeLog` for one log, once its block's timestamp and its transaction's sender
 * are known (HyperSync answers those separately from the log itself; joining them is the source's job, not this one's).
 * `address` is the emitting contract: since the launchpad joined the query (instant launchpad design, section 5.2) a log
 * is routed by address first and topic0 second.
 */
export type RawLog = {
  address: string;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  /** topic0 first, then whichever of topic1..topic3 the log carries, in order. */
  topics: string[];
  data: string;
  timestamp: number;
  txFrom: string | null;
};

export type DecodeOptions = {
  /** The launchpad's address. Null or absent: only PoolManager logs decode, exactly as before the launchpad. */
  launchpad?: string | null;
};

/**
 * Decodes one log into the `ChainEvent` its address and topic0 name, or `null` for a log this reader does not track: a
 * PoolManager topic0 outside the three, a launchpad topic0 outside the three activity events, or any other emitter. The
 * HyperSync query already filters by address and topic, so null is a defensive fallback, not the common case.
 *
 * Every address, pool id and hash comes back lowercase (types.ts's convention). Ticks, fees and bps come back `number`;
 * every other on-chain integer comes back `bigint`, exactly how viem decodes these widths, never routed through `number`.
 */
export function decodeLog(raw: RawLog, opts: DecodeOptions = {}): ChainEvent | null {
  const topic0 = raw.topics[0]?.toLowerCase();
  if (!topic0) return null;

  const topics = raw.topics as [Hex, ...Hex[]];
  const data = raw.data as Hex;
  const base: ChainEventBase = {
    block: raw.blockNumber,
    logIndex: raw.logIndex,
    timestamp: raw.timestamp,
    txHash: raw.txHash.toLowerCase(),
    txFrom: raw.txFrom ? raw.txFrom.toLowerCase() : null,
  };

  const address = raw.address.toLowerCase();
  if (address === POOL_MANAGER) return decodePoolManagerLog(topic0, topics, data, base);
  const launchpad = opts.launchpad?.toLowerCase();
  if (launchpad && address === launchpad) return decodeLaunchpadLog(topic0, topics, data, base);
  return null;
}

function decodePoolManagerLog(topic0: string, topics: [Hex, ...Hex[]], data: Hex, base: ChainEventBase): ChainEvent | null {
  if (topic0 === TOPIC0.initialize) {
    const { args } = decodeEventLog({ abi: POOL_MANAGER_EVENTS_ABI, eventName: "Initialize", topics, data });
    return {
      ...base,
      kind: "initialize",
      poolId: args.id.toLowerCase(),
      currency0: args.currency0.toLowerCase(),
      currency1: args.currency1.toLowerCase(),
      fee: args.fee,
      tickSpacing: args.tickSpacing,
      hooks: args.hooks.toLowerCase(),
      sqrtPriceX96: args.sqrtPriceX96,
      tick: args.tick,
    };
  }

  if (topic0 === TOPIC0.swap) {
    const { args } = decodeEventLog({ abi: POOL_MANAGER_EVENTS_ABI, eventName: "Swap", topics, data });
    return {
      ...base,
      kind: "swap",
      poolId: args.id.toLowerCase(),
      amount0: args.amount0,
      amount1: args.amount1,
      sqrtPriceX96: args.sqrtPriceX96,
      liquidity: args.liquidity,
      tick: args.tick,
      fee: args.fee,
    };
  }

  if (topic0 === TOPIC0.modifyLiquidity) {
    const { args } = decodeEventLog({ abi: POOL_MANAGER_EVENTS_ABI, eventName: "ModifyLiquidity", topics, data });
    return {
      ...base,
      kind: "modifyLiquidity",
      poolId: args.id.toLowerCase(),
      tickLower: args.tickLower,
      tickUpper: args.tickUpper,
      liquidityDelta: args.liquidityDelta,
    };
  }

  return null;
}

/** The launchpad's three activity events (spec 4.2). A setting event, or any other topic0, is null. */
function decodeLaunchpadLog(topic0: string, topics: [Hex, ...Hex[]], data: Hex, base: ChainEventBase): ChainEvent | null {
  if (topic0 === LAUNCH_TOPIC0.launched) {
    const { args } = decodeEventLog({ abi: LAUNCHPAD_EVENTS_ABI, eventName: "Launched", topics, data });
    const d = args.data;
    return {
      ...base,
      kind: "launched",
      token: args.token.toLowerCase(),
      creator: args.creator.toLowerCase(),
      quote: args.quote.toLowerCase(),
      poolId: d.poolId.toLowerCase(),
      payout: d.payout.toLowerCase(),
      hook: d.hook.toLowerCase(),
      tokenIsCurrency0: d.tokenIsCurrency0,
      openTick: d.openTick,
      openingValuation: d.openingValuation,
      liquidity: d.liquidity,
      tokensInPool: d.tokensInPool,
      firstBuyIn: d.firstBuyIn,
      firstBuyTokens: d.firstBuyTokens,
      routerFee: d.routerFee,
      creationFee: d.creationFee,
      creatorShareBps: d.creatorShareBps,
      name: d.name,
      symbol: d.symbol,
      metadataUri: d.metadataUri,
    };
  }

  if (topic0 === LAUNCH_TOPIC0.feesCollected) {
    const { args } = decodeEventLog({ abi: LAUNCHPAD_EVENTS_ABI, eventName: "FeesCollected", topics, data });
    return {
      ...base,
      kind: "launchFees",
      token: args.token.toLowerCase(),
      payout: args.payout.toLowerCase(),
      tokenFees: args.tokenFees,
      quoteFees: args.quoteFees,
      tokenToPayout: args.tokenToPayout,
      quoteToPayout: args.quoteToPayout,
    };
  }

  if (topic0 === LAUNCH_TOPIC0.payoutChanged) {
    const { args } = decodeEventLog({ abi: LAUNCHPAD_EVENTS_ABI, eventName: "PayoutChanged", topics, data });
    return {
      ...base,
      kind: "payoutChanged",
      token: args.token.toLowerCase(),
      previous: args.previous.toLowerCase(),
      payout: args.payout.toLowerCase(),
    };
  }

  return null;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run src/lib/chain/decode.test.ts`
Expected: PASS. (The source does not type-check against the new `RawLog` yet; vitest does not type-check, and Step 8 fixes it.)

- [ ] **Step 6: Write the failing source tests**

Edit `src/lib/chain/hypersyncSource.test.ts`. Replace line 3:

```ts
import { POOL_MANAGER, POOL_MANAGER_EVENTS_ABI, TOPIC0 } from "./abi";
```

with:

```ts
import { LAUNCH_TOPIC0, LAUNCHPAD_EVENTS_ABI, POOL_MANAGER, POOL_MANAGER_EVENTS_ABI, TOPIC0 } from "./abi";
```

Replace `swapLog` (lines 27-44, from its doc comment through its closing `}`) with:

```ts
/** Topics + data for one Swap log, HyperSync-shaped (a raw JSON object, not yet decoded). `address` is the emitter; null omits it. */
function swapLog(opts: { blockNumber?: number; logIndex?: number; txHash?: string; amount0?: bigint; amount1?: bigint; address?: string | null } = {}) {
  const topics = encodeEventTopics({ abi: POOL_MANAGER_EVENTS_ABI, eventName: "Swap", args: { id: POOL_ID, sender: SENDER } });
  const data = encodeAbiParameters(
    [{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }],
    [opts.amount0 ?? -1000n, opts.amount1 ?? 2000n, 79_228_162_514_264_337_593_543_950_336n, 123_456n, 100, 3000],
  );
  return {
    ...(opts.address === null ? {} : { address: opts.address ?? POOL_MANAGER }),
    block_number: opts.blockNumber ?? 100,
    log_index: opts.logIndex ?? 0,
    transaction_hash: opts.txHash ?? TX_HASH,
    topic0: topics[0],
    topic1: topics[1],
    topic2: topics[2],
    // topic3 intentionally absent: Swap has only two indexed params (id, sender).
    data,
  };
}

const LAUNCHPAD = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const LAUNCHED_TOKEN = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
const FEE_PAYOUT = "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";

/** One FeesCollected log from the launchpad, HyperSync-shaped. */
function feesLog(opts: { logIndex?: number; address?: string } = {}) {
  const topics = encodeEventTopics({ abi: LAUNCHPAD_EVENTS_ABI, eventName: "FeesCollected", args: { token: LAUNCHED_TOKEN, payout: FEE_PAYOUT } });
  return {
    address: opts.address ?? LAUNCHPAD,
    block_number: 100,
    log_index: opts.logIndex ?? 0,
    transaction_hash: TX_HASH,
    topic0: topics[0],
    topic1: topics[1],
    topic2: topics[2],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [1000n, 10n, 700n, 7n]),
  };
}
```

Replace the pinned-body `describe("fetch: request shape", …)` block (lines 144-166) with:

```ts
  describe("fetch: request shape", () => {
    it("POSTs {url}/query with the documented body and field selection, one selection without a launchpad", async () => {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(page([], 200)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, launchpad: null });
      await source.fetch(100, 199);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchImpl.mock.calls[0]!;
      expect(calledUrl).toBe(`${URL}/query`);
      const req = init as RequestInit;
      expect((req.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      const body = JSON.parse(String(req.body)) as Record<string, unknown>;
      expect(body).toEqual({
        from_block: 100,
        to_block: 200, // exclusive: to + 1
        logs: [{ address: [POOL_MANAGER], topics: [[TOPIC0.initialize, TOPIC0.swap, TOPIC0.modifyLiquidity]] }],
        field_selection: {
          block: ["number", "timestamp"],
          log: ["block_number", "log_index", "transaction_hash", "address", "topic0", "topic1", "topic2", "topic3", "data"],
          transaction: ["hash", "from"],
        },
      });
    });

    // Spec 5.2: the launchpad rides the same request as a second selection filtered to its three activity events.
    it("adds the launchpad as a second selection of its three activity topics, lowercased, still one request", async () => {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(page([], 200)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, launchpad: LAUNCHPAD.toUpperCase().replace("0X", "0x") });
      await source.fetch(100, 199);
      const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as Record<string, unknown>;
      expect(body.logs).toEqual([
        { address: [POOL_MANAGER], topics: [[TOPIC0.initialize, TOPIC0.swap, TOPIC0.modifyLiquidity]] },
        { address: [LAUNCHPAD], topics: [[LAUNCH_TOPIC0.launched, LAUNCH_TOPIC0.feesCollected, LAUNCH_TOPIC0.payoutChanged]] },
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
```

Then append, inside `describe("fetch: decoding and joining", …)`, after the "drops a log whose topic0 is not one of the three tracked events" test:

```ts
    it("decodes a launchpad log by its address, and drops a PoolManager-shaped log from any other address", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          page(
            [
              {
                logs: [feesLog({ logIndex: 0 }), swapLog({ logIndex: 1, address: "0x9999999999999999999999999999999999999999" }), swapLog({ logIndex: 2 })],
                blocks: [{ number: 100, timestamp: "0x1" }],
                transactions: [{ hash: TX_HASH, from: TX_FROM }],
              },
            ],
            200,
          ),
        ),
      );
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, launchpad: LAUNCHPAD });
      const { events } = await source.fetch(100, 199);
      expect(events.map((e) => [e.kind, e.logIndex])).toEqual([
        ["launchFees", 0],
        ["swap", 2],
      ]);
      expect(events[0]).toMatchObject({ kind: "launchFees", token: LAUNCHED_TOKEN, payout: FEE_PAYOUT, tokenFees: 1000n, txFrom: TX_FROM.toLowerCase() });
    });

    it("drops a log that arrives without an address, and a launchpad log while no launchpad is configured", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          page(
            [
              {
                logs: [swapLog({ logIndex: 0, address: null }), feesLog({ logIndex: 1 }), swapLog({ logIndex: 2 })],
                blocks: [{ number: 100, timestamp: "0x1" }],
                transactions: [{ hash: TX_HASH, from: TX_FROM }],
              },
            ],
            200,
          ),
        ),
      );
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, launchpad: null });
      const { events } = await source.fetch(100, 199);
      expect(events.map((e) => [e.kind, e.logIndex])).toEqual([["swap", 2]]);
    });
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run src/lib/chain/hypersyncSource.test.ts`
Expected: FAIL. The pinned body lacks `"address"`, the second selection is missing, the fees log never decodes and the address-less log is kept.

- [ ] **Step 8: Write the source changes**

Edit `src/lib/chain/hypersyncSource.ts`. Replace line 1:

```ts
import { POOL_MANAGER, TOPIC0 } from "./abi";
```

with:

```ts
import { LAUNCHPAD_ADDRESS } from "@/lib/launch/address";
import { LAUNCH_TOPIC0, POOL_MANAGER, TOPIC0 } from "./abi";
```

Replace lines 5-11 (`HyperSyncSourceOptions`) with:

```ts
export type HyperSyncSourceOptions = {
  url?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  /**
   * The launchpad's address (instant launchpad design, section 5.2). Undefined reads NEXT_PUBLIC_LAUNCHPAD_ADDRESS through
   * `LAUNCHPAD_ADDRESS`; null means no launchpad, so the query is exactly what it was before the launchpad.
   */
  launchpad?: string | null;
};
```

Replace lines 53-62 (`HyperSyncLog`) with:

```ts
type HyperSyncLog = {
  /** Selected since the launchpad joined the query; a log without one is dropped. */
  address?: string | null;
  block_number: number;
  log_index: number;
  transaction_hash: string;
  data: string;
  topic0?: string | null;
  topic1?: string | null;
  topic2?: string | null;
  topic3?: string | null;
};
```

After line 151 (`let rateLimitPerMinute: number | null = null;`) add:

```ts
  // Lowercased once: the filter and decode.ts's routing both compare lowercase.
  const launchpad = (opts.launchpad === undefined ? LAUNCHPAD_ADDRESS : opts.launchpad)?.toLowerCase() ?? null;
```

Replace the `queryBody` literal inside `fetch` (lines 223-232) with:

```ts
      // The PoolManager's three events, plus the launchpad's three activity events when one is configured: a second
      // selection in the same request, never a second request (spec 5.2). The launchpad's setting events stay out.
      const logs: { address: string[]; topics: string[][] }[] = [
        { address: [POOL_MANAGER], topics: [[TOPIC0.initialize, TOPIC0.swap, TOPIC0.modifyLiquidity]] },
      ];
      if (launchpad) {
        logs.push({ address: [launchpad], topics: [[LAUNCH_TOPIC0.launched, LAUNCH_TOPIC0.feesCollected, LAUNCH_TOPIC0.payoutChanged]] });
      }
      const queryBody = {
        from_block: fromBlock,
        to_block: toBlock + 1, // HyperSync's to_block is exclusive
        logs,
        field_selection: {
          block: ["number", "timestamp"],
          log: ["block_number", "log_index", "transaction_hash", "address", "topic0", "topic1", "topic2", "topic3", "data"],
          transaction: ["hash", "from"],
        },
      };
```

Replace the per-log loop (lines 264-281, from `for (const log of chunk.logs ?? []) {` through its closing brace after `if (decoded) events.push(decoded);`) with:

```ts
        for (const log of chunk.logs ?? []) {
          // Routing is by emitter now, so a log that names none cannot be placed: dropped, never guessed.
          if (!log.address) continue;
          const blockNumber = Number(log.block_number);
          const timestamp = timestamps.get(blockNumber);
          if (timestamp === undefined) {
            throw new Error(`HyperSync log at block ${blockNumber} has no matching block timestamp`);
          }
          const rawLog: RawLog = {
            address: log.address.toLowerCase(),
            blockNumber,
            logIndex: Number(log.log_index),
            txHash: log.transaction_hash,
            topics: buildTopics(log),
            data: log.data,
            timestamp,
            txFrom: senders.get(log.transaction_hash.toLowerCase()) ?? null,
          };
          const decoded = decodeLog(rawLog, { launchpad });
          if (decoded) events.push(decoded);
        }
```

- [ ] **Step 9: Run it to verify it passes**

Run: `npx vitest run src/lib/chain/hypersyncSource.test.ts src/lib/chain/decode.test.ts`
Expected: PASS.

- [ ] **Step 10: Write the failing fold tests**

Create `src/lib/chain/fold.launch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { foldEvents, newTokenCandidates } from "./fold";
import type {
  FoldState, InitializeEvent, LaunchFeesEvent, LaunchedEvent, PayoutChangedEvent, PoolState, SwapEvent, TokenState,
} from "./types";

// USDG is a real quotes.json row, so classify() treats it as the quote side exactly as production does.
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TOKEN = "0x" + "7a".repeat(20);
const SV_POOL = "0x" + "5a".repeat(32);
const OTHER_POOL = "0x" + "6b".repeat(32);
const ZERO = "0x" + "0".repeat(40);
const CREATOR = "0x" + "c1".repeat(20);
const PAYOUT = "0x" + "c2".repeat(20);
const TX = "0x" + "ab".repeat(32);
const Q96 = 2n ** 96n;
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

function emptyState(): FoldState {
  return { pools: new Map(), tokens: new Map(), quotes: new Map(), candles: new Map(), poolsByToken: new Map() };
}
const at = (block: number, logIndex: number) => ({ block, logIndex, timestamp: 1_790_000_000 + block, txHash: TX, txFrom: CREATOR });

function init(o: Partial<InitializeEvent> = {}): InitializeEvent {
  return {
    kind: "initialize", ...at(100, 0), poolId: SV_POOL, currency0: USDG, currency1: TOKEN, fee: 10_000, tickSpacing: 200,
    hooks: ZERO, sqrtPriceX96: Q96, tick: 0, ...o,
  };
}
function launched(o: Partial<LaunchedEvent> = {}): LaunchedEvent {
  return {
    kind: "launched", ...at(100, 3), token: TOKEN, creator: CREATOR, quote: USDG, poolId: SV_POOL, payout: CREATOR, hook: ZERO,
    tokenIsCurrency0: false, openTick: 398_400, openingValuation: 4_995_430_000n, liquidity: 2_240_000_000_000_000_000n,
    tokensInPool: 10n ** 27n - 300n, firstBuyIn: 0n, firstBuyTokens: 0n, routerFee: 0n, creationFee: 0n, creatorShareBps: 7000,
    name: "Tailor's Chalk", symbol: "CHALK", metadataUri: `ipfs://${CID}`, ...o,
  };
}
function fees(o: Partial<LaunchFeesEvent> = {}): LaunchFeesEvent {
  return {
    kind: "launchFees", ...at(160, 2), token: TOKEN, payout: CREATOR, tokenFees: 1000n, quoteFees: 10_000_000n,
    tokenToPayout: 700n, quoteToPayout: 7_000_000n, ...o,
  };
}
function payoutChanged(o: Partial<PayoutChangedEvent> = {}): PayoutChangedEvent {
  return { kind: "payoutChanged", ...at(170, 1), token: TOKEN, previous: CREATOR, payout: PAYOUT, ...o };
}
function pool(o: Partial<PoolState> = {}): PoolState {
  return {
    id: SV_POOL, tokenId: TOKEN, quoteId: USDG, tokenIsCurrency0: false, hooks: ZERO, fee: 10_000, tickSpacing: 200, origin: "SV",
    createdAt: 1_790_000_100, priceQuote: 0.000005, sqrtPriceX96: Q96, tvlToken: 0n, tvlQuote: 0n, swapCount: 0, lastSwapAt: null,
    volumeQuoteAllTime: 0, baselineAt: 0, ...o,
  };
}
function token(o: Partial<TokenState> = {}): TokenState {
  return {
    id: TOKEN, address: TOKEN, symbol: "CHALK", name: "Tailor's Chalk", decimals: 18, poolCount: 1, origin: "SV",
    primaryPoolId: SV_POOL, createdAt: 1_790_000_100, metadataLoaded: true, ...o,
  };
}

describe("foldEvents: the launchpad (instant launchpad design, section 5.2)", () => {
  it("labels the pool and the token SV when Initialize and Launched arrive in one batch, and records one launch row", () => {
    const state = emptyState();
    const result = foldEvents([init(), launched()], state);
    expect(state.pools.get(SV_POOL)?.origin).toBe("SV");
    expect(state.tokens.get(TOKEN)).toMatchObject({ origin: "SV", primaryPoolId: SV_POOL });
    expect(result.launches).toEqual([
      {
        tokenId: TOKEN, poolId: SV_POOL, quoteId: USDG, creator: CREATOR, payout: CREATOR, hook: ZERO, tokenIsCurrency0: false,
        creatorShareBps: 7000, openTick: 398_400, openingValuation: 4_995_430_000n, liquidity: 2_240_000_000_000_000_000n,
        tokensInPool: 10n ** 27n - 300n, firstBuyIn: 0n, firstBuyTokens: 0n, routerFee: 0n, creationFee: 0n,
        name: "Tailor's Chalk", symbol: "CHALK", metadataUri: `ipfs://${CID}`, metadataCid: CID,
        block: 100, logIndex: 3, txHash: TX, timestamp: 1_790_000_100,
      },
    ]);
    expect(result.launchEvents).toBe(1);
    expect(result.newTokens).toEqual([TOKEN]);
  });

  it("relabels a pool whose Initialize fell into an earlier batch, and its token, SV", () => {
    const state = emptyState();
    state.pools.set(SV_POOL, pool({ origin: "Uniswap" }));
    state.tokens.set(TOKEN, token({ origin: "Uniswap" }));
    state.poolsByToken.set(TOKEN, [SV_POOL]);
    const result = foldEvents([launched()], state);
    expect(result.pools.map((p) => [p.id, p.origin])).toEqual([[SV_POOL, "SV"]]);
    expect(result.tokens.map((t) => [t.id, t.origin])).toEqual([[TOKEN, "SV"]]);
  });

  it("keeps the token SV when a later second pool with more quote money becomes primary (D43 still picks the primary)", () => {
    const state = emptyState();
    state.quotes.set(USDG, { id: USDG, decimals: 6, usdPrice: 1 });
    state.pools.set(SV_POOL, pool());
    state.pools.set(OTHER_POOL, pool({ id: OTHER_POOL, origin: "Uniswap", tvlQuote: 1_000_000_000n, tvlToken: 10n ** 24n, createdAt: 1_790_000_900 }));
    state.tokens.set(TOKEN, token({ poolCount: 2 }));
    state.poolsByToken.set(TOKEN, [SV_POOL, OTHER_POOL]);
    const swap: SwapEvent = {
      kind: "swap", ...at(200, 0), poolId: OTHER_POOL, amount0: -1_000_000n, amount1: 10n ** 18n, sqrtPriceX96: Q96,
      liquidity: 10n ** 18n, tick: 0, fee: 3000,
    };
    const result = foldEvents([swap], state);
    expect(state.tokens.get(TOKEN)).toMatchObject({ primaryPoolId: OTHER_POOL, origin: "SV" });
    expect(result.tokens.map((t) => t.id)).toEqual([TOKEN]);
  });

  it("appends one fee row per FeesCollected, never summed, with the platform share as total minus payout", () => {
    const result = foldEvents([fees(), fees({ ...at(161, 0), tokenFees: 10n, quoteFees: 0n, tokenToPayout: 7n, quoteToPayout: 0n })], emptyState());
    expect(result.launchFees).toEqual([
      { txHash: TX, logIndex: 2, tokenId: TOKEN, payout: CREATOR, tokenPayout: 700n, tokenPlatform: 300n, quotePayout: 7_000_000n, quotePlatform: 3_000_000n, timestamp: 1_790_000_160, block: 160 },
      { txHash: TX, logIndex: 0, tokenId: TOKEN, payout: CREATOR, tokenPayout: 7n, tokenPlatform: 3n, quotePayout: 0n, quotePlatform: 0n, timestamp: 1_790_000_161, block: 161 },
    ]);
    expect(result.launchEvents).toBe(2);
  });

  it("keeps only the last payout change per token", () => {
    const result = foldEvents([payoutChanged(), payoutChanged({ ...at(171, 4), previous: PAYOUT, payout: CREATOR })], emptyState());
    expect(result.payouts).toEqual([{ tokenId: TOKEN, payout: CREATOR, block: 171, logIndex: 4 }]);
  });

  it("stores no metadata CID for a URI that is not exactly ipfs://<CID> (Review Focus 3)", () => {
    const https = foldEvents([launched({ metadataUri: "https://example.test/meta.json" })], emptyState());
    const withPath = foldEvents([launched({ metadataUri: `ipfs://${CID}/meta.json` })], emptyState());
    const empty = foldEvents([launched({ metadataUri: "" })], emptyState());
    expect([https, withPath, empty].map((r) => r.launches[0]!.metadataCid)).toEqual(["", "", ""]);
  });

  it("folds a batch of only fee and payout events without touching a pool, and asks for no token metadata", () => {
    const events = [fees(), payoutChanged()];
    expect(newTokenCandidates(events, emptyState())).toEqual([]);
    const result = foldEvents(events, emptyState());
    expect(result).toMatchObject({ pools: [], tokens: [], trades: [], ignoredPools: 0, launchEvents: 2 });
  });
});
```

- [ ] **Step 11: Run it to verify it fails**

Run: `npx vitest run src/lib/chain/fold.launch.test.ts`
Expected: FAIL. `launches`, `launchFees`, `payouts` and `launchEvents` are undefined on the result, and the relabel cases keep origin "Uniswap".

- [ ] **Step 12: Write the fold changes**

Edit `src/lib/chain/fold.ts`.

Replace the type import (lines 83-94):

```ts
import type {
  ChainEvent,
  InitializeEvent,
  SwapEvent,
  ModifyLiquidityEvent,
  FoldState,
  FoldResult,
  PoolState,
  TokenState,
  CandleState,
  TradeRow,
} from "./types";
```

with:

```ts
import type {
  ChainEvent,
  InitializeEvent,
  SwapEvent,
  ModifyLiquidityEvent,
  LaunchedEvent,
  LaunchFeesEvent,
  PayoutChangedEvent,
  LaunchRow,
  LaunchFeesRow,
  PayoutRow,
  FoldState,
  FoldResult,
  PoolState,
  TokenState,
  CandleState,
  TradeRow,
} from "./types";
```

In `FoldContext` (lines 122-134), after `  warnedOrphanPools: Set<string>;` add:

```ts
  /** Pool ids a `launched` event in this batch names: collected before the dispatch loop (spec 5.2 step 1). */
  svPools: Set<string>;
  launches: LaunchRow[];
  launchFees: LaunchFeesRow[];
  /** Keyed by token id: the last `payoutChanged` per token in the batch wins. */
  payouts: Map<string, PayoutRow>;
  launchEvents: number;
```

Replace the body of `foldEvents`, from `  const ctx: FoldContext = {` through the end of its `return { … };` (lines 163-199), with:

```ts
  // Spec 5.2 step 1: a launch transaction emits Initialize, ModifyLiquidity, maybe Swap, then Launched, all in one block,
  // so always in one batch. The pre-scan lets handleInitialize, which runs first, already label the pool SV.
  const svPools = new Set<string>();
  for (const event of events) if (event.kind === "launched") svPools.add(event.poolId);

  const ctx: FoldContext = {
    touchedPools: new Set(),
    touchedTokens: new Set(),
    touchedCandles: new Set(),
    trades: [],
    newTokenIds: [],
    ignoredPools: 0,
    orphanedTokens: 0,
    skippedLiquidity: 0,
    tokenMetadata: opts?.tokenMetadata,
    warnedOrphanPools: new Set(),
    svPools,
    launches: [],
    launchFees: [],
    payouts: new Map(),
    launchEvents: 0,
  };

  for (const event of events) {
    switch (event.kind) {
      case "initialize":
        handleInitialize(event, state, ctx);
        break;
      case "swap":
        handleSwap(event, state, ctx);
        break;
      case "modifyLiquidity":
        handleModifyLiquidity(event, state, ctx);
        break;
      case "launched":
        handleLaunched(event, state, ctx);
        break;
      case "launchFees":
        handleLaunchFees(event, ctx);
        break;
      case "payoutChanged":
        handlePayoutChanged(event, ctx);
        break;
    }
  }

  return {
    pools: Array.from(ctx.touchedPools, (id) => state.pools.get(id)!),
    tokens: Array.from(ctx.touchedTokens, (id) => state.tokens.get(id)!),
    candles: Array.from(ctx.touchedCandles, (id) => state.candles.get(id)!),
    trades: ctx.trades,
    newTokens: ctx.newTokenIds,
    ignoredPools: ctx.ignoredPools,
    orphanedTokens: ctx.orphanedTokens,
    skippedLiquidity: ctx.skippedLiquidity,
    launches: ctx.launches,
    launchFees: ctx.launchFees,
    payouts: [...ctx.payouts.values()],
    launchEvents: ctx.launchEvents,
  };
```

In `newTokenCandidates`, directly after the `initialize` branch's closing `}` (the brace after `continue;`, line 232) and before the comment `// Swap and ModifyLiquidity: a pool this batch touches…`, add:

```ts
    // The launchpad's events are not all pool events (spec 5.2 step 6): only Swap and ModifyLiquidity reach the repair case.
    if (event.kind !== "swap" && event.kind !== "modifyLiquidity") continue;
```

In `recomputePrimaryPool`, replace lines 342-347:

```ts
  const bestPool = pools.find((p) => p.id === best);
  if (bestPool && (token.primaryPoolId !== best || token.origin !== bestPool.origin)) {
    const updatedToken: TokenState = { ...token, primaryPoolId: best, origin: bestPool.origin };
    state.tokens.set(tokenId, updatedToken);
    ctx.touchedTokens.add(tokenId);
  }
```

with:

```ts
  const bestPool = pools.find((p) => p.id === best);
  if (!bestPool) return;
  // Spec 5.2 step 3: D43's ranking still picks the primary pool, but a token launched here stays SV even when another
  // pool with more money in it becomes primary and prices the token.
  const origin = pools.some((p) => p.origin === "SV") ? "SV" : bestPool.origin;
  if (token.primaryPoolId !== best || token.origin !== origin) {
    const updatedToken: TokenState = { ...token, primaryPoolId: best, origin };
    state.tokens.set(tokenId, updatedToken);
    ctx.touchedTokens.add(tokenId);
  }
```

In `handleInitialize`, replace line 384:

```ts
  const origin = originFor(event.poolId, event.hooks);
```

with:

```ts
  // Spec 5.2 step 2: a pool a Launched in this batch names is the launchpad's, whatever its hook.
  const origin = ctx.svPools.has(event.poolId) ? "SV" : originFor(event.poolId, event.hooks);
```

Append at the end of the file:

```ts

/** `ipfs://<CID>` and nothing else (spec 5.2); any other URI has no CID to match an upload by. */
const IPFS_CID_URI = /^ipfs:\/\/([A-Za-z0-9]{46,128})$/;

function metadataCidOf(uri: string): string {
  return IPFS_CID_URI.exec(uri)?.[1] ?? "";
}

/**
 * Spec 5.2 step 4. The row is appended whatever the state holds; the relabel is for the one case where a launch's
 * Initialize fell into an earlier batch, so the pre-scan could not label the pool when it was created.
 */
function handleLaunched(event: LaunchedEvent, state: FoldState, ctx: FoldContext): void {
  ctx.launchEvents += 1;
  ctx.launches.push({
    tokenId: event.token,
    poolId: event.poolId,
    quoteId: event.quote,
    creator: event.creator,
    payout: event.payout,
    hook: event.hook,
    tokenIsCurrency0: event.tokenIsCurrency0,
    creatorShareBps: event.creatorShareBps,
    openTick: event.openTick,
    openingValuation: event.openingValuation,
    liquidity: event.liquidity,
    tokensInPool: event.tokensInPool,
    firstBuyIn: event.firstBuyIn,
    firstBuyTokens: event.firstBuyTokens,
    routerFee: event.routerFee,
    creationFee: event.creationFee,
    name: event.name,
    symbol: event.symbol,
    metadataUri: event.metadataUri,
    metadataCid: metadataCidOf(event.metadataUri),
    block: event.block,
    logIndex: event.logIndex,
    txHash: event.txHash,
    timestamp: event.timestamp,
  });
  const pool = state.pools.get(event.poolId);
  if (!pool || pool.origin === "SV") return;
  state.pools.set(pool.id, { ...pool, origin: "SV" });
  ctx.touchedPools.add(pool.id);
  const token = state.tokens.get(pool.tokenId);
  if (token && token.origin !== "SV") {
    state.tokens.set(token.id, { ...token, origin: "SV" });
    ctx.touchedTokens.add(token.id);
  }
}

/** Spec 5.2 step 5: one row per log, keyed by (tx, log index), never summed here. */
function handleLaunchFees(event: LaunchFeesEvent, ctx: FoldContext): void {
  ctx.launchEvents += 1;
  ctx.launchFees.push({
    txHash: event.txHash,
    logIndex: event.logIndex,
    tokenId: event.token,
    payout: event.payout,
    tokenPayout: event.tokenToPayout,
    tokenPlatform: event.tokenFees - event.tokenToPayout,
    quotePayout: event.quoteToPayout,
    quotePlatform: event.quoteFees - event.quoteToPayout,
    timestamp: event.timestamp,
    block: event.block,
  });
}

/** Spec 5.2 step 5: the last change per token in the batch; the store applies it only over an older position. */
function handlePayoutChanged(event: PayoutChangedEvent, ctx: FoldContext): void {
  ctx.launchEvents += 1;
  ctx.payouts.set(event.token, { tokenId: event.token, payout: event.payout, block: event.block, logIndex: event.logIndex });
}
```

- [ ] **Step 13: Run it to verify it passes**

Run: `npx vitest run src/lib/chain/fold.launch.test.ts src/lib/chain/fold.test.ts`
Expected: PASS. The existing fold suite passes unchanged: the SV rule only acts when a pool's origin is SV.

- [ ] **Step 14: Write the failing store tests**

Edit `src/lib/chain/store.test.ts`.

Replace line 1:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
```

with:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
```

Replace line 8:

```ts
import type { CandleInterval, CandleState, FoldResult, InitializeEvent, PoolState, SwapEvent, TokenState, TradeRow } from "./types";
```

with:

```ts
import type {
  CandleInterval, CandleState, FoldResult, InitializeEvent, LaunchFeesEvent, LaunchFeesRow, LaunchRow, LaunchedEvent, PayoutChangedEvent,
  PoolState, SwapEvent, TokenState, TradeRow,
} from "./types";
```

In `beforeEach` (line 19), replace the string

```ts
    "delete from market.quotes; delete from market.tokens; delete from market.pools; delete from market.swaps; delete from market.candles; delete from market.sync_state",
```

with

```ts
    "delete from market.quotes; delete from market.tokens; delete from market.pools; delete from market.swaps; delete from market.candles; delete from market.sync_state; delete from market.launches; delete from market.launch_fee_events; delete from market.launch_uploads",
```

In `result()` (line 84), replace

```ts
    ignoredPools: 0, orphanedTokens: 0, skippedLiquidity: 0, ...o,
```

with

```ts
    ignoredPools: 0, orphanedTokens: 0, skippedLiquidity: 0, launches: [], launchFees: [], payouts: [], launchEvents: 0, ...o,
```

Append at the end of the file:

```ts
describe("applyFold and loadFoldState: the launchpad (instant launchpad design, section 5.2)", () => {
  const LAUNCH_TOKEN = addr(0xd1);
  const NEW_PAYOUT = addr(0xe2);
  const META_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
  const IMAGE_CID = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";
  const launchRow = (o: Partial<LaunchRow> = {}): LaunchRow => ({
    tokenId: LAUNCH_TOKEN, poolId: POOL_B, quoteId: QUOTE, creator: WALLET, payout: WALLET, hook: addr(0), tokenIsCurrency0: true,
    creatorShareBps: 7000, openTick: -168_200, openingValuation: 49_605_800_000_000_000_000n, liquidity: 10n ** 23n,
    tokensInPool: 10n ** 27n, firstBuyIn: 0n, firstBuyTokens: 0n, routerFee: 0n, creationFee: 0n, name: "Tailor's Chalk",
    symbol: "CHALK", metadataUri: `ipfs://${META_CID}`, metadataCid: META_CID, block: 140, logIndex: 5, txHash: txHash(40), timestamp: T0, ...o,
  });
  const feeRow = (o: Partial<LaunchFeesRow> = {}): LaunchFeesRow => ({
    txHash: txHash(41), logIndex: 2, tokenId: LAUNCH_TOKEN, payout: WALLET, tokenPayout: 7n, tokenPlatform: 3n, quotePayout: 70n,
    quotePlatform: 30n, timestamp: T0 + 60, block: 145, ...o,
  });
  const base = (block: number) => ({ block, logIndex: 0, timestamp: T0 + block, txHash: txHash(block), txFrom: WALLET });

  it("writes the launch, attaches its upload, inserts the fee row and applies the payout in the fold's transaction; a re-applied result changes nothing", async () => {
    await db.query(
      `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, website, status, created_at)
       values ($1, $2, $3, 'launch/img/k.webp', 'launch/meta/k.json', 'Tailor''s Chalk', 'CHALK', 'https://chalk.test', 'pending', $4)`,
      [WALLET, IMAGE_CID, META_CID, T0 - 30],
    );
    const r = result({
      launches: [launchRow()], launchFees: [feeRow()], launchEvents: 3,
      payouts: [{ tokenId: LAUNCH_TOKEN, payout: NEW_PAYOUT, block: 150, logIndex: 1 }],
    });
    await applyFold(db, r, 150, T0 + 100);
    await applyFold(db, r, 150, T0 + 200);
    expect(await db.query("select payout, payout_block, image_cid, website from market.launches")).toEqual([
      { payout: NEW_PAYOUT, payout_block: 150, image_cid: IMAGE_CID, website: "https://chalk.test" },
    ]);
    expect(await count("launch_fee_events")).toBe(1);
    expect(await db.query("select status, token_id from market.launch_uploads")).toEqual([{ status: "used", token_id: LAUNCH_TOKEN }]);
    expect(await readChainCursor(db)).toBe(150);
  });

  it("rolls the launch rows back with the cursor when any statement of the batch throws", async () => {
    const bad = result({ launches: [launchRow()], launchFees: [feeRow({ tokenPlatform: -1n })] }); // violates token_platform >= 0
    await expect(applyFold(db, bad, 160, T0)).rejects.toThrow();
    expect(await count("launches")).toBe(0);
    expect(await readChainCursor(db)).toBe(0);
  });

  it("reads no pool for a batch of only fee and payout events", async () => {
    const feeEvent: LaunchFeesEvent = { kind: "launchFees", ...base(170), token: LAUNCH_TOKEN, payout: WALLET, tokenFees: 1n, quoteFees: 1n, tokenToPayout: 0n, quoteToPayout: 0n };
    const payoutEvent: PayoutChangedEvent = { kind: "payoutChanged", ...base(171), token: LAUNCH_TOKEN, previous: WALLET, payout: NEW_PAYOUT };
    const spy = vi.spyOn(db, "query");
    const state = await loadFoldState(db, [feeEvent, payoutEvent]);
    expect(state.pools.size).toBe(0);
    expect(spy.mock.calls.some(([sql]) => String(sql).includes("from market.pools where id = any"))).toBe(false);
    spy.mockRestore();
  });

  it("loads the pool a Launched names, so a pool initialised in an earlier batch can be relabelled SV", async () => {
    await applyFold(db, result({ pools: [pool({ id: POOL_B, origin: "Uniswap" })], tokens: [token({ primaryPoolId: POOL_B, origin: "Uniswap" })] }), 1, T0);
    const launchedEvent: LaunchedEvent = {
      kind: "launched", ...base(180), token: TOKEN_A, creator: WALLET, quote: QUOTE, poolId: POOL_B, payout: WALLET, hook: addr(0),
      tokenIsCurrency0: true, openTick: 0, openingValuation: 1n, liquidity: 1n, tokensInPool: 1n, firstBuyIn: 0n, firstBuyTokens: 0n,
      routerFee: 0n, creationFee: 0n, creatorShareBps: 7000, name: "AI", symbol: "AI", metadataUri: "",
    };
    const state = await loadFoldState(db, [launchedEvent]);
    expect(state.pools.get(POOL_B)?.origin).toBe("Uniswap");
    expect(state.tokens.get(TOKEN_A)?.primaryPoolId).toBe(POOL_B);
  });
});
```

- [ ] **Step 15: Run it to verify it fails**

Run: `npx vitest run src/lib/chain/store.test.ts`
Expected: FAIL. `applyFold` writes no launch row; `loadFoldState` queries pools with `[undefined]` for the fee-only batch and never loads `POOL_B` for the launched-only batch.

- [ ] **Step 16: Write the store changes**

Edit `src/lib/chain/store.ts`. After line 5 (`import { dedupe, recomputeListedPools, upsertPools } from "@/lib/sync/writers";`) add:

```ts
import { applyPayouts, attachUploads, insertLaunchFees, insertLaunches } from "@/lib/launch/store";
```

Replace line 129:

```ts
  const poolIds = [...new Set(events.map((e) => e.poolId))];
```

with:

```ts
  // Only the events that name a pool (spec 5.2 step 6): the PoolManager's three and `launched`, whose pool may have been
  // initialised in an earlier batch and must load so the fold can relabel it SV. Fee and payout events carry none.
  const poolIds = [
    ...new Set(
      events.flatMap((e) =>
        e.kind === "initialize" || e.kind === "swap" || e.kind === "modifyLiquidity" || e.kind === "launched" ? [e.poolId] : [],
      ),
    ),
  ];
```

In `applyFold`, replace lines 380-382:

```ts
    if (opts?.holderDeltas) await applyHolderDeltas(t, opts.holderDeltas);
    const tokenIds = [...new Set([...result.tokens.map((tok) => tok.id), ...result.pools.map((p) => p.tokenId)])];
    await recomputeListedPools(t, tokenIds);
```

with:

```ts
    if (opts?.holderDeltas) await applyHolderDeltas(t, opts.holderDeltas);
    // The launchpad's rows (instant launchpad design, section 5.2): after the tokens, before the listing and the cursor.
    const launchTokenIds = result.launches.map((l) => l.tokenId);
    await insertLaunches(t, result.launches, now);
    await attachUploads(t, launchTokenIds, now);
    await insertLaunchFees(t, result.launchFees);
    await applyPayouts(t, result.payouts, now);
    const tokenIds = [...new Set([...result.tokens.map((tok) => tok.id), ...result.pools.map((p) => p.tokenId), ...launchTokenIds])];
    await recomputeListedPools(t, tokenIds);
```

- [ ] **Step 17: Run it to verify it passes**

Run: `npx vitest run src/lib/chain/store.test.ts`
Expected: PASS.

- [ ] **Step 18: Write the failing report and health tests**

Edit `src/lib/chain/run.test.ts`. Replace line 8:

```ts
import type { ChainEvent, InitializeEvent, SwapEvent, TransferEvent } from "./types";
```

with:

```ts
import type { ChainEvent, InitializeEvent, PayoutChangedEvent, SwapEvent, TransferEvent } from "./types";
```

In `seedToken`, replace

```ts
      pools: [], candles: [], trades: [], newTokens: [id], ignoredPools: 0, orphanedTokens: 0, skippedLiquidity: 0,
```

with

```ts
      pools: [], candles: [], trades: [], newTokens: [id], ignoredPools: 0, orphanedTokens: 0, skippedLiquidity: 0,
      launches: [], launchFees: [], payouts: [], launchEvents: 0,
```

In both exact reports (the `skipped: "lease"` one and the `skipped: "nightly"` one) replace

```ts
      skippedLiquidity: 0, holderDeltaApplied: 0, holderReadsUnknown: 0, requests: 0, quotesRefreshed: 0,
```

with

```ts
      skippedLiquidity: 0, launchEvents: 0, holderDeltaApplied: 0, holderReadsUnknown: 0, requests: 0, quotesRefreshed: 0,
```

(the line appears exactly twice in this file: use the Edit tool's replace-all).

Append at the end of the file:

```ts
describe("runChainSync: launchpad events in the report (instant launchpad design, section 5.2)", () => {
  it("counts the launchpad events a cycle folded, in the report and in the stored last_report", async () => {
    await seedCursor(db, 99);
    const payout: PayoutChangedEvent = {
      kind: "payoutChanged", block: 100, logIndex: 0, timestamp: 1_700_000_100, txHash: txHash(9), txFrom: WALLET,
      token: AI, previous: WALLET, payout: addr(0xd1),
    };
    const source = new FakeLogSource({ head: 200, batches: { 100: { events: [payout], nextBlock: 102 } } });
    const report = await runChainSync(db, chainDeps({ source }), baseOpts({ maxSpan: 150, maxRequests: 2 }));
    expect(report.error).toBeNull();
    expect(report.launchEvents).toBe(1);
    const [row] = await db.query<{ last_report: unknown }>("select last_report from market.sync_state where job = 'chain'");
    const stored = typeof row!.last_report === "string" ? JSON.parse(row!.last_report) : row!.last_report;
    expect(stored).toMatchObject({ launchEvents: 1 });
  });
});
```

Edit `src/lib/market/dbBackend.test.ts`. Inside `describe("createDbBackend health", …)`, after the test titled "surfaces the chain job's last cycle (holder-count reads) and the RPC hosts, and neither when absent (23 Sep 2026)", add:

```ts
  it("reads launchEvents from the last cycle, as 0 from a report written before it existed, and counts missing and deleted uploads (spec 5.2, 13)", async () => {
    const report = { at: NOW - 20, cursor: 990, blocks: 30, trades: 280, holderPairs: 190, holderDeltaApplied: 150, holderReadsUnknown: 40 };
    await finishRun(db, "chain", { now: NOW - 20, ok: true, rows: 1, queries: 1, report });
    expect((await backend().health()).sync?.lastCycle).toEqual({
      ageSec: 20, blocks: 30, trades: 280, holderPairs: 190, holderDeltaApplied: 150, holderReadsUnknown: 40, launchEvents: 0,
    });
    await finishRun(db, "chain", { now: NOW - 20, ok: true, rows: 1, queries: 1, report: { ...report, launchEvents: 4 } });
    expect((await backend().health()).sync?.lastCycle?.launchEvents).toBe(4);
    expect((await backend().health()).launches).toEqual({ missingUploads: 0, deletedUploads: 0 });
    await db.query(
      `insert into market.launches (token_id, pool_id, quote_id, creator, payout, token_is_currency0, creator_share_bps, open_tick,
         opening_valuation, liquidity, tokens_in_pool, first_buy_in, first_buy_tokens, router_fee, creation_fee, hook, name, symbol,
         metadata_uri, metadata_cid, launch_block, launch_log_index, launch_tx, launched_at, payout_block, payout_log_index, updated_at)
       values ('0xt', '0xp', '0xq', '0xc', '0xc', true, 7000, 0, 1, 1, 1, 0, 0, 0, 0, '0x0', 'N', 'S', 'ipfs://bafy', 'bafy', 1, 0, '0xtx', 1, 1, 0, 1)`,
    );
    await db.query(
      `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, status, created_at)
       values ('0xc', 'i', 'bafy', 'ik', 'mk', 'N', 'S', 'deleted', 1)`,
    );
    expect((await backend().health()).launches).toEqual({ missingUploads: 1, deletedUploads: 1 });
    await db.exec("delete from market.launches; delete from market.launch_uploads");
  });

  it("says the launch tables are unavailable, and is not ok, when market.launches is missing (the migration not applied)", async () => {
    const bare = await testDb(); // its own in-memory PGlite, so the suite's shared database keeps its tables
    try {
      await bare.exec("alter table market.launches rename to launches_gone");
      await finishRun(bare, "chain", { now: NOW - 20, ok: true, rows: 1, queries: 1 });
      const h = await createDbBackend(bare, { now: () => NOW }).health();
      expect(h.launches).toEqual({ error: "launch tables unavailable" });
      expect(h.ok).toBe(false);
    } finally {
      await bare.end();
    }
  });
```

- [ ] **Step 19: Run them to verify they fail**

Run: `npx vitest run src/lib/chain/run.test.ts src/lib/market/dbBackend.test.ts`
Expected: FAIL. `report.launchEvents` is undefined, `lastCycle` has no `launchEvents`, `health()` has no `launches`.

- [ ] **Step 20: Write the report and health changes**

Edit `src/lib/chain/run.ts`. In `ChainRunReport`, after `  skippedLiquidity: number;` add:

```ts
  /** Launchpad events folded this invocation (instant launchpad design, section 13). */
  launchEvents: number;
```

In `emptyReport()`, replace

```ts
    skippedLiquidity: 0, holderDeltaApplied: 0, holderReadsUnknown: 0, requests: 0, quotesRefreshed: 0,
```

with

```ts
    skippedLiquidity: 0, launchEvents: 0, holderDeltaApplied: 0, holderReadsUnknown: 0, requests: 0, quotesRefreshed: 0,
```

After `        report.skippedLiquidity += result.skippedLiquidity;` add:

```ts
        report.launchEvents += result.launchEvents;
```

In the `finishRun` call's `report:` object, replace

```ts
            holderDeltaApplied: holderOutcome.applied, holderReadsUnknown: holderOutcome.unknown,
          },
```

with

```ts
            holderDeltaApplied: holderOutcome.applied, holderReadsUnknown: holderOutcome.unknown,
            launchEvents: result.launchEvents,
          },
```

Edit `src/lib/market/backend.ts`. Replace line 18:

```ts
    lastCycle?: { ageSec: number; blocks: number; trades: number; holderPairs: number; holderDeltaApplied: number; holderReadsUnknown: number };
```

with:

```ts
    lastCycle?: {
      ageSec: number; blocks: number; trades: number; holderPairs: number; holderDeltaApplied: number; holderReadsUnknown: number;
      /** Launchpad events folded in the last cycle; 0 when the stored report predates the launchpad (spec section 13). */
      launchEvents: number;
    };
```

After the closing `};` of `holders?: { … }` (line 39) add:

```ts
  /**
   * Launches whose upload was not found, and uploads the nightly clean-up removed (spec section 13). When the launch
   * tables cannot be read (the migration not applied yet, above all) it says so and `ok` turns false: every launch
   * logo then answers "no logo" and the reader's applyFold throws, so this must be loud, not silently absent.
   */
  launches?: { missingUploads: number; deletedUploads: number } | { error: string };
```

Edit `src/lib/market/dbBackend.ts`. After line 6 (`import { refreshRow, requestBuild, STALE_SEC } from "@/lib/holders/store";`) add:

```ts
import { launchHealth } from "@/lib/launch/store";
```

Replace `lastCycleFrom` (lines 161-166):

```ts
function lastCycleFrom(stored: Record<string, unknown> | string | null, at: number): NonNullable<HealthReport["sync"]>["lastCycle"] | null {
  const n = reportNumbers(stored, ["at", "blocks", "trades", "holderPairs", "holderDeltaApplied", "holderReadsUnknown"] as const);
  if (!n) return null;
  const { at: reportedAt, ...rest } = n;
  return { ageSec: at - reportedAt, ...rest };
}
```

with:

```ts
function lastCycleFrom(stored: Record<string, unknown> | string | null, at: number): NonNullable<HealthReport["sync"]>["lastCycle"] | null {
  const n = reportNumbers(stored, ["at", "blocks", "trades", "holderPairs", "holderDeltaApplied", "holderReadsUnknown"] as const);
  if (!n) return null;
  const { at: reportedAt, ...rest } = n;
  // Optional (spec 5.2, amended 29 Sep 2026): a last_report written before the launchpad lacks it and must still parse.
  const launchEvents = reportNumbers(stored, ["launchEvents"] as const)?.launchEvents ?? 0;
  return { ageSec: at - reportedAt, ...rest, launchEvents };
}
```

In `health()`, replace lines 321-322:

```ts
      const ok = sync.lastOkAgeSec !== null && sync.lastOkAgeSec <= SYNC_OK_WITHIN_SEC && !quotesFailed && quotes.every((q) => !q.stale);
      return { ok, backend: "db", lag, quotes, db: { latencyMs }, sync, nightly: night, holders, ...(opts.rpc ? { rpc: opts.rpc } : {}) };
```

with:

```ts
      // Its own try/catch (I4), but not silent: a missing market.launches means the migration was not applied, which
      // also blanks every launch logo (the logo resolver's launchImage read fails) and stops the reader's applyFold.
      let launches: NonNullable<HealthReport["launches"]>;
      try {
        launches = await launchHealth(db);
      } catch (err) {
        console.warn(`health: launch tables unavailable: ${message(err)}`);
        launches = { error: "launch tables unavailable" };
      }
      const ok =
        sync.lastOkAgeSec !== null && sync.lastOkAgeSec <= SYNC_OK_WITHIN_SEC && !quotesFailed && quotes.every((q) => !q.stale) && !("error" in launches);
      return {
        ok, backend: "db", lag, quotes, db: { latencyMs }, sync, nightly: night, holders, launches,
        ...(opts.rpc ? { rpc: opts.rpc } : {}),
      };
```

- [ ] **Step 21: Run the reader's suites and the gates**

Run: `npx vitest run src/lib/chain src/lib/market src/app/api/internal src/app/api/health`
Expected: PASS.
Then: `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src`. All clean. `tsc` is what proves the kind guards: any `event.poolId` read on an un-narrowed `ChainEvent` fails to compile.

- [ ] **Step 22: Commit**

```bash
git add src/lib/chain src/lib/market/backend.ts src/lib/market/dbBackend.ts src/lib/market/dbBackend.test.ts
git commit -m "Launchpad: the reader folds Launched, FeesCollected and PayoutChanged into the store, labels launches SV, and reports them"
```

---

### Task 4: The listing window, the table order, the `launch` block and the Liquidity row

**Files:**
- Modify: `src/lib/sync/writers.ts:164-179` (`LISTED_POOL` becomes `listedPool(now)`, `recomputeListedPools` takes `now`, new `svWindowClosedTokens`)
- Modify: every caller of `recomputeListedPools`: `src/lib/chain/store.ts` (`applyFold`), `src/lib/sync/nightly.ts:118`, `src/lib/sync/market.ts:127`, `src/lib/seed/seed.ts:244`
- Modify: `src/lib/sync/writers.test.ts:132-161` (the clock on four calls, two new tests)
- Modify: `src/lib/chain/store.test.ts` (one test in the launchpad `describe` from Task 3)
- Modify: `src/lib/types.ts` (`LaunchInfo`; `TokenPair.launch`)
- Create: `src/lib/launch/read.ts`
- Modify: `src/lib/market/dbShape.ts:11-19` (`PAIR_ONE_SELECT`)
- Modify: `src/lib/market/dbBackend.ts:45-50` (`ORDER`, the launchpad scope), `:197-200` (`pair`)
- Modify: `src/lib/market/dbBackend.test.ts` (the clock on every `recomputeListedPools(db, "all")`; line 177's expectation)
- Create: `src/lib/market/dbBackend.launch.test.ts`
- Modify: `src/components/ActivityTabs.tsx:203`, `src/components/ActivityTabs.test.tsx` (one test)

**Interfaces:**
- Consumes: `insertLaunches`, `insertLaunchFees` (Task 1); `testDb`; the writers' `upsertQuotes`, `upsertTokens`, `upsertPools` and the `PoolRec`/`TokenRec`/`QuoteRec`/`QuotePriceRec` shapes (`src/lib/sync/source.ts`).
- Produces:
  ```ts
  // src/lib/sync/writers.ts
  export const SV_LISTING_WINDOW_SEC = 86_400;
  export async function recomputeListedPools(db: Db, tokenIds: readonly string[] | "all", now: number): Promise<number>;
  export async function svWindowClosedTokens(db: Db, now: number): Promise<string[]>;
  // src/lib/types.ts
  export type LaunchInfo = { creator: Address; payout: Address; quoteAddress: Address; quoteDecimals: number; tokenIsCurrency0: boolean;
    openTick: number; openingValuation: string; firstBuyIn: string; firstBuyTokens: string; creatorShareBps: number; launchedAt: number;
    launchBlock: number; launchTx: Hex; hidden: boolean; imageCid: string; description: string; website: string; x: string; telegram: string;
    routerFee: string; feesCollected: { tokenToPayout: string; tokenToPlatform: string; quoteToPayout: string; quoteToPlatform: string };
    feesCollectedAt: number };
  // TokenPair gains: launch?: LaunchInfo | null;   (undefined on list rows, null for a token not launched here)
  // src/lib/launch/read.ts
  export async function readLaunchInfo(db: Db, tokenId: string): Promise<LaunchInfo | null>;
  // src/lib/market/dbShape.ts
  export const PAIR_ONE_SELECT: string;
  ```

- [ ] **Step 1: Write the failing listing tests**

Edit `src/lib/sync/writers.test.ts`. Replace line 5:

```ts
import { dedupe, insertSwaps, markSynced, recomputeListedPools, upsertCandles, upsertPools, upsertQuotes, upsertTokens } from "./writers";
```

with:

```ts
import {
  SV_LISTING_WINDOW_SEC, dedupe, insertSwaps, markSynced, recomputeListedPools, svWindowClosedTokens, upsertCandles, upsertPools, upsertQuotes,
  upsertTokens,
} from "./writers";
```

In `describe("recomputeListedPools", …)`, give every call the clock: replace `recomputeListedPools(db, [TOKEN_A, TOKEN_B])` with `recomputeListedPools(db, [TOKEN_A, TOKEN_B], T0)`, `recomputeListedPools(db, [TOKEN_B])` with `recomputeListedPools(db, [TOKEN_B], T0)`, `recomputeListedPools(db, "all")` with `recomputeListedPools(db, "all", T0)` and `recomputeListedPools(db, [])` with `recomputeListedPools(db, [], T0)`. Then add, inside the same `describe`, after its last test:

```ts
  it("lists an SV pool with no swaps for its first 24 hours only, and a traded one for good (instant launchpad design, 5.4)", async () => {
    expect(SV_LISTING_WINDOW_SEC).toBe(86_400);
    await upsertTokens(db, [tokenRec({ origin: "SV" })], T0);
    await upsertPools(db, [poolRec({ origin: "SV", swapCount: 0, lastSwapAt: null, createdAt: T0 })], T0);
    expect(await recomputeListedPools(db, [TOKEN_A], T0 + 86_399)).toBe(1);
    expect((await listed())[TOKEN_A]).toBe(POOL_A);
    await recomputeListedPools(db, "all", T0 + 86_400);
    expect((await listed())[TOKEN_A]).toBeNull();
    await db.query("update market.pools set swap_count = 1, last_swap_at = $2 where id = $1", [POOL_A, T0 + 90_000]);
    await recomputeListedPools(db, [TOKEN_A], T0 + 10 * 86_400);
    expect((await listed())[TOKEN_A]).toBe(POOL_A);
  });

  it("svWindowClosedTokens names the tokens listed through an unswapped SV pool whose window has closed, and nothing else", async () => {
    await upsertTokens(db, [tokenRec({ origin: "SV" }), tokenRec({ id: TOKEN_B, address: TOKEN_B, primaryPool_id: poolId(0x12), origin: "SV" })], T0);
    await upsertPools(db, [
      poolRec({ origin: "SV", swapCount: 0, lastSwapAt: null, createdAt: T0 }),
      poolRec({ id: poolId(0x12), token_id: TOKEN_B, origin: "SV", swapCount: 0, lastSwapAt: null, createdAt: T0 + 50_000 }),
    ], T0);
    await recomputeListedPools(db, "all", T0 + 60_000);
    expect(await svWindowClosedTokens(db, T0 + 86_399)).toEqual([]);
    expect(await svWindowClosedTokens(db, T0 + 86_400)).toEqual([TOKEN_A]);
  });
```

Edit `src/lib/chain/store.test.ts`. Inside the `describe("applyFold and loadFoldState: the launchpad …")` block Task 3 added, append:

```ts
  it("takes an unswapped SV launch off the table on the first applyFold after its 24 hours (spec 5.4)", async () => {
    await applyFold(db, result({ pools: [pool({ origin: "SV", swapCount: 0, lastSwapAt: null, createdAt: T0 })], tokens: [token({ origin: "SV" })] }), 1, T0 + 10);
    expect(await db.query("select listed_pool_id from market.tokens where id = $1", [TOKEN_A])).toEqual([{ listed_pool_id: POOL_A }]);
    // An empty batch: result()'s defaults carry a swapped pool, which would list the token again.
    await applyFold(db, result({ pools: [], tokens: [], candles: [], trades: [] }), 2, T0 + 86_400);
    expect(await db.query("select listed_pool_id from market.tokens where id = $1", [TOKEN_A])).toEqual([{ listed_pool_id: null }]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/sync/writers.test.ts src/lib/chain/store.test.ts`
Expected: FAIL. `SV_LISTING_WINDOW_SEC` and `svWindowClosedTokens` are not exported, an unswapped SV pool is never listed, and nothing takes it off the table.

- [ ] **Step 3: Write the listing rule**

Edit `src/lib/sync/writers.ts`. Replace lines 164-179 (the `LISTED_POOL` constant with its doc comment, and `recomputeListedPools`):

```ts
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

with:

```ts
/**
 * How long an SV pool with no swaps stays listed after its launch (instant launchpad design, section 5.4; DEFAULT for
 * Kobe to confirm, spec 12). Without the window, five launches per wallet per day could fill the 500-row table.
 */
export const SV_LISTING_WINDOW_SEC = 86_400;

/**
 * Spec section 6, widened by spec 5.4: the primary pool when sane and listable, else the sane listable pool with the most
 * swaps, else null. Listable is "traded", or "a launchpad pool inside its first SV_LISTING_WINDOW_SEC". `now` is the SQL
 * parameter that holds the clock, so tests set it.
 */
function listedPool(now: string): string {
  const listable = `(p.swap_count > 0 or (p.origin = 'SV' and p.created_at > ${now}::int - ${SV_LISTING_WINDOW_SEC}))`;
  return `coalesce(
  (select p.id from market.pools p where p.id = t.primary_pool_id
     and ${listable}
     and p.price_quote > 1e-24 and p.price_quote < 1e18),
  (select p.id from market.pools p where p.token_id = t.id
     and ${listable}
     and p.price_quote > 1e-24 and p.price_quote < 1e18
     order by p.swap_count desc, p.last_swap_at desc nulls last, p.id limit 1))`;
}

export async function recomputeListedPools(db: Db, tokenIds: readonly string[] | "all", now: number): Promise<number> {
  if (tokenIds !== "all" && tokenIds.length === 0) return 0;
  const [row] =
    tokenIds === "all"
      ? await db.query<{ n: unknown }>(
          `with u as (update market.tokens t set listed_pool_id = ${listedPool("$1")} returning 1) select count(*) as n from u`,
          [now],
        )
      : await db.query<{ n: unknown }>(
          `with u as (update market.tokens t set listed_pool_id = ${listedPool("$2")} where t.id = any($1::text[]) returning 1)
           select count(*) as n from u`,
          [[...tokenIds], now],
        );
  return Number(row.n);
}

/**
 * The tokens still listed through an SV pool that never traded and whose window has closed (spec 5.4). Almost always
 * empty; `applyFold` recomputes whatever it names, which is how an unswapped launch leaves the table. Backed by the
 * partial index pools_sv_unswapped.
 */
export async function svWindowClosedTokens(db: Db, now: number): Promise<string[]> {
  const rows = await db.query<{ token_id: string }>(
    `select p.token_id from market.pools p join market.tokens t on t.id = p.token_id and t.listed_pool_id = p.id
     where p.origin = 'SV' and p.swap_count = 0 and p.created_at <= $1::int - ${SV_LISTING_WINDOW_SEC}`,
    [now],
  );
  return rows.map((r) => r.token_id);
}
```

Give every caller its clock:

- `src/lib/chain/store.ts`: in the import on line 5 add `svWindowClosedTokens` (`import { dedupe, recomputeListedPools, svWindowClosedTokens, upsertPools } from "@/lib/sync/writers";`), then replace the two lines Task 3 left in `applyFold`:

  ```ts
      const tokenIds = [...new Set([...result.tokens.map((tok) => tok.id), ...result.pools.map((p) => p.tokenId), ...launchTokenIds])];
      await recomputeListedPools(t, tokenIds);
  ```

  with:

  ```ts
      // Spec 5.4: plus the SV launches whose listing window has just closed, so an unswapped one leaves the table.
      const closed = await svWindowClosedTokens(t, now);
      const tokenIds = [
        ...new Set([...result.tokens.map((tok) => tok.id), ...result.pools.map((p) => p.tokenId), ...launchTokenIds, ...closed]),
      ];
      await recomputeListedPools(t, tokenIds, now);
  ```

- `src/lib/sync/nightly.ts:118`: `r.listed = await recomputeListedPools(db, "all");` becomes `r.listed = await recomputeListedPools(db, "all", opts.now);`
- `src/lib/sync/market.ts:127`: `await recomputeListedPools(db, ids);` becomes `await recomputeListedPools(db, ids, opts.now);`
- `src/lib/seed/seed.ts:244`: `await recomputeListedPools(t, "all");` becomes `await recomputeListedPools(t, "all", opts.now());`
- `src/lib/market/dbBackend.test.ts`: replace every `recomputeListedPools(db, "all")` with `recomputeListedPools(db, "all", NOW)` (Edit with replace-all; four occurrences, lines 147, 280, 566, 672; the pools there have all traded, so the clock changes nothing for them).

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/lib/sync src/lib/chain/store.test.ts src/lib/seed src/lib/market/dbBackend.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing read tests**

Create `src/lib/market/dbBackend.launch.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LaunchRow } from "@/lib/chain/types";
import type { Db } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import { insertLaunchFees, insertLaunches } from "@/lib/launch/store";
import type { PoolRec, QuotePriceRec, QuoteRec, TokenRec } from "@/lib/sync/source";
import { recomputeListedPools, upsertPools, upsertQuotes, upsertTokens } from "@/lib/sync/writers";
import { testDb } from "@/test/db";
import { createDbBackend } from "./dbBackend";

const NOW = 1_790_000_000;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const addr = (c: string) => `0x${c.repeat(40)}`;
const poolId = (c: string) => `0x${c.repeat(64)}`;
const OLD = addr("a"), SV = addr("b"), TRADED_SV = addr("c"), CREATOR = addr("d"), PAYOUT = addr("e");
const P_OLD = poolId("a"), P_SV = poolId("b"), P_TRADED = poolId("c");
const LAUNCH_TX = poolId("f");
const SUPPLY = "1000000000000000000000000000";

const quotes: QuoteRec[] = [{ id: USDG, address: USDG, symbol: "USDG", name: "Global Dollar", decimals: 6, enabled: true }];
const prices: QuotePriceRec[] = [{ id: USDG, usdPrice: "1", updatedAt: NOW - 60, aggregator: "pinned" }];
function poolRec(id: string, token: string, over: Partial<PoolRec>): PoolRec {
  return {
    id, token_id: token, quote_id: USDG, tokenIsCurrency0: false, hooks: addr("0"), fee: 10_000, tickSpacing: 200, origin: "SV",
    createdAt: NOW - 100, priceQuote: "0.000005", tvlToken: "0", tvlQuote: "0", swapCount: 0, lastSwapAt: null,
    volumeQuoteAllTime: "0", sqrtPriceX96: null, ...over,
  };
}
function tokenRec(id: string, symbol: string, origin: string, primary: string): TokenRec {
  return {
    id, address: id, symbol, name: `${symbol} token`, decimals: 18, totalSupply: SUPPLY, holdersCount: 1, poolCount: 1, origin,
    createdAt: NOW - 100, primaryPool_id: primary, metadataLoaded: true,
  };
}
function launchRow(o: Partial<LaunchRow> = {}): LaunchRow {
  return {
    tokenId: SV, poolId: P_SV, quoteId: USDG, creator: CREATOR, payout: PAYOUT, hook: addr("0"), tokenIsCurrency0: false,
    creatorShareBps: 7000, openTick: 398_400, openingValuation: 4_995_430_000n, liquidity: 2_240_000_000_000_000_000n,
    tokensInPool: 10n ** 27n - 300n, firstBuyIn: 99_500_000n, firstBuyTokens: 19_000_000n * 10n ** 18n, routerFee: 500_000n,
    creationFee: 0n, name: "Tailor's Chalk", symbol: "CHALK", metadataUri: "ipfs://bafymeta", metadataCid: "bafymeta",
    block: 100, logIndex: 3, txHash: LAUNCH_TX, timestamp: NOW - 100, ...o,
  };
}

describe("the instant launchpad on the markets table and the token page (spec 5.4 and 5.5)", () => {
  let db: Db;
  let now = NOW;
  const backend = () => createDbBackend(db, { now: () => now });

  beforeAll(async () => {
    db = await testDb();
  });
  afterAll(() => db.end());
  beforeEach(async () => {
    clearTtlCache();
    now = NOW;
    await db.exec("delete from market.quotes; delete from market.tokens; delete from market.pools; delete from market.launches; delete from market.launch_fee_events");
    await upsertQuotes(db, quotes, prices);
    await upsertTokens(db, [tokenRec(OLD, "OLD", "LONG", P_OLD), tokenRec(SV, "CHALK", "SV", P_SV), tokenRec(TRADED_SV, "TRD", "SV", P_TRADED)], NOW);
    await upsertPools(db, [
      poolRec(P_OLD, OLD, { origin: "LONG", createdAt: NOW - 90 * 86_400, swapCount: 5, lastSwapAt: NOW - 500, tvlQuote: "1000000" }),
      poolRec(P_SV, SV, {}),
      poolRec(P_TRADED, TRADED_SV, { createdAt: NOW - 3 * 86_400, swapCount: 1, lastSwapAt: NOW - 2000 }),
    ], NOW);
    await recomputeListedPools(db, "all", NOW);
  });

  it("lists an unswapped launch and sorts it by its launch time ahead of older swapped tokens", async () => {
    expect((await backend().pairs("all")).map((p) => p.id)).toEqual([SV, OLD, TRADED_SV]);
  });

  it("takes it off the table once its 24 hours have passed, and keeps one that traded", async () => {
    now = NOW + 86_400;
    await recomputeListedPools(db, "all", now);
    expect((await backend().pairs("all")).map((p) => p.id)).toEqual([OLD, TRADED_SV]);
  });

  it("returns SV tokens in the launchpad scope", async () => {
    expect((await backend().pairs("launchpad")).map((p) => p.id)).toEqual([SV, OLD, TRADED_SV]);
  });

  it("carries the launch block on pair(id), fees reading all 0 before any collection and summed on read after, unchanged by a re-applied batch", async () => {
    await insertLaunches(db, [launchRow()], NOW);
    await db.query("update market.launches set image_cid = 'bafyimg', description = 'Chalk for tailors.', website = 'https://chalk.test' where token_id = $1", [SV]);
    const before = await backend().pair(SV);
    expect(before?.launch).toEqual({
      creator: CREATOR, payout: PAYOUT, quoteAddress: USDG, quoteDecimals: 6, tokenIsCurrency0: false, openTick: 398_400,
      openingValuation: "4995430000", firstBuyIn: "99500000", firstBuyTokens: "19000000000000000000000000", creatorShareBps: 7000,
      launchedAt: NOW - 100, launchBlock: 100, launchTx: LAUNCH_TX, hidden: false, imageCid: "bafyimg", description: "Chalk for tailors.",
      website: "https://chalk.test", x: "", telegram: "", routerFee: "500000",
      feesCollected: { tokenToPayout: "0", tokenToPlatform: "0", quoteToPayout: "0", quoteToPlatform: "0" }, feesCollectedAt: 0,
    });
    const rows = [
      { txHash: poolId("1"), logIndex: 0, tokenId: SV, payout: PAYOUT, tokenPayout: 700n, tokenPlatform: 300n, quotePayout: 7n, quotePlatform: 3n, timestamp: NOW + 10, block: 110 },
      { txHash: poolId("2"), logIndex: 4, tokenId: SV, payout: PAYOUT, tokenPayout: 70n, tokenPlatform: 30n, quotePayout: 0n, quotePlatform: 0n, timestamp: NOW + 20, block: 120 },
    ];
    await insertLaunchFees(db, rows);
    await insertLaunchFees(db, rows); // a re-applied batch inserts nothing
    const after = await backend().pair(SV);
    expect(after?.launch?.feesCollected).toEqual({ tokenToPayout: "770", tokenToPlatform: "330", quoteToPayout: "7", quoteToPlatform: "3" });
    expect(after?.launch?.feesCollectedAt).toBe(NOW + 20);
  });

  it("answers a delisted launch through its launch pool, launch block included", async () => {
    await insertLaunches(db, [launchRow()], NOW);
    now = NOW + 86_400;
    await recomputeListedPools(db, "all", now);
    const pair = await backend().pair(SV);
    expect(pair).toMatchObject({ id: SV, poolId: P_SV, origin: "SV" });
    expect(pair?.launch?.creator).toBe(CREATOR);
  });

  it("blanks the image, description and links of a hidden launch", async () => {
    await insertLaunches(db, [launchRow()], NOW);
    await db.query(
      "update market.launches set image_cid = 'bafyimg', description = 'd', website = 'https://w.test', x = 'https://x.com/a', telegram = 'https://t.me/abcde', hidden = true where token_id = $1",
      [SV],
    );
    expect((await backend().pair(SV))?.launch).toMatchObject({ hidden: true, imageCid: "", description: "", website: "", x: "", telegram: "" });
  });

  it("gives a token not launched here launch: null, and list rows no launch field at all", async () => {
    expect((await backend().pair(OLD))?.launch).toBeNull();
    expect((await backend().pairs("all")).every((p) => !("launch" in p))).toBe(true);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/lib/market/dbBackend.launch.test.ts`
Expected: FAIL. Order puts `SV` last (it has no `last_swap_at`), the launchpad scope drops SV tokens, and `pair()` carries no `launch`.

- [ ] **Step 7: Write the types, the read and the backend changes**

Edit `src/lib/types.ts`. Insert before `export interface TokenPair {` (line 65):

```ts
/**
 * A token launched here (instant launchpad design, section 5.5): the single-token response only, never the 500-row list.
 * Raw amounts are decimal strings in raw units.
 */
export type LaunchInfo = {
  creator: Address;
  payout: Address;
  quoteAddress: Address;
  quoteDecimals: number;
  tokenIsCurrency0: boolean;
  openTick: number;
  /** V', raw quote units for the whole supply, decimal string. */
  openingValuation: string;
  firstBuyIn: string;
  firstBuyTokens: string;
  creatorShareBps: number;
  /** unix seconds */
  launchedAt: number;
  launchBlock: number;
  launchTx: Hex;
  hidden: boolean;
  /** All "" when hidden. */
  imageCid: string;
  description: string;
  website: string;
  x: string;
  telegram: string;
  /** Router fee taken out of the first buy; firstBuyIn + routerFee is the gross the creator paid. */
  routerFee: string;
  /** Summed on read over market.launch_fee_events, raw units, decimal strings; all "0" before any collection. */
  feesCollected: { tokenToPayout: string; tokenToPlatform: string; quoteToPayout: string; quoteToPlatform: string };
  /** Unix seconds of the latest collection, 0 before any. */
  feesCollectedAt: number;
};

```

In `TokenPair`, after `  feeTier: string;` (its last field) add:

```ts
  /** Instant launchpad (spec 5.5): undefined on list rows, null for a token not launched here. */
  launch?: LaunchInfo | null;
```

Create `src/lib/launch/read.ts`:

```ts
import "server-only";

import type { Db } from "@/lib/db/client";
import type { Address, Hex, LaunchInfo } from "@/lib/types";

type LaunchCols = {
  creator: string; payout: string; quote_id: string; quote_decimals: number; token_is_currency0: boolean; open_tick: number;
  opening_valuation: string; first_buy_in: string; first_buy_tokens: string; router_fee: string; creator_share_bps: number;
  launched_at: number; launch_block: number; launch_tx: string; hidden: boolean;
  image_cid: string; description: string; website: string; x: string; telegram: string;
};
type FeeCols = { token_to_payout: string; token_to_platform: string; quote_to_payout: string; quote_to_platform: string; fees_collected_at: number | string };

/** numeric cast to text, so both drivers hand back the exact digits. */
const LAUNCH_SQL = `select l.creator, l.payout, l.quote_id, q.decimals as quote_decimals, l.token_is_currency0, l.open_tick,
  l.opening_valuation::text as opening_valuation, l.first_buy_in::text as first_buy_in, l.first_buy_tokens::text as first_buy_tokens,
  l.router_fee::text as router_fee, l.creator_share_bps, l.launched_at, l.launch_block, l.launch_tx, l.hidden,
  l.image_cid, l.description, l.website, l.x, l.telegram
  from market.launches l join market.quotes q on q.id = l.quote_id where l.token_id = $1`;

/** Spec 5.5 (amended 29 Sep 2026): fee totals are never stored, only summed here, served by launch_fee_events_token. */
const FEES_SQL = `select coalesce(sum(token_payout), 0)::text as token_to_payout, coalesce(sum(token_platform), 0)::text as token_to_platform,
  coalesce(sum(quote_payout), 0)::text as quote_to_payout, coalesce(sum(quote_platform), 0)::text as quote_to_platform,
  coalesce(max(ts), 0) as fees_collected_at
  from market.launch_fee_events where token_id = $1`;

/** The `launch` block of the single-token response, or null for a token not launched here. Hidden blanks the five text fields. */
export async function readLaunchInfo(db: Db, tokenId: string): Promise<LaunchInfo | null> {
  const [l] = await db.query<LaunchCols>(LAUNCH_SQL, [tokenId]);
  if (!l) return null;
  const [f] = await db.query<FeeCols>(FEES_SQL, [tokenId]);
  const shown = (value: string) => (l.hidden ? "" : value);
  return {
    creator: l.creator as Address,
    payout: l.payout as Address,
    quoteAddress: l.quote_id as Address,
    quoteDecimals: l.quote_decimals,
    tokenIsCurrency0: l.token_is_currency0,
    openTick: l.open_tick,
    openingValuation: l.opening_valuation,
    firstBuyIn: l.first_buy_in,
    firstBuyTokens: l.first_buy_tokens,
    creatorShareBps: l.creator_share_bps,
    launchedAt: l.launched_at,
    launchBlock: l.launch_block,
    launchTx: l.launch_tx as Hex,
    hidden: l.hidden,
    imageCid: shown(l.image_cid),
    description: shown(l.description),
    website: shown(l.website),
    x: shown(l.x),
    telegram: shown(l.telegram),
    routerFee: l.router_fee,
    feesCollected: {
      tokenToPayout: f!.token_to_payout,
      tokenToPlatform: f!.token_to_platform,
      quoteToPayout: f!.quote_to_payout,
      quoteToPlatform: f!.quote_to_platform,
    },
    feesCollectedAt: Number(f!.fees_collected_at),
  };
}
```

Edit `src/lib/market/dbShape.ts`. Replace lines 11-19 (the `PAIR_SELECT` doc comment and constant) with:

```ts
const PAIR_COLUMNS = `
select t.id, t.symbol, t.name, t.address, t.decimals, t.total_supply::text as total_supply, t.holders_count,
  p.id as pool_id, p.quote_id, p.origin as pool_origin, p.hooks, p.fee, p.created_at as pool_created_at,
  p.price_quote, p.tvl_token::text as tvl_token, p.tvl_quote::text as tvl_quote, p.routable,
  q.symbol as quote_symbol, q.decimals as quote_decimals, q.usd_price, q.usd_updated_at, q.aggregator`;

/** One row per listed token. numeric(78,0) columns are cast to text so both drivers hand back strings. */
export const PAIR_SELECT = `${PAIR_COLUMNS}
from market.tokens t
join market.pools p on p.id = t.listed_pool_id
join market.quotes q on q.id = p.quote_id`;

/**
 * The single-token variant (instant launchpad design, section 5.4): a launch delisted by its 24-hour window keeps its
 * page, because the fee panel lives there, so an unlisted token falls back to its launch pool. The 500-row list query
 * keeps PAIR_SELECT and does not show it.
 */
export const PAIR_ONE_SELECT = `${PAIR_COLUMNS}
from market.tokens t
left join market.launches l on l.token_id = t.id
join market.pools p on p.id = coalesce(t.listed_pool_id, l.pool_id)
join market.quotes q on q.id = p.quote_id`;
```

Edit `src/lib/market/dbBackend.ts`. Replace line 10:

```ts
import { PAIR_SELECT, pairFromRow, type PairRow } from "./dbShape";
```

with:

```ts
import { readLaunchInfo } from "@/lib/launch/read";
import { PAIR_ONE_SELECT, PAIR_SELECT, pairFromRow, type PairRow } from "./dbShape";
```

Replace lines 45-50:

```ts
const ORDER = `order by p.last_swap_at desc nulls last, p.id limit ${PAIRS_LIMIT}`;
const PAIRS_SQL: Record<PairsScope, string> = {
  all: `${PAIR_SELECT} ${ORDER}`,
  // A token's origin equals its pools' origin (the indexer keeps them equal); tokens_origin_listed carries this.
  launchpad: `${PAIR_SELECT} where t.origin in ('LONG', 'Pons') ${ORDER}`,
};
```

with:

```ts
// Spec 5.4: an unswapped launch sorts by its launch time until its first trade, so the 500-row cap cannot push it off
// during its listing window. Every other listed pool has swapped, so their order is unchanged. Backed by pools_activity.
const ORDER = `order by coalesce(p.last_swap_at, p.created_at) desc, p.id limit ${PAIRS_LIMIT}`;
const PAIRS_SQL: Record<PairsScope, string> = {
  all: `${PAIR_SELECT} ${ORDER}`,
  // A token's origin equals its pools' origin (the indexer keeps them equal); tokens_origin_listed carries this.
  launchpad: `${PAIR_SELECT} where t.origin in ('LONG', 'Pons', 'SV') ${ORDER}`,
};
```

Replace `pair` (lines 197-200):

```ts
    async pair(id) {
      const rows = await db.query<PairRow>(`${PAIR_SELECT} where t.id = $1`, [id]);
      return (await shapeRows(rows, now()))[0] ?? null;
    },
```

with:

```ts
    async pair(id) {
      const rows = await db.query<PairRow>(`${PAIR_ONE_SELECT} where t.id = $1`, [id]);
      const pair = (await shapeRows(rows, now()))[0];
      if (!pair) return null;
      // Spec 5.5: the launch block rides the single-token answer only; `/api/tokens/[address]` and the token page share it
      // through the `pair:${id}` memo, so neither needs a change.
      return { ...pair, launch: await readLaunchInfo(db, id) };
    },
```

Edit `src/lib/market/dbBackend.test.ts:177`. Replace:

```ts
    expect(await backend().pair(B)).toEqual(expected[1]);
```

with:

```ts
    expect(await backend().pair(B)).toEqual({ ...expected[1], launch: null });
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run src/lib/market src/app/api/tokens`
Expected: PASS.

- [ ] **Step 9: Write the failing Liquidity-row test**

Spec 7.3: "`InfoList`'s Liquidity row divides by 2 (`pair.liquidity / 2 / quoteUsd`), a leftover from the two-sided figure D43 replaced. Since `pair.liquidity` is now the quote side alone, the row becomes `pair.liquidity / quoteUsd`, with a test."

Edit `src/components/ActivityTabs.test.tsx`. Replace line 3:

```ts
import { fmtAmt, short } from "@/lib/format";
```

with:

```ts
import { fmtAmt, fmtUsdOrDash, short } from "@/lib/format";
```

Add inside `describe("ActivityTabs", …)`, after the "renders the hook label unlinked…" test:

```ts
  it("shows the quote-side liquidity in the quote asset without halving it (D43: liquidity is the quote side alone)", () => {
    show("info");
    const quoteUsd = pair.priceUsd / pair.priceQuote;
    expect(screen.getByText(`${fmtUsdOrDash(pair.liquidity)} · ${fmtAmt(pair.liquidity! / quoteUsd, 2)} ${pair.quote}`)).toBeTruthy();
  });
```

- [ ] **Step 10: Run it to verify it fails**

Run: `npx vitest run src/components/ActivityTabs.test.tsx`
Expected: FAIL: the row prints half the quote amount.

- [ ] **Step 11: Fix the row**

Edit `src/components/ActivityTabs.tsx:203`. Replace:

```tsx
          : `${liquidity} · ${fmtAmt(pair.liquidity / 2 / quoteUsd, 2)} ${pair.quote}`,
```

with:

```tsx
          : `${liquidity} · ${fmtAmt(pair.liquidity / quoteUsd, 2)} ${pair.quote}`,
```

- [ ] **Step 12: Run it to verify it passes, then the gates**

Run: `npx vitest run src/components/ActivityTabs.test.tsx`
Expected: PASS.
Then: `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src`. All clean.

- [ ] **Step 13: Commit**

```bash
git add src/lib/sync/writers.ts src/lib/sync/writers.test.ts src/lib/sync/nightly.ts src/lib/sync/market.ts src/lib/seed/seed.ts src/lib/chain/store.ts src/lib/chain/store.test.ts src/lib/types.ts src/lib/launch/read.ts src/lib/market/dbShape.ts src/lib/market/dbBackend.ts src/lib/market/dbBackend.test.ts src/lib/market/dbBackend.launch.test.ts src/components/ActivityTabs.tsx src/components/ActivityTabs.test.tsx
git commit -m "Launchpad: launches list for 24 hours unswapped, sort by launch time, and carry a launch block on the token response; Liquidity row no longer halves"
```

---

### Task 5: The upload route, `POST /api/launch/upload`

**Files:**
- Modify: `package.json` (dependencies `sharp` and `aws4fetch`, through `npm install`)
- Create: `src/lib/launch/fields.ts`, `src/lib/launch/fields.test.ts`
- Create: `src/lib/launch/image.ts`, `src/lib/launch/image.test.ts`
- Create: `src/lib/launch/filebase.ts`, `src/lib/launch/filebase.test.ts`
- Modify: `src/lib/social/rateLimit.ts` (an upload-only per-IP limiter), `src/lib/social/rateLimit.test.ts`
- Create: `src/app/api/launch/upload/route.ts`, `src/app/api/launch/upload/route.test.ts`

**Interfaces:**
- Consumes: `requireSession`, `clientIp` (`src/app/api/_lib/session.ts`); `failure`, `tooManyRequests` (`src/app/api/_lib/respond.ts`); `allowWrite` (`src/lib/social/rateLimit.ts:103`); `createChainClient` (`src/lib/chain/onchain.ts:53`); `getDb` (`src/lib/db/client.ts:137`); `nowSec` (`src/lib/time.ts:5`); `svLaunchpadAbi`, `LAUNCHPAD_ADDRESS` (Task 2); `uploadCounts`, `overLimit`, `recordUpload` (Task 1); `sessionHeader`, `TEST_SESSION_SECRET` (`src/test/session.ts`).
- Produces:
  ```ts
  // src/lib/launch/fields.ts (no server imports: the form uses it too)
  export const NAME_MAX_BYTES = 32; export const SYMBOL_MAX_BYTES = 11; export const DESCRIPTION_MAX_CHARS = 500;
  export const WEBSITE_MAX_CHARS = 200; export const IMAGE_MAX_BYTES = 2_097_152;
  export type LaunchFields = { name: string; symbol: string; description: string; website: string; x: string; telegram: string };
  export type LaunchFieldName = keyof LaunchFields;
  export type FieldCheck = { ok: true; fields: LaunchFields } | { ok: false; field: LaunchFieldName };
  export function utf8Bytes(s: string): number;
  export function validateFields(raw: LaunchFields): FieldCheck;
  export function metadataJson(fields: LaunchFields, imageCid: string): Uint8Array<ArrayBuffer>;
  // src/lib/launch/image.ts (server only)
  export type ImageKind = "png" | "jpeg" | "gif" | "webp";
  export function sniffImage(bytes: Uint8Array): ImageKind | null;
  export type Reencoded = { ok: true; webp: Uint8Array<ArrayBuffer> } | { ok: false; code: "bad-image" | "unreadable-image" };
  export async function reencodeImage(bytes: Uint8Array, kind: ImageKind): Promise<Reencoded>;
  // src/lib/launch/filebase.ts (server only)
  export const FILEBASE_S3_URL = "https://s3.filebase.com";
  export type FilebaseConfig = { accessKey: string; secretKey: string; bucket: string };
  export class FilebaseError extends Error {}
  export function filebaseConfig(): FilebaseConfig | null;
  export async function putObject(cfg: FilebaseConfig, key: string, body: Uint8Array<ArrayBuffer>, contentType: string, timeoutMs?: number): Promise<string>;
  export async function deleteObject(cfg: FilebaseConfig, key: string, timeoutMs?: number): Promise<void>;
  // src/lib/social/rateLimit.ts
  export const UPLOAD_CLIENT_LIMIT = 10;
  export function allowUploadClient(ip: string, now: number): boolean;
  // POST /api/launch/upload → 200 { imageCid, metadataCid, metadataUri } | { error, code } (all no-store)
  ```

Before writing the route, read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` and `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/{runtime,maxDuration}.md` (Global Constraints).

- [ ] **Step 1: Add the two dependencies**

Run: `npm install sharp@^0.35.5 aws4fetch@^1.0.20`
Expected: `package.json` gains `"aws4fetch": "^1.0.20"` and `"sharp": "^0.35.5"` under `dependencies`; `package-lock.json` changes. Next installs `sharp` 0.35.4 transitively today; the direct pin takes it to 0.35.5 or later within 0.35. `sharp` is in Next's default `serverExternalPackages`, so `next.config.ts` needs no change.

- [ ] **Step 2: Write the failing field-rule tests**

Create `src/lib/launch/fields.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { metadataJson, utf8Bytes, validateFields, type LaunchFields } from "./fields";

const OK: LaunchFields = { name: "Tailor's Chalk", symbol: "CHALK", description: "", website: "", x: "", telegram: "" };
const check = (o: Partial<LaunchFields>) => validateFields({ ...OK, ...o });

describe("validateFields (instant launchpad design, section 6)", () => {
  it("counts the name and symbol in UTF-8 bytes, as the contract does: 8 rockets fit 32 bytes, 9 do not (Review Focus 1)", () => {
    expect(utf8Bytes("🚀")).toBe(4);
    expect(check({ name: "🚀".repeat(8) })).toMatchObject({ ok: true });
    expect(check({ name: "🚀".repeat(9) })).toEqual({ ok: false, field: "name" });
    expect(check({ name: "" })).toEqual({ ok: false, field: "name" });
    expect(check({ symbol: "🚀🚀" })).toMatchObject({ ok: true });
    expect(check({ symbol: "🚀🚀🚀" })).toEqual({ ok: false, field: "symbol" });
    expect(check({ symbol: "ABCDEFGHIJKL" })).toEqual({ ok: false, field: "symbol" });
    expect(check({ symbol: "" })).toEqual({ ok: false, field: "symbol" });
  });

  it("allows a description of 500 characters with newlines, and refuses 501 or any other control character", () => {
    expect(check({ description: "a".repeat(499) + "\n" })).toMatchObject({ ok: true });
    expect(check({ description: "é".repeat(500) })).toMatchObject({ ok: true }); // characters, not bytes
    expect(check({ description: "a".repeat(501) })).toEqual({ ok: false, field: "description" });
    expect(check({ description: "tab\there" })).toEqual({ ok: false, field: "description" });
    expect(check({ description: "cr\rhere" })).toEqual({ ok: false, field: "description" });
  });

  it("takes an https website of at most 200 characters as typed, and refuses anything else", () => {
    expect(check({ website: "https://chalk.test/about" })).toMatchObject({ ok: true, fields: { website: "https://chalk.test/about" } });
    expect(check({ website: "http://chalk.test" })).toEqual({ ok: false, field: "website" });
    expect(check({ website: "chalk.test" })).toEqual({ ok: false, field: "website" });
    expect(check({ website: "https://chalk.test/" + "a".repeat(182) })).toEqual({ ok: false, field: "website" }); // 201 characters
  });

  it("stores X as https://x.com/<handle> from a handle or an x.com or twitter.com profile URL", () => {
    const x = (value: string) => check({ x: value });
    expect(x("chalk_1")).toMatchObject({ fields: { x: "https://x.com/chalk_1" } });
    expect(x("@chalk_1")).toMatchObject({ fields: { x: "https://x.com/chalk_1" } });
    expect(x("https://x.com/chalk_1")).toMatchObject({ fields: { x: "https://x.com/chalk_1" } });
    expect(x("https://twitter.com/chalk_1/")).toMatchObject({ fields: { x: "https://x.com/chalk_1" } });
    expect(x("https://www.x.com/chalk_1")).toMatchObject({ fields: { x: "https://x.com/chalk_1" } });
    expect(x("a_handle_far_too_long")).toEqual({ ok: false, field: "x" });
    expect(x("https://x.com/chalk/status/1")).toEqual({ ok: false, field: "x" });
    expect(x("https://evil.test/chalk")).toEqual({ ok: false, field: "x" });
  });

  it("stores Telegram as https://t.me/<name> from a 5 to 32 character name or a t.me URL", () => {
    const t = (value: string) => check({ telegram: value });
    expect(t("chalk")).toMatchObject({ fields: { telegram: "https://t.me/chalk" } });
    expect(t("https://t.me/chalk_group")).toMatchObject({ fields: { telegram: "https://t.me/chalk_group" } });
    expect(t("chal")).toEqual({ ok: false, field: "telegram" });
    expect(t("https://t.me/+invite")).toEqual({ ok: false, field: "telegram" });
  });

  it("reports the first failing field in form order", () => {
    expect(validateFields({ name: "", symbol: "", description: "", website: "nope", x: "", telegram: "" })).toEqual({ ok: false, field: "name" });
  });
});

describe("metadataJson (spec 6: Doppler and LONG compatible)", () => {
  it("writes the keys in order, no whitespace, empty strings kept", () => {
    const fields = { ...OK, description: "Chalk for tailors.", x: "https://x.com/chalk" };
    expect(new TextDecoder().decode(metadataJson(fields, "bafyimage"))).toBe(
      '{"name":"Tailor\'s Chalk","symbol":"CHALK","description":"Chalk for tailors.","image":"ipfs://bafyimage","website":"","x":"https://x.com/chalk","telegram":""}',
    );
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/lib/launch/fields.test.ts`
Expected: FAIL with "Failed to resolve import "./fields"".

- [ ] **Step 4: Write the field rules**

Create `src/lib/launch/fields.ts`:

```ts
/**
 * The launch's text fields (instant launchpad design, section 6's request table), shared by the upload route and the form
 * so the two can never disagree. The name and symbol are measured in UTF-8 bytes, because the contract counts bytes
 * (spec 4.5 step 4); the description and website in characters. No server import: the browser bundles this file.
 */
export const NAME_MAX_BYTES = 32;
export const SYMBOL_MAX_BYTES = 11;
export const DESCRIPTION_MAX_CHARS = 500;
export const WEBSITE_MAX_CHARS = 200;
/** Exactly 2 MiB: an image of this size is accepted, one byte more is refused. */
export const IMAGE_MAX_BYTES = 2_097_152;

export type LaunchFields = { name: string; symbol: string; description: string; website: string; x: string; telegram: string };
export type LaunchFieldName = keyof LaunchFields;
export type FieldCheck = { ok: true; fields: LaunchFields } | { ok: false; field: LaunchFieldName };

const encoder = new TextEncoder();

export function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}

/** Every C0 control character and DEL, except the newline. */
const CONTROL = /[\x00-\x09\x0B-\x1F\x7F]/;
const X_HANDLE = /^@?([A-Za-z0-9_]{1,15})$/;
const X_URL = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/;
const TG_NAME = /^@?([A-Za-z0-9_]{5,32})$/;
const TG_URL = /^https:\/\/(?:www\.)?t\.me\/([A-Za-z0-9_]{5,32})\/?$/;

function website(raw: string): string | null {
  if (raw === "") return "";
  if (raw.length > WEBSITE_MAX_CHARS || !raw.startsWith("https://")) return null;
  try {
    return new URL(raw).hostname !== "" ? raw : null;
  } catch {
    return null;
  }
}

function xProfile(raw: string): string | null {
  if (raw === "") return "";
  const handle = X_HANDLE.exec(raw)?.[1] ?? X_URL.exec(raw)?.[1];
  return handle ? `https://x.com/${handle}` : null;
}

function telegram(raw: string): string | null {
  if (raw === "") return "";
  const name = TG_NAME.exec(raw)?.[1] ?? TG_URL.exec(raw)?.[1];
  return name ? `https://t.me/${name}` : null;
}

/** The first failing field in form order, or the fields as they will be stored (links normalised). */
export function validateFields(raw: LaunchFields): FieldCheck {
  const nameBytes = utf8Bytes(raw.name);
  if (nameBytes === 0 || nameBytes > NAME_MAX_BYTES) return { ok: false, field: "name" };
  const symbolBytes = utf8Bytes(raw.symbol);
  if (symbolBytes === 0 || symbolBytes > SYMBOL_MAX_BYTES) return { ok: false, field: "symbol" };
  if ([...raw.description].length > DESCRIPTION_MAX_CHARS || CONTROL.test(raw.description)) return { ok: false, field: "description" };
  const site = website(raw.website);
  if (site === null) return { ok: false, field: "website" };
  const x = xProfile(raw.x);
  if (x === null) return { ok: false, field: "x" };
  const tg = telegram(raw.telegram);
  if (tg === null) return { ok: false, field: "telegram" };
  return { ok: true, fields: { name: raw.name, symbol: raw.symbol, description: raw.description, website: site, x, telegram: tg } };
}

/** The pinned metadata document (spec 6): keys in this order, no whitespace, empty strings kept. */
export function metadataJson(fields: LaunchFields, imageCid: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify({
      name: fields.name,
      symbol: fields.symbol,
      description: fields.description,
      image: `ipfs://${imageCid}`,
      website: fields.website,
      x: fields.x,
      telegram: fields.telegram,
    }),
  );
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run src/lib/launch/fields.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing image tests**

Create `src/lib/launch/image.test.ts`:

```ts
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { reencodeImage, sniffImage } from "./image";

let png: Buffer;
let jpeg: Buffer;
let gif: Buffer;
let webp: Buffer;
let animated: Buffer;
beforeAll(async () => {
  const square = (background: string) => sharp({ create: { width: 64, height: 48, channels: 3, background } });
  png = await square("#00ff00").png().toBuffer();
  jpeg = await square("#ff0000").jpeg().toBuffer();
  gif = await square("#0000ff").gif().toBuffer();
  webp = await square("#ffff00").webp().toBuffer();
  const red = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#ff0000" } }).png().toBuffer();
  const blue = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#0000ff" } }).png().toBuffer();
  animated = await sharp([red, blue], { join: { animated: true } }).gif().toBuffer();
});

describe("sniffImage (spec 6 step 7)", () => {
  it("recognises PNG, JPEG, GIF and WebP by their first bytes, and nothing else", () => {
    expect([sniffImage(png), sniffImage(jpeg), sniffImage(gif), sniffImage(webp)]).toEqual(["png", "jpeg", "gif", "webp"]);
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("RIFF0000WAVE"))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });
});

describe("reencodeImage (spec 6 steps 8 and 9)", () => {
  it("turns each accepted type into one 512 x 512 WebP", async () => {
    for (const [bytes, kind] of [[png, "png"], [jpeg, "jpeg"], [gif, "gif"], [webp, "webp"]] as const) {
      const out = await reencodeImage(bytes, kind);
      if (!out.ok) throw new Error(`${kind} was refused`);
      const meta = await sharp(out.webp).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["webp", 512, 512]);
    }
  });

  it("keeps one frame of an animated GIF", async () => {
    expect((await sharp(animated, { pages: -1 }).metadata()).pages).toBe(2);
    const out = await reencodeImage(animated, "gif");
    if (!out.ok) throw new Error("refused");
    expect((await sharp(out.webp, { pages: -1 }).metadata()).pages ?? 1).toBe(1);
  });

  it("drops anything appended after the image's own end", async () => {
    const payload = new TextEncoder().encode("PAYLOAD-AFTER-THE-END");
    const out = await reencodeImage(Buffer.concat([png, payload]), "png");
    if (!out.ok) throw new Error("refused");
    expect(Buffer.from(out.webp).includes(Buffer.from(payload))).toBe(false);
  });

  it("refuses a file whose magic bytes disagree with its real format, and one it cannot decode", async () => {
    const disguised = Buffer.concat([png.subarray(0, 8), jpeg]); // PNG magic, JPEG body
    expect(sniffImage(disguised)).toBe("png");
    expect(await reencodeImage(disguised, "png")).toEqual({ ok: false, code: "bad-image" });
    expect(await reencodeImage(jpeg, "png")).toEqual({ ok: false, code: "bad-image" }); // decodes, but as a JPEG
    const huge = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: "#00ff00" } }).png({ compressionLevel: 9 }).toBuffer();
    expect(await reencodeImage(huge, "png")).toEqual({ ok: false, code: "unreadable-image" }); // 64 million pixels, over the 50 million limit
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run src/lib/launch/image.test.ts`
Expected: FAIL with "Failed to resolve import "./image"".

- [ ] **Step 8: Write the image module**

Create `src/lib/launch/image.ts`:

```ts
import "server-only";

import sharp from "sharp";

/**
 * The upload route's image steps (instant launchpad design, section 6, steps 7 to 9). The browser's type and size checks
 * are a courtesy; these are the rules. SVG and every other format are refused: an SVG is a document that can run script.
 */
export type ImageKind = "png" | "jpeg" | "gif" | "webp";
export type Reencoded = { ok: true; webp: Uint8Array<ArrayBuffer> } | { ok: false; code: "bad-image" | "unreadable-image" };

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  return signature.every((value, i) => bytes[at + i] === value);
}
function ascii(bytes: Uint8Array, text: string, at = 0): boolean {
  return startsWith(bytes, [...text].map((c) => c.charCodeAt(0)), at);
}

export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (startsWith(bytes, PNG)) return "png";
  if (startsWith(bytes, JPEG)) return "jpeg";
  if (ascii(bytes, "GIF87a") || ascii(bytes, "GIF89a")) return "gif";
  if (ascii(bytes, "RIFF") && ascii(bytes, "WEBP", 8)) return "webp";
  return null;
}

/**
 * Step 8: sharp must read the same format the magic bytes claimed, or the file is refused. Step 9: one frame, rotated by
 * its EXIF orientation, centre-cropped to 512 x 512, re-encoded as WebP at quality 82. EXIF and anything appended after
 * the image's own end are gone, and an animated GIF becomes still.
 */
export async function reencodeImage(bytes: Uint8Array, kind: ImageKind): Promise<Reencoded> {
  let format: string | undefined;
  try {
    format = (await sharp(bytes).metadata()).format;
  } catch {
    return { ok: false, code: "bad-image" };
  }
  if (format !== kind) return { ok: false, code: "bad-image" };
  try {
    const out = await sharp(bytes, { pages: 1, limitInputPixels: 50_000_000 })
      .rotate()
      .resize(512, 512, { fit: "cover", position: "centre" })
      .webp({ quality: 82 })
      .toBuffer();
    return { ok: true, webp: new Uint8Array(out) };
  } catch {
    return { ok: false, code: "unreadable-image" };
  }
}
```

- [ ] **Step 9: Run it to verify it passes**

Run: `npx vitest run src/lib/launch/image.test.ts`
Expected: PASS.

- [ ] **Step 10: Write the failing Filebase tests**

Create `src/lib/launch/filebase.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilebaseError, deleteObject, filebaseConfig, putObject, type FilebaseConfig } from "./filebase";

const CFG: FilebaseConfig = { accessKey: "test-access", secretKey: "test-secret", bucket: "test-bucket" };
const CID = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";
const seen: Request[] = [];
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  seen.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    seen.push(req);
    return req.method === "PUT" ? new Response(null, { status: 200, headers: { "x-amz-meta-cid": CID } }) : new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("filebaseConfig", () => {
  it("is null unless all three server-side names are set, and never needs the gateway", () => {
    vi.stubEnv("FILEBASE_ACCESS_KEY", "a");
    vi.stubEnv("FILEBASE_SECRET_KEY", "s");
    vi.stubEnv("FILEBASE_BUCKET", "");
    expect(filebaseConfig()).toBeNull();
    vi.stubEnv("FILEBASE_BUCKET", "b");
    vi.stubEnv("FILEBASE_GATEWAY_URL", "");
    expect(filebaseConfig()).toEqual({ accessKey: "a", secretKey: "s", bucket: "b" });
  });
});

describe("putObject and deleteObject (spec 6 step 11 and the orphan phase)", () => {
  it("signs a PUT to the bucket's key with SigV4 and answers the CID Filebase returns", async () => {
    await expect(putObject(CFG, "launch/img/abc.webp", new Uint8Array([1, 2, 3]), "image/webp")).resolves.toBe(CID);
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect([req.method, req.url]).toEqual(["PUT", "https://s3.filebase.com/test-bucket/launch/img/abc.webp"]);
    expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=test-access\/\d{8}\/us-east-1\/s3\/aws4_request/);
    expect(req.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await req.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("fails with FilebaseError on a refusal, a missing CID header, or no answer, and never retries", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("no", { status: 500 }));
    await expect(putObject(CFG, "k", new Uint8Array([1]), "image/webp")).rejects.toBeInstanceOf(FilebaseError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 200 }));
    await expect(putObject(CFG, "k", new Uint8Array([1]), "image/webp")).rejects.toThrow(/no CID/);
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(putObject(CFG, "k", new Uint8Array([1]), "image/webp")).rejects.toBeInstanceOf(FilebaseError);
  });

  it("deletes a key, treating an already-missing object as deleted", async () => {
    await deleteObject(CFG, "launch/meta/abc.json");
    expect([seen[0]!.method, seen[0]!.url]).toEqual(["DELETE", "https://s3.filebase.com/test-bucket/launch/meta/abc.json"]);
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 404 }));
    await expect(deleteObject(CFG, "gone")).resolves.toBeUndefined();
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 403 }));
    await expect(deleteObject(CFG, "k")).rejects.toBeInstanceOf(FilebaseError);
  });
});
```

- [ ] **Step 11: Run it to verify it fails**

Run: `npx vitest run src/lib/launch/filebase.test.ts`
Expected: FAIL with "Failed to resolve import "./filebase"".

- [ ] **Step 12: Write the Filebase client**

Create `src/lib/launch/filebase.ts`:

```ts
import "server-only";

import { AwsClient } from "aws4fetch";

/**
 * Filebase's S3-compatible API on an IPFS bucket (instant launchpad design, section 6): a PUT pins the object and answers
 * its CID in `x-amz-meta-cid`; a DeleteObject unpins it. Signed with `aws4fetch`, a small SigV4 signer, rather than the
 * AWS SDK. Server-side keys only. `retries: 0`, because the route has one 15-second budget per PUT and aws4fetch would
 * otherwise retry a 5xx ten times.
 */
export const FILEBASE_S3_URL = "https://s3.filebase.com";
const DEFAULT_TIMEOUT_MS = 15_000;

export type FilebaseConfig = { accessKey: string; secretKey: string; bucket: string };

export class FilebaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilebaseError";
  }
}

/** The three required names, or null: the route answers 503 "not-live" and the nightly phase is skipped. Values never logged. */
export function filebaseConfig(): FilebaseConfig | null {
  const accessKey = process.env.FILEBASE_ACCESS_KEY || "";
  const secretKey = process.env.FILEBASE_SECRET_KEY || "";
  const bucket = process.env.FILEBASE_BUCKET || "";
  return accessKey && secretKey && bucket ? { accessKey, secretKey, bucket } : null;
}

function client(cfg: FilebaseConfig): AwsClient {
  return new AwsClient({ accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey, service: "s3", region: "us-east-1", retries: 0 });
}

function objectUrl(cfg: FilebaseConfig, key: string): string {
  return `${FILEBASE_S3_URL}/${encodeURIComponent(cfg.bucket)}/${key}`;
}

export async function putObject(
  cfg: FilebaseConfig,
  key: string,
  body: Uint8Array<ArrayBuffer>,
  contentType: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  let res: Response;
  try {
    res = await client(cfg).fetch(objectUrl(cfg, key), {
      method: "PUT",
      body,
      headers: { "content-type": contentType },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new FilebaseError(`PUT ${key} got no answer`);
  }
  if (!res.ok) throw new FilebaseError(`PUT ${key} answered ${res.status}`);
  const cid = res.headers.get("x-amz-meta-cid");
  if (!cid) throw new FilebaseError(`PUT ${key} answered no CID`);
  return cid;
}

export async function deleteObject(cfg: FilebaseConfig, key: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  let res: Response;
  try {
    res = await client(cfg).fetch(objectUrl(cfg, key), { method: "DELETE", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new FilebaseError(`DELETE ${key} got no answer`);
  }
  // S3 answers 204 whether or not the object existed; a 404 from a gateway in front of it means the same.
  if (!res.ok && res.status !== 404) throw new FilebaseError(`DELETE ${key} answered ${res.status}`);
}
```

- [ ] **Step 13: Run it to verify it passes**

Run: `npx vitest run src/lib/launch/filebase.test.ts`
Expected: PASS.

- [ ] **Step 14: Write the failing per-IP upload limiter test**

Edit `src/lib/social/rateLimit.test.ts`. In the import from `./rateLimit` (lines 2-13) add `UPLOAD_CLIENT_LIMIT` and `allowUploadClient` to the list, keeping it sorted as the file does:

```ts
import {
  CLIENT_LIMIT,
  MAX_KEYS,
  UPLOAD_CLIENT_LIMIT,
  WINDOW_SEC,
  WRITE_LIMIT,
  allowClient,
  allowUploadClient,
  allowWrite,
  clientLimitSize,
  pruneRateLimit,
  rateLimitSize,
  resetRateLimit,
} from "./rateLimit";
```

Append at the end of the file:

```ts
describe("allowUploadClient (instant launchpad design, section 6 step 2)", () => {
  it("allows ten uploads a minute per client IP, in a key space of its own that never spends the sign-in budget", () => {
    expect(UPLOAD_CLIENT_LIMIT).toBe(10);
    for (let i = 0; i < UPLOAD_CLIENT_LIMIT; i += 1) expect(allowUploadClient("203.0.113.9", NOW)).toBe(true);
    expect(allowUploadClient("203.0.113.9", NOW)).toBe(false);
    expect(allowUploadClient("203.0.113.10", NOW)).toBe(true);
    expect(allowClient("203.0.113.9", NOW)).toBe(true);
    expect(clientLimitSize()).toBe(1); // only the sign-in call above landed in the sign-in map
    expect(allowUploadClient("203.0.113.9", NOW + WINDOW_SEC + 1)).toBe(true);
  });
});
```

- [ ] **Step 15: Run it to verify it fails**

Run: `npx vitest run src/lib/social/rateLimit.test.ts`
Expected: FAIL: `allowUploadClient` is not a function.

- [ ] **Step 16: Write the limiter**

Edit `src/lib/social/rateLimit.ts`. After the `CLIENT_LIMIT` constant (line 20) add:

```ts

/**
 * The upload route's per-IP budget (instant launchpad design, section 6 step 2): its own map and cap, keyed `upload:<ip>`,
 * so an upload never spends the sign-in routes' `allowClient` budget. In process only, like the others; the persistent
 * per-wallet limits live in market.launch_uploads.
 */
export const UPLOAD_CLIENT_LIMIT = 10;
```

Replace line 33:

```ts
const clients: Store = { hits: new Map(), sweptAt: -Infinity };
```

with:

```ts
const clients: Store = { hits: new Map(), sweptAt: -Infinity };
const uploads: Store = { hits: new Map(), sweptAt: -Infinity };
```

After `allowClient` (line 110) add:

```ts

/** true when this upload fits the client IP's last rolling minute, and counts it. */
export function allowUploadClient(ip: string, now: number): boolean {
  return allow(uploads, `upload:${ip}`, now, UPLOAD_CLIENT_LIMIT);
}
```

In `resetRateLimit()`, after `clients.sweptAt = -Infinity;` add:

```ts
  uploads.hits.clear();
  uploads.sweptAt = -Infinity;
```

- [ ] **Step 17: Run it to verify it passes**

Run: `npx vitest run src/lib/social/rateLimit.test.ts`
Expected: PASS.

- [ ] **Step 18: Write the failing route tests**

Create `src/app/api/launch/upload/route.test.ts`:

```ts
import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { allowUploadClient, allowWrite, resetRateLimit } from "@/lib/social/rateLimit";
import { nowSec } from "@/lib/time";
import type { Address } from "@/lib/types";
import { testDb } from "@/test/db";
import { TEST_SESSION_SECRET, sessionHeader } from "@/test/session";
import { POST } from "./route";

const LAUNCHPAD = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const h = vi.hoisted(() => ({
  db: null as import("@/lib/db/client").Db | null,
  launchpad: "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a" as string | undefined,
  gate: vi.fn(),
}));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, hasDb: () => h.db !== null, getDb: () => h.db as Db };
});
vi.mock("@/lib/launch/address", () => ({
  get LAUNCHPAD_ADDRESS() {
    return h.launchpad;
  },
  hasLaunchpad: () => h.launchpad !== undefined,
}));
vi.mock("@/lib/chain/onchain", () => ({ createChainClient: () => ({ readContract: h.gate }) }));

const WALLET = `0x${"a".repeat(40)}` as Address;
const IMAGE_CID = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";
const META_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

/** Every Filebase call the route makes, with its body read, so tests can check what was pinned and that nothing was deleted. */
const calls: { method: string; url: string; body: Uint8Array }[] = [];
async function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  calls.push({ method: req.method, url: req.url, body: new Uint8Array(await req.clone().arrayBuffer()) });
  if (req.method !== "PUT") return new Response(null, { status: 204 });
  return new Response(null, { status: 200, headers: { "x-amz-meta-cid": req.url.includes("/launch/img/") ? IMAGE_CID : META_CID } });
}
const filebase = vi.fn(answer);

let db: Db;
let png: Buffer;
let animated: Buffer;
beforeAll(async () => {
  db = await testDb();
  h.db = db;
  png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#00ff00" } }).png().toBuffer();
  const red = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#ff0000" } }).png().toBuffer();
  const blue = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#0000ff" } }).png().toBuffer();
  animated = await sharp([red, blue], { join: { animated: true } }).gif().toBuffer();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", TEST_SESSION_SECRET);
  vi.stubEnv("FILEBASE_ACCESS_KEY", "test-access");
  vi.stubEnv("FILEBASE_SECRET_KEY", "test-secret");
  vi.stubEnv("FILEBASE_BUCKET", "test-bucket");
  vi.stubGlobal("fetch", filebase);
  calls.length = 0;
  filebase.mockReset();
  filebase.mockImplementation(answer);
  h.db = db;
  h.launchpad = LAUNCHPAD;
  h.gate.mockReset();
  h.gate.mockResolvedValue(true);
  resetRateLimit();
  await db.exec("delete from market.launch_uploads");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Fields = { name: string; symbol: string; description: string; website: string; x: string; telegram: string };
function form(o: Partial<Fields> & { image?: Blob | null } = {}): FormData {
  const f = new FormData();
  if (o.image !== null) f.set("image", o.image ?? new Blob([new Uint8Array(png)], { type: "image/png" }), "logo.png");
  f.set("name", o.name ?? "Tailor's Chalk");
  f.set("symbol", o.symbol ?? "CHALK");
  f.set("description", o.description ?? "Chalk for tailors.");
  f.set("website", o.website ?? "https://chalk.test");
  f.set("x", o.x ?? "@chalk");
  f.set("telegram", o.telegram ?? "");
  return f;
}
const post = (body: BodyInit | null, headers: Record<string, string> = { cookie: sessionHeader(WALLET) }) =>
  POST(new Request("http://localhost:3000/api/launch/upload", { method: "POST", body, headers }));
const refusal = async (res: Response) => ({ status: res.status, cache: res.headers.get("Cache-Control"), body: await res.json() });
async function seedRows(n: number, status = "pending"): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await db.query(
      `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, status, created_at)
       values ($1, 'i', 'm', 'ik', 'mk', 'N', 'S', $2, $3)`,
      [WALLET, status, nowSec() - 10 - i],
    );
  }
}
const rows = () => db.query<{ status: string; wallet: string; x: string; image_key: string }>("select status, wallet, x, image_key from market.launch_uploads order by id");

describe("POST /api/launch/upload, in the order of spec 6's checks", () => {
  it("1: answers 401 without a session and 503 while sessions are not configured", async () => {
    expect((await post(form(), {})).status).toBe(401);
    vi.stubEnv("SESSION_SECRET", undefined);
    expect((await post(form())).status).toBe(503);
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("2: answers 429 when the wallet's write budget or the per-IP upload budget is spent", async () => {
    for (let i = 0; i < 60; i += 1) allowWrite(WALLET, nowSec());
    expect((await post(form())).status).toBe(429);
    resetRateLimit();
    for (let i = 0; i < 10; i += 1) allowUploadClient("unknown", nowSec()); // no proxy header in tests: the "unknown" key
    expect((await post(form())).status).toBe(429);
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("3: answers 503 not-live while the launchpad or a required Filebase name is unset", async () => {
    h.launchpad = undefined;
    expect(await refusal(await post(form()))).toMatchObject({ status: 503, cache: "no-store", body: { code: "not-live" } });
    h.launchpad = LAUNCHPAD;
    vi.stubEnv("FILEBASE_BUCKET", "");
    expect(await refusal(await post(form()))).toMatchObject({ status: 503, body: { code: "not-live" } });
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("4: asks the launchpad's own isAllowedLauncher, refusing 403 on false and 503 when the read fails, never passing", async () => {
    h.gate.mockResolvedValueOnce(false);
    expect(await refusal(await post(form()))).toMatchObject({ status: 403, body: { code: "not-allowed" } });
    expect(h.gate).toHaveBeenCalledWith(expect.objectContaining({ address: LAUNCHPAD, functionName: "isAllowedLauncher", args: [WALLET] }));
    h.gate.mockRejectedValueOnce(new Error("rpc down"));
    expect(await refusal(await post(form()))).toMatchObject({ status: 503, body: { code: "gate-unavailable" } });
    expect(calls).toEqual([]);
  });

  it("5: refuses a body that is not multipart (400) or larger than 2,200,000 bytes (413)", async () => {
    const json = await post(JSON.stringify({ name: "x" }), { cookie: sessionHeader(WALLET), "content-type": "application/json" });
    expect(await refusal(json)).toMatchObject({ status: 400, body: { code: "bad-form" } });
    const big = await post(form({ image: new Blob([new Uint8Array(2_300_000)], { type: "image/png" }) }));
    expect(await refusal(big)).toMatchObject({ status: 413, body: { code: "too-large" } });
  });

  it("6: names the first bad field: a missing image, a name over 32 bytes, a bad X handle", async () => {
    expect(await refusal(await post(form({ image: null })))).toMatchObject({ status: 400, body: { code: "bad-field", error: "image" } });
    expect(await refusal(await post(form({ name: "🚀".repeat(9) })))).toMatchObject({ status: 400, body: { code: "bad-field", error: "name" } });
    expect(await refusal(await post(form({ x: "not a handle" })))).toMatchObject({ status: 400, body: { code: "bad-field", error: "x" } });
    expect(calls).toEqual([]);
  });

  it("7: accepts an image of exactly 2,097,152 bytes and refuses one byte more; refuses SVG and unknown types", async () => {
    const exact = new Uint8Array(2_097_152);
    exact.set(png);
    expect((await post(form({ image: new Blob([exact], { type: "image/png" }) }))).status).toBe(200);
    const over = new Uint8Array(2_097_153);
    over.set(png);
    expect(await refusal(await post(form({ image: new Blob([over], { type: "image/png" }) })))).toMatchObject({ status: 413, body: { code: "too-large" } });
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: "image/svg+xml" });
    expect(await refusal(await post(form({ image: svg })))).toMatchObject({ status: 415, body: { code: "bad-image" } });
  });

  it("8 and 9: refuses magic bytes that disagree with the real format (415) and an image it cannot decode (422)", async () => {
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ff0000" } }).jpeg().toBuffer();
    const disguised = new Blob([new Uint8Array(Buffer.concat([png.subarray(0, 8), jpeg]))], { type: "image/png" });
    expect(await refusal(await post(form({ image: disguised })))).toMatchObject({ status: 415, body: { code: "bad-image" } });
    const huge = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: "#00ff00" } }).png({ compressionLevel: 9 }).toBuffer();
    expect(await refusal(await post(form({ image: new Blob([new Uint8Array(huge)], { type: "image/png" }) })))).toMatchObject({
      status: 422,
      body: { code: "unreadable-image" },
    });
    expect(calls).toEqual([]);
  });

  it("10: refuses a wallet at 5 uploads this hour before pinning anything; refused rows do not count", async () => {
    await seedRows(3, "refused");
    await seedRows(4);
    expect((await post(form())).status).toBe(200); // the 5th
    calls.length = 0;
    expect(await refusal(await post(form()))).toMatchObject({ status: 429, body: { code: "upload-limit" } });
    expect(calls).toEqual([]);
  });

  it("11: answers 502 storage-failed when a PUT fails or carries no CID, and records nothing", async () => {
    filebase.mockImplementationOnce(async () => new Response("down", { status: 503 }));
    expect(await refusal(await post(form()))).toMatchObject({ status: 502, body: { code: "storage-failed" } });
    filebase.mockImplementationOnce(async () => new Response(null, { status: 200 }));
    expect(await refusal(await post(form()))).toMatchObject({ status: 502, body: { code: "storage-failed" } });
    expect(await rows()).toEqual([]);
  });

  it("12: pins the WebP under its content hash, then the metadata JSON, records one pending row and answers the CIDs", async () => {
    const res = await post(form());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ imageCid: IMAGE_CID, metadataCid: META_CID, metadataUri: `ipfs://${META_CID}` });
    expect(calls.map((c) => c.method)).toEqual(["PUT", "PUT"]);
    const [img, meta] = calls;
    const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    expect(img!.url).toBe(`https://s3.filebase.com/test-bucket/launch/img/${sha(img!.body)}.webp`);
    expect(await sharp(img!.body).metadata()).toMatchObject({ format: "webp", width: 512, height: 512 });
    expect(meta!.url).toBe(`https://s3.filebase.com/test-bucket/launch/meta/${sha(meta!.body)}.json`);
    expect(new TextDecoder().decode(meta!.body)).toBe(
      `{"name":"Tailor's Chalk","symbol":"CHALK","description":"Chalk for tailors.","image":"ipfs://${IMAGE_CID}","website":"https://chalk.test","x":"https://x.com/chalk","telegram":""}`,
    );
    expect(await rows()).toEqual([{ status: "pending", wallet: WALLET, x: "https://x.com/chalk", image_key: `launch/img/${sha(img!.body)}.webp` }]);
  });

  it("pins one still frame of an animated GIF, and nothing appended after a PNG's end", async () => {
    expect((await post(form({ image: new Blob([new Uint8Array(animated)], { type: "image/gif" }) }))).status).toBe(200);
    expect((await sharp(calls[0]!.body, { pages: -1 }).metadata()).pages ?? 1).toBe(1);
    calls.length = 0;
    const tail = new Uint8Array(Buffer.concat([png, Buffer.from("PAYLOAD-AFTER-THE-END")]));
    expect((await post(form({ image: new Blob([tail], { type: "image/png" }) }))).status).toBe(200);
    expect(Buffer.from(calls[0]!.body).includes(Buffer.from("PAYLOAD"))).toBe(false);
  });

  it("12: two parallel uploads at the limit count each other: one accepted, the other stored refused and not counted", async () => {
    await seedRows(4);
    // Hold both image PUTs until both requests have arrived there, so both have passed the unlocked read of step 10 and
    // only the locked recount of step 12 can tell them apart.
    let images = 0;
    let release: () => void = () => {};
    const bothPinning = new Promise<void>((resolve) => {
      release = resolve;
    });
    filebase.mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/launch/img/")) {
        images += 1;
        if (images === 2) release();
        await bothPinning;
      }
      return answer(input, init);
    });
    // PGlite serialises transactions on its own, so also record what each transaction issues: the lock must be there.
    const statements: string[] = [];
    const realTx = db.tx.bind(db);
    h.db = {
      ...db,
      tx: <T,>(fn: (t: Db) => Promise<T>) =>
        realTx((t) => fn({ ...t, query: (sql: string, params?: readonly unknown[]) => { statements.push(sql); return t.query(sql, params); } } as Db)),
    } as Db;
    const statuses = (await Promise.all([post(form()), post(form())])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 429]);
    expect((await rows()).map((r) => r.status).sort()).toEqual(["pending", "pending", "pending", "pending", "pending", "refused"]);
    expect(statements.filter((sql) => sql.includes("pg_advisory_xact_lock"))).toHaveLength(2);
  });

  it("12: never deletes a pinned object when the insert fails: the same key may back another upload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.db = { ...db, tx: async () => { throw new Error("insert failed"); } } as Db;
    expect((await post(form())).status).toBe(500);
    expect(calls.map((c) => c.method)).toEqual(["PUT", "PUT"]);
  });
});
```

- [ ] **Step 19: Run it to verify it fails**

Run: `npx vitest run src/app/api/launch/upload/route.test.ts`
Expected: FAIL with "Failed to resolve import "./route"".

- [ ] **Step 20: Write the route**

Create `src/app/api/launch/upload/route.ts`:

```ts
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createChainClient } from "@/lib/chain/onchain";
import { getDb } from "@/lib/db/client";
import { svLaunchpadAbi } from "@/lib/launch/abi";
import { LAUNCHPAD_ADDRESS } from "@/lib/launch/address";
import { IMAGE_MAX_BYTES, metadataJson, validateFields, type LaunchFields } from "@/lib/launch/fields";
import { filebaseConfig, putObject, type FilebaseConfig } from "@/lib/launch/filebase";
import { reencodeImage, sniffImage } from "@/lib/launch/image";
import { overLimit, recordUpload, uploadCounts } from "@/lib/launch/uploads";
import { allowUploadClient, allowWrite } from "@/lib/social/rateLimit";
import { nowSec } from "@/lib/time";
import type { Address } from "@/lib/types";
import { failure, tooManyRequests } from "../../_lib/respond";
import { clientIp, requireSession } from "../../_lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };
/** Room for the 2,097,152-byte image plus the text fields and the multipart framing (spec 6 step 5). */
const BODY_CAP = 2_200_000;
const PUT_TIMEOUT_MS = 15_000;

/** Every refusal is `{ error, code }`, never cached; `error` is a fixed phrase or a field name, never an echo of the input. */
function refuse(status: number, code: string, error: string = code): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

/** One paced server client, created once and reused across requests (spec 6 step 4). */
let gateClient: ReturnType<typeof createChainClient> | undefined;
function gate(): ReturnType<typeof createChainClient> {
  gateClient ??= createChainClient();
  return gateClient;
}

/** The body, counted as it arrives and abandoned the moment it passes `cap`: content-length is only a hint. */
async function readBody(req: Request, cap: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        // No cancel: undici rejects a cancel on a stream it has already closed ("ReadableStream is already closed"),
        // which escapes even a .catch and fails the run. Returning is enough; releaseLock runs in finally.
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};

type Pinned = { imageCid: string; metadataCid: string; imageKey: string; metadataKey: string };

/** Step 11: the WebP, then the metadata JSON naming it. Keys are content hashes, so a repeat is a harmless overwrite. No database transaction is open here. */
async function pin(storage: FilebaseConfig, webp: Uint8Array<ArrayBuffer>, fields: LaunchFields): Promise<Pinned> {
  const imageKey = `launch/img/${sha256Hex(webp)}.webp`;
  const imageCid = await putObject(storage, imageKey, webp, "image/webp", PUT_TIMEOUT_MS);
  const json = metadataJson(fields, imageCid);
  const metadataKey = `launch/meta/${sha256Hex(json)}.json`;
  const metadataCid = await putObject(storage, metadataKey, json, "application/json", PUT_TIMEOUT_MS);
  return { imageCid, metadataCid, imageKey, metadataKey };
}

/**
 * `POST /api/launch/upload` (instant launchpad design, section 6): a Suits holder's image and links, re-encoded and pinned
 * on Filebase before the launch transaction, answered as `{ imageCid, metadataCid, metadataUri }`. The checks run in the
 * spec's order: session, budgets, configuration, gate, body, fields, image, persistent limit, pins, the locked insert.
 */
export async function POST(req: Request) {
  // 1. Session.
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const wallet = session.address.toLowerCase() as Address;
  const now = nowSec();

  // 2. The in-process budgets: the wallet's write budget, and an upload-only per-IP one.
  if (!allowWrite(wallet, now) || !allowUploadClient(clientIp(req), now)) return tooManyRequests();

  // 3. Configuration. FILEBASE_GATEWAY_URL is optional and not needed here.
  const launchpad = LAUNCHPAD_ADDRESS;
  const storage = filebaseConfig();
  if (!launchpad || !storage) return refuse(503, "not-live", "launching is not live");

  // 4. The launchpad's own gate, so the server applies exactly the contract's rule. A failed read is never a pass.
  let allowed: boolean;
  try {
    allowed = await gate().readContract({ address: launchpad, abi: svLaunchpadAbi, functionName: "isAllowedLauncher", args: [wallet] });
  } catch {
    return refuse(503, "gate-unavailable", "the launcher check could not be read");
  }
  if (!allowed) return refuse(403, "not-allowed", "launching is open to Suits holders");

  // 5. Multipart, read with a running count.
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) return refuse(400, "bad-form");
  const body = await readBody(req, BODY_CAP);
  if (!body) return refuse(413, "too-large");
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    return refuse(400, "bad-form");
  }

  // 6. Field rules, the image's presence first.
  const image = form.get("image");
  if (!(image instanceof Blob) || image.size === 0) return refuse(400, "bad-field", "image");
  const checked = validateFields({
    name: text(form, "name"),
    symbol: text(form, "symbol"),
    description: text(form, "description"),
    website: text(form, "website"),
    x: text(form, "x"),
    telegram: text(form, "telegram"),
  });
  if (!checked.ok) return refuse(400, "bad-field", checked.field);

  // 7. Size and magic bytes.
  if (image.size > IMAGE_MAX_BYTES) return refuse(413, "too-large");
  const bytes = new Uint8Array(await image.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) return refuse(415, "bad-image");

  // 8 and 9. sharp agrees on the format, then one 512 x 512 WebP frame.
  const encoded = await reencodeImage(bytes, kind);
  if (!encoded.ok) return refuse(encoded.code === "bad-image" ? 415 : 422, encoded.code);

  // 10. The persistent budget, a quick unlocked read, so a wallet over its limit costs no pin.
  try {
    if (overLimit(await uploadCounts(getDb(), wallet, now))) return refuse(429, "upload-limit");
  } catch (err) {
    return failure(err);
  }

  // 11. The pins.
  let pinned: Pinned;
  try {
    pinned = await pin(storage, encoded.webp, checked.fields);
  } catch (err) {
    console.warn(`launch upload: ${err instanceof Error ? err.message : String(err)}`);
    return refuse(502, "storage-failed");
  }

  // 12. The locked recount and insert. A refused row is still written, so the nightly clean-up can remove its objects;
  // the pinned objects are never deleted here, because the same content-hash key may back another upload or a live launch.
  try {
    const status = await recordUpload(getDb(), { wallet, ...pinned, ...checked.fields }, now);
    if (status === "refused") return refuse(429, "upload-limit");
    return NextResponse.json(
      { imageCid: pinned.imageCid, metadataCid: pinned.metadataCid, metadataUri: `ipfs://${pinned.metadataCid}` },
      { headers: NO_STORE },
    );
  } catch (err) {
    return failure(err);
  }
}
```

- [ ] **Step 21: Run it to verify it passes**

Run: `npx vitest run src/app/api/launch/upload/route.test.ts`
Expected: PASS.

- [ ] **Step 22: Run the gates, the build included (this task adds a route)**

Run: `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src`, `npm run build`. All clean; the build lists `ƒ /api/launch/upload`.

- [ ] **Step 23: Commit**

```bash
git add package.json package-lock.json src/lib/launch/fields.ts src/lib/launch/fields.test.ts src/lib/launch/image.ts src/lib/launch/image.test.ts src/lib/launch/filebase.ts src/lib/launch/filebase.test.ts src/lib/social/rateLimit.ts src/lib/social/rateLimit.test.ts src/app/api/launch/upload
git commit -m "Launchpad: POST /api/launch/upload re-encodes the image and pins it and its metadata on Filebase for Suits holders"
```

---

### Task 6: The nightly orphan clean-up and the launch logos

**Files:**
- Create: `src/lib/launch/cleanup.ts`, `src/lib/launch/cleanup.test.ts`
- Modify: `src/lib/sync/nightly.ts` (phase `"uploads"` between `"holders"` and `"probe"`; `NightlyResult.uploadsDeleted`), `src/lib/sync/nightly.test.ts`
- Modify: `src/lib/sync/run.ts:8-13` (`RunOpts.uploads`), `:90` (forwarded)
- Modify: `src/lib/sync/deps.ts:54, 62-66` (`SyncDeps.uploads`), `src/lib/sync/deps.test.ts`
- Modify: `src/app/api/internal/sync/nightly/route.ts:17-23`
- Create: `src/lib/launch/gateway.ts`, `src/lib/launch/gateway.test.ts`
- Modify: `src/lib/logos/resolve.ts` (the gateway list, `LogoDeps.launchImage`, the launch stage, the launch memo), `src/lib/logos/resolve.test.ts`
- Modify: `src/app/api/tokens/[address]/logo/route.ts` (the one-hour header for a launch logo), its `route.test.ts`

**Interfaces:**
- Consumes: `cleanableUploads`, `objectNeeded`, `markUploadDeleted` (Task 1); `filebaseConfig`, `deleteObject` (Task 5); `readState` (`src/lib/sync/state.ts:19`); `createChainClient` (`src/lib/chain/onchain.ts:53`); `getDb`, `hasDb` (`src/lib/db/client.ts`).
- Produces:
  ```ts
  // src/lib/launch/cleanup.ts (server only)
  export const CLEANUP_BATCH = 200; export const UPLOAD_GRACE_SEC = 86_400; export const LAUNCH_DEADLINE_SEC = 1_200; export const READER_STALE_SEC = 3_600;
  export type UploadCleaner = { blockTimestamp(block: number): Promise<number>; deleteObject(key: string): Promise<void> };
  export type CleanupResult = { skipped: "reader-stale" | null; deleted: number; failed: number; done: boolean };
  export async function cleanUploads(db: Db, cleaner: UploadCleaner, now: number, deadlineMs: number): Promise<CleanupResult>;
  export function createUploadCleaner(): UploadCleaner | undefined;
  // src/lib/sync/nightly.ts: NightlyResult gains `uploadsDeleted: number`; runNightly's opts gain `uploads?: UploadCleaner`
  // src/lib/sync/run.ts: RunOpts gains `uploads?: UploadCleaner`;  src/lib/sync/deps.ts: SyncDeps gains `uploads?: UploadCleaner`
  // src/lib/launch/gateway.ts
  export const FILEBASE_GATEWAY_FALLBACK = "https://ipfs.filebase.io";
  export function filebaseGatewayBase(): string;
  // src/lib/logos/resolve.ts
  export type LaunchImageRow = { imageCid: string; metadataUri: string; hidden: boolean };
  export type LaunchImageRead = { ok: true; row: LaunchImageRow | null } | { ok: false };
  // LogoDeps gains launchImage(address: string): Promise<LaunchImageRead>;  ResolvedLogo.source gains "launch"
  export const LAUNCH_TTL_MS = 3_600_000;
  ```

- [ ] **Step 1: Write the failing clean-up tests**

Spec 6, "Orphans": the cut-off is measured against how far the reader has got, not the wall clock, because a launch the reader has not folded yet has not marked its upload used. The phase is skipped when the chain job's `last_ok_at` is more than one hour old; `cutoff = timestamp of the chain cursor's block − 86400 − 1200`; up to 200 rows with `status in ('pending', 'refused') and created_at < cutoff`, oldest first; each object is deleted unless another row still needs it; then the row becomes `deleted`; a failed delete leaves the row for the next night.

Create `src/lib/launch/cleanup.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Db } from "@/lib/db/client";
import { finishRun, saveCursors } from "@/lib/sync/state";
import { testDb } from "@/test/db";
import { cleanUploads, type UploadCleaner } from "./cleanup";

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(() => db.exec("delete from market.launch_uploads; delete from market.sync_state"));

const NOW = 1_790_000_000;
const CURSOR_BLOCK = 5_000;
const CURSOR_TS = NOW - 120; // the reader's cursor block is two minutes old
const CUTOFF = CURSOR_TS - 86_400 - 1_200;

type MockCleaner = { blockTimestamp: Mock<UploadCleaner["blockTimestamp"]>; deleteObject: Mock<UploadCleaner["deleteObject"]> };
function cleaner(o: Partial<MockCleaner> = {}): MockCleaner {
  return {
    blockTimestamp: vi.fn<UploadCleaner["blockTimestamp"]>(async () => CURSOR_TS),
    deleteObject: vi.fn<UploadCleaner["deleteObject"]>(async () => {}),
    ...o,
  };
}
async function reader(lastOkAt: number): Promise<void> {
  await saveCursors(db, "chain", { cursor: CURSOR_BLOCK });
  await finishRun(db, "chain", { now: lastOkAt, ok: true, rows: 0, queries: 0 });
}
async function seed(status: string, createdAt: number, meta: string, image: string): Promise<number> {
  const [row] = await db.query<{ id: number | string }>(
    `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, status, created_at)
     values ('0xc1', $1, $2, $3, $4, 'N', 'S', $5, $6) returning id`,
    [image, meta, `launch/img/${image}.webp`, `launch/meta/${meta}.json`, status, createdAt],
  );
  return Number(row!.id);
}
const statuses = async () => (await db.query<{ status: string }>("select status from market.launch_uploads order by id")).map((r) => r.status);

describe("cleanUploads (instant launchpad design, section 6, orphans)", () => {
  it("deletes the objects of pending and refused rows below the cursor-based cut-off, and marks those rows deleted", async () => {
    await reader(NOW - 60);
    await seed("pending", CUTOFF - 10, "m1", "i1");
    await seed("refused", CUTOFF - 5, "m2", "i2");
    await seed("pending", CUTOFF + 10, "m3", "i3"); // the reader may not have folded its launch yet
    const c = cleaner();
    expect(await cleanUploads(db, c, NOW, Date.now() + 60_000)).toEqual({ skipped: null, deleted: 2, failed: 0, done: true });
    expect(c.blockTimestamp).toHaveBeenCalledWith(CURSOR_BLOCK);
    expect(c.deleteObject.mock.calls.map(([key]) => key)).toEqual([
      "launch/meta/m1.json", "launch/img/i1.webp", "launch/meta/m2.json", "launch/img/i2.webp",
    ]);
    expect(await statuses()).toEqual(["deleted", "deleted", "pending"]);
  });

  it("does nothing while the chain job's last success is over an hour old", async () => {
    await reader(NOW - 3_601);
    await seed("pending", CUTOFF - 10, "m1", "i1");
    const c = cleaner();
    expect(await cleanUploads(db, c, NOW, Date.now() + 60_000)).toEqual({ skipped: "reader-stale", deleted: 0, failed: 0, done: true });
    expect(c.blockTimestamp).not.toHaveBeenCalled();
    expect(c.deleteObject).not.toHaveBeenCalled();
    expect(await statuses()).toEqual(["pending"]);
  });

  it("keeps an object another row still needs: a used row, or a fresh pending one", async () => {
    await reader(NOW - 60);
    await seed("pending", CUTOFF - 10, "m1", "i1");
    await seed("used", CUTOFF - 900, "m1", "i9"); // a live launch's metadata
    await seed("pending", CUTOFF + 50, "m7", "i1"); // a fresh upload of the same image
    const c = cleaner();
    await cleanUploads(db, c, NOW, Date.now() + 60_000);
    expect(c.deleteObject).not.toHaveBeenCalled();
    expect(await statuses()).toEqual(["deleted", "used", "pending"]);
  });

  it("leaves a row as it was when a delete fails, for the next night", async () => {
    await reader(NOW - 60);
    await seed("pending", CUTOFF - 10, "m1", "i1");
    const c = cleaner({ deleteObject: vi.fn<UploadCleaner["deleteObject"]>(async () => { throw new Error("Filebase down"); }) });
    expect(await cleanUploads(db, c, NOW, Date.now() + 60_000)).toMatchObject({ deleted: 0, failed: 1, done: true });
    expect(await statuses()).toEqual(["pending"]);
  });

  it("stops at the deadline with done false and nothing deleted", async () => {
    await reader(NOW - 60);
    await seed("pending", CUTOFF - 10, "m1", "i1");
    const c = cleaner();
    expect(await cleanUploads(db, c, NOW, Date.now() - 1)).toEqual({ skipped: null, deleted: 0, failed: 0, done: false });
    expect(c.deleteObject).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/launch/cleanup.test.ts`
Expected: FAIL with "Failed to resolve import "./cleanup"".

- [ ] **Step 3: Write the clean-up**

Create `src/lib/launch/cleanup.ts`:

```ts
import "server-only";

import { createChainClient } from "@/lib/chain/onchain";
import type { Db } from "@/lib/db/client";
import { readState } from "@/lib/sync/state";
import { deleteObject, filebaseConfig } from "./filebase";
import { cleanableUploads, markUploadDeleted, objectNeeded } from "./uploads";

/**
 * The nightly `"uploads"` phase (instant launchpad design, section 6, orphans). An upload whose launch never landed keeps
 * two pinned objects for nothing; this removes them. The cut-off follows the reader's cursor, not the wall clock: an
 * upload whose launch the reader has not folded yet is still `pending`, and deleting it would blank a live token.
 */
export const CLEANUP_BATCH = 200;
export const UPLOAD_GRACE_SEC = 86_400;
/** The form's permit and launch deadline: the longest a signed launch can wait before it lands. */
export const LAUNCH_DEADLINE_SEC = 1_200;
export const READER_STALE_SEC = 3_600;

export type UploadCleaner = {
  /** Unix seconds of a block: one RPC call per night. */
  blockTimestamp(block: number): Promise<number>;
  /** S3 DeleteObject, which unpins the CID. */
  deleteObject(key: string): Promise<void>;
};
export type CleanupResult = { skipped: "reader-stale" | null; deleted: number; failed: number; done: boolean };

export async function cleanUploads(db: Db, cleaner: UploadCleaner, now: number, deadlineMs: number): Promise<CleanupResult> {
  const chain = await readState(db, "chain");
  // A stalled reader's cursor says nothing about recent launches, so nothing is safe to judge.
  if (chain.lastOkAt === null || now - chain.lastOkAt > READER_STALE_SEC) return { skipped: "reader-stale", deleted: 0, failed: 0, done: true };
  const cutoff = (await cleaner.blockTimestamp(chain.cursor)) - UPLOAD_GRACE_SEC - LAUNCH_DEADLINE_SEC;
  const rows = await cleanableUploads(db, cutoff, CLEANUP_BATCH);
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    if (Date.now() >= deadlineMs) return { skipped: null, deleted, failed, done: false };
    try {
      if (!(await objectNeeded(db, "metadata", row.metadataCid, row.id, cutoff))) await cleaner.deleteObject(row.metadataKey);
      if (!(await objectNeeded(db, "image", row.imageCid, row.id, cutoff))) await cleaner.deleteObject(row.imageKey);
      await markUploadDeleted(db, row.id);
      deleted += 1;
    } catch (err) {
      // The row stays as it was; the next night tries again. Only the message reaches the log.
      failed += 1;
      console.warn(`nightly uploads: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // A full batch may have more behind it; but a night where every delete failed must not keep the probe waiting.
  return { skipped: null, deleted, failed, done: rows.length < CLEANUP_BATCH || deleted === 0 };
}

/** The real cleaner, or undefined while FILEBASE_ACCESS_KEY, FILEBASE_SECRET_KEY or FILEBASE_BUCKET is unset: the phase is then skipped. */
export function createUploadCleaner(): UploadCleaner | undefined {
  const storage = filebaseConfig();
  if (!storage) return undefined;
  const client = createChainClient();
  return {
    blockTimestamp: async (block) => Number((await client.getBlock({ blockNumber: BigInt(block) })).timestamp),
    deleteObject: (key) => deleteObject(storage, key),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/launch/cleanup.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing nightly and wiring tests**

Edit `src/lib/sync/nightly.test.ts`.

Replace line 8:

```ts
import { readState, saveCursors } from "./state";
```

with:

```ts
import { finishRun, readState, saveCursors } from "./state";
import type { UploadCleaner } from "@/lib/launch/cleanup";
```

The result shape gains `uploadsDeleted`. Replace every `prunedHolders: 0, queries: 0 }` with `prunedHolders: 0, uploadsDeleted: 0, queries: 0 }` (Edit with replace-all; five occurrences, the exact `toEqual` results at lines 63, 135, 152, 201 and 211).

In the test titled `stores the phase sequence "prune" then "holders" then "probe", so a crash mid-cleanup resumes at the cleanup`, replace:

```ts
    expect(phases).toEqual(["prune", "holders", "probe", ""]);
```

with:

```ts
    expect(phases).toEqual(["prune", "holders", "uploads", "probe", ""]);
```

Append inside `describe("runNightly", …)`, after its last test:

```ts
  it('runs the "uploads" phase between "holders" and "probe" when a cleaner is supplied, and skips it without one (instant launchpad, section 6)', async () => {
    await seedTokensAndPools();
    await db.exec("delete from market.launch_uploads");
    await saveCursors(db, "chain", { cursor: 5_000 });
    await finishRun(db, "chain", { now: T0 + 1000 - 60, ok: true, rows: 0, queries: 0 });
    await db.query(
      `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, status, created_at)
       values ('0xc1', 'i1', 'm1', 'launch/img/i1.webp', 'launch/meta/m1.json', 'N', 'S', 'pending', $1)`,
      [T0 + 1000 - 200_000],
    );
    const withoutCleaner = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000 });
    expect(withoutCleaner).toMatchObject({ done: true, uploadsDeleted: 0 });
    const uploads = {
      blockTimestamp: vi.fn<UploadCleaner["blockTimestamp"]>(async () => T0 + 1000),
      deleteObject: vi.fn<UploadCleaner["deleteObject"]>(async () => {}),
    };
    const result = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, uploads });
    expect(result).toMatchObject({ done: true, phase: "", uploadsDeleted: 1 });
    expect(uploads.deleteObject.mock.calls.map(([key]) => key)).toEqual(["launch/meta/m1.json", "launch/img/i1.webp"]);
  });
```

Edit `src/lib/sync/deps.test.ts`. Inside `describe("syncDeps …")`, after the "gives the market job no Quoter" test, add:

```ts
  it("gives the nightly job an upload cleaner only while the three Filebase names are set (instant launchpad, section 6)", () => {
    vi.stubEnv("DATABASE_URL", FAKE_URL);
    vi.stubEnv("FILEBASE_ACCESS_KEY", "");
    expect(syncDeps("nightly").uploads).toBeUndefined();
    vi.stubEnv("FILEBASE_ACCESS_KEY", "test-access");
    vi.stubEnv("FILEBASE_SECRET_KEY", "test-secret");
    vi.stubEnv("FILEBASE_BUCKET", "test-bucket");
    const uploads = syncDeps("nightly").uploads;
    expect(typeof uploads?.deleteObject).toBe("function");
    expect(typeof uploads?.blockTimestamp).toBe("function");
    expect(syncDeps("market").uploads).toBeUndefined();
  });
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run src/lib/sync/nightly.test.ts src/lib/sync/deps.test.ts`
Expected: FAIL: the results carry no `uploadsDeleted`, the phase list has no `"uploads"`, and `syncDeps` has no `uploads`.

- [ ] **Step 7: Wire the phase**

Edit `src/lib/sync/nightly.ts`. After line 7 (`import { pruneCandles, pruneSwaps } from "./retention";`) add:

```ts
import { cleanUploads, type UploadCleaner } from "@/lib/launch/cleanup";
```

In `NightlyResult`, replace line 20:

```ts
  prunedHolders: number; queries: number;
```

with:

```ts
  prunedHolders: number;
  /** Uploads whose objects the "uploads" phase removed this run (instant launchpad design, section 6). */
  uploadsDeleted: number;
  queries: number;
```

Replace line 23:

```ts
const PHASES = ["listed", "prune", "holders", "probe"] as const;
```

with:

```ts
const PHASES = ["listed", "prune", "holders", "uploads", "probe"] as const;
```

Replace the signature line 91:

```ts
export async function runNightly(db: Db, opts: CycleOpts & { quoter?: Quoter }): Promise<NightlyResult> {
```

with:

```ts
export async function runNightly(db: Db, opts: CycleOpts & { quoter?: Quoter; uploads?: UploadCleaner }): Promise<NightlyResult> {
```

In line 93, the initial result, replace `prunedHolders: 0, queries: 0 };` with `prunedHolders: 0, uploadsDeleted: 0, queries: 0 };`.

In the `"holders"` block, replace its closing transition (lines 163-164):

```ts
    phase = "probe";
    await saveCursors(db, "nightly", { phase, cursorText: afterId });
  }
  if (phase === "probe") {
```

with:

```ts
    phase = "uploads";
    await saveCursors(db, "nightly", { phase, cursorText: afterId });
  }
  if (phase === "uploads") {
    // Instant launchpad (design section 6): the orphan clean-up. It sits before probe for prune's reason: bounded, with
    // no cursor of its own, and it must never be starved by a probe that can take weeks. Skipped without a cleaner
    // (the Filebase names unset, and every other phase's tests).
    if (opts.uploads) {
      if (Date.now() >= opts.deadlineMs) return finish(false, "uploads");
      const cleaned = await cleanUploads(db, opts.uploads, opts.now, opts.deadlineMs);
      r.uploadsDeleted = cleaned.deleted;
      if (!cleaned.done) return finish(false, "uploads");
    }
    phase = "probe";
    await saveCursors(db, "nightly", { phase, cursorText: afterId });
  }
  if (phase === "probe") {
```

Edit `src/lib/sync/run.ts`. After line 2 (`import type { Quoter } from "@/lib/quote/quoter";`) add:

```ts
import type { UploadCleaner } from "@/lib/launch/cleanup";
```

In `RunOpts` (lines 8-13), after `  quoter?: Quoter;` add:

```ts
  /** Forwarded into runNightly's "uploads" phase; deps.ts supplies it for "nightly" when the Filebase names are set. */
  uploads?: UploadCleaner;
```

In line 90, replace `deadlineMs: Date.now() + Math.max(0, endMs - cycleStartMs), quoter: opts.quoter };` with `deadlineMs: Date.now() + Math.max(0, endMs - cycleStartMs), quoter: opts.quoter, uploads: opts.uploads };`.

Edit `src/lib/sync/deps.ts`. After line 7 (`import { createQuoter, type Quoter } from "@/lib/quote/quoter";`) add:

```ts
import { createUploadCleaner, type UploadCleaner } from "@/lib/launch/cleanup";
```

Replace line 54:

```ts
export type SyncDeps = { db: Db; source: EnvioSource; quoter?: Quoter };
```

with:

```ts
export type SyncDeps = { db: Db; source: EnvioSource; quoter?: Quoter; uploads?: UploadCleaner };
```

Replace line 65:

```ts
  return job === "nightly" ? { ...deps, quoter: createQuoter() } : deps;
```

with:

```ts
  return job === "nightly" ? { ...deps, quoter: createQuoter(), uploads: createUploadCleaner() } : deps;
```

Edit `src/app/api/internal/sync/nightly/route.ts`. Replace lines 17-23:

```ts
    const { db, source, quoter } = syncDeps("nightly");
    // One pass per invocation: the runner breaks after a nightly result, so intervalSec is never used. The window
    // fits the walk at the nightly's 120 requests a minute and stays inside maxDuration.
    const report = await runSync(db, source, {
      job: "nightly", owner: randomUUID(), now: Date.now, sleep,
      windowSec: 280, intervalSec: 280, queryBudget: 400, leaseSec: 300, quoter,
    });
```

with:

```ts
    const { db, source, quoter, uploads } = syncDeps("nightly");
    // One pass per invocation: the runner breaks after a nightly result, so intervalSec is never used. The window
    // fits the walk at the nightly's 120 requests a minute and stays inside maxDuration.
    const report = await runSync(db, source, {
      job: "nightly", owner: randomUUID(), now: Date.now, sleep,
      windowSec: 280, intervalSec: 280, queryBudget: 400, leaseSec: 300, quoter, uploads,
    });
```

- [ ] **Step 8: Run them to verify they pass**

Run: `npx vitest run src/lib/sync src/app/api/internal`
Expected: PASS.

- [ ] **Step 9: Write the failing gateway and logo tests**

Create `src/lib/launch/gateway.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILEBASE_GATEWAY_FALLBACK, filebaseGatewayBase } from "./gateway";

afterEach(() => vi.unstubAllEnvs());

describe("filebaseGatewayBase (spec 5.6)", () => {
  it("falls back to Filebase's public gateway while FILEBASE_GATEWAY_URL is unset, empty or not an https origin", () => {
    expect(FILEBASE_GATEWAY_FALLBACK).toBe("https://ipfs.filebase.io");
    vi.stubEnv("FILEBASE_GATEWAY_URL", "");
    expect(filebaseGatewayBase()).toBe(FILEBASE_GATEWAY_FALLBACK);
    vi.stubEnv("FILEBASE_GATEWAY_URL", "http://gw.example.test");
    expect(filebaseGatewayBase()).toBe(FILEBASE_GATEWAY_FALLBACK);
    vi.stubEnv("FILEBASE_GATEWAY_URL", "https://gw.example.test/ipfs");
    expect(filebaseGatewayBase()).toBe(FILEBASE_GATEWAY_FALLBACK);
  });
  it("uses the dedicated gateway's origin, trailing slashes dropped", () => {
    vi.stubEnv("FILEBASE_GATEWAY_URL", "https://maxlong.myfilebase.com/");
    expect(filebaseGatewayBase()).toBe("https://maxlong.myfilebase.com");
  });
});
```

Edit `src/lib/logos/resolve.test.ts`.

The Filebase gateway now leads every `ipfs://` list (spec 5.6). Replace line 55:

```ts
    expect(toHttpCandidates(`ipfs://${CID}`)[0]).toBe(`https://gateway.pinata.cloud/ipfs/${CID}`);
```

with:

```ts
    expect(toHttpCandidates(`ipfs://${CID}`)[0]).toBe(`https://ipfs.filebase.io/ipfs/${CID}`);
    expect(toHttpCandidates(`ipfs://${CID}`)[1]).toBe(`https://gateway.pinata.cloud/ipfs/${CID}`);
```

In the same test replace `.toHaveLength(4);` with `.toHaveLength(5);`.

Replace line 108:

```ts
    expect(d.fetchJson).toHaveBeenCalledWith(`https://gateway.pinata.cloud/ipfs/${CID}`, 5000);
```

with:

```ts
    expect(d.fetchJson).toHaveBeenCalledWith(`https://ipfs.filebase.io/ipfs/${CID}`, 5000);
```

In "fails over to the next gateway when the first one does not answer", replace lines 133-136:

```ts
    expect(fetchJson.mock.calls.map((c) => c[0])).toEqual([
      `https://gateway.pinata.cloud/ipfs/${CID}`,
      `https://dweb.link/ipfs/${CID}`,
    ]);
```

with:

```ts
    expect(fetchJson.mock.calls.map((c) => c[0])).toEqual([
      `https://ipfs.filebase.io/ipfs/${CID}`,
      `https://gateway.pinata.cloud/ipfs/${CID}`,
    ]);
```

In `MockDeps` (lines 29-33) add a field:

```ts
  launchImage: Mock<LogoDeps["launchImage"]>;
```

In `deps()` (lines 36-45), after the `readString` line add:

```ts
    launchImage: vi.fn<LogoDeps["launchImage"]>(async () => ({ ok: true, row: null })),
```

Append at the end of the file:

```ts
describe("resolveLogo: a launch made here (instant launchpad design, section 5.6)", () => {
  const SV = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
  const row = (o: Partial<{ imageCid: string; metadataUri: string; hidden: boolean }> = {}) =>
    vi.fn<LogoDeps["launchImage"]>(async () => ({ ok: true, row: { imageCid: IMAGE_CID, metadataUri: `ipfs://${CID}`, hidden: false, ...o } }));

  it("answers the launch's image on the Filebase gateway first, source launch, without asking the chain", async () => {
    const d = deps({ launchImage: row() });
    await expect(resolveLogo(SV, d)).resolves.toEqual({ logo: { candidates: gateways(IMAGE_CID), source: "launch" }, definite: true });
    expect(gateways(IMAGE_CID)[0]).toBe(`https://ipfs.filebase.io/ipfs/${IMAGE_CID}`);
    expect(d.readString).not.toHaveBeenCalled();
    expect(d.fetchJson).not.toHaveBeenCalled();
  });

  it("answers a definite no logo for a hidden launch, and never reaches DexScreener", async () => {
    const d = deps({ launchImage: row({ hidden: true }), fetchJson: vi.fn<LogoDeps["fetchJson"]>(async () => ({ pairs: [{ info: { imageUrl: "https://dd.dexscreener.com/a.png" } }] })) });
    await expect(resolveLogo(SV, d)).resolves.toEqual({ logo: null, definite: true });
    expect(d.fetchJson).not.toHaveBeenCalled();
    expect(d.readString).not.toHaveBeenCalled();
  });

  it("reads the metadata JSON's image when the launch has no image CID of its own", async () => {
    const d = deps({ launchImage: row({ imageCid: "" }), fetchJson: vi.fn<LogoDeps["fetchJson"]>(async () => ({ image: `ipfs://${IMAGE_CID}` })) });
    await expect(resolveLogo(SV, d)).resolves.toEqual({ logo: { candidates: gateways(IMAGE_CID), source: "launch" }, definite: true });
    expect(d.fetchJson).toHaveBeenCalledWith(`https://ipfs.filebase.io/ipfs/${CID}`, 5000);
  });

  it("answers no logo, uncached, when the launch row cannot be read, without falling through to DexScreener", async () => {
    const launchImage = vi.fn<LogoDeps["launchImage"]>(async () => ({ ok: false }));
    const d = deps({ launchImage, fetchJson: vi.fn<LogoDeps["fetchJson"]>(async () => ({ pairs: [{ info: { imageUrl: "https://dd.dexscreener.com/a.png" } }] })) });
    await expect(resolveLogo(SV, d)).resolves.toEqual({ logo: null, definite: false });
    expect(d.fetchJson).not.toHaveBeenCalled();
    await resolveLogo(SV, d);
    expect(launchImage).toHaveBeenCalledTimes(2); // not memoised
  });

  it("holds a launch hit for one hour, not a day, so a takedown reaches everyone within the hour", async () => {
    const launchImage = row();
    const d = deps({ launchImage });
    await resolveLogo(SV, d);
    d.now.mockReturnValue(NOW + 59 * 60_000);
    await resolveLogo(SV, d);
    expect(launchImage).toHaveBeenCalledTimes(1);
    d.now.mockReturnValue(NOW + 60 * 60_000 + 1);
    await resolveLogo(SV, d);
    expect(launchImage).toHaveBeenCalledTimes(2);
  });

  it("falls through to the existing stages for a token not launched here", async () => {
    const d = deps({ readString: answers("logo", `ipfs://${CID}`) });
    await expect(resolveLogo(BABYHOOD, d)).resolves.toEqual({ logo: { candidates: gateways(CID), source: "pons" }, definite: true });
    expect(d.launchImage).toHaveBeenCalledWith(BABYHOOD);
  });
});
```

Edit `src/app/api/tokens/[address]/logo/route.test.ts`. Inside `describe("GET /api/tokens/[address]/logo", …)` add:

```ts
  it("serves a launch logo with a one-hour cache, so hiding a launch reaches every visitor within the hour (spec 5.6)", async () => {
    resolveLogoMock.mockResolvedValue({ logo: { candidates: [A], source: "launch" }, definite: true });
    fetchMock.mockResolvedValue(image(10));
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600, s-maxage=3600");
  });
```

- [ ] **Step 10: Run them to verify they fail**

Run: `npx vitest run src/lib/launch/gateway.test.ts src/lib/logos src/app/api/tokens`
Expected: FAIL: no `./gateway`, the gateway list has four entries led by Pinata, `launchImage` is never called and a launch logo gets the week-long header.

- [ ] **Step 11: Write the gateway and the logo changes**

Create `src/lib/launch/gateway.ts`:

```ts
/**
 * The Filebase gateway the logo resolver tries first for every ipfs:// URI (instant launchpad design, section 5.6):
 * FILEBASE_GATEWAY_URL, a dedicated gateway's https origin, else Filebase's public one. Server-only by use: only the
 * resolver reads it. Not a secret.
 */
export const FILEBASE_GATEWAY_FALLBACK = "https://ipfs.filebase.io";

export function filebaseGatewayBase(): string {
  const raw = (process.env.FILEBASE_GATEWAY_URL || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^/\s]+$/.test(raw) ? raw : FILEBASE_GATEWAY_FALLBACK;
}
```

Edit `src/lib/logos/resolve.ts`.

Replace lines 3-9 (the imports):

```ts
import {
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  http,
} from "viem";
import { robinhoodChain } from "@/lib/chain";
```

with:

```ts
import {
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  http,
} from "viem";
import { robinhoodChain } from "@/lib/chain";
import { getDb, hasDb } from "@/lib/db/client";
import { filebaseGatewayBase } from "@/lib/launch/gateway";
```

Replace lines 29-38 (`IPFS_GATEWAYS` and its doc comment):

```ts
/**
 * Tried in order; the first that answers wins. Each already ends in `/ipfs/`.
 * w3s.link answers with a redirect to another gateway, which `guardedFetch` follows.
 */
export const IPFS_GATEWAYS: readonly string[] = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://dweb.link/ipfs/",
  "https://w3s.link/ipfs/",
  "https://ipfs.io/ipfs/",
];
```

with:

```ts
/**
 * Tried in order; the first that answers wins. Each already ends in `/ipfs/`. The Filebase gateway leads (instant
 * launchpad design, section 5.6): launch images are pinned there, so it answers them fastest.
 * w3s.link answers with a redirect to another gateway, which `guardedFetch` follows.
 */
export const IPFS_GATEWAYS: readonly string[] = [
  `${filebaseGatewayBase()}/ipfs/`,
  "https://gateway.pinata.cloud/ipfs/",
  "https://dweb.link/ipfs/",
  "https://w3s.link/ipfs/",
  "https://ipfs.io/ipfs/",
];
```

After `const MISS_TTL_MS = 60 * 60 * 1000;` (line 55) add:

```ts
/** A launch's logo, hit or hidden, is held for an hour, not a day: setting `hidden` must reach every visitor within the hour. */
export const LAUNCH_TTL_MS = 60 * 60 * 1000;
```

Replace lines 57-61 (`ResolvedLogo`):

```ts
export type ResolvedLogo = {
  /** Fetchable URLs, best first; the proxy route walks them until one returns an image. */
  candidates: string[];
  source: "pons" | "long" | "dexscreener";
};
```

with:

```ts
export type ResolvedLogo = {
  /** Fetchable URLs, best first; the proxy route walks them until one returns an image. */
  candidates: string[];
  source: "launch" | "pons" | "long" | "dexscreener";
};

/** A launch made here, as market.launches holds it (spec 5.6). */
export type LaunchImageRow = { imageCid: string; metadataUri: string; hidden: boolean };
/** `{ ok: false }` is a database error: the lookup answers "no logo" for this request, never cached, never falling through. */
export type LaunchImageRead = { ok: true; row: LaunchImageRow | null } | { ok: false };
```

In `LogoDeps` (lines 76-81), after `  now(): number;` add:

```ts
  /** The launch row for this token, if it was launched here. */
  launchImage(address: string): Promise<LaunchImageRead>;
```

In `defaultDeps` (lines 127-152), replace `  now: Date.now,` with:

```ts
  now: Date.now,
  async launchImage(address) {
    if (!hasDb()) return { ok: true, row: null };
    try {
      const [row] = await getDb().query<{ image_cid: string; metadata_uri: string; hidden: boolean }>(
        "select image_cid, metadata_uri, hidden from market.launches where token_id = $1",
        [address],
      );
      return { ok: true, row: row ? { imageCid: row.image_cid, metadataUri: row.metadata_uri, hidden: row.hidden } : null };
    } catch (err) {
      // Visible in the logs as well as in /api/health's `launches.error`: a missing table (migration not applied) lands here.
      console.warn(`logo: launch row unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false };
    }
  },
```

After `fromDexScreener` (ends line 332) add:

```ts

/** The launch's own image CID, else its metadata JSON's `image`, like a LONG `tokenURI` (spec 5.6's table). */
async function fromLaunchRow(row: LaunchImageRow, ctx: Ctx): Promise<ResolvedLogo | null> {
  if (row.imageCid !== "") return { candidates: toHttpCandidates(`ipfs://${row.imageCid}`), source: "launch" };
  if (row.metadataUri === "") return null;
  const doc = await fetchJsonFromCandidates(toHttpCandidates(row.metadataUri), ctx);
  if (!doc.ok) return null;
  const image = pick(doc.value, "image");
  const candidates = image ? toHttpCandidates(image) : [];
  return candidates.length > 0 ? { candidates, source: "launch" } : null;
}
```

In `resolveLogo`, replace lines 379-392:

```ts
  const ctx: Ctx = { deps: d, deadline: deadline ?? now + TOTAL_BUDGET_MS, incomplete: false };

  let logo: ResolvedLogo | null = null;
  const direct = await read(key, "logo", ctx);
  if (direct.ok && direct.value) {
    const candidates = toHttpCandidates(direct.value);
    if (candidates.length > 0) logo = { candidates, source: "pons" };
  }
  logo ??= await fromTokenUri(key, ctx);
  logo ??= await fromDexScreener(key, ctx);

  const definite = !ctx.incomplete;
  if (logo || definite) {
    remember(key, { value: logo, expires: now + (logo ? HIT_TTL_MS : MISS_TTL_MS) });
  }
  return { logo, definite };
```

with:

```ts
  const ctx: Ctx = { deps: d, deadline: deadline ?? now + TOTAL_BUDGET_MS, incomplete: false };

  // Spec 5.6: a launch made here answers from its own row first. A failed read answers "no logo" for this request only:
  // falling through could answer, and cache, a DexScreener image for a hidden launch.
  const launch = await d.launchImage(key);
  if (!launch.ok) return { logo: null, definite: false };
  if (launch.row?.hidden) {
    remember(key, { value: null, expires: now + LAUNCH_TTL_MS });
    return { logo: null, definite: true };
  }
  if (launch.row) {
    const own = await fromLaunchRow(launch.row, ctx);
    if (own) {
      remember(key, { value: own, expires: now + LAUNCH_TTL_MS });
      return { logo: own, definite: true };
    }
  }

  let logo: ResolvedLogo | null = null;
  const direct = await read(key, "logo", ctx);
  if (direct.ok && direct.value) {
    const candidates = toHttpCandidates(direct.value);
    if (candidates.length > 0) logo = { candidates, source: "pons" };
  }
  logo ??= await fromTokenUri(key, ctx);
  logo ??= await fromDexScreener(key, ctx);

  const definite = !ctx.incomplete;
  if (logo || definite) {
    remember(key, { value: logo, expires: now + (logo ? HIT_TTL_MS : MISS_TTL_MS) });
  }
  return { logo, definite };
```

Edit `src/app/api/tokens/[address]/logo/route.ts`. After the `HIT_CACHE` constant (line 17) add:

```ts
/** A launch's logo (spec 5.6): an hour at both layers, so a takedown through `hidden` reaches everyone within the hour. */
const LAUNCH_CACHE = "public, max-age=3600, s-maxage=3600";
```

In the candidate loop, replace:

```ts
        "Cache-Control": HIT_CACHE,
```

with:

```ts
        "Cache-Control": logo.source === "launch" ? LAUNCH_CACHE : HIT_CACHE,
```

- [ ] **Step 12: Run them to verify they pass, then the gates with the build (this task changes two routes)**

Run: `npx vitest run src/lib/launch src/lib/logos src/app/api/tokens src/lib/sync`
Expected: PASS.
Then: `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src`, `npm run build`. All clean.

- [ ] **Step 13: Commit**

```bash
git add src/lib/launch/cleanup.ts src/lib/launch/cleanup.test.ts src/lib/launch/gateway.ts src/lib/launch/gateway.test.ts src/lib/sync/nightly.ts src/lib/sync/nightly.test.ts src/lib/sync/run.ts src/lib/sync/deps.ts src/lib/sync/deps.test.ts src/app/api/internal/sync/nightly/route.ts src/lib/logos src/app/api/tokens/[address]/logo
git commit -m "Launchpad: the nightly clean-up unpins uploads no launch used, and launch logos resolve from their own row on the Filebase gateway"
```

---

### Task 7: Launch writes, the form's arithmetic, the upload client and the contract reads

**Files:**
- Create: `src/lib/launch/math.ts`, `src/lib/launch/math.test.ts`
- Create: `src/lib/launch.ts`, `src/lib/launch.test.ts`
- Create: `src/lib/launch/client.ts`, `src/lib/launch/client.test.ts`
- Create: `src/hooks/useLaunchpad.ts`

**Interfaces:**
- Consumes: `svLaunchpadAbi`, `LAUNCHPAD_ADDRESS` (Task 2); `LaunchFields` (Task 5); `PERMIT2_ADDRESS`, `robinhoodChain` (`src/lib/chain.ts:70, 23`); `erc20Abi` (`src/lib/swap/abi.ts:115`); `permitTypedData`, `randomNonce` (`src/lib/swap/permit.ts:32, 56`); `toBase`, `toHuman` (`src/lib/quote/math.ts:93, 106`).
- Produces:
  ```ts
  // src/lib/launch/math.ts (pure; the browser bundles it)
  export const SUPPLY = 1_000_000_000n * 10n ** 18n; export const TOKEN_DECIMALS = 18;
  export const RULE_OF_THUMB = "Buys worth about 41 % of the opening valuation double the price, plus the 1 % pool fee.";
  export const PRESET_MULTIPLIERS = [1n, 2n, 5n, 20n] as const;
  export function presetValuations(min: bigint, max: bigint): bigint[];
  export function routerFeeOf(gross: bigint, routerFeeBps: number): bigint;
  export function estimateFirstBuyTokens(gross: bigint, snapped: bigint, routerFeeBps: number): bigint;
  export function minFirstBuyTokens(estimate: bigint): bigint;
  export function capTokens(capBps: number): bigint;
  export function firstBuyCapGross(snapped: bigint, capBps: number, routerFeeBps: number): bigint | null;
  export function maxFirstBuy(balance: bigint | undefined, creationFee: bigint, capGross: bigint | null): bigint | null;
  export function shareOfSupplyPct(tokens: bigint): number;
  export function rawToNumber(raw: bigint, decimals: number): number;
  export function usdToRaw(usd: string, usdPrice: number, decimals: number): bigint | null;
  export function pricePerToken(snapped: bigint, quoteDecimals: number): number;
  export function randomSalt(): Hex;
  // src/lib/launch.ts
  export const LAUNCH_DEADLINE_SEC = 1_200;
  export type LaunchDeps = { wallet: WalletClient; publicClient: PublicClient; account: Address };
  export type LaunchInput = { name: string; symbol: string; metadataUri: string; quote: Address; valuation: bigint; firstBuy: bigint;
    minFirstBuyTokens: bigint; payout: Address; salt: Hex; creationFee: bigint };
  export type LaunchStep = "approve" | "sign" | "confirm" | "launching";
  export interface LaunchHandle { hash: Hex; confirmation: Promise<{ token: Address }> }
  export interface WriteHandle { hash: Hex; confirmation: Promise<void> }
  export class LaunchFailedError extends Error { readonly revert: string | null }
  export class LaunchRejectedError extends Error {}
  export class LaunchUnconfirmedError extends Error {}
  export const LAUNCH_MESSAGES: { rejected; unconfirmed; notLive; approveFailed; launchFallback; writeFallback };
  export function messageForRevert(name: string | null, fallback?: string): string;
  export function revertNameOf(err: unknown): string | null;
  export function mapLaunchError(err: unknown, fallback?: string): Error;
  export async function executeLaunch(input: LaunchInput, deps: LaunchDeps, onStep?: (step: LaunchStep) => void): Promise<LaunchHandle>;
  export async function collectLaunchFees(token: Address, deps: LaunchDeps): Promise<WriteHandle>;
  export async function claimOwed(currency: Address, to: Address, deps: LaunchDeps): Promise<WriteHandle>;
  export async function changePayout(token: Address, payout: Address, deps: LaunchDeps): Promise<WriteHandle>;
  // src/lib/launch/client.ts
  export type UploadAnswer = { imageCid: string; metadataCid: string; metadataUri: string };
  export class UploadError extends Error { readonly code: string }
  export const UPLOAD_REUSE_MS = 12 * 60 * 60 * 1000;
  export const UPLOAD_MESSAGES: Record<"signIn" | "limit" | "notAllowed" | "notLive" | "tooLarge" | "badImage" | "failed", string>;
  export function uploadKey(fields: LaunchFields, image: File): string;
  export async function uploadLaunchAssets(fields: LaunchFields, image: Blob, fetchImpl?: typeof fetch): Promise<UploadAnswer>;
  // src/hooks/useLaunchpad.ts
  export type LaunchSettings = { allowed?: boolean; launchesToday?: number; dailyLimit?: number; routerFeeBps?: number; creatorShareBps?: number; firstBuyCapBps?: number; hook?: Address };
  export function useLaunchSettings(account?: Address): LaunchSettings;
  export type CurrencyBounds = { min: bigint; max: bigint; creationFee: bigint };
  export function useCurrencyConfig(quote?: Address): CurrencyBounds | undefined;
  export type OpeningInput = { account?: Address; salt: Hex; name: string; symbol: string; quote?: Address; valuation: bigint | null };
  export type Opening = { token?: Address; openTick?: number; snapped?: bigint; pending: boolean };
  export function useOpening(input: OpeningInput): Opening;
  export function useTokenBalanceOf(token?: Address, account?: Address): bigint | undefined;
  export type PendingFees = { tokenFees: bigint; quoteFees: bigint; tokenToPayout: bigint; quoteToPayout: bigint; tokenToFeeWallet: bigint; quoteToFeeWallet: bigint };
  export type LaunchFees = { uncollected?: PendingFees; uncollectedFailed: boolean; owedToken?: bigint; owedQuote?: bigint; refetch(): void };
  export function useLaunchFees(token: Address, quote: Address, account?: Address): LaunchFees;
  ```

- [ ] **Step 1: Write the failing arithmetic tests**

Spec 3.4 and 7.2: net quote `y` into the pool buys `S × y / (V' + y)` tokens; the pool takes 1 % from the input and the router fee is `floor(gross × routerFeeBps / 10_000)`, so `y = 0.99 × (gross − routerFee)`; the Max button is the smaller of the balance minus the creation fee and `V' × (1/(1 − cap) − 1) / 0.99 / (1 − routerFeeBps / 10_000) × 0.999`, "which at the 20 % cap and 50 bps is about 25.4 % of `V'`"; `minFirstBuyTokens` is the estimate less 0.5 %.

Create `src/lib/launch/math.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  PRESET_MULTIPLIERS, RULE_OF_THUMB, SUPPLY, capTokens, estimateFirstBuyTokens, firstBuyCapGross, maxFirstBuy, minFirstBuyTokens,
  presetValuations, pricePerToken, randomSalt, rawToNumber, routerFeeOf, shareOfSupplyPct, usdToRaw,
} from "./math";

const USDG = (n: number) => BigInt(Math.round(n * 1_000_000)); // 6 decimals
const V = 4_995_430_000n; // $4,995.43, spec 3.2's first row

describe("presets (spec 7.2, DEFAULT: the minimum times 1, 2, 5 and 20, clamped to the maximum)", () => {
  it("multiplies the minimum and clamps to the maximum", () => {
    expect(PRESET_MULTIPLIERS).toEqual([1n, 2n, 5n, 20n]);
    expect(presetValuations(USDG(5_000), USDG(10_000_000))).toEqual([USDG(5_000), USDG(10_000), USDG(25_000), USDG(100_000)]);
    expect(presetValuations(USDG(5_000), USDG(20_000))).toEqual([USDG(5_000), USDG(10_000), USDG(20_000), USDG(20_000)]);
  });
});

describe("the first buy (spec 3.4 and 7.2)", () => {
  it("takes the router fee out of the gross, floored, exactly as SVRouter does", () => {
    expect(routerFeeOf(USDG(100), 50)).toBe(USDG(0.5));
    expect(routerFeeOf(199n, 50)).toBe(0n);
  });

  it("estimates S × y / (V' + y), y = 0.99 × (gross − router fee)", () => {
    const gross = USDG(100);
    const y = ((gross - routerFeeOf(gross, 50)) * 99n) / 100n;
    expect(estimateFirstBuyTokens(gross, V, 50)).toBe((SUPPLY * y) / (V + y));
    expect(estimateFirstBuyTokens(0n, V, 50)).toBe(0n);
    expect(estimateFirstBuyTokens(gross, 0n, 50)).toBe(0n);
  });

  it("sends the estimate less 0.5 % as the floor", () => {
    expect(minFirstBuyTokens(1_000_000n)).toBe(995_000n);
  });

  it("caps the gross near 25.4 % of V' at a 20 % cap and 50 bps, and a buy of that size stays under the cap", () => {
    const cap = firstBuyCapGross(V, 2000, 50)!;
    expect(Number(cap) / Number(V)).toBeCloseTo(0.2536, 3);
    expect(estimateFirstBuyTokens(cap, V, 50)).toBeLessThan(capTokens(2000));
    expect(capTokens(2000)).toBe(SUPPLY / 5n);
    expect(firstBuyCapGross(V, 0, 50)).toBe(0n); // 0 blocks any first buy
    expect(firstBuyCapGross(V, 10_000, 50)).toBeNull(); // no cap to stay under
  });

  it("offers the smaller of the balance less the creation fee and the cap as Max", () => {
    expect(maxFirstBuy(USDG(100), USDG(1), USDG(500))).toBe(USDG(99));
    expect(maxFirstBuy(USDG(10_000), 0n, USDG(500))).toBe(USDG(500));
    expect(maxFirstBuy(USDG(1), USDG(5), USDG(500))).toBe(0n);
    expect(maxFirstBuy(undefined, 0n, USDG(500))).toBe(USDG(500));
    expect(maxFirstBuy(USDG(7), 0n, null)).toBe(USDG(7));
    expect(maxFirstBuy(undefined, 0n, null)).toBeNull();
  });

  it("reports a share of supply in percent", () => {
    expect(shareOfSupplyPct(SUPPLY / 5n)).toBe(20);
    expect(shareOfSupplyPct(0n)).toBe(0);
  });
});

describe("display conversions", () => {
  it("turns a typed USD amount into raw quote units at the current price, rounded to the last decimal, and refuses nonsense", () => {
    expect(usdToRaw("5000", 1, 6)).toBe(USDG(5_000));
    expect(usdToRaw("1000", 250, 18)).toBe(4n * 10n ** 18n);
    expect(usdToRaw("", 1, 6)).toBeNull();
    expect(usdToRaw("0", 1, 6)).toBeNull();
    expect(usdToRaw("12", 0, 6)).toBeNull();
    expect(usdToRaw("abc", 1, 6)).toBeNull();
  });

  it("prices one whole token at V' over one billion", () => {
    expect(pricePerToken(V, 6)).toBeCloseTo(4.99543e-6, 12);
    expect(rawToNumber(V, 6)).toBeCloseTo(4995.43, 6);
  });

  it("draws a fresh 32-byte salt each time", () => {
    const a = randomSalt();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(randomSalt()).not.toBe(a);
  });

  it("states the one rule of thumb spec 3.4 allows", () => {
    expect(RULE_OF_THUMB).toBe("Buys worth about 41 % of the opening valuation double the price, plus the 1 % pool fee.");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/launch/math.test.ts`
Expected: FAIL with "Failed to resolve import "./math"".

- [ ] **Step 3: Write the arithmetic**

Create `src/lib/launch/math.ts`:

```ts
import type { Hex } from "viem";
import { toBase, toHuman } from "@/lib/quote/math";

/**
 * The launch form's arithmetic (instant launchpad design, sections 3.4 and 7.2), in raw integers. It only previews: the
 * contract snaps the valuation itself (the form reads `openingFor`), and `minFirstBuyTokens` protects the creator if a
 * setting or the currency order differs from what the form showed. USD appears only at the edges, for display.
 */
export const SUPPLY = 1_000_000_000n * 10n ** 18n;
export const TOKEN_DECIMALS = 18;
const BPS = 10_000n;
/** Spec 3.4: the only price claim the form makes. No line may say that every buyer pays the same price. */
export const RULE_OF_THUMB = "Buys worth about 41 % of the opening valuation double the price, plus the 1 % pool fee.";
/** DEFAULT (spec 12): the currency's minimum times 1, 2, 5 and 20. */
export const PRESET_MULTIPLIERS = [1n, 2n, 5n, 20n] as const;

export function presetValuations(min: bigint, max: bigint): bigint[] {
  return PRESET_MULTIPLIERS.map((k) => (min * k > max ? max : min * k));
}

/** `floor(gross × routerFeeBps / 10_000)`, exactly as SVRouter and the launchpad take it (spec 4.5 step 7). */
export function routerFeeOf(gross: bigint, routerFeeBps: number): bigint {
  return (gross * BigInt(routerFeeBps)) / BPS;
}

/** Tokens a gross first buy receives: `S × y / (V' + y)` with `y = 0.99 × (gross − routerFee)` (spec 3.4). */
export function estimateFirstBuyTokens(gross: bigint, snapped: bigint, routerFeeBps: number): bigint {
  if (gross <= 0n || snapped <= 0n) return 0n;
  const y = ((gross - routerFeeOf(gross, routerFeeBps)) * 99n) / 100n;
  return (SUPPLY * y) / (snapped + y);
}

/** The floor sent as `minFirstBuyTokens`: the estimate less 0.5 % (spec 7.2). */
export function minFirstBuyTokens(estimate: bigint): bigint {
  return (estimate * 995n) / 1000n;
}

export function capTokens(capBps: number): bigint {
  return (SUPPLY * BigInt(capBps)) / BPS;
}

/**
 * The largest gross first buy that stays under the cap: `V' × cap/(1 − cap) / 0.99 / (1 − fee) × 0.999`, floored.
 * 0 when the cap is 0 (first buys blocked); null when the cap is the whole supply, since then there is nothing to stay under.
 */
export function firstBuyCapGross(snapped: bigint, capBps: number, routerFeeBps: number): bigint | null {
  if (capBps <= 0) return 0n;
  if (capBps >= 10_000) return null;
  const c = BigInt(capBps);
  const f = BigInt(routerFeeBps);
  return (snapped * c * 100n * BPS * 999n) / ((BPS - c) * 99n * (BPS - f) * 1000n);
}

/** The Max button: the smaller of the balance less the creation fee and the cap; null when neither is known. */
export function maxFirstBuy(balance: bigint | undefined, creationFee: bigint, capGross: bigint | null): bigint | null {
  const spendable = balance === undefined ? null : balance > creationFee ? balance - creationFee : 0n;
  if (spendable === null) return capGross;
  if (capGross === null) return spendable;
  return spendable < capGross ? spendable : capGross;
}

export function shareOfSupplyPct(tokens: bigint): number {
  return Number((tokens * 1_000_000n) / SUPPLY) / 10_000;
}

/** Raw units as a plain number, for display only. */
export function rawToNumber(raw: bigint, decimals: number): number {
  return Number(toHuman(raw, decimals));
}

/**
 * A typed USD amount in raw quote units at `usdPrice` (per whole quote unit), rounded to the currency's last decimal
 * (`toFixed` rounds; beyond 18 decimals `toBase` then truncates); null for anything unusable. A requested valuation
 * only: the contract snaps it and bounds-checks it itself.
 */
export function usdToRaw(usd: string, usdPrice: number, decimals: number): bigint | null {
  const value = Number(usd);
  if (usd.trim() === "" || !Number.isFinite(value) || value <= 0 || !(usdPrice > 0)) return null;
  try {
    return toBase((value / usdPrice).toFixed(Math.min(decimals, 18)), decimals);
  } catch {
    return null;
  }
}

/** One whole token's opening price in whole quote units: V' over one billion tokens. */
export function pricePerToken(snapped: bigint, quoteDecimals: number): number {
  return rawToNumber(snapped, quoteDecimals) / 1e9;
}

/** The app's CREATE2 salt (spec 4.2): random, so nobody can predict the token address before the transaction is sequenced. */
export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/launch/math.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing wallet-write tests**

Create `src/lib/launch.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContractFunctionExecutionError, ContractFunctionRevertedError, RawContractError, UserRejectedRequestError, encodeAbiParameters,
  encodeErrorResult, encodeEventTopics, maxUint256, zeroAddress, type Hex, type Log, type PublicClient, type WalletClient,
} from "viem";
import { LAUNCHPAD_EVENTS_ABI } from "@/lib/chain/abi";
import { PERMIT2_ADDRESS } from "@/lib/chain";
import type { Address } from "@/lib/types";
import { svLaunchpadAbi } from "./launch/abi";
import {
  LAUNCH_MESSAGES, LaunchFailedError, LaunchRejectedError, LaunchUnconfirmedError, changePayout, claimOwed, collectLaunchFees,
  executeLaunch, messageForRevert, type LaunchDeps, type LaunchInput, type LaunchStep,
} from "./launch";

const h = vi.hoisted(() => ({ launchpad: "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a" as string | undefined }));
vi.mock("./launch/address", () => ({
  get LAUNCHPAD_ADDRESS() {
    return h.launchpad;
  },
  hasLaunchpad: () => h.launchpad !== undefined,
}));

const LAUNCHPAD = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a" as Address;
const ACCOUNT = "0x8888888888888888888888888888888888888888" as Address;
const OTHER = "0x9999999999999999999999999999999999999999" as Address;
const DECOY = "0x6666666666666666666666666666666666666666" as Address;
const QUOTE = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const TOKEN = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as Address;
const TX_HASH = `0x${"11".repeat(32)}` as Hex;
const APPROVE_HASH = `0x${"22".repeat(32)}` as Hex;
const SIGNATURE = `0x${"33".repeat(65)}` as Hex;
const SALT = `0x${"44".repeat(32)}` as Hex;
const NOW_SEC = 1_790_000_000;

const INPUT: LaunchInput = {
  name: "Tailor's Chalk", symbol: "CHALK", metadataUri: "ipfs://bafymeta", quote: QUOTE, valuation: 5_000_000_000n, firstBuy: 0n,
  minFirstBuyTokens: 0n, payout: ACCOUNT, salt: SALT, creationFee: 0n,
};

/** One Launched log, built with viem so the encoding is the real one; `address` defaults to the launchpad. */
function launchedLog(creator: Address = ACCOUNT, address: Address = LAUNCHPAD): Log {
  const topics = encodeEventTopics({ abi: LAUNCHPAD_EVENTS_ABI, eventName: "Launched", args: { token: TOKEN, creator, quote: QUOTE } });
  const data = encodeAbiParameters([LAUNCHPAD_EVENTS_ABI[0].inputs[3]], [{
    poolId: `0x${"cd".repeat(32)}`, payout: creator, hook: zeroAddress, tokenIsCurrency0: false, openTick: 398_400,
    openingValuation: 4_995_430_000n, liquidity: 1n, tokensInPool: 1n, firstBuyIn: 0n, firstBuyTokens: 0n, routerFee: 0n,
    creationFee: 0n, creatorShareBps: 7000, name: "Tailor's Chalk", symbol: "CHALK", metadataUri: "ipfs://bafymeta",
  }]);
  return {
    address, topics: topics as [Hex, ...Hex[]], data, blockHash: `0x${"00".repeat(32)}`, blockNumber: 77n, logIndex: 0,
    transactionHash: TX_HASH, transactionIndex: 0, removed: false,
  };
}

function reverted(errorName: string, args?: readonly unknown[]): Error {
  const data = encodeErrorResult({ abi: svLaunchpadAbi, errorName, args } as Parameters<typeof encodeErrorResult>[0]);
  return new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: svLaunchpadAbi, data, functionName: "launch" }), {
    abi: svLaunchpadAbi, functionName: "launch", args: [],
  });
}

function harness(o: { allowance?: bigint; logs?: Log[]; status?: "success" | "reverted" } = {}) {
  const readContract = vi.fn().mockResolvedValue(o.allowance ?? 0n);
  const simulateContract = vi.fn().mockResolvedValue({ request: {} });
  const writeContract = vi.fn(async ({ functionName }: { functionName: string; args: readonly unknown[] }) => (functionName === "approve" ? APPROVE_HASH : TX_HASH));
  const signTypedData = vi.fn().mockResolvedValue(SIGNATURE);
  const waitForTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) =>
    hash === APPROVE_HASH ? { status: "success", logs: [], blockNumber: 70n } : { status: o.status ?? "success", logs: o.logs ?? [launchedLog()], blockNumber: 77n },
  );
  const getTransaction = vi.fn().mockResolvedValue({ from: ACCOUNT, to: LAUNCHPAD, input: "0xabcdef", value: 0n });
  const call = vi.fn().mockResolvedValue({ data: "0x" });
  const deps: LaunchDeps = {
    wallet: { writeContract, signTypedData } as unknown as WalletClient,
    publicClient: { readContract, simulateContract, waitForTransactionReceipt, getTransaction, call } as unknown as PublicClient,
    account: ACCOUNT,
  };
  return { deps, readContract, simulateContract, writeContract, signTypedData, waitForTransactionReceipt, getTransaction, call };
}

beforeEach(() => {
  h.launchpad = LAUNCHPAD;
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("executeLaunch (spec 7.2, submit steps 3 to 6)", () => {
  it("sends a free launch with a zeroed permit and an empty signature, simulating first, and reads the token from our Launched", async () => {
    const t = harness({ logs: [launchedLog(OTHER), launchedLog()] }); // another creator's launch in the same block comes first
    const steps: LaunchStep[] = [];
    const handle = await executeLaunch(INPUT, t.deps, (s) => steps.push(s));
    expect(handle.hash).toBe(TX_HASH);
    expect(t.readContract).not.toHaveBeenCalled(); // no allowance: nothing is pulled
    expect(t.signTypedData).not.toHaveBeenCalled();
    const { name, symbol, metadataUri, quote, valuation, firstBuy, minFirstBuyTokens, payout, salt } = INPUT;
    const args = [
      { name, symbol, metadataUri, quote, valuation, firstBuy, minFirstBuyTokens, payout, salt, deadline: BigInt(NOW_SEC + 1200) },
      { permitted: { token: zeroAddress, amount: 0n }, nonce: 0n, deadline: 0n },
      "0x",
    ];
    expect(t.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ address: LAUNCHPAD, functionName: "launch", args, account: ACCOUNT }));
    expect(t.writeContract).toHaveBeenCalledWith(expect.objectContaining({ address: LAUNCHPAD, functionName: "launch", args, account: ACCOUNT }));
    expect(t.simulateContract.mock.invocationCallOrder[0]!).toBeLessThan(t.writeContract.mock.invocationCallOrder[0]!);
    expect(steps).toEqual(["confirm", "launching"]);
    await expect(handle.confirmation).resolves.toEqual({ token: TOKEN });
  });

  it("approves Permit2 for the maximum when the allowance is short, then signs exactly first buy plus creation fee to the launchpad", async () => {
    const t = harness({ allowance: 10n });
    const steps: LaunchStep[] = [];
    await executeLaunch({ ...INPUT, firstBuy: 100_000_000n, minFirstBuyTokens: 5n, creationFee: 2_000_000n }, t.deps, (s) => steps.push(s));
    expect(t.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: QUOTE, functionName: "allowance", args: [ACCOUNT, PERMIT2_ADDRESS] }));
    expect(t.writeContract.mock.calls[0]![0]).toMatchObject({ address: QUOTE, functionName: "approve", args: [PERMIT2_ADDRESS, maxUint256] });
    expect(t.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: APPROVE_HASH });
    const typed = t.signTypedData.mock.calls[0]![0];
    expect(typed.message).toMatchObject({ permitted: { token: QUOTE, amount: 102_000_000n }, spender: LAUNCHPAD, deadline: BigInt(NOW_SEC + 1200) });
    const [, permit, signature] = t.writeContract.mock.calls[1]![0].args;
    expect(permit).toEqual({ permitted: { token: QUOTE, amount: 102_000_000n }, nonce: typed.message.nonce, deadline: BigInt(NOW_SEC + 1200) });
    expect(signature).toBe(SIGNATURE);
    expect(steps).toEqual(["approve", "sign", "confirm", "launching"]);
  });

  it("skips the approval when the allowance already covers the total", async () => {
    const t = harness({ allowance: maxUint256 });
    const steps: LaunchStep[] = [];
    await executeLaunch({ ...INPUT, firstBuy: 1n }, t.deps, (s) => steps.push(s));
    expect(t.writeContract).toHaveBeenCalledTimes(1);
    expect(steps).toEqual(["sign", "confirm", "launching"]);
  });

  it("maps a simulated revert to spec 7.2's message and never opens the wallet", async () => {
    const t = harness();
    t.simulateContract.mockRejectedValueOnce(reverted("DailyLimitReached"));
    const err = await executeLaunch(INPUT, t.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaunchFailedError);
    expect((err as LaunchFailedError).message).toBe("You have used today's launches.");
    expect((err as LaunchFailedError).revert).toBe("DailyLimitReached");
    expect(t.writeContract).not.toHaveBeenCalled();
  });

  it("names PoolAlreadyInitialized, bubbled up from the PoolManager, so the form can draw a new salt", async () => {
    const t = harness();
    t.simulateContract.mockRejectedValueOnce(reverted("PoolAlreadyInitialized"));
    await expect(executeLaunch(INPUT, t.deps)).rejects.toMatchObject({
      revert: "PoolAlreadyInitialized",
      message: "Someone opened this token's pool first. A new address is ready; press Launch again.",
    });
  });

  it("maps a dismissed wallet to LaunchRejectedError", async () => {
    const t = harness({ allowance: maxUint256 });
    t.signTypedData.mockRejectedValueOnce(new UserRejectedRequestError(new Error("User rejected the request.")));
    await expect(executeLaunch({ ...INPUT, firstBuy: 1n }, t.deps)).rejects.toThrow(new LaunchRejectedError(LAUNCH_MESSAGES.rejected));
  });

  it("replays a mined revert with eth_call at its block, same sender, data and value, and decodes the reason from the replay", async () => {
    const t = harness({ status: "reverted" });
    t.call.mockRejectedValueOnce(new RawContractError({ data: encodeErrorResult({ abi: svLaunchpadAbi, errorName: "FirstBuyTooSmall", args: [1n, 2n] }) }));
    const handle = await executeLaunch(INPUT, t.deps);
    await expect(handle.confirmation).rejects.toMatchObject({
      name: "LaunchFailedError", revert: "FirstBuyTooSmall", message: "The first buy would get fewer tokens than shown. Review and try again.",
    });
    expect(t.call).toHaveBeenCalledWith({ account: ACCOUNT, to: LAUNCHPAD, data: "0xabcdef", value: 0n, blockNumber: 77n });
  });

  it("says it could not confirm, never that nothing was spent, when the receipt cannot be read", async () => {
    const t = harness();
    t.waitForTransactionReceipt.mockRejectedValueOnce(new Error("timeout"));
    const handle = await executeLaunch(INPUT, t.deps);
    await expect(handle.confirmation).rejects.toBeInstanceOf(LaunchUnconfirmedError);
  });

  it("ignores a Launched emitted by another contract, and fails when none is ours", async () => {
    const t = harness({ logs: [launchedLog(ACCOUNT, DECOY)] });
    const handle = await executeLaunch(INPUT, t.deps);
    await expect(handle.confirmation).rejects.toThrow(LAUNCH_MESSAGES.launchFallback);
  });

  it("refuses to run before the launchpad is live", async () => {
    h.launchpad = undefined;
    await expect(executeLaunch(INPUT, harness().deps)).rejects.toThrow(LAUNCH_MESSAGES.notLive);
  });
});

describe("the fee panel's writes (spec 7.3)", () => {
  it("collects, claims to a chosen address and changes the payout, each simulated first and confirmed by its receipt", async () => {
    const t = harness();
    await (await collectLaunchFees(TOKEN, t.deps)).confirmation;
    await (await claimOwed(QUOTE, OTHER, t.deps)).confirmation;
    await (await changePayout(TOKEN, OTHER, t.deps)).confirmation;
    expect(t.writeContract.mock.calls.map(([c]) => [c.functionName, c.args])).toEqual([
      ["collectFees", [TOKEN]],
      ["claim", [QUOTE, OTHER]],
      ["setPayout", [TOKEN, OTHER]],
    ]);
    expect(t.simulateContract).toHaveBeenCalledTimes(3);
  });

  it("maps the panel's own reverts to plain words", async () => {
    const t = harness();
    t.simulateContract.mockRejectedValueOnce(reverted("NothingToCollect"));
    await expect(collectLaunchFees(TOKEN, t.deps)).rejects.toThrow("Nothing to collect yet.");
    expect(messageForRevert("NothingOwed", LAUNCH_MESSAGES.writeFallback)).toBe("Nothing is owed to this wallet.");
    expect(messageForRevert("NotPayout", LAUNCH_MESSAGES.writeFallback)).toBe("Only the current payout address can change it.");
    expect(messageForRevert("SomethingNew", LAUNCH_MESSAGES.writeFallback)).toBe(LAUNCH_MESSAGES.writeFallback);
    expect(messageForRevert(null)).toBe("Launch failed. Nothing was spent except gas.");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/lib/launch.test.ts`
Expected: FAIL with "Failed to resolve import "./launch"". (`src/lib/launch.ts` and the `src/lib/launch/` folder coexist exactly as `src/lib/swap.ts` and `src/lib/swap/` do: the file wins for `@/lib/launch`.)

- [ ] **Step 7: Write the wallet writes**

Create `src/lib/launch.ts`:

```ts
import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  decodeErrorResult,
  isAddressEqual,
  maxUint256,
  parseEventLogs,
  zeroAddress,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { PERMIT2_ADDRESS, robinhoodChain } from "./chain";
import { svLaunchpadAbi } from "./launch/abi";
import { LAUNCHPAD_ADDRESS } from "./launch/address";
import { erc20Abi } from "./swap/abi";
import { permitTypedData, randomNonce } from "./swap/permit";
import type { Address } from "./types";

/**
 * Every launchpad wallet write (instant launchpad design, sections 7.2 and 7.3), the mirror of `src/lib/swap.ts`, with one
 * difference: each write is simulated before the wallet opens, so a revert is shown by name before anything is signed.
 * A write that reached the chain and reverted is replayed with `eth_call` at its block, because a receipt carries no reason.
 */

/** The permit's and the launch's deadline: 20 minutes, which the nightly clean-up also allows for (spec 6). */
export const LAUNCH_DEADLINE_SEC = 1_200;

export type LaunchDeps = { wallet: WalletClient; publicClient: PublicClient; account: Address };
export type LaunchInput = {
  name: string; symbol: string; metadataUri: string; quote: Address; valuation: bigint; firstBuy: bigint;
  minFirstBuyTokens: bigint; payout: Address; salt: Hex; creationFee: bigint;
};
export type LaunchStep = "approve" | "sign" | "confirm" | "launching";
export interface LaunchHandle {
  hash: Hex;
  confirmation: Promise<{ token: Address }>;
}
export interface WriteHandle {
  hash: Hex;
  confirmation: Promise<void>;
}

export class LaunchFailedError extends Error {
  readonly revert: string | null;
  constructor(message: string, revert: string | null = null) {
    super(message);
    this.name = "LaunchFailedError";
    this.revert = revert;
  }
}
/** The user dismissed the wallet. Nothing was signed and nothing was sent. */
export class LaunchRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchRejectedError";
  }
}
/** Sent, but its outcome could not be read. It may have succeeded: never tell the user nothing was spent. */
export class LaunchUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchUnconfirmedError";
  }
}

export const LAUNCH_MESSAGES = {
  rejected: "Cancelled in wallet. Nothing was spent.",
  unconfirmed: "Sent, but we could not confirm it. Check the transaction before trying again.",
  notLive: "Launching is not live yet.",
  approveFailed: "Could not approve the currency. Nothing was spent except gas.",
  launchFallback: "Launch failed. Nothing was spent except gas.",
  writeFallback: "That did not go through. Nothing was spent except gas.",
} as const;

/** Spec 7.2's error table, plus the fee panel's own reverts (7.3). */
const REVERT_MESSAGES: Readonly<Record<string, string>> = {
  PoolAlreadyInitialized: "Someone opened this token's pool first. A new address is ready; press Launch again.",
  DailyLimitReached: "You have used today's launches.",
  NotAllowedToLaunch: "Launching is open to Suits holders.",
  FirstBuyTooLarge: "The first buy is above the cap. Lower it and try again.",
  FirstBuyTooSmall: "The first buy would get fewer tokens than shown. Review and try again.",
  BadPayout: "That payout address cannot receive fees. Choose another.",
  PermitMismatch: "The fees changed. Review and try again.",
  Expired: "The launch expired before it was sent. Try again.",
  NothingToCollect: "Nothing to collect yet.",
  NothingOwed: "Nothing is owed to this wallet.",
  NotPayout: "Only the current payout address can change it.",
  ZeroAddress: "Enter an address.",
};

export function messageForRevert(name: string | null, fallback: string = LAUNCH_MESSAGES.launchFallback): string {
  return (name !== null && REVERT_MESSAGES[name]) || fallback;
}

function decodeName(data: Hex): string | null {
  try {
    return decodeErrorResult({ abi: svLaunchpadAbi, data }).errorName;
  } catch {
    return null;
  }
}

/** The innermost named revert: viem's decoded one from a simulation, or raw revert data from a replay's `eth_call`. */
export function revertNameOf(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    if (reverted.data?.errorName) return reverted.data.errorName;
    if (reverted.raw) return decodeName(reverted.raw);
  }
  const holder = err.walk((e) => {
    const data = (e as { data?: unknown }).data;
    return typeof data === "string" || (typeof data === "object" && data !== null && typeof (data as { data?: unknown }).data === "string");
  }) as { data?: unknown } | null;
  const raw = typeof holder?.data === "string" ? holder.data : (holder?.data as { data?: string } | undefined)?.data;
  return raw && raw.startsWith("0x") ? decodeName(raw as Hex) : null;
}

export function mapLaunchError(err: unknown, fallback: string = LAUNCH_MESSAGES.launchFallback): Error {
  if (err instanceof LaunchFailedError || err instanceof LaunchRejectedError || err instanceof LaunchUnconfirmedError) return err;
  if (err instanceof BaseError && err.walk((e) => e instanceof UserRejectedRequestError)) return new LaunchRejectedError(LAUNCH_MESSAGES.rejected);
  const name = revertNameOf(err);
  return new LaunchFailedError(messageForRevert(name, fallback), name);
}

function requireLaunchpad(): Address {
  if (!LAUNCHPAD_ADDRESS) throw new LaunchFailedError(LAUNCH_MESSAGES.notLive);
  return LAUNCHPAD_ADDRESS;
}

/** Replays a mined transaction at its own block, same sender, data and value, and names the revert (spec 7.2 step 6). */
async function replayRevert(deps: LaunchDeps, hash: Hex, blockNumber: bigint): Promise<string | null> {
  try {
    const tx = await deps.publicClient.getTransaction({ hash });
    await deps.publicClient.call({ account: tx.from, to: tx.to ?? undefined, data: tx.input, value: tx.value, blockNumber });
    return null;
  } catch (err) {
    return revertNameOf(err);
  }
}

/** The receipt, or the reason it reverted, or "could not confirm" when it cannot be read. */
async function receiptOf(deps: LaunchDeps, hash: Hex, fallback: string) {
  let receipt;
  try {
    receipt = await deps.publicClient.waitForTransactionReceipt({ hash });
  } catch {
    throw new LaunchUnconfirmedError(LAUNCH_MESSAGES.unconfirmed);
  }
  if (receipt.status === "reverted") {
    const name = await replayRevert(deps, hash, receipt.blockNumber);
    throw new LaunchFailedError(messageForRevert(name, fallback), name);
  }
  return receipt;
}

/** The token from this creator's `Launched`, filtered by the launchpad's address first: topic0 is not proof of provenance. */
async function confirmLaunch(deps: LaunchDeps, launchpad: Address, hash: Hex): Promise<{ token: Address }> {
  const receipt = await receiptOf(deps, hash, LAUNCH_MESSAGES.launchFallback);
  const ours = parseEventLogs({
    abi: svLaunchpadAbi,
    eventName: "Launched",
    logs: receipt.logs.filter((log) => isAddressEqual(log.address, launchpad)),
  }).find((event) => isAddressEqual(event.args.creator, deps.account));
  if (!ours) throw new LaunchFailedError(LAUNCH_MESSAGES.launchFallback);
  return { token: ours.args.token.toLowerCase() as Address };
}

/**
 * Spec 7.2, submit steps 3 to 6: approve Permit2 when the total is above zero and the allowance is short; sign exactly
 * `firstBuy + creationFee` to the launchpad; simulate; send; wait. A zero total sends a zeroed permit and an empty
 * signature, and needs no approval at all.
 */
export async function executeLaunch(input: LaunchInput, deps: LaunchDeps, onStep: (step: LaunchStep) => void = () => {}): Promise<LaunchHandle> {
  const launchpad = requireLaunchpad();
  const total = input.firstBuy + input.creationFee;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + LAUNCH_DEADLINE_SEC);
  const params = {
    name: input.name, symbol: input.symbol, metadataUri: input.metadataUri, quote: input.quote, valuation: input.valuation,
    firstBuy: input.firstBuy, minFirstBuyTokens: input.minFirstBuyTokens, payout: input.payout, salt: input.salt, deadline,
  };
  let permit = { permitted: { token: zeroAddress as Address, amount: 0n }, nonce: 0n, deadline: 0n };
  let signature: Hex = "0x";
  try {
    if (total > 0n) {
      const allowance = await deps.publicClient.readContract({
        address: input.quote, abi: erc20Abi, functionName: "allowance", args: [deps.account, PERMIT2_ADDRESS],
      });
      if (allowance < total) {
        onStep("approve");
        const approval = await deps.wallet.writeContract({
          address: input.quote, abi: erc20Abi, functionName: "approve", args: [PERMIT2_ADDRESS, maxUint256], account: deps.account, chain: robinhoodChain,
        });
        const approved = await deps.publicClient.waitForTransactionReceipt({ hash: approval });
        if (approved.status === "reverted") throw new LaunchFailedError(LAUNCH_MESSAGES.approveFailed);
      }
      onStep("sign");
      const nonce = randomNonce();
      signature = await deps.wallet.signTypedData({
        ...permitTypedData({ token: input.quote, amount: total, spender: launchpad, nonce, deadline }),
        account: deps.account,
      });
      permit = { permitted: { token: input.quote, amount: total }, nonce, deadline };
    }
    onStep("confirm");
    const request = { address: launchpad, abi: svLaunchpadAbi, functionName: "launch", args: [params, permit, signature], account: deps.account } as const;
    await deps.publicClient.simulateContract(request);
    const hash = await deps.wallet.writeContract({ ...request, chain: robinhoodChain });
    onStep("launching");
    const confirmation = confirmLaunch(deps, launchpad, hash);
    void confirmation.catch(() => {});
    return { hash, confirmation };
  } catch (err) {
    throw mapLaunchError(err);
  }
}

function handle(hash: Hex, confirmation: Promise<void>): WriteHandle {
  void confirmation.catch(() => {});
  return { hash, confirmation };
}

async function confirmWrite(deps: LaunchDeps, hash: Hex): Promise<void> {
  await receiptOf(deps, hash, LAUNCH_MESSAGES.writeFallback);
}

/** `collectFees(token)`: anyone may trigger it (spec 4.6). */
export async function collectLaunchFees(token: Address, deps: LaunchDeps): Promise<WriteHandle> {
  const launchpad = requireLaunchpad();
  try {
    const request = { address: launchpad, abi: svLaunchpadAbi, functionName: "collectFees", args: [token], account: deps.account } as const;
    await deps.publicClient.simulateContract(request);
    const hash = await deps.wallet.writeContract({ ...request, chain: robinhoodChain });
    return handle(hash, confirmWrite(deps, hash));
  } catch (err) {
    throw mapLaunchError(err, LAUNCH_MESSAGES.writeFallback);
  }
}

/** `claim(currency, to)`: pays the caller's owed balance to `to`, which rescues a recipient the token refuses (spec 4.6). */
export async function claimOwed(currency: Address, to: Address, deps: LaunchDeps): Promise<WriteHandle> {
  const launchpad = requireLaunchpad();
  try {
    const request = { address: launchpad, abi: svLaunchpadAbi, functionName: "claim", args: [currency, to], account: deps.account } as const;
    await deps.publicClient.simulateContract(request);
    const hash = await deps.wallet.writeContract({ ...request, chain: robinhoodChain });
    return handle(hash, confirmWrite(deps, hash));
  } catch (err) {
    throw mapLaunchError(err, LAUNCH_MESSAGES.writeFallback);
  }
}

/** `setPayout(token, payout)`: the current payout address only; once handed on, the old one cannot take it back. */
export async function changePayout(token: Address, payout: Address, deps: LaunchDeps): Promise<WriteHandle> {
  const launchpad = requireLaunchpad();
  try {
    const request = { address: launchpad, abi: svLaunchpadAbi, functionName: "setPayout", args: [token, payout], account: deps.account } as const;
    await deps.publicClient.simulateContract(request);
    const hash = await deps.wallet.writeContract({ ...request, chain: robinhoodChain });
    return handle(hash, confirmWrite(deps, hash));
  } catch (err) {
    throw mapLaunchError(err, LAUNCH_MESSAGES.writeFallback);
  }
}
```

If `tsc` rejects the `as const` request object passed to both `simulateContract` and `writeContract` (viem's two parameter types differ in how they want `chain`), pass the fields explicitly to each call instead of spreading; the arguments and their order stay exactly as written.

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run src/lib/launch.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing upload-client tests**

Create `src/lib/launch/client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { LaunchFields } from "./fields";
import { UPLOAD_MESSAGES, UPLOAD_REUSE_MS, UploadError, uploadKey, uploadLaunchAssets } from "./client";

const FIELDS: LaunchFields = { name: "Tailor's Chalk", symbol: "CHALK", description: "", website: "", x: "@chalk", telegram: "" };
const IMAGE = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", { type: "image/png", lastModified: 1 });
const answer = { imageCid: "bafyimg", metadataCid: "bafymeta", metadataUri: "ipfs://bafymeta" };
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("uploadLaunchAssets (spec 7.2, submit step 2)", () => {
  it("POSTs the image and the six fields as multipart to the upload route, with the session cookie, and answers the CIDs", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json(answer, 200));
    await expect(uploadLaunchAssets(FIELDS, IMAGE, fetchImpl)).resolves.toEqual(answer);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/launch/upload");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    const body = init!.body as FormData;
    expect([...body.keys()].sort()).toEqual(["description", "image", "name", "symbol", "telegram", "website", "x"]);
    expect(body.get("x")).toBe("@chalk");
    expect(body.get("image")).toBeInstanceOf(File);
  });

  it("turns each refusal into one plain sentence", async () => {
    const cases: ReadonlyArray<[number, unknown, string]> = [
      [401, { error: "not signed in" }, UPLOAD_MESSAGES.signIn],
      [429, { error: "upload-limit", code: "upload-limit" }, UPLOAD_MESSAGES.limit],
      [429, "too many requests", UPLOAD_MESSAGES.limit],
      [403, { error: "x", code: "not-allowed" }, UPLOAD_MESSAGES.notAllowed],
      [503, { error: "x", code: "not-live" }, UPLOAD_MESSAGES.notLive],
      [413, { error: "too-large", code: "too-large" }, UPLOAD_MESSAGES.tooLarge],
      [415, { error: "bad-image", code: "bad-image" }, UPLOAD_MESSAGES.badImage],
      [422, { error: "unreadable-image", code: "unreadable-image" }, UPLOAD_MESSAGES.badImage],
      [400, { error: "x", code: "bad-field" }, "Check the X field."],
      [400, { error: "telegram", code: "bad-field" }, "Check the Telegram field."],
      [502, { error: "storage-failed", code: "storage-failed" }, UPLOAD_MESSAGES.failed],
      [503, { error: "x", code: "gate-unavailable" }, UPLOAD_MESSAGES.failed],
    ];
    for (const [status, body, message] of cases) {
      const fetchImpl = vi.fn(async () => (typeof body === "string" ? new Response(body, { status }) : json(body, status)));
      const err = await uploadLaunchAssets(FIELDS, IMAGE, fetchImpl).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UploadError);
      expect((err as Error).message).toBe(message);
    }
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(uploadLaunchAssets(FIELDS, IMAGE, offline)).rejects.toThrow(UPLOAD_MESSAGES.failed);
  });

  it("keys an answer to this image and these fields, so a retry reuses it and any change uploads again", () => {
    expect(UPLOAD_REUSE_MS).toBe(12 * 3600 * 1000);
    const key = uploadKey(FIELDS, IMAGE);
    expect(uploadKey({ ...FIELDS }, IMAGE)).toBe(key);
    expect(uploadKey({ ...FIELDS, website: "https://chalk.test" }, IMAGE)).not.toBe(key);
    expect(uploadKey(FIELDS, new File([new Uint8Array([1])], "logo.png", { type: "image/png", lastModified: 1 }))).not.toBe(key);
  });
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `npx vitest run src/lib/launch/client.test.ts`
Expected: FAIL with "Failed to resolve import "./client"".

- [ ] **Step 11: Write the upload client**

Create `src/lib/launch/client.ts`:

```ts
import type { LaunchFields } from "./fields";

/**
 * The browser's half of `POST /api/launch/upload` (instant launchpad design, section 7.2, submit step 2). Every refusal
 * becomes one plain sentence; the route's codes never reach the screen.
 */
export type UploadAnswer = { imageCid: string; metadataCid: string; metadataUri: string };

export class UploadError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}

/** An answer older than this is refreshed, well inside the nightly clean-up's 24-hour window (spec 7.2). */
export const UPLOAD_REUSE_MS = 12 * 60 * 60 * 1000;

export const UPLOAD_MESSAGES = {
  signIn: "Sign in again, then press Launch.",
  limit: "You have uploaded too many images for now. Try again later.",
  notAllowed: "Launching is open to Suits holders.",
  notLive: "Launching is not live yet.",
  tooLarge: "The image is larger than 2 MB.",
  badImage: "That image could not be read. Use a PNG, JPEG, WebP or GIF.",
  failed: "The upload failed. Nothing was spent. Try again.",
} as const;

const FIELD_LABELS: Readonly<Record<string, string>> = {
  image: "image", name: "name", symbol: "symbol", description: "description", website: "website", x: "X", telegram: "Telegram",
};

/** What a cached answer is valid for: exactly these fields and this file. */
export function uploadKey(fields: LaunchFields, image: File): string {
  return JSON.stringify([fields.name, fields.symbol, fields.description, fields.website, fields.x, fields.telegram, image.name, image.size, image.type, image.lastModified]);
}

export async function uploadLaunchAssets(fields: LaunchFields, image: Blob, fetchImpl: typeof fetch = fetch): Promise<UploadAnswer> {
  const body = new FormData();
  body.set("image", image);
  body.set("name", fields.name);
  body.set("symbol", fields.symbol);
  body.set("description", fields.description);
  body.set("website", fields.website);
  body.set("x", fields.x);
  body.set("telegram", fields.telegram);
  let res: Response;
  try {
    res = await fetchImpl("/api/launch/upload", { method: "POST", body, credentials: "same-origin" });
  } catch {
    throw new UploadError(UPLOAD_MESSAGES.failed, "network");
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // A plain-text 429 or an HTML error page: the status alone decides below.
  }
  if (res.ok) {
    const a = parsed as Partial<UploadAnswer> | null;
    if (a && typeof a.imageCid === "string" && typeof a.metadataCid === "string" && typeof a.metadataUri === "string") {
      return { imageCid: a.imageCid, metadataCid: a.metadataCid, metadataUri: a.metadataUri };
    }
    throw new UploadError(UPLOAD_MESSAGES.failed, "bad-answer");
  }
  const { code = "", error = "" } = (parsed ?? {}) as { code?: string; error?: string };
  if (res.status === 401) throw new UploadError(UPLOAD_MESSAGES.signIn, "not-signed-in");
  if (res.status === 429) throw new UploadError(UPLOAD_MESSAGES.limit, code || "rate-limited");
  switch (code) {
    case "not-allowed":
      throw new UploadError(UPLOAD_MESSAGES.notAllowed, code);
    case "not-live":
      throw new UploadError(UPLOAD_MESSAGES.notLive, code);
    case "too-large":
      throw new UploadError(UPLOAD_MESSAGES.tooLarge, code);
    case "bad-image":
    case "unreadable-image":
      throw new UploadError(UPLOAD_MESSAGES.badImage, code);
    case "bad-field":
      throw new UploadError(`Check the ${FIELD_LABELS[error] ?? "form's"} field.`, code);
    default:
      throw new UploadError(UPLOAD_MESSAGES.failed, code || String(res.status));
  }
}
```

- [ ] **Step 12: Run it to verify it passes**

Run: `npx vitest run src/lib/launch/client.test.ts`
Expected: PASS.

- [ ] **Step 13: Write the contract-read hooks**

These are thin wagmi wirings with no logic of their own beyond picking fields; the components that use them (Tasks 8 and 9) mock this module and assert behaviour, and `tsc` checks every argument against the ABI.

Create `src/hooks/useLaunchpad.ts`:

```ts
"use client";

import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { robinhoodChain } from "@/lib/chain";
import { svLaunchpadAbi } from "@/lib/launch/abi";
import { LAUNCHPAD_ADDRESS } from "@/lib/launch/address";
import { erc20Abi } from "@/lib/swap/abi";
import type { Address } from "@/lib/types";

/**
 * The launchpad's contract reads (instant launchpad design, sections 7.2 and 7.3). Every figure the form and the fee
 * panel show about the contract's settings is read live: the creator share, router fee and first-buy cap are never
 * hard-coded. Nothing is read while NEXT_PUBLIC_LAUNCHPAD_ADDRESS is unset.
 */
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const LIVE = LAUNCHPAD_ADDRESS !== undefined;
const LAUNCHPAD = { address: LAUNCHPAD_ADDRESS ?? ZERO, abi: svLaunchpadAbi, chainId: robinhoodChain.id } as const;

export type LaunchSettings = {
  allowed?: boolean;
  launchesToday?: number;
  dailyLimit?: number;
  routerFeeBps?: number;
  creatorShareBps?: number;
  firstBuyCapBps?: number;
  /** The launchpad's `hook()` setting. Non-zero means future launches would carry a hook; the form refuses to launch then. */
  hook?: Address;
};

export function useLaunchSettings(account?: Address): LaunchSettings {
  const { data } = useReadContracts({
    contracts: [
      { ...LAUNCHPAD, functionName: "routerFeeBps" },
      { ...LAUNCHPAD, functionName: "creatorShareBps" },
      { ...LAUNCHPAD, functionName: "firstBuyCapBps" },
      { ...LAUNCHPAD, functionName: "dailyLaunchLimit" },
      { ...LAUNCHPAD, functionName: "isAllowedLauncher", args: [account ?? ZERO] },
      { ...LAUNCHPAD, functionName: "launchesToday", args: [account ?? ZERO] },
      { ...LAUNCHPAD, functionName: "hook" },
    ],
    query: { enabled: LIVE, refetchInterval: 30_000 },
  });
  const at = <T,>(i: number): T | undefined => (data?.[i]?.status === "success" ? (data[i]!.result as T) : undefined);
  const today = at<bigint>(5);
  return {
    routerFeeBps: at<number>(0),
    creatorShareBps: at<number>(1),
    firstBuyCapBps: at<number>(2),
    dailyLimit: at<number>(3),
    allowed: account ? at<boolean>(4) : undefined,
    launchesToday: account && today !== undefined ? Number(today) : undefined,
    hook: at<Address>(6),
  };
}

export type CurrencyBounds = { min: bigint; max: bigint; creationFee: bigint };

export function useCurrencyConfig(quote?: Address): CurrencyBounds | undefined {
  const { data } = useReadContract({
    ...LAUNCHPAD,
    functionName: "currency",
    args: [quote ?? ZERO],
    query: { enabled: LIVE && quote !== undefined },
  });
  return data ? { min: data.minValuation, max: data.maxValuation, creationFee: data.creationFee } : undefined;
}

function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

export type OpeningInput = { account?: Address; salt: Hex; name: string; symbol: string; quote?: Address; valuation: bigint | null };
export type Opening = { token?: Address; openTick?: number; snapped?: bigint; pending: boolean };

/**
 * The snapped preview (spec 7.2): `predictToken` for the currency order, then `openingFor` for V', re-read 300 ms after
 * the last change to name, symbol, currency or valuation. Spec 14.20: the contract answers, the app ports no TickMath.
 */
export function useOpening(input: OpeningInput): Opening {
  const key = JSON.stringify([input.account ?? "", input.salt, input.name, input.symbol, input.quote ?? "", input.valuation?.toString() ?? ""]);
  const settled = useDebounced(key, 300);
  const [account, salt, name, symbol, quote, valuation] = JSON.parse(settled) as string[];
  const ready = LIVE && account !== "" && name !== "" && symbol !== "" && quote !== "" && valuation !== "";
  const predicted = useReadContract({
    ...LAUNCHPAD,
    functionName: "predictToken",
    args: [(account || ZERO) as Address, salt as Hex, name!, symbol!],
    query: { enabled: ready },
  });
  const token = predicted.data;
  const opening = useReadContract({
    ...LAUNCHPAD,
    functionName: "openingFor",
    args: [token ?? ZERO, (quote || ZERO) as Address, valuation ? BigInt(valuation) : 0n],
    query: { enabled: ready && token !== undefined },
  });
  return {
    token,
    openTick: opening.data?.[0],
    snapped: opening.data?.[2],
    pending: key !== settled || predicted.isFetching || opening.isFetching,
  };
}

export function useTokenBalanceOf(token?: Address, account?: Address): bigint | undefined {
  const { data } = useReadContract({
    address: token ?? ZERO,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account ?? ZERO],
    chainId: robinhoodChain.id,
    query: { enabled: token !== undefined && account !== undefined, refetchInterval: 10_000 },
  });
  return data;
}

export type PendingFees = {
  tokenFees: bigint; quoteFees: bigint; tokenToPayout: bigint; quoteToPayout: bigint; tokenToFeeWallet: bigint; quoteToFeeWallet: bigint;
};
export type LaunchFees = {
  uncollected?: PendingFees;
  /** The view could not be read: the panel must say so, never show zeros (Review Focus 5). */
  uncollectedFailed: boolean;
  owedToken?: bigint;
  owedQuote?: bigint;
  refetch(): void;
};

/** Spec 7.3: `uncollectedFees(token)` every 30 s, and the connected wallet's `owed` balance in both currencies. */
export function useLaunchFees(token: Address, quote: Address, account?: Address): LaunchFees {
  const fees = useReadContract({ ...LAUNCHPAD, functionName: "uncollectedFees", args: [token], query: { enabled: LIVE, refetchInterval: 30_000 } });
  const owed = useReadContracts({
    contracts: [
      { ...LAUNCHPAD, functionName: "owed", args: [account ?? ZERO, token] },
      { ...LAUNCHPAD, functionName: "owed", args: [account ?? ZERO, quote] },
    ],
    query: { enabled: LIVE && account !== undefined, refetchInterval: 30_000 },
  });
  const owedAt = (i: number) => (owed.data?.[i]?.status === "success" ? (owed.data[i]!.result as bigint) : undefined);
  return {
    uncollected: fees.data,
    uncollectedFailed: fees.isError && fees.data === undefined,
    owedToken: account ? owedAt(0) : undefined,
    owedQuote: account ? owedAt(1) : undefined,
    refetch: () => {
      void fees.refetch();
      void owed.refetch();
    },
  };
}
```

- [ ] **Step 14: Run the gates**

Run: `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src`. All clean.

- [ ] **Step 15: Commit**

```bash
git add src/lib/launch/math.ts src/lib/launch/math.test.ts src/lib/launch.ts src/lib/launch.test.ts src/lib/launch/client.ts src/lib/launch/client.test.ts src/hooks/useLaunchpad.ts
git commit -m "Launchpad: the launch and fee-panel wallet writes, the form's arithmetic, the upload client and the contract reads"
```

---

### Task 8: The `/launch` page, the form and the nav entry

**Files:**
- Modify: `src/context/AppState.tsx:43` (`GateKind` gains `"launch"`), `:51-88` and the value object (`withSignIn`); `gate`, `completeSign`, `cancelSign` and a connect-modal effect tell an abandoned action's `onCancel`
- Modify: `src/context/AppState.test.tsx` (four gate tests)
- Modify: `src/components/SignModal.tsx:77-83` (the launch wording), `src/components/SignModal.test.tsx`
- Create: `src/components/CurrencySelect.tsx`
- Create: `src/components/LaunchForm.tsx`, `src/components/LaunchForm.test.tsx`
- Create: `src/app/launch/page.tsx`, `src/app/launch/page.test.tsx`
- Modify: `src/components/TopBar.tsx:10-14` (`NAV`)
- Create: `src/components/TopBar.test.tsx`

**Interfaces:**
- Consumes: everything Task 7 produces (`executeLaunch`, `LaunchFailedError`, `LaunchRejectedError`, `LaunchUnconfirmedError`, `LAUNCH_MESSAGES`, `LaunchStep`; `uploadLaunchAssets`, `uploadKey`, `UploadError`, `UPLOAD_REUSE_MS`; the `math.ts` functions; `useLaunchSettings`, `useCurrencyConfig`, `useOpening`, `useTokenBalanceOf`); `validateFields`, `utf8Bytes`, `NAME_MAX_BYTES`, `SYMBOL_MAX_BYTES`, `DESCRIPTION_MAX_CHARS`, `IMAGE_MAX_BYTES` (Task 5); `hasLaunchpad` (Task 2); `useQuotes` (`src/hooks/useMarketsData.ts:48`); `USDG` (`src/lib/chain/math/constants.ts:5`); `toBase`, `toHuman` (`src/lib/quote/math.ts`); `fmtAmt`, `fmtInt`, `fmtPrice` (`src/lib/format.ts`); `Spinner` (`src/components/ui.tsx:125`).
- Produces:
  ```ts
  // src/context/AppState.tsx
  export type GateKind = "star" | "vote" | "launch";
  // AppState gains: withSignIn(kind: GateKind, run: () => void, onCancel?: () => void): void;  the connect/sign-in gate the star uses, for any action;
  //   onCancel fires when the sign modal is closed without signing (cancelSign)
  // src/components/CurrencySelect.tsx
  export function hasUsdPrice(q: QuoteAsset): boolean;
  export function orderCurrencies(quotes: readonly QuoteAsset[]): QuoteAsset[];
  export default function CurrencySelect(props: { quotes: readonly QuoteAsset[]; value: Address | null; onChange(address: Address): void }): JSX.Element;
  // src/components/LaunchForm.tsx
  export default function LaunchForm(): JSX.Element;
  // src/app/launch/page.tsx: metadata { title: "Launch" }; renders LaunchForm, or the not-live card while LAUNCHPAD_ADDRESS is unset
  ```

Before writing the page, read `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md` and `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md` (Global Constraints). The page follows `/traders`: a server page exporting `metadata` that renders one client component. The whole app already sits behind the Suits gate (`TokenGate` in `src/app/layout.tsx`, D44), which matches the launcher gate.

- [ ] **Step 1: Write the failing sign-in and nav tests**

Edit `src/context/AppState.test.tsx`. In `h` (lines 16-29) add three members after `openConnectModal: vi.fn(),`:

```ts
  connectModalOpen: false,
  launchRun: vi.fn(),
  launchCancel: vi.fn(),
```

Replace line 32:

```ts
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: h.openConnectModal }) }));
```

with:

```ts
vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: () => ({ openConnectModal: h.openConnectModal, connectModalOpen: h.connectModalOpen }),
}));
```

In `Probe`, after the `vote bear` button add:

```tsx
      <button type="button" onClick={() => s.withSignIn("launch", h.launchRun, h.launchCancel)}>
        launch
      </button>
```

In `describe("AppStateProvider sign-in", …)`'s `beforeEach` add:

```ts
    h.connectModalOpen = false;
    h.launchRun.mockReset();
    h.launchCancel.mockReset();
```

and append inside that `describe`:

```ts
  it("tells a queued launch it was abandoned when the signature is refused, and a later unrelated sign-in does not launch", async () => {
    h.ds.signIn.mockRejectedValueOnce(new Error("401"));
    show();
    await waitFor(() => expect(h.ds.session).toHaveBeenCalled());
    fireEvent.click(screen.getByText("launch"));
    expect(screen.getByTestId("modal").textContent).toBe("launch");
    await act(async () => {
      fireEvent.click(screen.getByText("complete"));
    });
    await waitFor(() => expect(h.launchCancel).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(screen.getByText("complete"));
    });
    await waitFor(() => expect(screen.getByTestId("signed").textContent).toBe("true"));
    expect(h.launchRun).not.toHaveBeenCalled();
  });

  it("tells a queued launch it was abandoned when a star replaces it, and the sign-in then runs only the star", async () => {
    show();
    await waitFor(() => expect(h.ds.session).toHaveBeenCalled());
    fireEvent.click(screen.getByText("launch"));
    fireEvent.click(screen.getByText("star"));
    expect(h.launchCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("modal").textContent).toBe("star");
    await act(async () => {
      fireEvent.click(screen.getByText("complete"));
    });
    await waitFor(() => expect(h.ds.setWatch).toHaveBeenCalledWith(TOKEN, true));
    expect(h.launchRun).not.toHaveBeenCalled();
  });

  it("tells a queued launch it was abandoned when the connect modal closes with no wallet", async () => {
    h.account = { address: undefined, isConnected: false };
    const { rerenderApp } = show();
    fireEvent.click(screen.getByText("launch"));
    expect(h.openConnectModal).toHaveBeenCalled();
    h.connectModalOpen = true;
    rerenderApp();
    expect(h.launchCancel).not.toHaveBeenCalled();
    h.connectModalOpen = false;
    rerenderApp();
    expect(h.launchCancel).toHaveBeenCalledTimes(1);
    expect(h.launchRun).not.toHaveBeenCalled();
  });

  it("tells a queued launch nothing when the sign-in succeeds, and runs it", async () => {
    show();
    await waitFor(() => expect(h.ds.session).toHaveBeenCalled());
    fireEvent.click(screen.getByText("launch"));
    await act(async () => {
      fireEvent.click(screen.getByText("complete"));
    });
    await waitFor(() => expect(h.launchRun).toHaveBeenCalledTimes(1));
    expect(h.launchCancel).not.toHaveBeenCalled();
  });
```

Edit `src/components/SignModal.test.tsx`. Replace line 11:

```ts
    signModal: { kind: "star" as "star" | "vote" },
```

with:

```ts
    signModal: { kind: "star" as "star" | "vote" | "launch" },
```

Add inside `describe("SignModal", …)`:

```ts
  it("says what a launch sign-in is for", () => {
    h.state.signModal = { kind: "launch" };
    render(<SignModal />);
    expect(screen.getByText("Sign to launch a token")).toBeTruthy();
    expect(screen.getByText(/ties your uploads to this address/)).toBeTruthy();
  });
```

Create `src/components/TopBar.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/dom";
import TopBar from "./TopBar";

vi.mock("next/navigation", () => ({ usePathname: () => "/launch", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/context/AppState", () => ({ useAppState: () => ({ filters: { query: "" }, setQuery: vi.fn() }) }));
vi.mock("./WalletButton", () => ({ default: () => null }));

describe("TopBar (instant launchpad design, section 7.1)", () => {
  it("offers Launch after Traders in both the desktop and the phone rows, marked current on /launch", () => {
    render(<TopBar />);
    const links = screen.getAllByRole("link", { name: "Launch" });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("/launch");
      expect(link.getAttribute("aria-current")).toBe("page");
    }
    const [desktop] = screen.getAllByRole("navigation", { name: "Primary" });
    expect([...desktop!.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Markets", "Watchlist", "Traders", "Launch"]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/components/SignModal.test.tsx src/components/TopBar.test.tsx`
Expected: FAIL: the modal says "Sign to save your watchlist" and there is no Launch link.

- [ ] **Step 3: Add the gate kind, the wording and the nav entry**

Edit `src/context/AppState.tsx`. Replace line 43:

```ts
export type GateKind = "star" | "vote";
```

with:

```ts
export type GateKind = "star" | "vote" | "launch";
```

In `interface AppState`, after `  promptSignIn(): void;` add:

```ts
  /**
   * The same connect-then-sign gate the star and the vote use, for any action: `run` fires once a session exists. The
   * launch form (instant launchpad design, section 7.2, submit step 1) passes a no-op and resumes itself when `signed`
   * flips, because its submit closes over the form's state. `onCancel` fires when the sign modal is closed without a
   * signature, so the caller can drop what it queued.
   */
  withSignIn(kind: GateKind, run: () => void, onCancel?: () => void): void;
```

The queued action remembers its cancel callback. Replace line 187:

```ts
  const pendingRef = useRef<{ kind: GateKind; run: GatedAction } | null>(null);
```

with:

```ts
  const pendingRef = useRef<{ kind: GateKind; run: GatedAction; onCancel?: () => void } | null>(null);
```

Replace `gate` (lines 238-253):

```ts
  const gate = useCallback(
    (kind: GateKind, run: GatedAction) => {
      if (!isConnected || !address) {
        pendingRef.current = { kind, run };
        openConnectModal?.();
        return;
      }
      if (!sameAddress(session?.address, address)) {
        pendingRef.current = { kind, run };
        setSignModal({ kind });
        return;
      }
      fire(run, { address });
    },
    [address, fire, isConnected, openConnectModal, session],
  );
```

with:

```ts
  const gate = useCallback(
    (kind: GateKind, run: GatedAction, onCancel?: () => void) => {
      // A new gesture replaces whatever was queued: the replaced action is abandoned, so its owner is told
      // (a star pressed while a launch waits for its signature must never let that launch fire later).
      const replace = (next: { kind: GateKind; run: GatedAction; onCancel?: () => void }) => {
        const previous = pendingRef.current;
        pendingRef.current = next;
        if (previous && previous !== next) previous.onCancel?.();
      };
      if (!isConnected || !address) {
        replace({ kind, run, onCancel });
        openConnectModal?.();
        return;
      }
      if (!sameAddress(session?.address, address)) {
        replace({ kind, run, onCancel });
        setSignModal({ kind });
        return;
      }
      fire(run, { address });
    },
    [address, fire, isConnected, openConnectModal, session],
  );
```

Replace `cancelSign` (lines 299-302):

```ts
  const cancelSign = useCallback(() => {
    pendingRef.current = null;
    setSignModal(null);
  }, []);
```

with:

```ts
  const cancelSign = useCallback(() => {
    // Closed without signing: the queued action is dropped, and its owner is told so it can undo what it showed.
    const pending = pendingRef.current;
    pendingRef.current = null;
    setSignModal(null);
    pending?.onCancel?.();
  }, []);
```

Every other path that abandons a queued action tells its owner too (fix round: `onCancel` must fire on each of them, or a launch form keeps a stale "Sign in" step and could resume on an unrelated sign-in).

A refused signature. In `completeSign`, replace:

```ts
      } catch (err) {
        // A refusal — the wallet's or the server's — drops the queued action rather than leaving
        // it to fire on some later, unrelated sign-in; only a fresh gesture may queue another one.
        pendingRef.current = null;
        throw err;
      }
```

with:

```ts
      } catch (err) {
        // A refusal — the wallet's or the server's — drops the queued action rather than leaving
        // it to fire on some later, unrelated sign-in; only a fresh gesture may queue another one.
        const abandoned = pendingRef.current;
        pendingRef.current = null;
        abandoned?.onCancel?.();
        throw err;
      }
```

The connect modal closed while still disconnected. Replace line 121:

```ts
  const { openConnectModal } = useConnectModal();
```

with:

```ts
  const { openConnectModal, connectModalOpen } = useConnectModal();
```

and add, after the effect that continues a pending action once a wallet connects (the `useEffect` right after `promptSignIn`, lines 262-272):

```ts
  // The connect modal closed and no wallet arrived: the action queued behind it is abandoned (its owner is told).
  const connectWasOpen = useRef(false);
  useEffect(() => {
    if (connectModalOpen) {
      connectWasOpen.current = true;
      return;
    }
    if (!connectWasOpen.current) return;
    connectWasOpen.current = false;
    if (isConnected) return; // connected: the effect above carries the action on
    const abandoned = pendingRef.current;
    pendingRef.current = null;
    abandoned?.onCancel?.();
  }, [connectModalOpen, isConnected]);
```

`useRef` and `useEffect` are already imported by `AppState.tsx`.

After the `promptSignIn` callback (line 260) add:

```ts
  const withSignIn = useCallback(
    (kind: GateKind, run: () => void, onCancel?: () => void) => gate(kind, () => run(), onCancel),
    [gate],
  );
```

In the value object (lines 469-470) replace:

```ts
      signModal,
      promptSignIn,
```

with:

```ts
      signModal,
      promptSignIn,
      withSignIn,
```

and in its dependency array (lines 498-499) the same two lines with the same addition.

Edit `src/components/SignModal.tsx`. Replace lines 77-83:

```tsx
        <div id="sign-title" className="mt-4 text-[17px] font-medium">
          {kind === "vote" ? "Sign to cast your vote" : "Sign to save your watchlist"}
        </div>
        <p className="mt-2 text-pretty text-[12.5px] leading-[1.55] text-ink-55">
          A one-time signature ties your watchlist and votes to this address. No gas,
          no transaction, nothing moves.
        </p>
```

with:

```tsx
        <div id="sign-title" className="mt-4 text-[17px] font-medium">
          {kind === "vote" ? "Sign to cast your vote" : kind === "launch" ? "Sign to launch a token" : "Sign to save your watchlist"}
        </div>
        <p className="mt-2 text-pretty text-[12.5px] leading-[1.55] text-ink-55">
          {kind === "launch"
            ? "A one-time signature ties your uploads to this address. No gas, no transaction, nothing moves."
            : "A one-time signature ties your watchlist and votes to this address. No gas, no transaction, nothing moves."}
        </p>
```

Edit `src/components/TopBar.tsx`. Replace lines 10-14:

```ts
const NAV = [
  { href: "/", label: "Markets" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/traders", label: "Traders" },
] as const;
```

with:

```ts
const NAV = [
  { href: "/", label: "Markets" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/traders", label: "Traders" },
  { href: "/launch", label: "Launch" },
] as const;
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/components/SignModal.test.tsx src/components/TopBar.test.tsx src/context`
Expected: PASS.

- [ ] **Step 5: Write the failing form tests**

Create `src/components/LaunchForm.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LaunchFailedError, messageForRevert } from "@/lib/launch";
import { estimateFirstBuyTokens, minFirstBuyTokens } from "@/lib/launch/math";
import type { Address, QuoteAsset } from "@/lib/types";
import { act, fireEvent, render, screen, waitFor } from "@/test/dom";
import LaunchForm from "./LaunchForm";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const AMC = "0x05a3d1cd21d0c88145e82600e62e7e496e0f222b" as Address;
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" as Address;
const TOKEN = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as Address;
const TX = `0x${"11".repeat(32)}` as `0x${string}`;
const SNAPPED = 4_995_430_000n; // $4,995.43
const ANSWER = { imageCid: "bafyimg", metadataCid: "bafymeta", metadataUri: "ipfs://bafymeta" };

const QUOTES: QuoteAsset[] = [
  { symbol: "NVDA", name: "NVIDIA", address: NVDA, decimals: 18, usdPrice: 120, pairs: 3, vol24h: 900, stale: false },
  { symbol: "AMC", name: "AMC Entertainment", address: AMC, decimals: 18, usdPrice: 0, pairs: 1, vol24h: 10, stale: true },
  { symbol: "USDG", name: "Global Dollar", address: USDG, decimals: 6, usdPrice: 1, pairs: 5, vol24h: 100, stale: false },
];

const h = vi.hoisted(() => ({
  state: {
    address: "0x1111111111111111111111111111111111111111" as string | undefined,
    isConnected: true,
    signed: true,
    withSignIn: vi.fn(),
    addToast: vi.fn(() => 1),
    updateToast: vi.fn(),
  },
  settings: {} as Record<string, unknown>,
  bounds: {} as Record<string, { min: bigint; max: bigint; creationFee: bigint }>,
  opening: { token: "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a", openTick: -398_400, snapped: 4_995_430_000n as bigint | undefined, pending: false },
  balance: 1_000_000_000n as bigint | undefined,
  quotes: [] as unknown[],
  upload: vi.fn(),
  execute: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/context/AppState", () => ({ useAppState: () => h.state }));
vi.mock("@/hooks/useMarketsData", () => ({ useQuotes: () => ({ data: h.quotes }) }));
vi.mock("@/hooks/useLaunchpad", () => ({
  useLaunchSettings: () => h.settings,
  useCurrencyConfig: (quote?: string) => (quote ? h.bounds[quote.toLowerCase()] : undefined),
  useOpening: () => h.opening,
  useTokenBalanceOf: () => h.balance,
}));
vi.mock("wagmi", () => ({ usePublicClient: () => ({ id: "public" }), useWalletClient: () => ({ data: { id: "wallet" } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/lib/launch/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/launch/client")>()), uploadLaunchAssets: h.upload }));
vi.mock("@/lib/launch", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/launch")>()), executeLaunch: h.execute }));

beforeEach(() => {
  h.state.address = WALLET;
  h.state.isConnected = true;
  h.state.signed = true;
  h.state.withSignIn.mockReset();
  h.state.addToast.mockClear();
  h.state.updateToast.mockClear();
  h.settings = {
    allowed: true, launchesToday: 0, dailyLimit: 5, routerFeeBps: 50, creatorShareBps: 7000, firstBuyCapBps: 2000,
    hook: "0x0000000000000000000000000000000000000000",
  };
  // jsdom has no object URLs; the form's image preview needs both.
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  h.bounds = {
    [USDG]: { min: 5_000_000_000n, max: 10_000_000_000_000n, creationFee: 0n },
    [AMC]: { min: 50n * 10n ** 18n, max: 100_000n * 10n ** 18n, creationFee: 0n },
  };
  h.opening = { token: TOKEN, openTick: -398_400, snapped: SNAPPED, pending: false };
  h.balance = 1_000_000_000n; // 1,000 USDG
  h.quotes = QUOTES;
  h.upload.mockReset().mockResolvedValue(ANSWER);
  h.execute.mockReset().mockResolvedValue({ hash: TX, confirmation: Promise.resolve({ token: TOKEN }) });
  h.push.mockReset();
});

function fill(o: { name?: string; symbol?: string } = {}) {
  fireEvent.change(screen.getByLabelText("Image"), { target: { files: [new File([new Uint8Array(10)], "logo.png", { type: "image/png" })] } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: o.name ?? "Tailor's Chalk" } });
  fireEvent.change(screen.getByLabelText("Symbol"), { target: { value: o.symbol ?? "CHALK" } });
}
const launch = () => screen.getByRole("button", { name: "Launch" });
const press = async () => {
  await act(async () => {
    fireEvent.click(launch());
  });
};

describe("LaunchForm: the button's reasons, first match wins (spec 7.2)", () => {
  it("asks for a wallet, then a Suit, then a launch left today, then the fields", () => {
    h.state.isConnected = false;
    h.state.address = undefined;
    const { rerender } = render(<LaunchForm />);
    expect(screen.getByText("Connect a wallet to launch.")).toBeTruthy();
    expect((launch() as HTMLButtonElement).disabled).toBe(true);
    h.state.isConnected = true;
    h.state.address = WALLET;
    h.settings = { ...h.settings, allowed: false };
    rerender(<LaunchForm />);
    expect(screen.getByText("Launching is open to Suits holders.")).toBeTruthy();
    h.settings = { ...h.settings, allowed: true, launchesToday: 5 };
    rerender(<LaunchForm />);
    expect(screen.getByText("You have used today's launches.")).toBeTruthy();
    h.settings = { ...h.settings, launchesToday: 2 };
    rerender(<LaunchForm />);
    expect(screen.getByText("Add an image, a name and a symbol.")).toBeTruthy();
    expect(screen.getByText("3 of 5 left today. The count resets at 00:00 UTC.")).toBeTruthy();
  });

  it("waits for every setting the contract answers, never assuming 0 (fee, cap, share or hook unread)", () => {
    for (const key of ["routerFeeBps", "firstBuyCapBps", "creatorShareBps", "hook"]) {
      h.settings = { allowed: true, launchesToday: 0, dailyLimit: 5, routerFeeBps: 50, creatorShareBps: 7000, firstBuyCapBps: 2000, hook: "0x0000000000000000000000000000000000000000", [key]: undefined };
      const { unmount } = render(<LaunchForm />);
      fill();
      expect(screen.getByText("Reading the launchpad's settings.")).toBeTruthy();
      expect((launch() as HTMLButtonElement).disabled).toBe(true);
      unmount();
    }
  });

  it("refuses to launch while the launchpad has a hook set, as the contracts README promises", () => {
    h.settings = { ...h.settings, hook: "0x00000000000000000000000000000000000000c0" };
    render(<LaunchForm />);
    fill();
    expect(screen.getByText("Launches are paused while a hook is set.")).toBeTruthy();
    expect((launch() as HTMLButtonElement).disabled).toBe(true);
  });

  it("counts the name in bytes: 8 rockets fit, 9 do not (Review Focus 1)", () => {
    render(<LaunchForm />);
    fill({ name: "🚀".repeat(8) });
    expect(screen.getByText("32/32 bytes")).toBeTruthy();
    expect((launch() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "🚀".repeat(9) } });
    expect(screen.getByText("36/32 bytes")).toBeTruthy();
    expect(screen.getByText("The name fits 32 bytes and the symbol 11.")).toBeTruthy();
  });

  it("refuses a valuation outside the currency's bounds, a first buy above the balance, then one above the cap", () => {
    render(<LaunchForm />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("Custom valuation"), { target: { value: "1000" } });
    expect(screen.getByText("Pick a valuation between $5,000 and $10,000,000.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "$5,000" }));
    fireEvent.change(screen.getByLabelText("First buy"), { target: { value: "2000" } });
    expect(screen.getByText("The first buy is more than your balance.")).toBeTruthy();
    h.balance = 10_000_000_000n; // 10,000 USDG
    fireEvent.change(screen.getByLabelText("First buy"), { target: { value: "1999" } });
    expect(screen.getByText("The first buy is above the cap.")).toBeTruthy();
  });

  it("reads the fee share from the contract, never a fixed 70 %, and shows the snapped opening in USD", () => {
    h.settings = { ...h.settings, creatorShareBps: 6500 };
    render(<LaunchForm />);
    expect(screen.getByText("65 % of trading fees to your payout address")).toBeTruthy();
    expect(["$5,000", "$10,000", "$25,000", "$100,000"].every((label) => screen.getByRole("button", { name: label }))).toBe(true);
    expect(screen.getByText("Opens at $4,995 · $0.000004995 per token")).toBeTruthy();
    expect(screen.getByText("Gas only")).toBeTruthy();
    expect(screen.getByText("Buys worth about 41 % of the opening valuation double the price, plus the 1 % pool fee.")).toBeTruthy();
  });

  it("works in the currency's own units when it has no USD price (Review Focus 2)", () => {
    render(<LaunchForm />);
    fill(); // so the first failing reason is the valuation's
    fireEvent.click(screen.getByRole("button", { name: /Currency/ }));
    const options = screen.getAllByRole("option");
    expect(options[0]!.textContent).toContain("USDG"); // USDG first, then by 24 h volume
    expect(options[1]!.textContent).toContain("NVDA");
    const amc = screen.getByRole("option", { name: /AMC/ });
    expect(amc.textContent).toContain("No USD price");
    fireEvent.click(amc);
    expect(["50 AMC", "100 AMC", "250 AMC", "1,000 AMC"].every((label) => screen.getByRole("button", { name: label }))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("Custom valuation"), { target: { value: "10" } });
    expect(screen.getByText("Pick a valuation between 50 AMC and 100,000 AMC.")).toBeTruthy();
  });
});

describe("LaunchForm: submitting (spec 7.2's steps)", () => {
  it("uploads, launches with the requested valuation and a zero floor without a first buy, then opens the token page", async () => {
    render(<LaunchForm />);
    fill();
    await press();
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(`/t/${TOKEN}?launched=${TX}`));
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.upload.mock.calls[0]![0]).toEqual({ name: "Tailor's Chalk", symbol: "CHALK", description: "", website: "", x: "", telegram: "" });
    expect(h.execute.mock.calls[0]![0]).toMatchObject({
      name: "Tailor's Chalk", symbol: "CHALK", metadataUri: "ipfs://bafymeta", quote: USDG, valuation: 5_000_000_000n,
      firstBuy: 0n, minFirstBuyTokens: 0n, payout: WALLET, creationFee: 0n,
    });
    expect(h.state.addToast).toHaveBeenCalledWith({ kind: "pending", message: "Launching CHALK", hash: TX });
    expect(h.state.updateToast).toHaveBeenCalledWith(1, { kind: "confirmed", message: "Launched CHALK" });
  });

  it("sends the first buy's estimate less 0.5 % as the floor", async () => {
    render(<LaunchForm />);
    fill();
    fireEvent.change(screen.getByLabelText("First buy"), { target: { value: "100" } });
    await press();
    await waitFor(() => expect(h.execute).toHaveBeenCalled());
    expect(h.execute.mock.calls[0]![0]).toMatchObject({
      firstBuy: 100_000_000n,
      minFirstBuyTokens: minFirstBuyTokens(estimateFirstBuyTokens(100_000_000n, SNAPPED, 50)),
    });
  });

  it("shows a simulated revert by name, and a mined one replayed by the wallet code", async () => {
    h.execute.mockRejectedValueOnce(new LaunchFailedError(messageForRevert("DailyLimitReached"), "DailyLimitReached"));
    render(<LaunchForm />);
    fill();
    await press();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("You have used today's launches."));
    h.execute.mockImplementationOnce(async () => {
      const confirmation = Promise.reject(new LaunchFailedError(messageForRevert("FirstBuyTooSmall"), "FirstBuyTooSmall"));
      confirmation.catch(() => {});
      return { hash: TX, confirmation };
    });
    await press();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The first buy would get fewer tokens than shown. Review and try again."));
    expect(h.state.updateToast).toHaveBeenLastCalledWith(1, { kind: "failed", message: "The first buy would get fewer tokens than shown. Review and try again." });
    expect(h.push).not.toHaveBeenCalled();
  });

  it("draws a new salt after PoolAlreadyInitialized, and reuses the upload on the retry", async () => {
    h.execute.mockRejectedValueOnce(new LaunchFailedError(messageForRevert("PoolAlreadyInitialized"), "PoolAlreadyInitialized"));
    render(<LaunchForm />);
    fill();
    await press();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    await press();
    await waitFor(() => expect(h.push).toHaveBeenCalled());
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(h.execute.mock.calls[1]![0].salt).not.toBe(h.execute.mock.calls[0]![0].salt);
    expect(h.upload).toHaveBeenCalledTimes(1);
  });

  it("sends one upload and one launch however many times Launch is pressed while one is in flight (Review Focus 4)", async () => {
    h.execute.mockReturnValue(new Promise(() => {})); // the wallet never answers
    render(<LaunchForm />);
    fill();
    const button = launch();
    // Three clicks in one tick: React has not re-rendered the pending button yet, so only the in-flight guard stops them.
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(h.execute).toHaveBeenCalledTimes(1));
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Launch" })).toBeNull(); // the pending button names the current step instead
  });

  it("signs in first when there is no session, then carries on by itself once signed", async () => {
    h.state.signed = false;
    const { rerender } = render(<LaunchForm />);
    fill();
    await press();
    expect(h.state.withSignIn).toHaveBeenCalledWith("launch", expect.any(Function), expect.any(Function));
    expect(h.upload).not.toHaveBeenCalled();
    expect(screen.getByText("Sign in")).toBeTruthy();
    h.state.signed = true;
    await act(async () => {
      rerender(<LaunchForm />);
    });
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(`/t/${TOKEN}?launched=${TX}`));
    expect(h.upload).toHaveBeenCalledTimes(1);
  });

  it("drops the queued launch and its steps when the sign modal is closed without signing, so a later sign-in resumes nothing", async () => {
    h.state.signed = false;
    const { rerender } = render(<LaunchForm />);
    fill();
    await press();
    expect(screen.getByText("Sign in")).toBeTruthy();
    const onCancel = h.state.withSignIn.mock.calls[0]![2] as () => void;
    act(() => onCancel()); // what AppState's cancelSign calls
    expect(screen.queryByText("Sign in")).toBeNull();
    h.state.signed = true;
    await act(async () => {
      rerender(<LaunchForm />);
    });
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/components/LaunchForm.test.tsx`
Expected: FAIL with "Failed to resolve import "./LaunchForm"".

- [ ] **Step 7: Write the currency picker**

Create `src/components/CurrencySelect.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";
import { USDG } from "@/lib/chain/math/constants";
import type { Address, QuoteAsset } from "@/lib/types";
import { MagnifierIcon } from "./ui";

/** A fresh USD price, the same test the markets table uses: a stale or absent feed is no price at all. */
export function hasUsdPrice(q: QuoteAsset): boolean {
  return !q.stale && q.usdPrice > 0;
}

/** USDG first, then by 24 h volume, then by symbol (instant launchpad design, section 7.2). */
export function orderCurrencies(quotes: readonly QuoteAsset[]): QuoteAsset[] {
  return [...quotes].sort((a, b) => {
    const au = a.address.toLowerCase() === USDG;
    const bu = b.address.toLowerCase() === USDG;
    if (au !== bu) return au ? -1 : 1;
    return b.vol24h - a.vol24h || a.symbol.localeCompare(b.symbol);
  });
}

/**
 * A single-select popover on QuotePicker's recipe (search, then a listbox of rows), for the launch's currency. Each row
 * says whether the form will work in USD for it or in the currency's own units.
 */
export default function CurrencySelect({
  quotes,
  value,
  onChange,
}: {
  quotes: readonly QuoteAsset[];
  value: Address | null;
  onChange(address: Address): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ordered = useMemo(() => orderCurrencies(quotes), [quotes]);
  const needle = query.trim().toLowerCase();
  const rows = ordered.filter((q) => !needle || q.symbol.toLowerCase().includes(needle) || q.name.toLowerCase().includes(needle));
  const selected = quotes.find((q) => q.address.toLowerCase() === value?.toLowerCase());

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Currency ${selected?.symbol ?? ""}`.trim()}
        onClick={() => setOpen((o) => !o)}
        className="mt-2 flex h-10 w-full items-center justify-between border border-hairline-strong bg-transparent px-3 font-mono text-[12px] hover:border-hairline-hover"
      >
        <span>{selected?.symbol ?? "Pick a currency"}</span>
        <span className="text-ink-45">▾</span>
      </button>
      {open ? (
        <div role="dialog" aria-label="Pick a currency" className="absolute left-0 right-0 top-[46px] z-[8] border border-hairline-strong bg-panel p-[10px] font-mono">
          <div className="relative flex items-center">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a currency"
              aria-label="Find a currency"
              className="h-[30px] w-full border border-hairline-strong bg-transparent pl-7 pr-[10px] text-[11px] outline-none focus:border-hairline-focus"
            />
            <MagnifierIcon className="pointer-events-none absolute left-[9px]" />
          </div>
          <div role="listbox" aria-label="Currencies" className="mt-2 max-h-[280px] overflow-y-auto">
            {rows.map((q) => {
              const on = q.address.toLowerCase() === value?.toLowerCase();
              return (
                <button
                  key={q.address}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => {
                    onChange(q.address);
                    setOpen(false);
                    setQuery("");
                  }}
                  className={`flex w-full items-center justify-between px-2 py-[7px] text-left hover:bg-hover-item ${on ? "text-chalk" : "text-ink"}`}
                >
                  <span className="text-[11.5px]">{q.symbol}</span>
                  <span className="text-[10px] text-ink-45">{hasUsdPrice(q) ? "USD" : "No USD price"}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 8: Write the form**

Create `src/components/LaunchForm.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isAddress, type Hex } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import { useAppState } from "@/context/AppState";
import { useCurrencyConfig, useLaunchSettings, useOpening, useTokenBalanceOf } from "@/hooks/useLaunchpad";
import { useQuotes } from "@/hooks/useMarketsData";
import { robinhoodChain } from "@/lib/chain";
import { USDG, ZERO_ADDRESS } from "@/lib/chain/math/constants";
import { fmtAmt, fmtInt, fmtPrice } from "@/lib/format";
import { LAUNCH_MESSAGES, LaunchFailedError, LaunchRejectedError, LaunchUnconfirmedError, executeLaunch, type LaunchStep } from "@/lib/launch";
import { UPLOAD_REUSE_MS, UploadError, uploadKey, uploadLaunchAssets, type UploadAnswer } from "@/lib/launch/client";
import {
  DESCRIPTION_MAX_CHARS, IMAGE_MAX_BYTES, NAME_MAX_BYTES, SYMBOL_MAX_BYTES, utf8Bytes, validateFields, type LaunchFields,
} from "@/lib/launch/fields";
import {
  RULE_OF_THUMB, capTokens, estimateFirstBuyTokens, firstBuyCapGross, maxFirstBuy, minFirstBuyTokens, presetValuations, pricePerToken,
  randomSalt, rawToNumber, routerFeeOf, shareOfSupplyPct, usdToRaw,
} from "@/lib/launch/math";
import { toBase, toHuman } from "@/lib/quote/math";
import type { Address } from "@/lib/types";
import CurrencySelect, { hasUsdPrice, orderCurrencies } from "./CurrencySelect";
import { Spinner } from "./ui";

/**
 * `/launch` (instant launchpad design, section 7.2): one transaction that deploys the token, opens its pool at the
 * valuation picked here and optionally buys first. The preview is the contract's own `openingFor`; the fee share, router
 * fee and cap are read live. No line here says or implies that every buyer pays the same price.
 */
type SubmitStep = "sign-in" | "upload" | LaunchStep;
const STEP_LABELS: Record<SubmitStep, string> = {
  "sign-in": "Sign in",
  upload: "Upload",
  approve: "Approve",
  sign: "Sign the payment",
  confirm: "Confirm in wallet",
  launching: "Launching",
};
const AMOUNT_RE = /^\d*\.?\d*$/;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const LABEL = "flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-ink-45";
const INPUT = "mt-2 h-10 w-full border border-hairline-strong bg-transparent px-3 text-[13px] outline-none focus:border-hairline-focus";
const PRIMARY = "mt-[14px] h-11 w-full bg-chalk font-mono text-[11px] uppercase tracking-[0.22em] text-onlight hover:bg-white";
const DISABLED =
  "mt-[14px] h-11 w-full cursor-not-allowed border border-hairline-mid bg-[rgba(244,238,218,0.06)] font-mono text-[11px] uppercase tracking-[0.22em] text-ink-34";
const PENDING =
  "mt-[14px] flex h-11 w-full cursor-wait items-center justify-center gap-[10px] bg-[rgba(244,238,218,0.55)] font-mono text-[11px] uppercase tracking-[0.22em] text-onlight";

/** A typed amount in raw units, 0 for a half-typed or empty field. Display and gating only. */
function parseAmount(text: string, decimals: number): bigint {
  if (text === "" || text === ".") return 0n;
  try {
    return toBase(text, decimals);
  } catch {
    return 0n;
  }
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-ink-50">{label}</span>
      <span className="text-right tabular-nums">{children}</span>
    </div>
  );
}

export default function LaunchForm() {
  const router = useRouter();
  const { address, isConnected, signed, withSignIn, addToast, updateToast } = useAppState();
  const publicClient = usePublicClient({ chainId: robinhoodChain.id });
  const { data: walletClient } = useWalletClient({ chainId: robinhoodChain.id });
  const quotesQuery = useQuotes();
  const currencies = useMemo(() => orderCurrencies(quotesQuery.data ?? []), [quotesQuery.data]);

  const [image, setImage] = useState<File | null>(null);
  const [imageNote, setImageNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [x, setX] = useState("");
  const [telegram, setTelegram] = useState("");
  const [picked, setPicked] = useState<Address | null>(null);
  const [preset, setPreset] = useState<number | "custom">(0);
  const [custom, setCustom] = useState("");
  const [firstBuy, setFirstBuy] = useState("");
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [payout, setPayout] = useState("");
  const [salt, setSalt] = useState<Hex>(() => randomSalt());
  const [pending, setPending] = useState(false);
  const [plan, setPlan] = useState<SubmitStep[]>([]);
  const [current, setCurrent] = useState<SubmitStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const resumeAfterSignIn = useRef(false);
  const uploadCache = useRef<{ key: string; answer: UploadAnswer; at: number } | null>(null);

  // The currency: USDG until the creator picks another.
  const asset = currencies.find((q) => q.address.toLowerCase() === (picked ?? USDG).toLowerCase()) ?? currencies[0];
  const quote = asset?.address;
  const decimals = asset?.decimals ?? 18;
  const usd = asset && hasUsdPrice(asset) ? asset.usdPrice : null;

  const settings = useLaunchSettings(address);
  const bounds = useCurrencyConfig(quote);
  const presets = bounds ? presetValuations(bounds.min, bounds.max) : [];
  const requested: bigint | null =
    preset === "custom"
      ? usd !== null
        ? usdToRaw(custom, usd, decimals)
        : custom === "" ? null : parseAmount(custom, decimals) || null
      : (presets[preset] ?? null);
  const inRange = requested !== null && bounds !== undefined && requested >= bounds.min && requested <= bounds.max;
  const opening = useOpening({ account: address, salt, name, symbol, quote, valuation: inRange ? requested : null });
  const snapped = inRange ? opening.snapped : undefined;
  const balance = useTokenBalanceOf(quote, address);

  // Never a default for a setting: until the contract has answered, the button says so (no silent 0 bps or 0 % cap).
  const routerFeeBps = settings.routerFeeBps;
  const capBps = settings.firstBuyCapBps;
  const settingsRead =
    routerFeeBps !== undefined && capBps !== undefined && settings.creatorShareBps !== undefined && settings.hook !== undefined;
  const hookSet = settings.hook !== undefined && settings.hook.toLowerCase() !== ZERO_ADDRESS;
  const creationFee = bounds?.creationFee ?? 0n;
  const firstBuyRaw = parseAmount(firstBuy, decimals);
  const total = firstBuyRaw + creationFee;
  const estimate = snapped && routerFeeBps !== undefined ? estimateFirstBuyTokens(firstBuyRaw, snapped, routerFeeBps) : 0n;
  const capGross = snapped && routerFeeBps !== undefined && capBps !== undefined ? firstBuyCapGross(snapped, capBps, routerFeeBps) : null;
  const maxBuy = maxFirstBuy(balance, creationFee, capGross);
  const rawFields: LaunchFields = { name, symbol, description, website, x, telegram };
  const checked = validateFields(rawFields);
  const payoutAddress = (payoutOpen && payout !== "" ? payout : address) as Address | undefined;

  /** Whole dollars when the currency has a USD price, else the currency's own units. */
  const money = (raw: bigint) => {
    const n = rawToNumber(raw, decimals);
    return usd !== null ? `$${fmtInt(n * usd)}` : `${fmtAmt(n)} ${asset?.symbol ?? ""}`;
  };
  const units = (raw: bigint) => `${fmtAmt(rawToNumber(raw, decimals))} ${asset?.symbol ?? ""}`;
  const perToken = (raw: bigint) => {
    const p = pricePerToken(raw, decimals) * (usd ?? 1);
    // Below $0.0001 fmtPrice's 8 decimals would print $0.00000500; four significant digits, never exponent notation,
    // print a launch's typical opening price as $0.000004995.
    const text = p >= 0.0001 || p <= 0 ? fmtPrice(p).slice(1) : p.toFixed(Math.min(20, 3 - Math.floor(Math.log10(p))));
    return usd !== null ? `$${text}` : `${text} ${asset?.symbol ?? ""}`;
  };

  function reasonText(): string | null {
    if (!isConnected || !address) return "Connect a wallet to launch.";
    if (settings.allowed === undefined) return "Checking your wallet.";
    if (!settings.allowed) return "Launching is open to Suits holders.";
    if (!settingsRead) return "Reading the launchpad's settings.";
    // The contracts README promises it: no launch through the app while a hook is set on the launchpad.
    if (hookSet) return "Launches are paused while a hook is set.";
    if (settings.launchesToday !== undefined && settings.dailyLimit !== undefined && settings.launchesToday >= settings.dailyLimit) {
      return "You have used today's launches.";
    }
    if (!image || name === "" || symbol === "") return "Add an image, a name and a symbol.";
    if (!checked.ok) {
      return checked.field === "name" || checked.field === "symbol"
        ? `The name fits ${NAME_MAX_BYTES} bytes and the symbol ${SYMBOL_MAX_BYTES}.`
        : "Check the description and the links.";
    }
    if (!bounds) return "Reading this currency's limits.";
    if (!inRange) return `Pick a valuation between ${money(bounds.min)} and ${money(bounds.max)}.`;
    if (balance !== undefined && total > balance) return "The first buy is more than your balance.";
    if (firstBuyRaw > 0n && capBps !== undefined && estimate > capTokens(capBps)) return "The first buy is above the cap.";
    if (payoutOpen && payout !== "" && !isAddress(payout)) return "Enter a valid payout address.";
    if (!snapped) return "Working out the opening price.";
    return null;
  }
  const reason = reasonText();

  const onImage = (file: File | null) => {
    setImageNote(null);
    if (preview && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(preview);
    setPreview(null);
    setImage(null);
    if (!file) return;
    // A courtesy only: the route re-checks the bytes themselves (spec 6 step 7).
    if (!IMAGE_TYPES.includes(file.type)) return setImageNote("Use a PNG, JPEG, WebP or GIF.");
    if (file.size > IMAGE_MAX_BYTES) return setImageNote("The image is larger than 2 MB.");
    setImage(file);
    if (typeof URL.createObjectURL === "function") setPreview(URL.createObjectURL(file));
  };

  /**
   * Step 2: the answer is kept for this image and these fields, refreshed after 12 hours (spec 7.2). `now` comes from the
   * click (or the resume effect), never read here: the component body stays free of clock reads.
   */
  async function uploadOnce(fields: LaunchFields, file: File, now: number): Promise<UploadAnswer> {
    const key = uploadKey(fields, file);
    const cached = uploadCache.current;
    if (cached && cached.key === key && now - cached.at < UPLOAD_REUSE_MS) return cached.answer;
    const answer = await uploadLaunchAssets(fields, file);
    uploadCache.current = { key, answer, at: now };
    return answer;
  }

  const submit = async (now: number) => {
    if (inFlight.current || reason !== null || !address || !walletClient || !publicClient || !quote || !image || !snapped || requested === null || !payoutAddress) return;
    const walletSteps: SubmitStep[] = ["upload", ...(total > 0n ? (["approve", "sign"] as const) : []), "confirm", "launching"];
    setError(null);
    if (!signed) {
      // Step 1: the existing SignModal through AppState's gate. The effect below resumes once `signed` flips.
      setPlan(["sign-in", ...walletSteps]);
      setCurrent("sign-in");
      resumeAfterSignIn.current = true;
      // Closed without signing: drop the queued launch and the step list, so nothing resumes on a later, unrelated sign-in.
      withSignIn("launch", () => {}, () => {
        resumeAfterSignIn.current = false;
        setCurrent(null);
        setPlan([]);
      });
      return;
    }
    inFlight.current = true;
    setPending(true);
    setPlan((p) => (p[0] === "sign-in" ? ["sign-in", ...walletSteps] : walletSteps));
    let toastId: number | null = null;
    try {
      setCurrent("upload");
      const answer = await uploadOnce(rawFields, image, now);
      const handle = await executeLaunch(
        {
          name, symbol, metadataUri: answer.metadataUri, quote, valuation: requested, firstBuy: firstBuyRaw,
          minFirstBuyTokens: firstBuyRaw > 0n ? minFirstBuyTokens(estimate) : 0n, payout: payoutAddress, salt, creationFee,
        },
        { wallet: walletClient, publicClient, account: address },
        setCurrent,
      );
      toastId = addToast({ kind: "pending", message: `Launching ${symbol}`, hash: handle.hash });
      const { token } = await handle.confirmation;
      updateToast(toastId, { kind: "confirmed", message: `Launched ${symbol}` });
      router.push(`/t/${token}?launched=${handle.hash}`);
    } catch (err) {
      const known = err instanceof UploadError || err instanceof LaunchFailedError || err instanceof LaunchRejectedError || err instanceof LaunchUnconfirmedError;
      const message = known ? (err as Error).message : LAUNCH_MESSAGES.launchFallback;
      // Someone initialised this token's pool key first (spec 4.10): a new salt is a new address and a new key.
      if (err instanceof LaunchFailedError && err.revert === "PoolAlreadyInitialized") setSalt(randomSalt());
      setError(message);
      if (toastId !== null) updateToast(toastId, { kind: err instanceof LaunchUnconfirmedError ? "unconfirmed" : "failed", message });
    } finally {
      inFlight.current = false;
      setPending(false);
      setCurrent(null);
    }
  };

  // The submit closes over this render's state, so the resume after sign-in must call the newest one.
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });
  useEffect(() => {
    if (signed && resumeAfterSignIn.current) {
      resumeAfterSignIn.current = false;
      void submitRef.current(Date.now());
    }
  }, [signed]);

  const nameBytes = utf8Bytes(name);
  const symbolBytes = utf8Bytes(symbol);
  const shareBps = settings.creatorShareBps;
  const onAmount = (setter: (v: string) => void) => (raw: string) => {
    if (AMOUNT_RE.test(raw)) setter(raw);
  };

  return (
    <div className="mt-5 flex flex-col gap-6 twocol:flex-row twocol:items-start twocol:gap-8">
      <div className="w-full min-w-0 flex-1">
        <label className={LABEL} htmlFor="launch-image">
          <span>Image</span>
          <span className="normal-case tracking-[0.04em]">PNG, JPEG, WebP or GIF, 2 MB at most</span>
        </label>
        <div className="mt-2 flex items-center gap-4">
          <div className="flex h-24 w-24 flex-none items-center justify-center border border-hairline-strong">
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local object URL of the picked file, nothing to optimise
              <img src={preview} alt="" width={96} height={96} className="h-24 w-24 object-cover" />
            ) : (
              <span className="font-mono text-[10px] text-ink-40">96 × 96</span>
            )}
          </div>
          <input id="launch-image" type="file" accept={IMAGE_TYPES.join(",")} aria-label="Image" onChange={(e) => onImage(e.target.files?.[0] ?? null)} className="text-[12px]" />
        </div>
        {imageNote ? <div className="mt-2 font-mono text-[10.5px] text-down">{imageNote}</div> : null}

        <label className={`${LABEL} mt-5`} htmlFor="launch-name">
          <span>Name</span>
          <span className="normal-case tracking-[0.04em]">{nameBytes}/{NAME_MAX_BYTES} bytes</span>
        </label>
        <input id="launch-name" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} className={INPUT} autoComplete="off" />

        <label className={`${LABEL} mt-4`} htmlFor="launch-symbol">
          <span>Symbol</span>
          <span className="normal-case tracking-[0.04em]">{symbolBytes}/{SYMBOL_MAX_BYTES} bytes</span>
        </label>
        <input id="launch-symbol" aria-label="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} className={INPUT} autoComplete="off" />

        <label className={`${LABEL} mt-4`} htmlFor="launch-description">
          <span>Description</span>
          <span className="normal-case tracking-[0.04em]">{[...description].length}/{DESCRIPTION_MAX_CHARS}</span>
        </label>
        <textarea
          id="launch-description"
          aria-label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="mt-2 w-full border border-hairline-strong bg-transparent px-3 py-2 text-[13px] outline-none focus:border-hairline-focus"
        />

        {(
          [
            ["Website", website, setWebsite, "https://"],
            ["X", x, setX, "handle or x.com link"],
            ["Telegram", telegram, setTelegram, "name or t.me link"],
          ] as const
        ).map(([label, value, setter, hint]) => (
          <div key={label}>
            <label className={`${LABEL} mt-4`} htmlFor={`launch-${label}`}>
              <span>{label}</span>
              <span className="normal-case tracking-[0.04em]">optional</span>
            </label>
            <input id={`launch-${label}`} aria-label={label} value={value} placeholder={hint} onChange={(e) => setter(e.target.value)} className={INPUT} autoComplete="off" />
          </div>
        ))}

        <div className={`${LABEL} mt-5`}>
          <span>Currency</span>
        </div>
        <CurrencySelect
          quotes={currencies}
          value={quote ?? null}
          onChange={(a) => {
            setPicked(a);
            setPreset(0);
            setCustom("");
            setFirstBuy("");
          }}
        />

        <div className={`${LABEL} mt-5`}>
          <span>Opening valuation</span>
          {bounds ? <span className="normal-case tracking-[0.04em]">{money(bounds.min)} to {money(bounds.max)}</span> : null}
        </div>
        <div role="group" aria-label="Opening valuation" className="no-scrollbar mt-2 flex overflow-x-auto border border-hairline-strong">
          {presets.map((v, i) => (
            <button
              key={i}
              type="button"
              aria-pressed={preset === i}
              onClick={() => setPreset(i)}
              className={`h-7 flex-1 whitespace-nowrap border-r border-hairline-mid px-3 font-mono text-[10.5px] ${preset === i ? "bg-chalk-10 text-chalk" : "bg-transparent text-ink-60"}`}
            >
              {money(v)}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={preset === "custom"}
            onClick={() => setPreset("custom")}
            className={`h-7 flex-1 px-3 font-mono text-[10.5px] ${preset === "custom" ? "bg-chalk-10 text-chalk" : "bg-transparent text-ink-60"}`}
          >
            Custom
          </button>
        </div>
        {preset === "custom" ? (
          <div className="mt-2 flex h-10 items-center border border-hairline-strong focus-within:border-hairline-focus">
            <input
              aria-label="Custom valuation"
              inputMode="decimal"
              autoComplete="off"
              value={custom}
              onChange={(e) => onAmount(setCustom)(e.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent px-3 font-mono text-[13px] tabular-nums outline-none"
            />
            <span className="pr-3 font-mono text-[11px] text-ink-45">{usd !== null ? "USD" : asset?.symbol}</span>
          </div>
        ) : null}
        <div className="mt-2 font-mono text-[11px] text-ink-60" aria-live="polite">
          {snapped ? `Opens at ${money(snapped)} · ${perToken(snapped)} per token` : opening.pending && inRange ? "Working out the opening price…" : ""}
        </div>

        <label className={`${LABEL} mt-5`} htmlFor="launch-first-buy">
          <span>First buy</span>
          <span className="normal-case tracking-[0.04em]">Balance {balance !== undefined ? units(balance) : "—"}</span>
        </label>
        <div className="mt-2 flex h-10 items-center border border-hairline-strong focus-within:border-hairline-focus">
          <input
            id="launch-first-buy"
            aria-label="First buy"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={firstBuy}
            onChange={(e) => onAmount(setFirstBuy)(e.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent px-3 font-mono text-[13px] tabular-nums outline-none"
          />
          <button
            type="button"
            disabled={maxBuy === null}
            onClick={() => maxBuy !== null && setFirstBuy(toHuman(maxBuy, decimals))}
            className="mr-2 h-7 border border-hairline-mid bg-transparent px-[10px] font-mono text-[10.5px] text-ink-70 hover:border-hairline-hover hover:text-ink"
          >
            Max
          </button>
          <span className="pr-3 font-mono text-[11px] text-ink-45">{asset?.symbol}</span>
        </div>
        {firstBuyRaw > 0n && snapped ? (
          <div className="mt-2 font-mono text-[11px] text-ink-60">
            About {fmtAmt(rawToNumber(estimate, 18), 0)} tokens, {shareOfSupplyPct(estimate).toFixed(2)} % of supply
          </div>
        ) : null}

        <button type="button" onClick={() => setPayoutOpen((o) => !o)} aria-expanded={payoutOpen} className={`${LABEL} mt-5 w-full bg-transparent p-0`}>
          <span>Fee payout</span>
          <span className="normal-case tracking-[0.04em]">{payoutOpen ? "Another address" : "Your wallet"}</span>
        </button>
        {payoutOpen ? (
          <input aria-label="Payout address" placeholder="0x…" value={payout} onChange={(e) => setPayout(e.target.value.trim())} className={INPUT} autoComplete="off" spellCheck={false} />
        ) : null}
      </div>

      <div className="w-full flex-none twocol:w-[360px]">
        <div className="border border-hairline p-4 font-mono text-[11.5px]">
          <Row label="Opening valuation">{snapped ? money(snapped) : "—"}</Row>
          <Row label="Opening price">{snapped ? perToken(snapped) : "—"}</Row>
          <Row label="First buy">{firstBuyRaw > 0n ? units(firstBuyRaw) : "None"}</Row>
          {firstBuyRaw > 0n && routerFeeBps !== undefined ? (
            <div className="pb-1 text-right text-[10.5px] text-ink-45">
              of which router fee {units(routerFeeOf(firstBuyRaw, routerFeeBps))} at {(routerFeeBps / 100).toFixed(2)} %
            </div>
          ) : null}
          <Row label="Creation fee">{creationFee === 0n ? "Free" : units(creationFee)}</Row>
          <Row label="You pay">{total === 0n ? "Gas only" : units(total)}</Row>
          <div className="mt-3 border-t border-hairline-soft pt-3 text-[11px] leading-[1.5] text-ink-60">
            {shareBps !== undefined ? <div>{`${shareBps / 100} % of trading fees to your payout address`}</div> : null}
            {settings.dailyLimit !== undefined && settings.launchesToday !== undefined ? (
              <div className="mt-1">{`${Math.max(0, settings.dailyLimit - settings.launchesToday)} of ${settings.dailyLimit} left today. The count resets at 00:00 UTC.`}</div>
            ) : null}
            <div className="mt-1">{RULE_OF_THUMB}</div>
          </div>

          {pending ? (
            <button type="button" disabled className={PENDING}>
              <Spinner dark />
              {current ? STEP_LABELS[current] : "Launch"}
            </button>
          ) : (
            <button type="button" disabled={reason !== null} onClick={() => void submit(Date.now())} className={reason === null ? PRIMARY : DISABLED}>
              Launch
            </button>
          )}
          {reason !== null && !pending ? <div className="mt-2 text-center text-[10.5px] text-ink-50">{reason}</div> : null}
          {error ? (
            <div role="alert" className="mt-2 text-center text-[10.5px] text-down">
              {error}
            </div>
          ) : null}
          {current !== null && plan.length > 0 ? (
            <ol className="mt-3 space-y-1 text-[10.5px]">
              {plan.map((step, i) => {
                const at = plan.indexOf(current);
                const state = i < at ? "done" : i === at ? "now" : "next";
                return (
                  <li key={step} className={`flex items-center gap-2 ${state === "next" ? "text-ink-40" : "text-ink"}`}>
                    <span className="w-3">{state === "done" ? "✓" : state === "now" ? <Spinner /> : `${i + 1}`}</span>
                    {STEP_LABELS[step]}
                  </li>
                );
              })}
            </ol>
          ) : null}
        </div>
      </div>
    </div>
  );
}
```

Notes for the implementer. The pending button names the current step, so no button is named "Launch" while a launch is in flight; that is what the double-press test's last line checks. The in-flight guard is a ref, set synchronously before the first `await`, because three clicks in one tick all reach the same `submit` before React re-renders. `presets.map` keys by index because two presets can be equal once clamped to the maximum. `setCurrent` is passed to `executeLaunch` as its `onStep`, which is why `SubmitStep` includes every `LaunchStep`. The resume after sign-in goes through `submitRef` in an effect keyed on `signed`, never through the gate's callback: the callback would run the render's old closure, where `signed` is still false.

- [ ] **Step 9: Run it to verify it passes**

Run: `npx vitest run src/components/LaunchForm.test.tsx`
Expected: PASS.

- [ ] **Step 10: Write the failing page test**

Create `src/app/launch/page.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/dom";
import LaunchPage, { metadata } from "./page";

const h = vi.hoisted(() => ({ live: false }));
vi.mock("@/lib/launch/address", () => ({ hasLaunchpad: () => h.live, LAUNCHPAD_ADDRESS: undefined }));
vi.mock("@/components/LaunchForm", () => ({ default: () => <div>the launch form</div> }));

describe("/launch (instant launchpad design, section 7.2)", () => {
  it("is titled Launch", () => {
    expect(metadata.title).toBe("Launch");
  });

  it("shows only the not-live card while the launchpad address is unset", () => {
    h.live = false;
    render(<LaunchPage />);
    expect(screen.getByText("Launching is not live yet")).toBeTruthy();
    expect(screen.getByText("Token launches open here once the launchpad contract is deployed.")).toBeTruthy();
    expect(screen.queryByText("the launch form")).toBeNull();
  });

  it("shows the form once it is set", () => {
    h.live = true;
    render(<LaunchPage />);
    expect(screen.getByText("the launch form")).toBeTruthy();
    expect(screen.queryByText("Launching is not live yet")).toBeNull();
  });
});
```

- [ ] **Step 11: Run it to verify it fails**

Run: `npx vitest run src/app/launch/page.test.tsx`
Expected: FAIL with "Failed to resolve import "./page"".

- [ ] **Step 12: Write the page**

Create `src/app/launch/page.tsx`:

```tsx
import type { Metadata } from "next";
import LaunchForm from "@/components/LaunchForm";
import { hasLaunchpad } from "@/lib/launch/address";

export const metadata: Metadata = { title: "Launch" };

/** Spec 7.2: while NEXT_PUBLIC_LAUNCHPAD_ADDRESS is unset the page shows only this card, in TradePanel's card recipe. */
function NotLive() {
  return (
    <div className="mt-5 border border-hairline px-[22px] py-[34px] text-center">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-40">Launch</div>
      <div className="mb-2 mt-3 text-[17px]">Launching is not live yet</div>
      <div className="text-pretty text-[12.5px] leading-[1.5] text-ink-50">Token launches open here once the launchpad contract is deployed.</div>
    </div>
  );
}

export default function LaunchPage() {
  return (
    <section className="px-4 pb-8 tablet:px-5 desktop:px-6">
      <div className="mt-[18px] flex items-baseline gap-[14px]">
        <h1 className="text-[18px] font-medium tracking-[-0.01em]">Launch a token</h1>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-40">Uniswap v4 · Robinhood Chain</span>
      </div>
      {hasLaunchpad() ? <LaunchForm /> : <NotLive />}
    </section>
  );
}
```

- [ ] **Step 13: Run it to verify it passes, then the gates with the build (this task adds a page)**

Run: `npx vitest run src/app/launch src/components`
Expected: PASS.
Then: `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src`, `npm run build`. All clean; the build lists `/launch`.

- [ ] **Step 14: Commit**

```bash
git add src/context/AppState.tsx src/components/SignModal.tsx src/components/SignModal.test.tsx src/components/TopBar.tsx src/components/TopBar.test.tsx src/components/CurrencySelect.tsx src/components/LaunchForm.tsx src/components/LaunchForm.test.tsx src/app/launch
git commit -m "Launchpad: /launch, the one-transaction launch form with the live preview, and the Launch nav entry"
```

---

### Task 9: The token page, the SV filter, README and `.env.example`

**Files:**
- Modify: `src/hooks/useMarketsData.ts:30-46` (`usePair` re-reads a listed SV token by id, and waits for a just-launched one), `src/hooks/useMarketsData.test.tsx`
- Modify: `src/app/t/[address]/page.tsx:10-12, 88-104` (`searchParams.launched`)
- Modify: `src/components/TokenView.tsx` (the indexing wait, the fee panel), `src/components/TokenView.test.tsx`
- Modify: `src/components/TokenHeader.tsx:59` (the chip); Create: `src/components/TokenHeader.test.tsx`
- Modify: `src/components/ActivityTabs.tsx:182-209` (the launch rows), `src/components/ActivityTabs.test.tsx`
- Create: `src/components/LaunchFeesPanel.tsx`, `src/components/LaunchFeesPanel.test.tsx`
- Modify: `src/lib/markets.ts:36-45` (`ORIGIN_OPTIONS`), `src/lib/markets.test.ts`
- Modify: `README.md` (Routes, the variables table, Layout, a launchpad paragraph), `scripts/README.md` (one command row), `.env.example` (five names)

**Interfaces:**
- Consumes: `LaunchInfo`, `TokenPair.launch` (Task 4); `useLaunchFees`, `PendingFees` (Task 7); `collectLaunchFees`, `claimOwed`, `changePayout`, `LaunchFailedError`, `LaunchRejectedError`, `LaunchUnconfirmedError`, `LAUNCH_MESSAGES`, `WriteHandle`, `LaunchDeps` (Task 7); `txUrl`, `addressUrl` (`src/lib/chain.ts:44-50`); `toHuman` (`src/lib/quote/math.ts:106`); `Badge`, `Spinner` (`src/components/ui.tsx`).
- Produces:
  ```ts
  // src/hooks/useMarketsData.ts
  export const LAUNCH_WAIT_POLL_MS = 5_000; export const LAUNCH_WAIT_MAX_MS = 300_000;
  export function usePair(id: string, opts?: { launched?: boolean }): /* unchanged shape */;
  // src/components/TokenView.tsx
  export default function TokenView(props: { address: string; launchedTx?: Hex }): JSX.Element;
  // src/components/LaunchFeesPanel.tsx
  export default function LaunchFeesPanel(props: { pair: TokenPair; launch: LaunchInfo; now: number }): JSX.Element;
  ```

Before editing the page, read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md` (Global Constraints): in this Next.js, `searchParams` is a Promise, awaited like `params`.

- [ ] **Step 1: Write the failing hook tests**

A listed row comes from the 500-row list, which never carries `launch` (spec 5.5), so the token page of a listed SV token must read the single-token answer as well; and a page opened by `/launch`'s redirect keeps asking while the reader catches up (spec 7.3).

Edit `src/hooks/useMarketsData.test.tsx`. Replace lines 3-15 (the two type/runtime imports from `@/lib/types` and `./useMarketsData`):

```ts
import type { Address, Candle, HoldersView, Interval, TraderRow } from "@/lib/types";
import { queryHarness, renderHook, waitFor } from "@/test/dom";
import {
  HOLDERS_FAST_POLL_MS,
  HOLDERS_POLL_MS,
  HOLDERS_SLOW_POLL_MS,
  keys,
  useChartCandles,
  useHolders,
  useTraders,
  useVotes,
  useWatchlist,
} from "./useMarketsData";
```

with:

```ts
import type { Address, Candle, HoldersView, Interval, LaunchInfo, TokenPair, TraderRow } from "@/lib/types";
import { act, queryHarness, renderHook, waitFor } from "@/test/dom";
import {
  HOLDERS_FAST_POLL_MS,
  HOLDERS_POLL_MS,
  HOLDERS_SLOW_POLL_MS,
  LAUNCH_WAIT_MAX_MS,
  LAUNCH_WAIT_POLL_MS,
  keys,
  useChartCandles,
  useHolders,
  usePair,
  useTraders,
  useVotes,
  useWatchlist,
} from "./useMarketsData";
```

In `h.ds` (lines 28-34) add two members:

```ts
    pairs: vi.fn<() => Promise<TokenPair[]>>(),
    pair: vi.fn<(id: string) => Promise<TokenPair | null>>(),
```

Append at the end of the file:

```ts
describe("usePair and the instant launchpad (spec 5.5 and 7.3)", () => {
  const SV = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
  const row = (origin: TokenPair["origin"]) => ({ id: SV, ticker: "CHALK", origin }) as TokenPair;
  const LAUNCH = { creator: "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1" } as unknown as LaunchInfo;

  beforeEach(() => {
    h.ds.pairs.mockReset();
    h.ds.pair.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("re-reads a listed SV token by id, since only the single-token answer carries its launch block", async () => {
    h.ds.pairs.mockResolvedValue([row("SV")]);
    h.ds.pair.mockResolvedValue({ ...row("SV"), launch: LAUNCH });
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => usePair(SV), { wrapper });
    await waitFor(() => expect(result.current.pair?.launch).toEqual(LAUNCH));
    expect(h.ds.pair).toHaveBeenCalledWith(SV);
  });

  it("never re-reads a listed token of another origin", async () => {
    h.ds.pairs.mockResolvedValue([row("LONG")]);
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => usePair(SV), { wrapper });
    await waitFor(() => expect(result.current.pair?.origin).toBe("LONG"));
    expect(h.ds.pair).not.toHaveBeenCalled();
  });

  it("asks every 5 s while a just-launched token is not indexed, stops once it arrives, and gives up after five minutes", async () => {
    expect([LAUNCH_WAIT_POLL_MS, LAUNCH_WAIT_MAX_MS]).toEqual([5_000, 300_000]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.ds.pairs.mockResolvedValue([]);
    h.ds.pair.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...row("SV"), launch: LAUNCH });
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => usePair(SV, { launched: true }), { wrapper });
    await waitFor(() => expect(h.ds.pair).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LAUNCH_WAIT_POLL_MS);
    });
    await waitFor(() => expect(result.current.pair?.launch).toEqual(LAUNCH));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * LAUNCH_WAIT_POLL_MS);
    });
    expect(h.ds.pair).toHaveBeenCalledTimes(2);

    h.ds.pair.mockReset().mockResolvedValue(null);
    const late = renderHook(() => usePair("0x" + "5b".repeat(20), { launched: true }), { wrapper: queryHarness().wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LAUNCH_WAIT_MAX_MS + LAUNCH_WAIT_POLL_MS);
    });
    const asked = h.ds.pair.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * LAUNCH_WAIT_POLL_MS);
    });
    expect(h.ds.pair.mock.calls.length).toBe(asked);
    expect(late.result.current.pair).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/hooks/useMarketsData.test.tsx`
Expected: FAIL: `LAUNCH_WAIT_POLL_MS` is not exported, a listed SV row is never re-read, and nothing polls.

- [ ] **Step 3: Write the hook change**

Edit `src/hooks/useMarketsData.ts`. Line 3 already imports `useEffect` and `useRef` (for `useHolders`), so no import changes. Replace `usePair` (lines 30-46) with:

```ts
/** Spec 7.3: how often, and for how long, a page opened by /launch's redirect asks again while the reader catches up. */
export const LAUNCH_WAIT_POLL_MS = 5_000;
export const LAUNCH_WAIT_MAX_MS = 300_000;

export function usePair(id: string, opts: { launched?: boolean } = {}) {
  const ds = useDataSource();
  const query = usePairs();
  const key = id.toLowerCase();
  const listed: TokenPair | undefined = query.data?.find((p) => p.id === key);
  // Spec 5.5: the `launch` block rides only on the single-token answer, never the 500-row list, so a listed SV token is
  // read by id as well. Every other listed token needs nothing more than its row.
  const needsSingle = listed === undefined || listed.origin === "SV";
  // Stamped in an effect, like useHolders' window: reading the clock while rendering is impure.
  const waitingSince = useRef(0);
  useEffect(() => {
    waitingSince.current = Date.now();
  }, [key]);
  const launched = opts.launched === true;
  // Only once the list has settled without the id: a token outside the 500-row window still has a page.
  const fallback = useQuery({
    queryKey: keys.pair(key),
    queryFn: () => ds.pair(key),
    staleTime: 30_000,
    enabled: !query.isPending && needsSingle,
    refetchInterval: (q) => {
      if (!launched || q.state.data) return false;
      const since = waitingSince.current;
      return since > 0 && Date.now() - since >= LAUNCH_WAIT_MAX_MS ? false : LAUNCH_WAIT_POLL_MS;
    },
  });
  const pair: TokenPair | undefined = listed?.origin === "SV" ? (fallback.data ?? listed) : (listed ?? fallback.data ?? undefined);
  // TokenView reads isPending for its skeleton; both flags cover both queries, so a deep link never flashes "No token"
  // while the fallback is still in flight, and a listed row already in hand never flashes the skeleton.
  const waiting = pair === undefined && fallback.isLoading;
  return { ...query, pair, isPending: query.isPending || waiting, isLoading: query.isLoading || waiting };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/hooks/useMarketsData.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing token-page tests**

Edit `src/components/TokenView.test.tsx`. Replace line 1:

```ts
import { describe, expect, it, vi } from "vitest";
```

with:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { txUrl } from "@/lib/chain";
```

Replace line 2:

```ts
import type { Interval, TokenPair } from "@/lib/types";
```

with:

```ts
import type { Interval, LaunchInfo, TokenPair } from "@/lib/types";
```

Replace line 4:

```ts
import { fireEvent, render, screen } from "@/test/dom";
```

with:

```ts
import { act, fireEvent, render, screen } from "@/test/dom";
```

The file's existing `vi.mock("@/hooks/useMarketsData", …)` factory (lines 15-17) replaces the whole module, and `TokenView` now imports `LAUNCH_WAIT_MAX_MS` from it; replace that factory with:

```ts
vi.mock("@/hooks/useMarketsData", () => ({
  LAUNCH_WAIT_MAX_MS: 300_000,
  usePair: () => ({ pair: h.pair, isPending: h.isPending, dataUpdatedAt: 0 }),
}));
```

After the `vi.mock("./ActivityTabs", …)` line (line 20) add:

```ts
vi.mock("./LaunchFeesPanel", () => ({ default: () => <div>the fee panel</div> }));
```

Append at the end of the file:

```ts
describe("TokenView and the instant launchpad (spec 7.3)", () => {
  const TX = `0x${"11".repeat(32)}` as `0x${string}`;
  afterEach(() => vi.useRealTimers());

  it("waits for a just-launched token with its transaction link, then falls back to the usual text after five minutes, link kept", () => {
    vi.useFakeTimers();
    h.pair = undefined;
    h.isPending = false;
    render(<TokenView address={PAIR_A.id} launchedTx={TX} />);
    expect(screen.getByText("Your token is live on chain. Its page fills in within about two minutes.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /View the launch transaction/ }).getAttribute("href")).toBe(txUrl(TX));
    act(() => {
      vi.advanceTimersByTime(300_000);
    });
    expect(screen.getByText(/No token at/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /View the launch transaction/ }).getAttribute("href")).toBe(txUrl(TX));
  });

  it("keeps today's text, with no link, without a launch", () => {
    h.pair = undefined;
    h.isPending = false;
    render(<TokenView address={PAIR_A.id} />);
    expect(screen.getByText(/No token at/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /View the launch transaction/ })).toBeNull();
  });

  it("shows the fee panel for a token launched here, and nothing for any other", () => {
    h.isPending = false;
    h.pair = { ...PAIR_A, launch: { creator: "0xc1" } as unknown as LaunchInfo } as TokenPair;
    const { rerender } = render(<TokenView address={PAIR_A.id} />);
    expect(screen.getByText("the fee panel")).toBeTruthy();
    h.pair = { ...PAIR_A, launch: null } as TokenPair;
    rerender(<TokenView address={PAIR_A.id} />);
    expect(screen.queryByText("the fee panel")).toBeNull();
  });
});
```

Create `src/components/TokenHeader.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import type { LaunchInfo, TokenPair } from "@/lib/types";
import { render, screen } from "@/test/dom";
import TokenHeader from "./TokenHeader";

vi.mock("@/context/AppState", () => ({
  useAppState: () => ({ stars: new Set(), toggleStar: vi.fn(), votes: {}, vote: vi.fn(), votePending: new Set() }),
}));

const pair = {
  id: "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a", ticker: "CHALK", name: "Tailor's Chalk", address: "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a",
  quote: "USDG", origin: "SV", tradeable: true, priceUsd: 0.000005, priceQuote: 0.000005, change1h: null, change24h: null, vol24h: 0, mcap: 0,
  fdv: 0, liquidity: 0, holders: 1, createdAt: 0, bull: 0, bear: 0, poolId: "0x01", hook: "None", hookAddress: "0x0000000000000000000000000000000000000000",
  feeTier: "1.00%",
} as TokenPair;

describe("TokenHeader (spec 7.3)", () => {
  it("adds a LAUNCHED HERE chip beside the SV badge for a token launched here", () => {
    render(<TokenHeader pair={{ ...pair, launch: { creator: "0xc1" } as unknown as LaunchInfo }} />);
    expect(screen.getByText("SV")).toBeTruthy();
    expect(screen.getByText("LAUNCHED HERE")).toBeTruthy();
  });
  it("shows no chip otherwise", () => {
    render(<TokenHeader pair={{ ...pair, origin: "LONG", launch: null }} />);
    expect(screen.queryByText("LAUNCHED HERE")).toBeNull();
  });
});
```

Edit `src/components/ActivityTabs.test.tsx`. Replace lines 2-4:

```ts
import { addressUrl, ZERO_ADDRESS } from "@/lib/chain";
import { fmtAmt, fmtUsdOrDash, short } from "@/lib/format";
import type { Address, Holder, HoldersView, TokenPair, Trade } from "@/lib/types";
```

(the second line as Task 4 left it) with:

```ts
import { addressUrl, txUrl, ZERO_ADDRESS } from "@/lib/chain";
import { ageHours, fmtAge, fmtAmt, fmtISODate, fmtUsd, fmtUsdOrDash, short } from "@/lib/format";
import type { Address, Holder, HoldersView, LaunchInfo, TokenPair, Trade } from "@/lib/types";
```

Append at the end of the file:

```ts
describe("ActivityTabs: the launch rows (spec 7.3)", () => {
  const CREATOR = "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1" as Address;
  const PAYOUT = "0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2" as Address;
  const LAUNCH_TX = `0x${"33".repeat(32)}` as `0x${string}`;
  const LAUNCHED_AT = 1_999_990_000; // seconds; NOW_MS is 2_000_000_000_000
  const launch: LaunchInfo = {
    creator: CREATOR, payout: PAYOUT, quoteAddress: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address, quoteDecimals: 6,
    tokenIsCurrency0: false, openTick: 398_400, openingValuation: "4995430000", firstBuyIn: "99500000", firstBuyTokens: "19000000000000000000000000",
    creatorShareBps: 7000, launchedAt: LAUNCHED_AT, launchBlock: 100, launchTx: LAUNCH_TX, hidden: false, imageCid: "bafyimg",
    description: "", website: "https://chalk.test", x: "https://x.com/chalk", telegram: "https://t.me/chalks", routerFee: "500000",
    feesCollected: { tokenToPayout: "0", tokenToPlatform: "0", quoteToPayout: "0", quoteToPlatform: "0" }, feesCollectedAt: 0,
  };
  const launched: TokenPair = { ...pair, ticker: "CHALK", quote: "USDG", origin: "SV", priceUsd: 0.000005, priceQuote: 0.000005, launch };
  const info = (p: TokenPair) => render(<ActivityTabs pair={p} now={NOW_MS} tab="info" onTabChange={vi.fn()} />);

  it("lists creator, payout, opening valuation in USD, the gross first buy, the launch and the fee share, then the links", () => {
    info(launched);
    expect(screen.getByRole("link", { name: short(CREATOR) }).getAttribute("href")).toBe(addressUrl(CREATOR));
    expect(screen.getByRole("link", { name: short(PAYOUT) }).getAttribute("href")).toBe(addressUrl(PAYOUT));
    expect(screen.getByText(fmtUsd(4995.43))).toBeTruthy();
    expect(screen.getByText(`${fmtAmt(100)} USDG · ${fmtAmt(19_000_000)} CHALK`)).toBeTruthy(); // 99.5 net plus the 0.5 router fee
    const at = LAUNCHED_AT * 1000;
    expect(screen.getByRole("link", { name: `${fmtISODate(at)} · ${fmtAge(ageHours(at, NOW_MS))} ago` }).getAttribute("href")).toBe(txUrl(LAUNCH_TX));
    expect(screen.getByText("70 % payout · 30 % MaxLong")).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://chalk.test" }).getAttribute("href")).toBe("https://chalk.test");
    expect(screen.getByRole("link", { name: "https://x.com/chalk" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://t.me/chalks" })).toBeTruthy();
  });

  it("reads the fee share from the launch, never a fixed 70 / 30, and says None without a first buy", () => {
    info({ ...launched, launch: { ...launch, creatorShareBps: 6500, firstBuyIn: "0", firstBuyTokens: "0", routerFee: "0" } });
    expect(screen.getByText("65 % payout · 35 % MaxLong")).toBeTruthy();
    expect(screen.getByText("None")).toBeTruthy();
  });

  it("shows the opening valuation in the quote when the quote has no USD price (Review Focus 2), and no links for a hidden launch", () => {
    info({ ...launched, stale: true, priceUsd: 0, launch: { ...launch, hidden: true, website: "", x: "", telegram: "" } });
    expect(screen.getByText(`${fmtAmt(4995.43)} USDG`)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "https://chalk.test" })).toBeNull();
    expect(screen.queryByText("Website")).toBeNull();
  });
});
```

Create `src/components/LaunchFeesPanel.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LaunchFailedError } from "@/lib/launch";
import type { Address, LaunchInfo, TokenPair } from "@/lib/types";
import { act, fireEvent, render, screen, waitFor, within } from "@/test/dom";
import LaunchFeesPanel from "./LaunchFeesPanel";

const TOKEN = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as Address;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const PAYOUT = "0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2" as Address;
const STRANGER = "0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1" as Address;
const RESCUE = "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1" as Address;
const TX = `0x${"11".repeat(32)}` as `0x${string}`;
const E18 = 10n ** 18n;

const h = vi.hoisted(() => ({
  state: { address: "0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1" as string | undefined, isConnected: true, addToast: vi.fn(() => 7), updateToast: vi.fn() },
  fees: {} as Record<string, unknown>,
  refetch: vi.fn(),
  collect: vi.fn(),
  claim: vi.fn(),
  change: vi.fn(),
}));
vi.mock("@/context/AppState", () => ({ useAppState: () => h.state }));
vi.mock("@/hooks/useLaunchpad", () => ({ useLaunchFees: () => ({ ...h.fees, refetch: h.refetch }) }));
vi.mock("wagmi", () => ({ usePublicClient: () => ({ id: "public" }), useWalletClient: () => ({ data: { id: "wallet" } }) }));
vi.mock("@/lib/launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/launch")>()),
  collectLaunchFees: h.collect,
  claimOwed: h.claim,
  changePayout: h.change,
}));

const pair = { id: TOKEN, ticker: "CHALK", quote: "USDG", address: TOKEN } as TokenPair;
const launch = {
  payout: PAYOUT, quoteAddress: USDG, quoteDecimals: 6, creatorShareBps: 7000,
  feesCollected: { tokenToPayout: String(770n * E18), tokenToPlatform: String(330n * E18), quoteToPayout: "7000000", quoteToPlatform: "3000000" },
  feesCollectedAt: 1_999_999_000,
} as unknown as LaunchInfo;
const NOW_MS = 2_000_000_000_000;
const ok = () => ({ hash: TX, confirmation: Promise.resolve() });
const show = () => render(<LaunchFeesPanel pair={pair} launch={launch} now={NOW_MS} />);

beforeEach(() => {
  h.state.address = STRANGER;
  h.state.addToast.mockClear();
  h.state.updateToast.mockClear();
  h.fees = {
    uncollected: { tokenFees: 1000n * E18, quoteFees: 10_000_000n, tokenToPayout: 700n * E18, quoteToPayout: 7_000_000n, tokenToFeeWallet: 300n * E18, quoteToFeeWallet: 3_000_000n },
    uncollectedFailed: false,
    owedToken: 0n,
    owedQuote: 0n,
  };
  h.refetch.mockReset();
  h.collect.mockReset().mockImplementation(async () => ok());
  h.claim.mockReset().mockImplementation(async () => ok());
  h.change.mockReset().mockImplementation(async () => ok());
});

describe("LaunchFeesPanel (spec 7.3)", () => {
  it("shows a stranger the uncollected split, what was collected so far, and Collect; no payout change and nothing owed", () => {
    show();
    const uncollected = within(screen.getByRole("region", { name: "Uncollected fees" }));
    expect(uncollected.getByText("700 CHALK · 7 USDG")).toBeTruthy();
    expect(uncollected.getByText("300 CHALK · 3 USDG")).toBeTruthy();
    const collected = within(screen.getByRole("region", { name: "Collected so far" }));
    expect(collected.getByText("770 CHALK · 7 USDG")).toBeTruthy();
    expect(collected.getByText("330 CHALK · 3 USDG")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Collect fees" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Change payout" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Owed to you" })).toBeNull();
  });

  it("collects for anyone, with the usual toasts, and re-reads the fees after", async () => {
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
    });
    await waitFor(() => expect(h.state.updateToast).toHaveBeenCalledWith(7, { kind: "confirmed", message: "Fees collected for CHALK" }));
    expect(h.collect).toHaveBeenCalledWith(TOKEN, { wallet: { id: "wallet" }, publicClient: { id: "public" }, account: STRANGER });
    expect(h.refetch).toHaveBeenCalled();
  });

  it("disables Collect with a reason when both amounts are zero", () => {
    h.fees = { ...h.fees, uncollected: { tokenFees: 0n, quoteFees: 0n, tokenToPayout: 0n, quoteToPayout: 0n, tokenToFeeWallet: 0n, quoteToFeeWallet: 0n } };
    show();
    expect((screen.getByRole("button", { name: "Collect fees" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Nothing to collect yet.")).toBeTruthy();
  });

  it("says it could not read the uncollected fees and keeps Collect usable, never showing zeros (Review Focus 5)", () => {
    h.fees = { ...h.fees, uncollected: undefined, uncollectedFailed: true };
    show();
    expect(screen.getByText("Could not read the uncollected fees just now.")).toBeTruthy();
    expect(screen.queryByText("Nothing to collect yet.")).toBeNull();
    expect((screen.getByRole("button", { name: "Collect fees" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("lets the current payout change it, and says the change is permanent for this wallet", async () => {
    h.state.address = PAYOUT;
    show();
    expect(screen.getByText("Once you hand the payout on, only the new address can change it.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("New payout address"), { target: { value: RESCUE } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Change payout" }));
    });
    expect(h.change).toHaveBeenCalledWith(TOKEN, RESCUE, expect.objectContaining({ account: PAYOUT }));
  });

  it("shows an owed balance with a Claim per currency, to an address that defaults to the wallet and can be changed", async () => {
    h.fees = { ...h.fees, owedToken: 5n * E18, owedQuote: 2_500_000n };
    show();
    const owed = within(screen.getByRole("region", { name: "Owed to you" }));
    expect(owed.getByText("5 CHALK")).toBeTruthy();
    expect(owed.getByText("2.5 USDG")).toBeTruthy();
    expect((owed.getByLabelText("Send to") as HTMLInputElement).value).toBe(STRANGER);
    await act(async () => {
      fireEvent.click(owed.getByRole("button", { name: "Claim USDG" }));
    });
    expect(h.claim).toHaveBeenLastCalledWith(USDG, STRANGER, expect.anything());
    fireEvent.change(owed.getByLabelText("Send to"), { target: { value: RESCUE } });
    await act(async () => {
      fireEvent.click(owed.getByRole("button", { name: "Claim CHALK" }));
    });
    expect(h.claim).toHaveBeenLastCalledWith(TOKEN, RESCUE, expect.anything());
  });

  it("shows a refused write's own words", async () => {
    h.collect.mockRejectedValueOnce(new LaunchFailedError("Nothing to collect yet.", "NothingToCollect"));
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Nothing to collect yet."));
  });
});
```

Edit `src/lib/markets.test.ts`. Replace line 2:

```ts
import { DEFAULT_FILTERS, selectPairs } from "./markets";
```

with:

```ts
import { DEFAULT_FILTERS, ORIGIN_OPTIONS, selectPairs } from "./markets";
```

Append inside `describe("selectPairs with null fields", …)`:

```ts
  it("offers SV in the origin filter and keeps only launches when it is picked (instant launchpad design, 7.4)", () => {
    expect(ORIGIN_OPTIONS.map((o) => o.key)).toContain("SV");
    expect(ORIGIN_OPTIONS.find((o) => o.key === "SV")?.label).toBe("SV");
    const list = [pair({ id: "0xa", origin: "SV" }), pair({ id: "0xb", origin: "LONG" })];
    expect(selectPairs(list, { ...DEFAULT_FILTERS, origin: "SV" }, 1_000).map((r) => r.id)).toEqual(["0xa"]);
  });
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run src/components/TokenView.test.tsx src/components/TokenHeader.test.tsx src/components/ActivityTabs.test.tsx src/components/LaunchFeesPanel.test.tsx src/lib/markets.test.ts`
Expected: FAIL: no wait text, no chip, no launch rows, no `./LaunchFeesPanel`, no SV option.

- [ ] **Step 7: Write the token page pieces**

Edit `src/lib/markets.ts`. Replace lines 40-45 (the `ORIGIN_OPTIONS` array body):

```ts
  { key: "all", label: "All" },
  { key: "LONG", label: "LONG" },
  { key: "Pons", label: "PONS" },
  { key: "Uniswap", label: "UNISWAP" },
  { key: "Other", label: "OTHER" },
];
```

with:

```ts
  { key: "all", label: "All" },
  { key: "LONG", label: "LONG" },
  { key: "Pons", label: "PONS" },
  { key: "SV", label: "SV" },
  { key: "Uniswap", label: "UNISWAP" },
  { key: "Other", label: "OTHER" },
];
```

Edit `src/components/TokenHeader.tsx`. Replace line 59:

```tsx
            <Badge>{pair.origin.toUpperCase()}</Badge>
```

with:

```tsx
            <Badge>{pair.origin.toUpperCase()}</Badge>
            {pair.launch ? <Badge>LAUNCHED HERE</Badge> : null}
```

Edit `src/components/ActivityTabs.tsx`. Replace lines 5-15 (the `@/lib/chain` and `@/lib/format` imports):

```ts
import { addressUrl, txUrl, ZERO_ADDRESS } from "@/lib/chain";
import {
  ageHours,
  fmtAge,
  fmtAmt,
  fmtClock,
  fmtISODate,
  fmtPrice,
  fmtUsdOrDash,
  short,
} from "@/lib/format";
```

with:

```ts
import { addressUrl, txUrl, ZERO_ADDRESS } from "@/lib/chain";
import {
  ageHours,
  fmtAge,
  fmtAmt,
  fmtClock,
  fmtISODate,
  fmtPrice,
  fmtUsd,
  fmtUsdOrDash,
  short,
} from "@/lib/format";
import { toHuman } from "@/lib/quote/math";
```

In `InfoList`, replace the closing of the `rows` array (lines 205-209):

```tsx
    // The quote asset's address isn't on TokenPair, and nothing in this page's tree already
    // holds useQuotes()'s result to resolve it from — pulling that query into this tab just
    // for a link isn't worth the new fetch, so this row stays unlinked (Task 3 spec note).
    { label: "Quote", value: `${pair.quote} · ${fmtUsdOrDash(pair.stale ? null : quoteUsd)}` },
  ];
```

with:

```tsx
    // The quote asset's address isn't on TokenPair, and nothing in this page's tree already
    // holds useQuotes()'s result to resolve it from — pulling that query into this tab just
    // for a link isn't worth the new fetch, so this row stays unlinked (Task 3 spec note).
    { label: "Quote", value: `${pair.quote} · ${fmtUsdOrDash(pair.stale ? null : quoteUsd)}` },
    ...launchRows(pair, now, pair.stale || !(quoteUsd > 0) ? null : quoteUsd),
  ];
```

and add, just above `function InfoList`:

```tsx
/**
 * The instant launchpad's facts (spec 7.3), appended to the Info tab for a token launched here. The fee share is the
 * launch's own `creatorShareBps`, never a fixed 70 / 30; a hidden launch arrives with its links blanked, so none show.
 */
function launchRows(pair: TokenPair, now: number, quoteUsd: number | null): InfoRow[] {
  const launch = pair.launch;
  if (!launch) return [];
  const quote = (raw: string) => Number(toHuman(BigInt(raw), launch.quoteDecimals));
  const valuation = quote(launch.openingValuation);
  const gross = quote((BigInt(launch.firstBuyIn) + BigInt(launch.routerFee)).toString());
  const tokens = Number(toHuman(BigInt(launch.firstBuyTokens), 18));
  const at = launch.launchedAt * 1000;
  const payoutPct = launch.creatorShareBps / 100;
  const rows: InfoRow[] = [
    { label: "Creator", value: short(launch.creator), href: addressUrl(launch.creator) },
    { label: "Payout", value: short(launch.payout), href: addressUrl(launch.payout) },
    { label: "Opening valuation", value: quoteUsd !== null ? fmtUsd(valuation * quoteUsd) : `${fmtAmt(valuation)} ${pair.quote}` },
    { label: "First buy", value: launch.firstBuyIn === "0" ? "None" : `${fmtAmt(gross)} ${pair.quote} · ${fmtAmt(tokens)} ${pair.ticker}` },
    { label: "Launched", value: `${fmtISODate(at)} · ${fmtAge(ageHours(at, now))} ago`, href: txUrl(launch.launchTx) },
    { label: "Fee share", value: `${payoutPct} % payout · ${100 - payoutPct} % MaxLong` },
  ];
  if (launch.website) rows.push({ label: "Website", value: launch.website, href: launch.website });
  if (launch.x) rows.push({ label: "X", value: launch.x, href: launch.x });
  if (launch.telegram) rows.push({ label: "Telegram", value: launch.telegram, href: launch.telegram });
  return rows;
}
```

`InfoRow` (line 175) is `{ label: string; value: string; href?: string }`; if it is declared after `InfoList` in the file, move the new function below the interface so the type is in scope.

Create `src/components/LaunchFeesPanel.tsx`:

```tsx
"use client";

import { useState, type ReactNode } from "react";
import { isAddress } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import { useAppState } from "@/context/AppState";
import { useLaunchFees } from "@/hooks/useLaunchpad";
import { robinhoodChain } from "@/lib/chain";
import { ageHours, fmtAge, fmtAmt } from "@/lib/format";
import {
  LAUNCH_MESSAGES, LaunchFailedError, LaunchRejectedError, LaunchUnconfirmedError, changePayout, claimOwed, collectLaunchFees,
  type LaunchDeps, type WriteHandle,
} from "@/lib/launch";
import { toHuman } from "@/lib/quote/math";
import type { Address, LaunchInfo, TokenPair } from "@/lib/types";

const BUTTON = "h-9 w-full bg-chalk font-mono text-[10.5px] uppercase tracking-[0.22em] text-onlight hover:bg-white disabled:cursor-not-allowed disabled:bg-[rgba(244,238,218,0.06)] disabled:text-ink-34";
const SMALL = "h-8 border border-hairline-btn bg-transparent px-3 font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink hover:border-hairline-hover disabled:cursor-not-allowed disabled:text-ink-34";
const INPUT = "h-8 w-full border border-hairline-strong bg-transparent px-2 font-mono text-[11px] outline-none focus:border-hairline-focus";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-t border-hairline-soft pt-3 first:border-t-0 first:pt-0">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink-40">{title}</div>
      <div className="mt-2">{children}</div>
    </section>
  );
}
function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px] font-mono text-[11.5px]">
      <span className="text-ink-50">{label}</span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  );
}

/**
 * The launch's fee panel under the trade panel (instant launchpad design, section 7.3): what the position has earned and
 * not yet collected, read live from the contract, split by the contract's own numbers; what was collected so far, summed
 * by the store; anything owed to the connected wallet, with a claim to an address it picks; Collect, for anyone; and
 * Change payout, for the current payout address only.
 */
export default function LaunchFeesPanel({ pair, launch, now }: { pair: TokenPair; launch: LaunchInfo; now: number }) {
  const { address, isConnected, addToast, updateToast } = useAppState();
  const publicClient = usePublicClient({ chainId: robinhoodChain.id });
  const { data: walletClient } = useWalletClient({ chainId: robinhoodChain.id });
  const token = pair.address as Address;
  const fees = useLaunchFees(token, launch.quoteAddress, address);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimTo, setClaimTo] = useState<string | null>(null);
  const [newPayout, setNewPayout] = useState("");

  const tok = (raw: bigint) => `${fmtAmt(Number(toHuman(raw, 18)))} ${pair.ticker}`;
  const quo = (raw: bigint) => `${fmtAmt(Number(toHuman(raw, launch.quoteDecimals)))} ${pair.quote}`;
  const both = (t: bigint, q: bigint) => `${tok(t)} · ${quo(q)}`;
  const isPayout = Boolean(address && address.toLowerCase() === launch.payout.toLowerCase());
  const u = fees.uncollected;
  const nothingToCollect = u !== undefined && u.tokenFees === 0n && u.quoteFees === 0n;
  const owedToken = fees.owedToken ?? 0n;
  const owedQuote = fees.owedQuote ?? 0n;
  const to = (claimTo ?? address ?? "") as Address;

  async function run(key: string, pending: string, done: string, start: (deps: LaunchDeps) => Promise<WriteHandle>) {
    if (busy || !address || !walletClient || !publicClient) return;
    setBusy(key);
    setError(null);
    const toastId = addToast({ kind: "pending", message: pending });
    try {
      const handle = await start({ wallet: walletClient, publicClient, account: address });
      updateToast(toastId, { hash: handle.hash });
      await handle.confirmation;
      updateToast(toastId, { kind: "confirmed", message: done });
      fees.refetch();
    } catch (err) {
      const known = err instanceof LaunchFailedError || err instanceof LaunchRejectedError || err instanceof LaunchUnconfirmedError;
      const message = known ? (err as Error).message : LAUNCH_MESSAGES.writeFallback;
      updateToast(toastId, { kind: err instanceof LaunchUnconfirmedError ? "unconfirmed" : "failed", message });
      setError(message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border border-hairline p-4">
      <div className="mb-3 font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-40">Launch fees</div>
      <div className="flex flex-col gap-3">
        <Section title="Uncollected fees">
          {fees.uncollectedFailed ? (
            <div className="font-mono text-[11px] text-ink-50">Could not read the uncollected fees just now.</div>
          ) : u ? (
            <>
              <Line label="To payout" value={both(u.tokenToPayout, u.quoteToPayout)} />
              <Line label="To MaxLong" value={both(u.tokenToFeeWallet, u.quoteToFeeWallet)} />
            </>
          ) : (
            <div className="font-mono text-[11px] text-ink-40">Reading…</div>
          )}
        </Section>

        <Section title="Collected so far">
          <Line label="To payout" value={both(BigInt(launch.feesCollected.tokenToPayout), BigInt(launch.feesCollected.quoteToPayout))} />
          <Line label="To MaxLong" value={both(BigInt(launch.feesCollected.tokenToPlatform), BigInt(launch.feesCollected.quoteToPlatform))} />
          <div className="mt-1 font-mono text-[10.5px] text-ink-45">
            {launch.feesCollectedAt > 0 ? `Last collected ${fmtAge(ageHours(launch.feesCollectedAt * 1000, now))} ago` : "Not collected yet"}
          </div>
        </Section>

        {owedToken > 0n || owedQuote > 0n ? (
          <Section title="Owed to you">
            <div className="font-mono text-[10.5px] leading-[1.5] text-ink-50">A share that could not be delivered waits here. Send it to this wallet or another address.</div>
            <label className="mt-2 block font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-45" htmlFor="claim-to">
              Send to
            </label>
            <input id="claim-to" aria-label="Send to" className={`mt-1 ${INPUT}`} value={to} onChange={(e) => setClaimTo(e.target.value.trim())} spellCheck={false} />
            {(
              [
                [owedToken, token, pair.ticker, tok(owedToken)],
                [owedQuote, launch.quoteAddress, pair.quote, quo(owedQuote)],
              ] as const
            ).map(([amount, currency, label, text]) =>
              amount > 0n ? (
                <div key={label} className="mt-2 flex items-center justify-between gap-3">
                  <span className="font-mono text-[11.5px] tabular-nums">{text}</span>
                  <button
                    type="button"
                    disabled={busy !== null || !isAddress(to)}
                    onClick={() => void run(`claim-${label}`, `Claiming ${text}`, `Claimed ${text}`, (deps) => claimOwed(currency, to, deps))}
                    className={SMALL}
                  >
                    {`Claim ${label}`}
                  </button>
                </div>
              ) : null,
            )}
          </Section>
        ) : null}

        <div>
          <button
            type="button"
            disabled={busy !== null || !isConnected || nothingToCollect}
            onClick={() => void run("collect", `Collecting fees for ${pair.ticker}`, `Fees collected for ${pair.ticker}`, (deps) => collectLaunchFees(token, deps))}
            className={BUTTON}
          >
            Collect fees
          </button>
          {nothingToCollect ? <div className="mt-2 text-center font-mono text-[10.5px] text-ink-50">Nothing to collect yet.</div> : null}
          {!isConnected ? <div className="mt-2 text-center font-mono text-[10.5px] text-ink-50">Connect a wallet to collect.</div> : null}
        </div>

        {isPayout ? (
          <Section title="Change payout">
            <input aria-label="New payout address" placeholder="0x…" className={INPUT} value={newPayout} onChange={(e) => setNewPayout(e.target.value.trim())} spellCheck={false} />
            <button
              type="button"
              disabled={busy !== null || !isAddress(newPayout)}
              onClick={() => void run("payout", "Changing the payout", "Payout changed", (deps) => changePayout(token, newPayout as Address, deps))}
              className={`mt-2 w-full ${SMALL}`}
            >
              Change payout
            </button>
            <div className="mt-2 font-mono text-[10.5px] leading-[1.5] text-ink-50">Once you hand the payout on, only the new address can change it.</div>
          </Section>
        ) : null}

        {error ? (
          <div role="alert" className="font-mono text-[10.5px] text-down">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

Edit `src/components/TokenView.tsx`. Replace lines 3-11 (imports):

```tsx
import Link from "next/link";
import { useState } from "react";
import { usePair } from "@/hooks/useMarketsData";
import { short } from "@/lib/format";
import type { Interval } from "@/lib/types";
import ActivityTabs, { type ActivityTab } from "./ActivityTabs";
import CandleChart from "./CandleChart";
import TokenHeader from "./TokenHeader";
import TradePanel from "./TradePanel";
```

with:

```tsx
import Link from "next/link";
import { useEffect, useState } from "react";
import { LAUNCH_WAIT_MAX_MS, usePair } from "@/hooks/useMarketsData";
import { txUrl } from "@/lib/chain";
import { short } from "@/lib/format";
import type { Hex, Interval } from "@/lib/types";
import ActivityTabs, { type ActivityTab } from "./ActivityTabs";
import CandleChart from "./CandleChart";
import LaunchFeesPanel from "./LaunchFeesPanel";
import TokenHeader from "./TokenHeader";
import TradePanel from "./TradePanel";
import { Spinner } from "./ui";
```

Replace lines 40-41:

```tsx
export default function TokenView({ address }: { address: string }) {
  const { pair, isPending, dataUpdatedAt } = usePair(address);
```

with:

```tsx
export default function TokenView({ address, launchedTx }: { address: string; launchedTx?: Hex }) {
  const { pair, isPending, dataUpdatedAt } = usePair(address, { launched: launchedTx !== undefined });
  // Spec 7.3: a page opened by /launch's redirect waits for the reader for five minutes, then says what it always says.
  const [waitOver, setWaitOver] = useState(false);
  useEffect(() => {
    if (!launchedTx) return;
    const id = window.setTimeout(() => setWaitOver(true), LAUNCH_WAIT_MAX_MS);
    return () => window.clearTimeout(id);
  }, [launchedTx]);
```

Replace the `if (!pair) { … }` block (lines 65-77) with:

```tsx
  if (!pair) {
    const waiting = launchedTx !== undefined && !waitOver;
    return (
      <section className={GUTTER}>
        <BackLink />
        <div className="px-4 py-16 text-center">
          {waiting ? (
            <>
              <div className="text-[16px]">Your token is live on chain. Its page fills in within about two minutes.</div>
              <div className="mt-3 flex justify-center">
                <Spinner />
              </div>
            </>
          ) : (
            <>
              <div className="text-[16px]">No token at {short(address)}.</div>
              <div className="mt-[6px] text-[12.5px] text-ink-50">
                It may not be indexed yet, or the address is wrong.
              </div>
            </>
          )}
          {launchedTx ? (
            <a
              href={txUrl(launchedTx)}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-block font-mono text-[10px] uppercase tracking-[0.2em] text-ink-60 hover:text-ink"
            >
              View the launch transaction ↗
            </a>
          ) : null}
        </div>
      </section>
    );
  }
```

Replace lines 88-90:

```tsx
        <div className="order-1 w-full flex-none twocol:order-2 twocol:w-[360px]">
          <TradePanel pair={pair} />
        </div>
```

with:

```tsx
        <div className="order-1 w-full flex-none twocol:order-2 twocol:w-[360px]">
          <TradePanel pair={pair} />
          {pair.launch ? (
            <div className="mt-6">
              <LaunchFeesPanel pair={pair} launch={pair.launch} now={dataUpdatedAt} />
            </div>
          ) : null}
        </div>
```

Edit `src/app/t/[address]/page.tsx`. Replace line 8:

```ts
import type { TokenPair } from "@/lib/types";
```

with:

```ts
import type { Hex, TokenPair } from "@/lib/types";
```

Replace lines 10-12:

```ts
interface Props {
  params: Promise<{ address: string }>;
}
```

with:

```ts
interface Props {
  params: Promise<{ address: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/** `?launched=<tx>` from /launch's redirect (spec 7.3): a transaction hash, or ignored. */
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
```

Replace lines 88-91:

```ts
export default async function TokenPage({ params }: Props) {
  const { address } = await params;
  const id = decodeURIComponent(address).toLowerCase();
  const pair = await getPair(id);
```

with:

```ts
export default async function TokenPage({ params, searchParams }: Props) {
  const { address } = await params;
  const id = decodeURIComponent(address).toLowerCase();
  const pair = await getPair(id);
  const { launched } = await searchParams;
  const launchedTx = typeof launched === "string" && TX_HASH.test(launched) ? (launched.toLowerCase() as Hex) : undefined;
```

and line 101:

```tsx
        <TokenView address={id} />
```

with:

```tsx
        <TokenView address={id} launchedTx={launchedTx} />
```

The server-rendered `TokenFacts` layer is untouched: it shows its unknown-token state while the reader catches up (spec 7.3).

- [ ] **Step 8: Run them to verify they pass**

Run: `npx vitest run src/components src/hooks src/lib/markets.test.ts src/app`
Expected: PASS.

- [ ] **Step 9: Write the docs**

Edit `.env.example`. After the `NEXT_PUBLIC_SVROUTER_ADDRESS=` line (line 15) add:

```
# The instant launchpad's address on Robinhood Chain; empty keeps /launch on "not live yet" and the reader off its logs.
NEXT_PUBLIC_LAUNCHPAD_ADDRESS=
```

At the end of the file add (each comment on its own line above its name, never trailing the value):

```
# Instant launchpad image storage (server-only)
# Filebase S3 access key for the launch image bucket; required for uploads and the nightly clean-up.
FILEBASE_ACCESS_KEY=
# Filebase S3 secret key for that bucket; required, never in the bundle.
FILEBASE_SECRET_KEY=
# The Filebase IPFS bucket launch images and metadata are pinned to; required.
FILEBASE_BUCKET=
# Optional: a dedicated Filebase gateway's https origin, tried first for ipfs:// logos; defaults to https://ipfs.filebase.io.
FILEBASE_GATEWAY_URL=
```

Edit `README.md`.

In the Routes table (lines 23-27) add a row after `/t/[address]`:

```
| `/launch` | Launch a token: image, name, symbol, currency, opening valuation, optional first buy; one transaction (Suits holders) |
```

In the variables table (lines 89-99) add, after the `SYNC_INTERVAL_SEC` row:

```
| `NEXT_PUBLIC_LAUNCHPAD_ADDRESS` | the launchpad contract; empty keeps `/launch` on "not live yet", the reader off its logs and the upload route at 503 |
| `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY`, `FILEBASE_BUCKET` | the Filebase IPFS bucket launch images are pinned to; all three for uploads and the nightly clean-up |
| `FILEBASE_GATEWAY_URL` | optional; a dedicated gateway's https origin for launch logos, default `https://ipfs.filebase.io` |
```

After the `GET /api/tokens/[address]/logo` paragraph (ends line 110) add:

```
The instant launchpad (spec `docs/superpowers/specs/2026-09-28-instant-launchpad-design.md`): the reader adds the
launchpad as a second log selection in its per-minute HyperSync request and folds `Launched`, `FeesCollected` and
`PayoutChanged` into `market.launches` and `market.launch_fee_events`. A launched token lists with the `SV` badge from
its launch block; one nobody has bought leaves the table after 24 hours and returns with its first trade, and its page
stays up. `POST /api/launch/upload` re-encodes a creator's image to a 512 x 512 WebP and pins it and a metadata JSON on
Filebase before the launch (Suits holders, 5 an hour and 20 a day per wallet); the nightly job's `uploads` phase unpins
what no launch used. To hide a launch's image and links: `update market.launches set hidden = true where token_id = '<lowercase address>'`
in the Supabase SQL editor; the logo answers "no logo" within the hour.
```

In the Layout block (lines 138-152) add after the `src/lib/holders` line:

```
src/lib/launch     the instant launchpad: ABI and address, stores, upload rules, Filebase, form arithmetic, wallet writes (src/lib/launch.ts)
```

Edit `scripts/README.md`. In the command table (lines 8-14) add a last row:

```
| `npm run launch:currencies -- --out <path>` | Writes the launchpad's deploy config for the contracts repo's `script/config/launch-currencies.json`, in the schema its deploy script reads: `minUsd` 5,000, `maxUsd` 10,000,000, `creationFee` `"0"`, then 54 currencies from `quotes.json`, each `address, symbol, decimals, priceSource, chainlinkProxy, chainlinkDecimals, referenceUsdPrice`, with only USDG `pinned` and every `referenceUsdPrice` `"0"` until filled in. Refuses to overwrite an existing file without `--force`, so the 29 reference prices filled in by hand are never lost. Reads no environment. |
```

- [ ] **Step 10: Run the final gates, the build included**

Run: `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src`, `npm run build`. All clean. The build lists `/launch`, `ƒ /api/launch/upload` and `ƒ /t/[address]`.

- [ ] **Step 11: Commit**

```bash
git add src/hooks/useMarketsData.ts src/hooks/useMarketsData.test.tsx "src/app/t/[address]/page.tsx" src/components/TokenView.tsx src/components/TokenView.test.tsx src/components/TokenHeader.tsx src/components/TokenHeader.test.tsx src/components/ActivityTabs.tsx src/components/ActivityTabs.test.tsx src/components/LaunchFeesPanel.tsx src/components/LaunchFeesPanel.test.tsx src/lib/markets.ts src/lib/markets.test.ts README.md scripts/README.md .env.example
git commit -m "Launchpad: the token page's chip, launch rows, fee panel and indexing wait, the SV filter, and the docs"
```

---

## Rollout: Kobe's own steps

Agents build and push nothing to production; these are Kobe's, in this order (spec section 9, frontend side in full, contracts side named).

| # | Step | Where |
|---|---|---|
| 1 | Generate the deploy config once: `npm run launch:currencies -- --out ../SuitVenturesMarket-contracts/script/config/launch-currencies.json`. Fill the 29 `referenceUsdPrice` rows whose `priceSource` is `reference`, each as a quoted integer string with 8 decimals (USD 300.25 is `"30025000000"`; `"0"` is refused by the deploy script), leave every other key as written, and commit the file in the contracts repo | frontend, then contracts |
| 2 | Contracts plan: dry run on an anvil fork of 4663, read the printed bounds, deploy with `--broadcast`, verify, `acceptOwnership` from `OWNER` if needed, read the settings back (spec 9 steps 2 to 4) | contracts |
| 3 | Record the launchpad's address and deploy block in both READMEs | workspace and frontend |
| 4 | Create the Filebase IPFS bucket and an access key pair for it; optionally a dedicated gateway | Filebase console |
| 5 | Merge the frontend branch locally and run `npm run db:migrate` against production **before** pushing. This is not optional: without `market.launches` the reader's `applyFold` throws on its first cycle (the chain job stalls), every token response and logo lookup reads the missing table, and `/api/health` answers `launches: { error: "launch tables unavailable" }` with `ok: false` | laptop, `.env.local`'s `DATABASE_URL_DIRECT` |
| 6 | On Vercel set `NEXT_PUBLIC_LAUNCHPAD_ADDRESS`, `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY`, `FILEBASE_BUCKET` and, if a dedicated gateway exists, `FILEBASE_GATEWAY_URL`, for Production. Set the address before anyone launches: a launch the reader has already passed over needs a catch-up rewind to appear | Vercel |
| 7 | Push `main`; wait for the deployment | GitHub, Vercel |
| 8 | Check `/api/health`: `ok: true`, `sync.lastCycle.launchEvents` present (0 until the first launch), `launches: { missingUploads: 0, deletedUploads: 0 }`. A `launches.error` means the migration did not reach this database: stop and run step 5 | browser |
| 9 | Rehearsal (spec 9 step 7): one free USDG launch and one NVDA launch with a small first buy, from a Suits wallet. Check the redirect's indexing wait, the table row with the `SV` badge, the "LAUNCHED HERE" chip, the Info rows, a buy and a sell through the Buy panel, a fee collection from the panel and its split in "Collected so far" at the launch's creator share (the Info tab's Fee share row), never assumed to be 70/30 | site |
| 10 | Hide the rehearsal tokens: `update market.launches set hidden = true where token_id in ('<first>', '<second>');` | Supabase SQL editor |
| 11 | Add Decision Log entry D47 (spec section 15) to the workspace README, and confirm or change the DEFAULTs of spec 12: the USD 5,000 to 10,000,000 bounds, the presets, the 24-hour listing window | workspace README, with MAXLONG |
| 12 | At handover: ownership and fee wallet to MAXLONG's Safe through `Ownable2Step` (spec 9 step 8) | contracts |

## Self-Review

**Spec coverage.**

| Spec | Task |
|---|---|
| 5.1 migration | 1 |
| 5.2 address, query body, `address` field, decode by address then topic0, event kinds, pre-scan, `recomputePrimaryPool` SV rule, `handleLaunched`/`handleLaunchFees`/`handlePayoutChanged`, kind guards, `FoldResult`, store writes in order, idempotence, report and health (`launchEvents`, optional in `lastCycleFrom`, `launches.missingUploads`) | 1 (stores), 2 (ABI, address), 3 |
| 5.3 primary pool | 3 (the SV rule; D43 ranking untouched) |
| 5.4 listing window with the clock, closed-window recompute, `pair()` fallback to the launch pool, `ORDER`, launchpad scope | 4 |
| 5.5 `launch` block, fees summed on read, hidden blanks | 4 |
| 5.6 logo stage, failed read answers no logo uncached, Filebase gateway first, one-hour cache and memo | 6 |
| 6 upload route, every check in order, metadata JSON, keys by content hash, orphans phase, env names, moderation | 5, 6, 9 (README) |
| 7.1 nav | 8 |
| 7.2 `/launch`: not-live card, form fields, currency picker, presets, custom value, snapped preview, first buy with Max and estimate, payout, summary panel, button reasons, submit steps, upload reuse, simulate, revert replay, error table, ABI with the three foreign errors | 2, 7, 8 |
| 7.3 indexing wait, chip, launch rows, Liquidity row fix, fee panel (uncollected, collected, owed with claim to any address, collect, change payout) | 4 (Liquidity), 7 (writes, reads), 9 |
| 7.4 SV filter, launchpad scope | 4, 9 |
| 8.2 every listed frontend test | 1 to 9 |
| 8.3 the frontend script generating the deploy config | 2 |
| 9 steps 5 and 6, and the rest as Kobe's own | Rollout |
| 10 costs | no code: one request, no cron, three tables, one indexed sum per single-token read, as built |
| 13 health | 3 (`launchEvents`, `missingUploads`), 6 (`deletedUploads` via `launchHealth`, Task 1) |

**Placeholder scan.** No step says "add validation" or "similar to"; every code step carries its code.

**Type consistency.** `LaunchRow`, `LaunchFeesRow`, `PayoutRow` (Task 1) are what the fold emits and the store writes (Task 3). `LaunchInfo` (Task 4) is what `readLaunchInfo` returns, what the Info rows and the fee panel read (Task 9). `UploadCleaner` (Task 6) is what `deps.ts`, `run.ts` and `nightly.ts` pass. `LaunchStep` and `SubmitStep` line up between `executeLaunch`'s `onStep` and the form (Tasks 7, 8). `PendingFees` (Task 7) matches `uncollectedFees`' tuple in the ABI (Task 2).

**Where the spec was silent, this plan decided** (each is small and can be changed at review):

1. `HyperSyncSourceOptions.launchpad` is `string | null`, not `string`: `null` lets the pinned-body test prove the query is unchanged without a launchpad, whatever the environment holds.
2. A list row never carries `launch` (spec 5.5), so `usePair` re-reads a listed SV token by id to get it; other listed tokens are unaffected.
3. The indexing wait gets `?launched=` from the page's `searchParams` and passes it to `TokenView` as a prop, rather than reading `useSearchParams` in a client component.
4. X and Telegram also accept a leading `@` on a bare handle; stored the same way.
5. The button's reason list keeps spec 7.2's order and adds states the spec did not name: "Reading the launchpad's settings." (router fee, cap, creator share or hook not read yet; never a default of 0), "Launches are paused while a hook is set." (fix round: the contracts README promises it), "Checking your wallet." (gate read in flight), "The name fits 32 bytes and the symbol 11.", "Check the description and the links.", "Reading this currency's limits.", "Enter a valid payout address.", and "Working out the opening price." last.
6. Valuations show as whole dollars ("$5,000"), not the spec's shorthand ("$5K"), matching the snapped preview's "$4,995".
7. The deploy config follows the canonical schema the contracts deploy script (branch `feat/instant-launchpad`) already reads, spelled out in Task 2 Step 10: `{ minUsd, maxUsd, creationFee: "<raw integer string>", currencies: [{ address, symbol, decimals, priceSource: "chainlink" | "pinned" | "reference", chainlinkProxy (zero address when none), chainlinkDecimals (0 when none), referenceUsdPrice: "<8-decimal integer string>" }] }` in that key order. `creationFee` and `referenceUsdPrice` are strings and start as `"0"`; there is no top-level decimals key (8 is a documented constant in `currencyConfig.ts` only); only USDG is `pinned`. The generator's test pins the key order.
8. The nightly `"uploads"` phase reports done when its batch was short or no delete succeeded, so a Filebase outage cannot hold the probe phase back night after night.
9. `FILEBASE_GATEWAY_URL` must be an https origin with no path; anything else falls back to `https://ipfs.filebase.io`.
10. A launch whose metadata JSON cannot be fetched (no image CID, not hidden) falls through to the resolver's existing stages instead of answering "no logo".
11. The payout defaults to the connected address, sent explicitly, rather than the zero address the contract would also accept.
12. The fee panel's writes share one fallback line, "That did not go through. Nothing was spent except gas.", and name `NothingToCollect`, `NothingOwed`, `NotPayout` and `ZeroAddress` in plain words.
13. Nine tasks, not six to eight: the reader, the upload route and the form each fill a reviewer's sitting on their own.
