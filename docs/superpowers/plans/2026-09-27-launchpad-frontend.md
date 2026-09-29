# Launchpad Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the `SVLaunchpad` contract's events inside the existing minute cron, store every raise and contribution in two new `market.*` tables, serve them through two read routes, and give the site three screens (`/launch`, `/launch/new`, `/launch/[id]`) plus the token-page chip, the `SV` badge and filter, wallet writes for every raise action, a health counter, and the quotes script the contracts deploy reads.

**Architecture:** The HyperSync source gains a second `logs` selection for the launchpad address (only when `NEXT_PUBLIC_SVLAUNCHPAD_ADDRESS` is set) and selects each log's `address`, so `decodeLog` routes by address then topic0. Presale events join the `ChainEvent` union, the pure fold turns them into an ordered list of row operations (`FoldResult.presales`), and `applyFold` applies those operations after the token and pool upserts in the same transaction as the trades and the cursor. `Finalized` sets `tokens.origin = 'SV'` and `pools.origin = 'SV'`, and the listing rule treats an `SV` pool as listable without a trade. Status is derived in SQL at read time. The read side is two `MarketBackend` methods, two routes, two data-source methods and two hooks; the write side is `src/lib/launch.ts`, a mirror of `executeSwap`.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, viem 2 / wagmi 3, TanStack Query 5, Tailwind v4, postgres.js behind `Db` (`src/lib/db/client.ts`), vitest 4 with PGlite (`src/test/db.ts`) and jsdom (`src/test/dom.tsx`).

**Spec:** `docs/superpowers/specs/2026-09-27-launchpad-design.md` (sections 5 to 8, the `scripts/launchpad-quotes.mts` script named in 4.5, and the README additions; section 4's contracts belong to a separate plan).

## Global Constraints

- Data conventions, verbatim from spec section 6: "Conventions as in the existing migrations: snake_case, lower-case hex ids, `numeric` for raw chain integers cast to text on read, `int` unix seconds, no foreign keys. One migration file under `supabase/migrations/`, applied with `npm run db:migrate` over `DATABASE_URL_DIRECT`, which Kobe runs against production."
- Status is derived in SQL from the stored facts and `now`, never stored, verbatim from spec section 6:

  | Status | Rule |
  |---|---|
  | `launched` | `launched_at > 0` |
  | `failed` | `closed_at > 0`, or `deadline_ts ≤ now` and `raised < floor`, or `deadline_ts + 604800 ≤ now` (the stall valve: refunds are open on chain whatever was raised) |
  | `launchable` | not launched, not failed, and (`raised = target` or `deadline_ts ≤ now`) |
  | `scheduled` | `now < start_ts` |
  | `open` | otherwise |

  "The page therefore shows "did not reach its floor" before the first refund writes `Closed`, "launch now" the moment a deadline passes above the floor, and the refund button the moment the stall valve opens, never "launch now" while refunds are already open."
- Route conventions, verbatim from spec section 7: "**Routes**, in the conventions of the existing routes (`dynamic = "force-dynamic"`, `badRequest` on a bad id, `cached(data, 5)` on success, `failure(err)` on error, the per-process `ttlCache` memo with a 5-second TTL, the backend from `getBackend()`): `GET /api/launch` returns every raise with derived status, quote symbol and decimals, USD values for target and raised through the existing quote-price helper, contributors and time fields, ordered open by soonest deadline, then launchable, then scheduled by start, then launched newest first, then failed. `GET /api/launch/[id]` returns one raise and, given `?wallet=`, that wallet's contribution row, which is public on chain in any case. There are no write routes: every write is a wallet transaction."
- The launchpad address is the environment variable `NEXT_PUBLIC_SVLAUNCHPAD_ADDRESS`, "named like `NEXT_PUBLIC_SVROUTER_ADDRESS`, read by the browser and by the reader alike; the reader adds the selection only when it is set" (spec section 7).
- The ABI the reader decodes against is the event list of spec section 4.2, reproduced exactly as a viem `as const` array: names, parameter names, types, order and `indexed` flags (Task 2 carries it; `abi.test.ts` pins every selector).
- Copy on screen follows the product's rules: plain words, no jargon, no em-dashes in any sentence the user reads, numbers formatted with the helpers in `src/lib/format.ts` (`fmtUsd`, `fmtAmt`, `fmtInt`, `fmtQuote`, `short`) and the new `fmtDuration`. Raw chain amounts travel as decimal strings and `bigint`; a `number` holds an amount only for display.
- Units on chain are quote-asset units; USD only on screen (spec section 2).
- The reader's discipline is unchanged: the fold never touches the network; every write of a batch lands in `applyFold`'s one transaction with the cursor; additive writes rely on the `chain` lease for idempotence, exactly as `applyHolderDeltas` does.
- Every task ends with `npx vitest run` (or the file-scoped runs it names), and Task 14 runs `npm test`, `npm run lint`, `npm run build` clean. No new dependencies.
- Never print, commit or read out any `.env*` file's values; only variable names appear in this plan.
- Line numbers cited for the repo's files are those of the files as they stand before this plan's tasks run; an earlier task shifts a later task's numbers by a few lines (Task 3 lengthens `fold.ts` and `store.ts`, Task 6 adds an import to `dbBackend.ts`, Task 12 appends a test to `dbBackend.test.ts`). Every edit quotes the text it replaces, so match on the quoted text, never on the number.

## File structure

New files, one responsibility each:

| File | Responsibility |
|---|---|
| `supabase/migrations/20260927000000_presales.sql` | The two tables and their indexes (Task 1) |
| `src/lib/launch/abi.ts`, `abi.test.ts` | The launchpad ABI (`svLaunchpadAbi`) and the folded events' topic0 map (Task 2) |
| `src/lib/launch/constants.ts` | The contract's constants the screens compute with (Task 2) |
| `src/lib/launch/store.ts`, `store.test.ts` | `applyPresaleOps`: the SQL for each presale row operation (Task 5) |
| `src/lib/launch/read.ts`, `read.test.ts` | `readLaunches` / `readLaunch`: the derived-status SQL and USD shaping (Task 6) |
| `src/app/api/launch/route.ts`, `route.test.ts` | `GET /api/launch` (Task 6) |
| `src/app/api/launch/[id]/route.ts`, `route.test.ts` | `GET /api/launch/[id]` (Task 6) |
| `src/lib/launch.ts`, `launch.test.ts` | Wallet writes, the mirror of `src/lib/swap.ts` (Task 8) |
| `src/lib/launch/math.ts`, `math.test.ts` | Pure display arithmetic over raw strings (Task 9) |
| `src/components/RaiseProgress.tsx`, `Countdown.tsx`, `LaunchList.tsx` and tests | The two small pieces and the list (Task 9) |
| `src/app/launch/page.tsx`, `src/app/launch/new/page.tsx`, `src/app/launch/[id]/page.tsx` | The three server pages (Tasks 9 to 11) |
| `src/components/CreateRaiseForm.tsx`, `RaiseView.tsx` and tests | The create form and the raise page (Tasks 10 and 11) |
| `src/components/OriginBadge.tsx`, `OriginBadge.test.tsx`, `TokenHeader.test.tsx` | The badge with the `SV` tooltip and the token-page chip (Task 12) |
| `src/lib/launch/quotes.ts`, `quotes.test.ts`, `scripts/launchpad-quotes.mts` | The deploy JSON's arithmetic and the script (Task 13) |

Modified files: `src/lib/chain.ts` (address), `src/lib/chain/types.ts` (event union, ops), `src/lib/chain/decode.ts` and `hypersyncSource.ts` (routing by address), `src/lib/chain/fold.ts` (presale handlers), `src/lib/chain/store.ts` (apply ops in the transaction), `src/lib/sync/writers.ts` (listing rule), `src/lib/chain/run.ts` (cycle report), `src/lib/market/backend.ts`, `dbBackend.ts`, `envioBackend.ts`, `dbShape.ts` (read methods, `launchId`), `src/lib/types.ts`, `src/lib/data/envio.ts`, `mock.ts`, `src/hooks/useMarketsData.ts`, `src/lib/format.ts`, `src/lib/markets.ts`, `src/components/TopBar.tsx`, `TokenHeader.tsx`, `PairsTable.tsx`, `package.json`, `.env.example`, `README.md`, `scripts/README.md`, and the tests named in each task.

---

### Task 1: The migration for `market.presales` and `market.presale_contributions`

**Files:**
- Create: `supabase/migrations/20260927000000_presales.sql`
- Modify: `src/lib/db/migrate.test.ts:10` (the `TABLES` list) and append one test
- Test: `src/lib/db/migrate.test.ts`

**Interfaces:**
- Consumes: `migrate(db)` (`src/lib/db/migrate.ts:16`) applies every `supabase/migrations/*.sql` in name order; `createPgliteDb()` (`src/lib/db/pglite.ts`); `testDb()` (`src/test/db.ts:6`) is what every later PGlite test boots.
- Produces: the two tables exactly as spec section 6, which Tasks 5 and 6 read and write by these column names.

- [ ] **Step 1: Write the failing test**

Edit `src/lib/db/migrate.test.ts`. Line 10 today is:

```ts
const TABLES = ["candles", "holder_refresh", "pools", "quotes", "schema_migrations", "swaps", "sync_state", "token_balances", "tokens"];
```

Replace it with:

```ts
const TABLES = ["candles", "holder_refresh", "pools", "presale_contributions", "presales", "quotes", "schema_migrations", "swaps", "sync_state", "token_balances", "tokens"];
```

Then add this test inside the `describe("migrate", …)` block, after the "round-trips a COPY" test (after line 44):

```ts
  it("creates market.presales and market.presale_contributions with the launchpad's columns and indexes (launchpad design, section 6)", async () => {
    await migrate(db); // idempotent, so this case also passes when run alone
    const presales = await db.query<{ column_name: string; data_type: string }>(
      "select column_name, data_type from information_schema.columns where table_schema = 'market' and table_name = 'presales' order by ordinal_position",
    );
    expect(presales.map((c) => c.column_name)).toEqual([
      "id", "creator", "payout", "quote_id", "token_id", "pool_id", "name", "symbol", "image", "website", "x", "telegram",
      "target", "floor", "raised", "sale_tokens", "sqrt_price_x96", "start_ts", "deadline_ts", "created_ts", "launched_at", "closed_at",
      "created_block", "contributors", "fee", "quote_to_pool", "tokens_to_pool", "tokens_burned", "liquidity",
      "creator_claimed", "fees_creator_0", "fees_creator_1", "fees_platform_0", "fees_platform_1", "updated_at",
    ]);
    // Raw chain integers are numeric, never int or float, so a uint256 round-trips as its exact digits.
    for (const name of ["target", "floor", "raised", "sale_tokens", "sqrt_price_x96", "fee", "liquidity", "fees_platform_1"]) {
      expect(presales.find((c) => c.column_name === name)?.data_type).toBe("numeric");
    }
    for (const name of ["start_ts", "deadline_ts", "launched_at", "closed_at", "contributors", "updated_at"]) {
      expect(presales.find((c) => c.column_name === name)?.data_type).toBe("integer");
    }
    const contributions = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'market' and table_name = 'presale_contributions' order by ordinal_position",
    );
    expect(contributions.map((c) => c.column_name)).toEqual(["id", "wallet", "amount", "claimed_at", "refunded_at", "updated_at"]);
    const indexes = await db.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'market' and tablename in ('presales', 'presale_contributions') order by indexname",
    );
    expect(indexes.map((i) => i.indexname)).toEqual(
      expect.arrayContaining(["presales_token", "presales_deadline", "presales_launched", "presale_contributions_wallet"]),
    );
    // Defaults: a row inserted with only the columns RaiseCreated carries reads 0 and '' everywhere else.
    await db.query(
      `insert into market.presales (id, creator, payout, quote_id, target, floor, sale_tokens, start_ts, deadline_ts, created_ts, created_block, updated_at)
       values (1, '0xc', '0xc', '0xq', 1000000, 500000, 450000000000000000000000000, 10, 20, 5, 100, 5)`,
    );
    const [row] = await db.query<{ token_id: string; raised: string; launched_at: number; contributors: number; name: string }>(
      "select token_id, raised::text as raised, launched_at, contributors, name from market.presales where id = 1",
    );
    expect(row).toEqual({ token_id: "", raised: "0", launched_at: 0, contributors: 0, name: "" });
    await db.query("delete from market.presales where id = 1");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/db/migrate.test.ts`
Expected: FAIL. The first test fails on `TABLES` (`presales` missing from `information_schema.tables`), the new test fails with an empty column list.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260927000000_presales.sql`:

```sql
-- Token launchpad (docs/superpowers/specs/2026-09-27-launchpad-design.md, section 6): one row per raise the
-- SVLaunchpad contract created, folded by the chain reader from the launchpad's own events in the same
-- transaction as the trades and the cursor (section 5). Status is never stored: it is derived in SQL from these
-- facts and now (section 6's table), so a raise flips to "launchable" the moment its deadline passes above its
-- floor without any writer touching the row. Raw chain integers are numeric(78,0) and are cast to text on read;
-- times are unix seconds, 0 meaning "not yet"; addresses and ids are lower-case hex. No foreign keys, as in every
-- other migration: a raise names a token that market.tokens learns of in the same batch, and a token row rewritten
-- by the reader must never cascade a raise away. Additive and reversible by dropping the two tables.
create table market.presales (
  id int primary key,
  creator text not null,
  payout text not null,
  quote_id text not null,
  token_id text not null default '',
  pool_id text not null default '',
  name text not null default '',
  symbol text not null default '',
  image text not null default '',
  website text not null default '',
  x text not null default '',
  telegram text not null default '',
  target numeric(78,0) not null,
  floor numeric(78,0) not null,
  raised numeric(78,0) not null default 0,
  sale_tokens numeric(78,0) not null,
  sqrt_price_x96 numeric(78,0) not null default 0,
  start_ts int not null,
  deadline_ts int not null,
  created_ts int not null,
  launched_at int not null default 0,
  closed_at int not null default 0,
  created_block int not null,
  contributors int not null default 0,
  fee numeric(78,0) not null default 0,
  quote_to_pool numeric(78,0) not null default 0,
  tokens_to_pool numeric(78,0) not null default 0,
  tokens_burned numeric(78,0) not null default 0,
  liquidity numeric(78,0) not null default 0,
  creator_claimed numeric(78,0) not null default 0,
  fees_creator_0 numeric(78,0) not null default 0,
  fees_creator_1 numeric(78,0) not null default 0,
  fees_platform_0 numeric(78,0) not null default 0,
  fees_platform_1 numeric(78,0) not null default 0,
  updated_at int not null
);
-- The token page finds its raise by token (section 7's chip); the list orders open raises by deadline and
-- launched ones by launch time (section 7's route).
create index presales_token on market.presales (token_id);
create index presales_deadline on market.presales (deadline_ts);
create index presales_launched on market.presales (launched_at);

-- One row per (raise, wallet), additive across a wallet's contributions; claimed_at and refunded_at are 0 until the
-- matching event. The raise page reads one wallet's row by primary key; the wallet index serves a wallet's own
-- history across raises.
create table market.presale_contributions (
  id int not null,
  wallet text not null,
  amount numeric(78,0) not null,
  claimed_at int not null default 0,
  refunded_at int not null default 0,
  updated_at int not null,
  primary key (id, wallet)
);
create index presale_contributions_wallet on market.presale_contributions (wallet);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/db/migrate.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the whole node project once**

Run: `npx vitest run --project node`
Expected: PASS. (Every PGlite test boots through `testDb()`, which now applies the new file too; nothing else reads the new tables yet.)

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260927000000_presales.sql src/lib/db/migrate.test.ts
git commit -m "Launchpad: market.presales and market.presale_contributions, the two tables of design section 6"
```

---

### Task 2: The launchpad ABI, the address, the constants and the presale event types

**Files:**
- Create: `src/lib/launch/abi.ts`
- Create: `src/lib/launch/abi.test.ts`
- Create: `src/lib/launch/constants.ts`
- Modify: `src/lib/chain.ts:87-94` (add the launchpad address beside the router's)
- Modify: `src/lib/chain/types.ts:55` (the presale event types, `PoolManagerEvent`; `ChainEvent` itself widens in Task 3)
- Modify: `.env.example` (after the `NEXT_PUBLIC_SVROUTER_ADDRESS` block, lines 11-15)

**Interfaces:**
- Consumes: viem `toEventSelector`, `encodeEventTopics`, `encodeFunctionData`, `toFunctionSelector`; `Address` from `src/lib/types.ts`.
- Produces:
  ```ts
  // src/lib/launch/abi.ts
  export const svLaunchpadAbi: readonly [...] /* as const */;
  export const PRESALE_TOPIC0: { raiseCreated; raiseMetadata; contributed; finalized; closed; refunded; claimed; creatorClaimed; feesCollected; payoutChanged } /* each a 0x… topic0 string */;
  // src/lib/chain.ts
  export const SVLAUNCHPAD_ADDRESS: Address | undefined;
  export function hasLaunchpad(): boolean;
  // src/lib/launch/constants.ts
  export const SUPPLY = 1_000_000_000n * 10n ** 18n; export const SALE_BPS = 4500n; export const POOL_BPS = 4500n; export const CREATOR_BPS = 1000n;
  export const SALE_TOKENS = (SUPPLY * SALE_BPS) / 10_000n; export const WALLET_CAP_BPS = 1000n; export const MIN_FLOOR_BPS = 5000n;
  export const MIN_DURATION_SEC = 3600; export const MAX_DURATION_SEC = 30 * 86_400; export const MAX_START_DELAY_SEC = 14 * 86_400;
  export const STALL_GRACE_SEC = 7 * 86_400; export const MAX_FEE_BPS = 500; export const CREATOR_TOKENS = (SUPPLY * CREATOR_BPS) / 10_000n; export const CREATOR_VESTING_SEC = 90 * 86_400;
  // src/lib/chain/types.ts
  export type RaiseCreatedEvent, RaiseMetadataEvent, ContributedEvent, FinalizedEvent, ClosedEvent, RefundedEvent, ClaimedEvent, CreatorClaimedEvent, FeesCollectedEvent, PayoutChangedEvent;
  export type PresaleEvent = RaiseCreatedEvent | … | PayoutChangedEvent;
  export type PoolManagerEvent = InitializeEvent | SwapEvent | ModifyLiquidityEvent;
  ```

The function ABI below is spec section 4.2's "Function signatures" block, verbatim and in the block's order: `CreateParams` in its field order with `start` and `duration` as `uint64`, the eight writes, the six admin setters, and the thirteen views, `getRaise` returning the `Raise` struct in the spec's storage order and `poolKey` returning v4's `PoolKey`. `ISVLaunchpad` is the single source for the contracts and this file; `abi.test.ts` pins each selector to the block's canonical signature and `getRaise`'s and `poolKey`'s output layouts, so a fragment that drifts from the interface fails the suite here rather than a transaction. `create` treats `start == 0` as the block's own timestamp (spec 4.2, create step 2), which is what the form sends for "now". The screens read only `feeBps`, `launcherGate`, `creationOpen` and `quoteLimits`, all in the block.

- [ ] **Step 1: Write the failing test**

Create `src/lib/launch/abi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeAbiParameters, encodeEventTopics, encodeFunctionData, toEventSelector, toFunctionSelector } from "viem";
import type { Address } from "@/lib/types";
import { PRESALE_TOPIC0, svLaunchpadAbi } from "./abi";

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** Canonical (type-only) signatures, copied from the design spec section 4.2, so topic0 is pinned independently of how abi.ts spells the fields. */
const EVENTS: ReadonlyArray<[keyof typeof PRESALE_TOPIC0 | null, string, string]> = [
  ["raiseCreated", "RaiseCreated", "RaiseCreated(uint256,address,address,uint256,uint256,uint64,uint64,uint256)"],
  ["raiseMetadata", "RaiseMetadata", "RaiseMetadata(uint256,string,string,string,string,string,string)"],
  ["contributed", "Contributed", "Contributed(uint256,address,uint256,uint256)"],
  ["finalized", "Finalized", "Finalized(uint256,address,bytes32,uint160,uint256,uint256,uint256,uint256,uint256,uint128)"],
  ["closed", "Closed", "Closed(uint256,uint256)"],
  ["refunded", "Refunded", "Refunded(uint256,address,uint256)"],
  ["claimed", "Claimed", "Claimed(uint256,address,uint256)"],
  ["creatorClaimed", "CreatorClaimed", "CreatorClaimed(uint256,address,uint256)"],
  ["feesCollected", "FeesCollected", "FeesCollected(uint256,uint256,uint256,uint256,uint256)"],
  ["payoutChanged", "PayoutChanged", "PayoutChanged(uint256,address)"],
  [null, "FeeChanged", "FeeChanged(uint16)"],
  [null, "FeeWalletChanged", "FeeWalletChanged(address)"],
  [null, "QuoteChanged", "QuoteChanged(address,uint256,uint256)"],
  [null, "LauncherGateChanged", "LauncherGateChanged(address)"],
  [null, "CreatorFeeShareChanged", "CreatorFeeShareChanged(uint16)"],
  [null, "CreationOpenChanged", "CreationOpenChanged(bool)"],
];

type EventItem = Extract<(typeof svLaunchpadAbi)[number], { type: "event" }>;
const eventItem = (name: string): EventItem => svLaunchpadAbi.find((i): i is EventItem => i.type === "event" && i.name === name)!;
const layout = (name: string) => eventItem(name).inputs.map((i) => [i.name, i.type, "indexed" in i ? i.indexed : false]);

describe("svLaunchpadAbi events (spec section 4.2)", () => {
  it("carries exactly the sixteen events, each with the Solidity signature's topic0", () => {
    const names = svLaunchpadAbi.filter((i) => i.type === "event").map((i) => i.name).sort();
    expect(names).toEqual(EVENTS.map(([, name]) => name).sort());
    for (const [, name, canonical] of EVENTS) {
      expect(encodeEventTopics({ abi: svLaunchpadAbi, eventName: name as EventItem["name"] })[0]).toBe(toEventSelector(canonical));
    }
  });

  it("maps the ten folded events to their topic0, and only those", () => {
    for (const [key, name, canonical] of EVENTS) {
      if (key) expect(PRESALE_TOPIC0[key]).toBe(toEventSelector(canonical));
      expect(Object.values(PRESALE_TOPIC0).includes(toEventSelector(canonical))).toBe(key !== null);
    }
    expect(new Set(Object.values(PRESALE_TOPIC0)).size).toBe(10);
  });

  it("gives every folded event its exact parameter names, types and indexed flags", () => {
    expect(layout("RaiseCreated")).toEqual([
      ["id", "uint256", true], ["creator", "address", true], ["quote", "address", true],
      ["target", "uint256", false], ["floor", "uint256", false], ["start", "uint64", false], ["deadline", "uint64", false], ["saleTokens", "uint256", false],
    ]);
    expect(layout("RaiseMetadata")).toEqual([
      ["id", "uint256", true], ["name", "string", false], ["symbol", "string", false],
      ["image", "string", false], ["website", "string", false], ["x", "string", false], ["telegram", "string", false],
    ]);
    expect(layout("Contributed")).toEqual([["id", "uint256", true], ["wallet", "address", true], ["amount", "uint256", false], ["raised", "uint256", false]]);
    expect(layout("Finalized")).toEqual([
      ["id", "uint256", true], ["token", "address", true], ["poolId", "bytes32", true],
      ["sqrtPriceX96", "uint160", false], ["raised", "uint256", false], ["fee", "uint256", false], ["quoteToPool", "uint256", false],
      ["tokensToPool", "uint256", false], ["tokensBurned", "uint256", false], ["liquidity", "uint128", false],
    ]);
    expect(layout("Closed")).toEqual([["id", "uint256", true], ["raised", "uint256", false]]);
    expect(layout("Refunded")).toEqual([["id", "uint256", true], ["wallet", "address", true], ["amount", "uint256", false]]);
    expect(layout("Claimed")).toEqual([["id", "uint256", true], ["wallet", "address", true], ["amount", "uint256", false]]);
    expect(layout("CreatorClaimed")).toEqual([["id", "uint256", true], ["payout", "address", true], ["amount", "uint256", false]]);
    expect(layout("FeesCollected")).toEqual([
      ["id", "uint256", true], ["creator0", "uint256", false], ["creator1", "uint256", false], ["platform0", "uint256", false], ["platform1", "uint256", false],
    ]);
    expect(layout("PayoutChanged")).toEqual([["id", "uint256", true], ["payout", "address", false]]);
    expect(layout("QuoteChanged")).toEqual([["asset", "address", true], ["minTarget", "uint256", false], ["maxTarget", "uint256", false]]);
  });
});

describe("svLaunchpadAbi functions (spec section 4.2's Function signatures block, verbatim)", () => {
  it("carries exactly the block's functions, each encoding with the selector of its canonical signature", () => {
    const permit = { permitted: { token: A, amount: 5n }, nonce: 7n, deadline: 9n };
    const cases: ReadonlyArray<[string, `0x${string}`]> = [
      ["create((string,string,string,string,string,string,address,uint256,uint256,uint64,uint64))",
        encodeFunctionData({ abi: svLaunchpadAbi, functionName: "create", args: [{ name: "N", symbol: "S", image: "", website: "", x: "", telegram: "", quote: A, target: 1n, floor: 1n, start: 0n, duration: 3600n }] })],
      ["contribute(uint256,uint256,((address,uint256),uint256,uint256),bytes)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "contribute", args: [1n, 5n, permit, "0xabcd"] })],
      ["finalize(uint256)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "finalize", args: [1n] })],
      ["claim(uint256)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "claim", args: [1n] })],
      ["claimCreator(uint256)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "claimCreator", args: [1n] })],
      ["refund(uint256)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "refund", args: [1n] })],
      ["collectFees(uint256)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "collectFees", args: [1n] })],
      ["setPayout(uint256,address)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "setPayout", args: [1n, A] })],
      ["setFee(uint16)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "setFee", args: [200] })],
      ["setFeeWallet(address)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "setFeeWallet", args: [A] })],
      ["setQuote(address,uint256,uint256)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "setQuote", args: [A, 1n, 2n] })],
      ["setLauncherGate(address)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "setLauncherGate", args: [A] })],
      ["setCreatorFeeShare(uint16)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "setCreatorFeeShare", args: [7000] })],
      ["setCreationOpen(bool)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "setCreationOpen", args: [true] })],
      ["getRaise(uint256)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "getRaise", args: [1n] })],
      ["contributed(uint256,address)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "contributed", args: [1n, A] })],
      ["claimed(uint256,address)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "claimed", args: [1n, A] })],
      ["nextId()", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "nextId" })],
      ["feeBps()", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "feeBps" })],
      ["feeWallet()", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "feeWallet" })],
      ["launcherGate()", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "launcherGate" })],
      ["creatorFeeShareBps()", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "creatorFeeShareBps" })],
      ["creationOpen()", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "creationOpen" })],
      ["quoteLimits(address)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "quoteLimits", args: [A] })],
      ["poolKey(uint256)", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "poolKey", args: [1n] })],
      ["poolManager()", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "poolManager" })],
      ["permit2()", encodeFunctionData({ abi: svLaunchpadAbi, functionName: "permit2" })],
    ];
    for (const [canonical, data] of cases) expect(data.slice(0, 10)).toBe(toFunctionSelector(canonical));
    // No function beyond the block's, and none of the block's missing.
    const names = svLaunchpadAbi.filter((i) => i.type === "function").map((i) => i.name).sort();
    expect(names).toEqual(cases.map(([canonical]) => canonical.slice(0, canonical.indexOf("("))).sort());
  });

  it("decodes getRaise's Raise struct in the spec's storage order, and poolKey's PoolKey", () => {
    const raise = {
      creator: A, payout: B, quote: A, token: B, target: 1_000_000_000n, floor: 500_000_000n, start: 10n, deadline: 20n, raised: 5n,
      saleTokens: 450_000_000n * 10n ** 18n, creatorClaimed: 0n, sqrtPriceX96: 2n ** 96n, liquidity: 12n, launchedAt: 30n,
      creatorFeeShareBps: 7000, status: 2, name: "Tailor's Chalk", symbol: "CHALK",
    };
    const encodedRaise = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "creator", type: "address" }, { name: "payout", type: "address" }, { name: "quote", type: "address" }, { name: "token", type: "address" },
            { name: "target", type: "uint256" }, { name: "floor", type: "uint256" }, { name: "start", type: "uint64" }, { name: "deadline", type: "uint64" },
            { name: "raised", type: "uint256" }, { name: "saleTokens", type: "uint256" }, { name: "creatorClaimed", type: "uint256" },
            { name: "sqrtPriceX96", type: "uint160" }, { name: "liquidity", type: "uint128" }, { name: "launchedAt", type: "uint64" },
            { name: "creatorFeeShareBps", type: "uint16" }, { name: "status", type: "uint8" }, { name: "name", type: "string" }, { name: "symbol", type: "string" },
          ],
        },
      ],
      [raise],
    );
    expect(decodeFunctionResult({ abi: svLaunchpadAbi, functionName: "getRaise", data: encodedRaise })).toEqual(raise);

    const key = { currency0: A, currency1: B, fee: 10_000, tickSpacing: 200, hooks: ZERO };
    const encodedKey = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" },
            { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
          ],
        },
      ],
      [key],
    );
    expect(decodeFunctionResult({ abi: svLaunchpadAbi, functionName: "poolKey", data: encodedKey })).toEqual(key);
  });

  it("carries the interface's error names so a revert can be read", () => {
    const errors = svLaunchpadAbi.filter((i) => i.type === "error").map((i) => i.name).sort();
    expect(errors).toEqual([
      "AlreadyClaimed", "CreationClosed", "DurationOutOfRange", "Ended", "FeeTooHigh", "FloorOutOfRange", "NotAllowedToLaunch", "NotCreator",
      "NotLaunchable", "NotLaunched", "NotOpen", "NotPoolManager", "NotRefundable", "NotStarted", "NothingToClaim", "PermitMismatch",
      "QuoteNotEnabled", "RaiseFull", "RenounceDisabled", "StartOutOfRange", "TargetOutOfRange", "TextTooLong", "UnexpectedCallback",
      "WalletCapReached", "ZeroAddress", "ZeroAmount",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/launch/abi.test.ts`
Expected: FAIL with "Cannot find module './abi'".

- [ ] **Step 3: Write the ABI**

Create `src/lib/launch/abi.ts`:

```ts
import { toEventSelector } from "viem";

/**
 * The SVLaunchpad interface (docs/superpowers/specs/2026-09-27-launchpad-design.md, section 4.2): the
 * "Function signatures" block and the events list, both verbatim and in the block's order. `ISVLaunchpad` is
 * the single source for the contracts and this file; `abi.test.ts` pins every selector, `getRaise`'s and
 * `poolKey`'s output layouts and every event's topic0, so a fragment that drifts from the interface fails the
 * suite here rather than a transaction. Solidity's `IPoolManager` and `ISignatureTransfer` return types are plain
 * addresses in the ABI; `Raise` and `PoolKey` are tuples in their struct order.
 */
export const svLaunchpadAbi = [
  // --- CreateParams and the writes ---------------------------------------------
  {
    type: "function",
    name: "create",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "image", type: "string" },
          { name: "website", type: "string" },
          { name: "x", type: "string" },
          { name: "telegram", type: "string" },
          { name: "quote", type: "address" },
          { name: "target", type: "uint256" },
          { name: "floor", type: "uint256" },
          { name: "start", type: "uint64" },
          { name: "duration", type: "uint64" },
        ],
      },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "contribute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "amount", type: "uint256" },
      {
        name: "permit",
        type: "tuple",
        components: [
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
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  { type: "function", name: "finalize", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  { type: "function", name: "claimCreator", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  { type: "function", name: "refund", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  { type: "function", name: "collectFees", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  {
    type: "function",
    name: "setPayout",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "payout", type: "address" },
    ],
    outputs: [],
  },
  // --- the admin setters ---------------------------------------------------------
  { type: "function", name: "setFee", stateMutability: "nonpayable", inputs: [{ name: "bps", type: "uint16" }], outputs: [] },
  { type: "function", name: "setFeeWallet", stateMutability: "nonpayable", inputs: [{ name: "wallet", type: "address" }], outputs: [] },
  {
    type: "function",
    name: "setQuote",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "minTarget", type: "uint256" },
      { name: "maxTarget", type: "uint256" },
    ],
    outputs: [],
  },
  { type: "function", name: "setLauncherGate", stateMutability: "nonpayable", inputs: [{ name: "nft", type: "address" }], outputs: [] },
  { type: "function", name: "setCreatorFeeShare", stateMutability: "nonpayable", inputs: [{ name: "bps", type: "uint16" }], outputs: [] },
  { type: "function", name: "setCreationOpen", stateMutability: "nonpayable", inputs: [{ name: "open", type: "bool" }], outputs: [] },
  // --- the views ------------------------------------------------------------------
  {
    type: "function",
    name: "getRaise",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "creator", type: "address" },
          { name: "payout", type: "address" },
          { name: "quote", type: "address" },
          { name: "token", type: "address" },
          { name: "target", type: "uint256" },
          { name: "floor", type: "uint256" },
          { name: "start", type: "uint64" },
          { name: "deadline", type: "uint64" },
          { name: "raised", type: "uint256" },
          { name: "saleTokens", type: "uint256" },
          { name: "creatorClaimed", type: "uint256" },
          { name: "sqrtPriceX96", type: "uint160" },
          { name: "liquidity", type: "uint128" },
          { name: "launchedAt", type: "uint64" },
          { name: "creatorFeeShareBps", type: "uint16" },
          { name: "status", type: "uint8" },
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "contributed",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "wallet", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimed",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "wallet", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  { type: "function", name: "nextId", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "function", name: "feeWallet", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "launcherGate", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "creatorFeeShareBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "function", name: "creationOpen", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  {
    type: "function",
    name: "quoteLimits",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "minTarget", type: "uint256" },
      { name: "maxTarget", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "poolKey",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
    ],
  },
  { type: "function", name: "poolManager", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "permit2", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  // --- events, verbatim from spec section 4.2 -----------------------------------
  {
    type: "event",
    name: "RaiseCreated",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "quote", type: "address", indexed: true },
      { name: "target", type: "uint256", indexed: false },
      { name: "floor", type: "uint256", indexed: false },
      { name: "start", type: "uint64", indexed: false },
      { name: "deadline", type: "uint64", indexed: false },
      { name: "saleTokens", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RaiseMetadata",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "image", type: "string", indexed: false },
      { name: "website", type: "string", indexed: false },
      { name: "x", type: "string", indexed: false },
      { name: "telegram", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Contributed",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "wallet", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "raised", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Finalized",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "raised", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "quoteToPool", type: "uint256", indexed: false },
      { name: "tokensToPool", type: "uint256", indexed: false },
      { name: "tokensBurned", type: "uint256", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Closed",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "raised", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "wallet", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "wallet", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CreatorClaimed",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "payout", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "FeesCollected",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "creator0", type: "uint256", indexed: false },
      { name: "creator1", type: "uint256", indexed: false },
      { name: "platform0", type: "uint256", indexed: false },
      { name: "platform1", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PayoutChanged",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "payout", type: "address", indexed: false },
    ],
  },
  { type: "event", name: "FeeChanged", inputs: [{ name: "bps", type: "uint16", indexed: false }] },
  { type: "event", name: "FeeWalletChanged", inputs: [{ name: "wallet", type: "address", indexed: false }] },
  {
    type: "event",
    name: "QuoteChanged",
    inputs: [
      { name: "asset", type: "address", indexed: true },
      { name: "minTarget", type: "uint256", indexed: false },
      { name: "maxTarget", type: "uint256", indexed: false },
    ],
  },
  { type: "event", name: "LauncherGateChanged", inputs: [{ name: "nft", type: "address", indexed: false }] },
  { type: "event", name: "CreatorFeeShareChanged", inputs: [{ name: "bps", type: "uint16", indexed: false }] },
  { type: "event", name: "CreationOpenChanged", inputs: [{ name: "open", type: "bool", indexed: false }] },
  // --- errors, from spec section 4.2's list -----------------------------------------
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "FeeTooHigh", inputs: [] },
  { type: "error", name: "RenounceDisabled", inputs: [] },
  { type: "error", name: "CreationClosed", inputs: [] },
  { type: "error", name: "NotAllowedToLaunch", inputs: [] },
  { type: "error", name: "QuoteNotEnabled", inputs: [] },
  { type: "error", name: "TargetOutOfRange", inputs: [] },
  { type: "error", name: "FloorOutOfRange", inputs: [] },
  { type: "error", name: "StartOutOfRange", inputs: [] },
  { type: "error", name: "DurationOutOfRange", inputs: [] },
  { type: "error", name: "TextTooLong", inputs: [] },
  { type: "error", name: "NotOpen", inputs: [] },
  { type: "error", name: "NotStarted", inputs: [] },
  { type: "error", name: "Ended", inputs: [] },
  { type: "error", name: "RaiseFull", inputs: [] },
  { type: "error", name: "WalletCapReached", inputs: [] },
  { type: "error", name: "PermitMismatch", inputs: [] },
  { type: "error", name: "NotLaunchable", inputs: [] },
  { type: "error", name: "NotLaunched", inputs: [] },
  { type: "error", name: "NothingToClaim", inputs: [] },
  { type: "error", name: "AlreadyClaimed", inputs: [] },
  { type: "error", name: "NotRefundable", inputs: [] },
  { type: "error", name: "NotCreator", inputs: [] },
  { type: "error", name: "NotPoolManager", inputs: [] },
  { type: "error", name: "UnexpectedCallback", inputs: [] },
] as const;

/**
 * topic0 of each event the fold consumes (design section 5's events-to-rows table), keyed by the ChainEvent
 * `kind` the decoder produces. The six settings events (FeeChanged and friends) are deliberately absent: the
 * decoder drops them, since nothing on screen reads a setting from history.
 */
export const PRESALE_TOPIC0 = {
  raiseCreated: toEventSelector("RaiseCreated(uint256,address,address,uint256,uint256,uint64,uint64,uint256)"),
  raiseMetadata: toEventSelector("RaiseMetadata(uint256,string,string,string,string,string,string)"),
  contributed: toEventSelector("Contributed(uint256,address,uint256,uint256)"),
  finalized: toEventSelector("Finalized(uint256,address,bytes32,uint160,uint256,uint256,uint256,uint256,uint256,uint128)"),
  closed: toEventSelector("Closed(uint256,uint256)"),
  refunded: toEventSelector("Refunded(uint256,address,uint256)"),
  claimed: toEventSelector("Claimed(uint256,address,uint256)"),
  creatorClaimed: toEventSelector("CreatorClaimed(uint256,address,uint256)"),
  feesCollected: toEventSelector("FeesCollected(uint256,uint256,uint256,uint256,uint256)"),
  payoutChanged: toEventSelector("PayoutChanged(uint256,address)"),
} as const;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/launch/abi.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add the address, the constants and the event types**

Edit `src/lib/chain.ts`. After line 94 (the closing brace of `hasRouter`) append:

```ts

/**
 * SVLaunchpad, the same deployment-choice treatment as the router above (launchpad design, section 7): the
 * env var is `NEXT_PUBLIC_…` because the browser signs against it and the chain reader adds it to its
 * HyperSync query, and it is read by direct member access because it is substituted at build time.
 * Anything that is not an address is `undefined`: the screens say the launchpad is not deployed, and the
 * reader adds no second log selection.
 */
export const SVLAUNCHPAD_ADDRESS: Address | undefined = ADDRESS.test(process.env.NEXT_PUBLIC_SVLAUNCHPAD_ADDRESS ?? "")
  ? (process.env.NEXT_PUBLIC_SVLAUNCHPAD_ADDRESS as Address)
  : undefined;

/** false renders the create form's and the raise page's "goes live when the launchpad is deployed" states. */
export function hasLaunchpad(): boolean {
  return SVLAUNCHPAD_ADDRESS !== undefined;
}
```

Create `src/lib/launch/constants.ts`:

```ts
/**
 * SVLaunchpad's constants (launchpad design, sections 3 and 4.2), repeated here for the screens' arithmetic:
 * the opening price, the per-wallet cap and the pool depth are computed in the browser from the raise's own
 * raw numbers and these. Every bigint is a raw on-chain unit; the seconds are plain numbers.
 */
export const SUPPLY = 1_000_000_000n * 10n ** 18n;
export const SALE_BPS = 4500n;
export const POOL_BPS = 4500n;
export const CREATOR_BPS = 1000n;
/** SUPPLY * SALE_BPS / 10000: the tokens every raise sells, fixed at creation (`Raise.saleTokens`). */
export const SALE_TOKENS = (SUPPLY * SALE_BPS) / 10_000n;
/** SUPPLY * CREATOR_BPS / 10000: the creator's tenth, released linearly over CREATOR_VESTING_SEC from launch (spec decision 3). */
export const CREATOR_TOKENS = (SUPPLY * CREATOR_BPS) / 10_000n;
/** At most 10 % of the target per wallet (spec section 2). */
export const WALLET_CAP_BPS = 1000n;
export const MIN_FLOOR_BPS = 5000n;
export const MIN_DURATION_SEC = 3600;
export const MAX_DURATION_SEC = 30 * 86_400;
export const MAX_START_DELAY_SEC = 14 * 86_400;
export const STALL_GRACE_SEC = 7 * 86_400;
export const CREATOR_VESTING_SEC = 90 * 86_400;
export const MAX_FEE_BPS = 500;
```

Edit `src/lib/chain/types.ts`. Replace line 55 (`export type ChainEvent = InitializeEvent | SwapEvent | ModifyLiquidityEvent;`) with:

```ts
/** The PoolManager's three events, the reader's original input. */
export type PoolManagerEvent = InitializeEvent | SwapEvent | ModifyLiquidityEvent;

// --- SVLaunchpad events (launchpad design, section 5) -------------------------------------------------
// Decoded from the launchpad's own logs by address (decode.ts), with the same lowercase convention as the
// PoolManager's. `id` is the raise id (a small sequential integer, market.presales.id); raw amounts stay bigint.

export type RaiseCreatedEvent = ChainEventBase & {
  kind: "raiseCreated";
  id: number;
  creator: string;
  quote: string;
  target: bigint;
  floor: bigint;
  start: number;
  deadline: number;
  saleTokens: bigint;
};

export type RaiseMetadataEvent = ChainEventBase & {
  kind: "raiseMetadata";
  id: number;
  name: string;
  symbol: string;
  image: string;
  website: string;
  x: string;
  telegram: string;
};

export type ContributedEvent = ChainEventBase & { kind: "contributed"; id: number; wallet: string; amount: bigint; raised: bigint };

export type FinalizedEvent = ChainEventBase & {
  kind: "finalized";
  id: number;
  token: string;
  poolId: string;
  sqrtPriceX96: bigint;
  raised: bigint;
  fee: bigint;
  quoteToPool: bigint;
  tokensToPool: bigint;
  tokensBurned: bigint;
  liquidity: bigint;
};

export type ClosedEvent = ChainEventBase & { kind: "closed"; id: number; raised: bigint };
export type RefundedEvent = ChainEventBase & { kind: "refunded"; id: number; wallet: string; amount: bigint };
export type ClaimedEvent = ChainEventBase & { kind: "claimed"; id: number; wallet: string; amount: bigint };
export type CreatorClaimedEvent = ChainEventBase & { kind: "creatorClaimed"; id: number; payout: string; amount: bigint };
export type FeesCollectedEvent = ChainEventBase & {
  kind: "feesCollected";
  id: number;
  creator0: bigint;
  creator1: bigint;
  platform0: bigint;
  platform1: bigint;
};
export type PayoutChangedEvent = ChainEventBase & { kind: "payoutChanged"; id: number; payout: string };

export type PresaleEvent =
  | RaiseCreatedEvent
  | RaiseMetadataEvent
  | ContributedEvent
  | FinalizedEvent
  | ClosedEvent
  | RefundedEvent
  | ClaimedEvent
  | CreatorClaimedEvent
  | FeesCollectedEvent
  | PayoutChangedEvent;

/** Widened to `PoolManagerEvent | PresaleEvent` in the source task, once decode.ts can produce a presale event. */
export type ChainEvent = PoolManagerEvent;
```

Edit `.env.example`: after line 15 (`NEXT_PUBLIC_SVROUTER_ADDRESS=`) insert:

```
# SVLaunchpad on Robinhood Chain, once it is deployed. Read by the browser (the create form and the raise
# page sign against it) and by the chain reader, which adds the launchpad's logs to its HyperSync query only
# while this is set. Empty means no launchpad: /launch says so, and the reader's query is unchanged.
NEXT_PUBLIC_SVLAUNCHPAD_ADDRESS=

```

- [ ] **Step 6: Run the reader's tests and the chain module's test**

Run: `npx vitest run src/lib/chain src/lib/launch`
Expected: PASS. Nothing consumes the new types yet; `chain.test.ts` still passes (`SVLAUNCHPAD_ADDRESS` is undefined in the test environment).

- [ ] **Step 7: Commit**

```bash
git add src/lib/launch/abi.ts src/lib/launch/abi.test.ts src/lib/launch/constants.ts src/lib/chain.ts src/lib/chain/types.ts .env.example
git commit -m "Launchpad: the SVLaunchpad ABI with every selector pinned, the address, the constants and the presale event types"
```

---

### Task 3: The source selects the launchpad's logs and the decoder routes by address

**Files:**
- Modify: `src/lib/chain/decode.ts` (whole file: `RawLog.address`, routing by address then topic0, presale decoding)
- Modify: `src/lib/chain/decode.test.ts:28-34` (`BASE` gains `address`) and append presale cases
- Modify: `src/lib/chain/hypersyncSource.ts:5-11` (option), `:53-62` (`HyperSyncLog.address`), `:142-151` (resolve the launchpad), `:222-232` (query body), `:270-278` (`RawLog.address`, decode options)
- Modify: `src/lib/chain/hypersyncSource.test.ts:28-44` (`swapLog` gains `address`), `:144-166` (the pinned body) and append two tests
- Modify: `src/lib/chain/types.ts` (the `ChainEvent` line, mid-file after Task 2: it widens)
- Modify: `src/lib/chain/fold.ts:225-239` (`newTokenCandidates` skips presale events) and `src/lib/chain/store.ts:129` (`loadFoldState` collects pool ids only from events that carry one)

**Interfaces:**
- Consumes: `svLaunchpadAbi`, `PRESALE_TOPIC0` (Task 2); `SVLAUNCHPAD_ADDRESS` (Task 2); `POOL_MANAGER`, `TOPIC0`, `POOL_MANAGER_EVENTS_ABI` (`src/lib/chain/abi.ts`).
- Produces:
  ```ts
  // decode.ts
  export type RawLog = { address: string; blockNumber: number; logIndex: number; txHash: string; topics: string[]; data: string; timestamp: number; txFrom: string | null };
  export type DecodeOptions = { /** The launchpad's address, lowercase; null or absent decodes PoolManager logs only. */ launchpad?: string | null };
  export function decodeLog(raw: RawLog, opts?: DecodeOptions): ChainEvent | null;
  // hypersyncSource.ts
  export type HyperSyncSourceOptions = { url?; token?; fetchImpl?; sleep?; maxAttempts?; /** undefined reads SVLAUNCHPAD_ADDRESS; null means no launchpad. */ launchpad?: string | null };
  // types.ts
  export type ChainEvent = PoolManagerEvent | PresaleEvent;
  ```

- [ ] **Step 1: Write the failing decoder tests**

Edit `src/lib/chain/decode.test.ts`. Add these imports at the top, after line 4:

```ts
import { POOL_MANAGER } from "./abi";
import { svLaunchpadAbi } from "@/lib/launch/abi";
```

Replace lines 28-34 (`BASE`) with:

```ts
const LAUNCHPAD = "0x5555555555555555555555555555555555555555";
const BASE: Omit<RawLog, "topics" | "data"> = {
  address: POOL_MANAGER.toUpperCase().replace("0X", "0x"), // mixed case: the address route must lowercase too
  blockNumber: 68_500_000,
  logIndex: 7,
  txHash: TX_HASH,
  timestamp: 1_700_000_000,
  txFrom: TX_FROM,
};
```

Append this block at the end of the file:

```ts
describe("decodeLog routes by address before topic0 (launchpad design, section 5)", () => {
  const WALLET = "0x7777777777777777777777777777777777777777";
  const TOKEN = "0x8888888888888888888888888888888888888888";
  const strings = (s: string[]) => encodeAbiParameters(s.map(() => ({ type: "string" })), s);

  it("drops a PoolManager-shaped log emitted by any other address", () => {
    const topics = encodeEventTopics({ abi: POOL_MANAGER_EVENTS_ABI, eventName: "Swap", args: { id: POOL_ID, sender: SENDER } });
    const data = encodeAbiParameters(
      [{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }],
      [1n, -1n, 1n, 1n, 0, 0],
    );
    expect(decodeLog({ ...BASE, address: LAUNCHPAD, topics: topicsOf(topics), data }, { launchpad: LAUNCHPAD })).toBeNull();
    expect(decodeLog({ ...BASE, address: "0x9999999999999999999999999999999999999999", topics: topicsOf(topics), data })).toBeNull();
  });

  it("decodes RaiseCreated from the launchpad's address, lowercasing the addresses and keeping the amounts as bigint", () => {
    const topics = encodeEventTopics({ abi: svLaunchpadAbi, eventName: "RaiseCreated", args: { id: 7n, creator: WALLET, quote: CURRENCY1 } });
    const data = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint64" }, { type: "uint64" }, { type: "uint256" }],
      [1_000_000_000n, 500_000_000n, 1_700_000_100n, 1_700_086_500n, 450_000_000n * 10n ** 18n],
    );
    const event = decodeLog({ ...BASE, address: LAUNCHPAD.toUpperCase().replace("0X", "0x"), topics: topicsOf(topics), data }, { launchpad: LAUNCHPAD });
    expect(event).toEqual({
      kind: "raiseCreated",
      block: BASE.blockNumber,
      logIndex: BASE.logIndex,
      timestamp: BASE.timestamp,
      txHash: TX_HASH.toLowerCase(),
      txFrom: TX_FROM.toLowerCase(),
      id: 7,
      creator: WALLET,
      quote: CURRENCY1,
      target: 1_000_000_000n,
      floor: 500_000_000n,
      start: 1_700_000_100,
      deadline: 1_700_086_500,
      saleTokens: 450_000_000n * 10n ** 18n,
    });
  });

  it("decodes RaiseMetadata's six strings as given", () => {
    const topics = encodeEventTopics({ abi: svLaunchpadAbi, eventName: "RaiseMetadata", args: { id: 7n } });
    const data = strings(["Tailor's Chalk", "CHALK", "https://img.test/chalk.png", "https://chalk.test", "https://x.com/chalk", "https://t.me/chalk"]);
    expect(decodeLog({ ...BASE, address: LAUNCHPAD, topics: topicsOf(topics), data }, { launchpad: LAUNCHPAD })).toMatchObject({
      kind: "raiseMetadata",
      id: 7,
      name: "Tailor's Chalk",
      symbol: "CHALK",
      image: "https://img.test/chalk.png",
      website: "https://chalk.test",
      x: "https://x.com/chalk",
      telegram: "https://t.me/chalk",
    });
  });

  it("decodes Contributed, Finalized, Closed, Refunded, Claimed, CreatorClaimed, FeesCollected and PayoutChanged", () => {
    const at = (eventName: "Contributed" | "Refunded" | "Claimed" | "CreatorClaimed" | "Closed" | "FeesCollected" | "PayoutChanged" | "Finalized", args: Record<string, unknown>, types: string[], values: unknown[]) => {
      const topics = encodeEventTopics({ abi: svLaunchpadAbi, eventName, args } as Parameters<typeof encodeEventTopics>[0]);
      const data = encodeAbiParameters(types.map((type) => ({ type })), values);
      return decodeLog({ ...BASE, address: LAUNCHPAD, topics: topicsOf(topics), data }, { launchpad: LAUNCHPAD });
    };
    expect(at("Contributed", { id: 7n, wallet: WALLET }, ["uint256", "uint256"], [25n, 125n])).toMatchObject({ kind: "contributed", id: 7, wallet: WALLET, amount: 25n, raised: 125n });
    expect(
      at("Finalized", { id: 7n, token: TOKEN, poolId: POOL_ID }, ["uint160", "uint256", "uint256", "uint256", "uint256", "uint256", "uint128"], [2n ** 96n, 1000n, 20n, 980n, 441_000n, 9_000n, 12_345n]),
    ).toMatchObject({ kind: "finalized", id: 7, token: TOKEN, poolId: POOL_ID.toLowerCase(), sqrtPriceX96: 2n ** 96n, raised: 1000n, fee: 20n, quoteToPool: 980n, tokensToPool: 441_000n, tokensBurned: 9_000n, liquidity: 12_345n });
    expect(at("Closed", { id: 7n }, ["uint256"], [300n])).toMatchObject({ kind: "closed", id: 7, raised: 300n });
    expect(at("Refunded", { id: 7n, wallet: WALLET }, ["uint256"], [25n])).toMatchObject({ kind: "refunded", id: 7, wallet: WALLET, amount: 25n });
    expect(at("Claimed", { id: 7n, wallet: WALLET }, ["uint256"], [99n])).toMatchObject({ kind: "claimed", id: 7, wallet: WALLET, amount: 99n });
    expect(at("CreatorClaimed", { id: 7n, payout: WALLET }, ["uint256"], [5n])).toMatchObject({ kind: "creatorClaimed", id: 7, payout: WALLET, amount: 5n });
    expect(at("FeesCollected", { id: 7n }, ["uint256", "uint256", "uint256", "uint256"], [1n, 2n, 3n, 4n])).toMatchObject({ kind: "feesCollected", id: 7, creator0: 1n, creator1: 2n, platform0: 3n, platform1: 4n });
    expect(at("PayoutChanged", { id: 7n }, ["address"], [WALLET])).toMatchObject({ kind: "payoutChanged", id: 7, payout: WALLET });
  });

  it("drops the launchpad's settings events and an unknown topic0 from the launchpad", () => {
    const topics = encodeEventTopics({ abi: svLaunchpadAbi, eventName: "FeeChanged" });
    const data = encodeAbiParameters([{ type: "uint16" }], [200]);
    expect(decodeLog({ ...BASE, address: LAUNCHPAD, topics: topicsOf(topics), data }, { launchpad: LAUNCHPAD })).toBeNull();
    expect(decodeLog({ ...BASE, address: LAUNCHPAD, topics: ["0x" + "9".repeat(64)], data: "0x" }, { launchpad: LAUNCHPAD })).toBeNull();
  });

  it("decodes nothing from the launchpad while no launchpad address is configured", () => {
    const topics = encodeEventTopics({ abi: svLaunchpadAbi, eventName: "Closed", args: { id: 7n } });
    const data = encodeAbiParameters([{ type: "uint256" }], [300n]);
    expect(decodeLog({ ...BASE, address: LAUNCHPAD, topics: topicsOf(topics), data })).toBeNull();
    expect(decodeLog({ ...BASE, address: LAUNCHPAD, topics: topicsOf(topics), data }, { launchpad: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the decoder test to verify it fails**

Run: `npx vitest run src/lib/chain/decode.test.ts`
Expected: FAIL. The existing cases fail to type-check at runtime only if `address` is unknown to `RawLog` (vitest does not type-check, so they still pass); the new block fails because `decodeLog` ignores `address` and returns a `swap` for the decoy, and returns `null` for every launchpad log.

- [ ] **Step 3: Write the decoder**

Replace the whole of `src/lib/chain/decode.ts` with:

```ts
import { decodeEventLog, type Hex } from "viem";
import { PRESALE_TOPIC0, svLaunchpadAbi } from "@/lib/launch/abi";
import { POOL_MANAGER, POOL_MANAGER_EVENTS_ABI, TOPIC0 } from "./abi";
import type { ChainEvent, ChainEventBase, PresaleEvent } from "./types";

/**
 * What `hypersyncSource.ts` hands to `decodeLog` for one log, once its block's timestamp and its
 * transaction's sender are known (HyperSync answers those separately from the log itself; joining
 * them is the source's job, not this one's). `address` is the emitting contract: since the launchpad
 * joined the query (launchpad design, section 5) a log is routed by address first and topic0 second.
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
  /** The launchpad's address, lowercase. Null or absent: only PoolManager logs decode, exactly as before the launchpad. */
  launchpad?: string | null;
};

/**
 * Decodes one log into the `ChainEvent` its address and topic0 name, or `null` for a log this reader does
 * not track: a PoolManager topic0 outside the three, a launchpad settings event, or any other emitter
 * (the HyperSync query already filters by address, so the last is a defensive fallback, not the common
 * case).
 *
 * Every address, pool id and hash comes back lowercase (types.ts's convention: compared lowercase
 * everywhere). `fee`, `tick`, `tickSpacing`, `tickLower`, `tickUpper`, a raise `id` and its `start` and
 * `deadline` come back `number`; every other on-chain integer (amounts, `liquidity`, `liquidityDelta`,
 * `sqrtPriceX96`, `target`, `raised`, …) comes back `bigint`, never routed through `number`.
 */
export function decodeLog(raw: RawLog, opts: DecodeOptions = {}): ChainEvent | null {
  const topic0 = raw.topics[0]?.toLowerCase();
  if (!topic0) return null;

  const address = raw.address.toLowerCase();
  const base: ChainEventBase = {
    block: raw.blockNumber,
    logIndex: raw.logIndex,
    timestamp: raw.timestamp,
    txHash: raw.txHash.toLowerCase(),
    txFrom: raw.txFrom ? raw.txFrom.toLowerCase() : null,
  };

  if (address === POOL_MANAGER) return decodePoolManagerLog(raw, base, topic0);
  const launchpad = opts.launchpad?.toLowerCase();
  if (launchpad && address === launchpad) return decodePresaleLog(raw, base, topic0);
  return null;
}

function decodePoolManagerLog(raw: RawLog, base: ChainEventBase, topic0: string): ChainEvent | null {
  const topics = raw.topics as [Hex, ...Hex[]];
  const data = raw.data as Hex;

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

/** The ten folded launchpad events (design section 5's table). A settings event or an unknown topic0 is null. */
function decodePresaleLog(raw: RawLog, base: ChainEventBase, topic0: string): PresaleEvent | null {
  const topics = raw.topics as [Hex, ...Hex[]];
  const data = raw.data as Hex;

  switch (topic0) {
    case PRESALE_TOPIC0.raiseCreated: {
      const { args } = decodeEventLog({ abi: svLaunchpadAbi, eventName: "RaiseCreated", topics, data });
      return {
        ...base,
        kind: "raiseCreated",
        id: Number(args.id),
        creator: args.creator.toLowerCase(),
        quote: args.quote.toLowerCase(),
        target: args.target,
        floor: args.floor,
        start: Number(args.start),
        deadline: Number(args.deadline),
        saleTokens: args.saleTokens,
      };
    }
    case PRESALE_TOPIC0.raiseMetadata: {
      const { args } = decodeEventLog({ abi: svLaunchpadAbi, eventName: "RaiseMetadata", topics, data });
      return {
        ...base,
        kind: "raiseMetadata",
        id: Number(args.id),
        name: args.name,
        symbol: args.symbol,
        image: args.image,
        website: args.website,
        x: args.x,
        telegram: args.telegram,
      };
    }
    case PRESALE_TOPIC0.contributed: {
      const { args } = decodeEventLog({ abi: svLaunchpadAbi, eventName: "Contributed", topics, data });
      return { ...base, kind: "contributed", id: Number(args.id), wallet: args.wallet.toLowerCase(), amount: args.amount, raised: args.raised };
    }
    case PRESALE_TOPIC0.finalized: {
      const { args } = decodeEventLog({ abi: svLaunchpadAbi, eventName: "Finalized", topics, data });
      return {
        ...base,
        kind: "finalized",
        id: Number(args.id),
        token: args.token.toLowerCase(),
        poolId: args.poolId.toLowerCase(),
        sqrtPriceX96: args.sqrtPriceX96,
        raised: args.raised,
        fee: args.fee,
        quoteToPool: args.quoteToPool,
        tokensToPool: args.tokensToPool,
        tokensBurned: args.tokensBurned,
        liquidity: args.liquidity,
      };
    }
    case PRESALE_TOPIC0.closed: {
      const { args } = decodeEventLog({ abi: svLaunchpadAbi, eventName: "Closed", topics, data });
      return { ...base, kind: "closed", id: Number(args.id), raised: args.raised };
    }
    case PRESALE_TOPIC0.refunded: {
      const { args } = decodeEventLog({ abi: svLaunchpadAbi, eventName: "Refunded", topics, data });
      return { ...base, kind: "refunded", id: Number(args.id), wallet: args.wallet.toLowerCase(), amount: args.amount };
    }
    case PRESALE_TOPIC0.claimed: {
      const { args } = decodeEventLog({ abi: svLaunchpadAbi, eventName: "Claimed", topics, data });
      return { ...base, kind: "claimed", id: Number(args.id), wallet: args.wallet.toLowerCase(), amount: args.amount };
    }
    case PRESALE_TOPIC0.creatorClaimed: {
      const { args } = decodeEventLog({ abi: svLaunchpadAbi, eventName: "CreatorClaimed", topics, data });
      return { ...base, kind: "creatorClaimed", id: Number(args.id), payout: args.payout.toLowerCase(), amount: args.amount };
    }
    case PRESALE_TOPIC0.feesCollected: {
      const { args } = decodeEventLog({ abi: svLaunchpadAbi, eventName: "FeesCollected", topics, data });
      return {
        ...base,
        kind: "feesCollected",
        id: Number(args.id),
        creator0: args.creator0,
        creator1: args.creator1,
        platform0: args.platform0,
        platform1: args.platform1,
      };
    }
    case PRESALE_TOPIC0.payoutChanged: {
      const { args } = decodeEventLog({ abi: svLaunchpadAbi, eventName: "PayoutChanged", topics, data });
      return { ...base, kind: "payoutChanged", id: Number(args.id), payout: args.payout.toLowerCase() };
    }
    default:
      return null;
  }
}
```

Edit `src/lib/chain/types.ts`: replace the two lines Task 2 left after the `PresaleEvent` union, mid-file (the comment and `export type ChainEvent = PoolManagerEvent;`), with:

```ts
/** Everything the source hands the fold: the PoolManager's three events and the launchpad's ten, in (block, logIndex) order. */
export type ChainEvent = PoolManagerEvent | PresaleEvent;
```

Edit `src/lib/chain/fold.ts` `newTokenCandidates` (lines 225-239). Replace the loop body with:

```ts
  for (const event of events) {
    if (event.kind === "initialize") {
      const c = initializeTarget(event, state);
      if (!c) continue;
      const existing = state.tokens.get(c.token);
      if (!existing || !existing.metadataLoaded) add(c.token);
      continue;
    }
    // A launchpad event names no pool this fold prices; only the PoolManager's Swap and ModifyLiquidity
    // can surface the MAJOR-1 repair case below.
    if (event.kind !== "swap" && event.kind !== "modifyLiquidity") continue;
    // Swap and ModifyLiquidity: a pool this batch touches whose token is known but still
    // unloaded is the MAJOR-1 repair case, not a creation — same rule either way: worth
    // reading again.
    const pool = state.pools.get(event.poolId);
    const token = pool ? state.tokens.get(pool.tokenId) : undefined;
    if (token && !token.metadataLoaded) add(token.id);
  }
```

Edit `src/lib/chain/store.ts` line 129. Replace:

```ts
  const poolIds = [...new Set(events.map((e) => e.poolId))];
```

with:

```ts
  // Only the events that name a pool: the PoolManager's three, and Finalized (its launch pool, so a replayed
  // launch batch loads the pool whose origin the fold flips to SV). The other launchpad events carry none.
  const poolIds = [...new Set(events.flatMap((e) => ("poolId" in e ? [e.poolId] : [])))];
```

- [ ] **Step 4: Run the decoder test to verify it passes**

Run: `npx vitest run src/lib/chain/decode.test.ts src/lib/chain/fold.test.ts src/lib/chain/store.test.ts`
Expected: PASS (the fold and store suites prove the two guards changed nothing for PoolManager events).

- [ ] **Step 5: Write the failing source tests**

Edit `src/lib/chain/hypersyncSource.test.ts`.

Replace lines 28-44 (`swapLog`) with a version that carries the emitter's address:

```ts
/** Topics + data for one Swap log, HyperSync-shaped (a raw JSON object, not yet decoded). `address` is the emitter, selected since the launchpad joined the query. */
function swapLog(opts: { blockNumber?: number; logIndex?: number; txHash?: string; amount0?: bigint; amount1?: bigint; address?: string } = {}) {
  const topics = encodeEventTopics({ abi: POOL_MANAGER_EVENTS_ABI, eventName: "Swap", args: { id: POOL_ID, sender: SENDER } });
  const data = encodeAbiParameters(
    [{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }],
    [opts.amount0 ?? -1000n, opts.amount1 ?? 2000n, 79_228_162_514_264_337_593_543_950_336n, 123_456n, 100, 3000],
  );
  return {
    address: opts.address ?? POOL_MANAGER,
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

const LAUNCHPAD = "0x5555555555555555555555555555555555555555";
const CONTRIBUTOR = "0x7777777777777777777777777777777777777777";

/** One Contributed log from the launchpad, HyperSync-shaped. */
function contributedLog(opts: { blockNumber?: number; logIndex?: number; address?: string } = {}) {
  const topics = encodeEventTopics({ abi: svLaunchpadAbi, eventName: "Contributed", args: { id: 3n, wallet: CONTRIBUTOR } });
  return {
    address: opts.address ?? LAUNCHPAD,
    block_number: opts.blockNumber ?? 100,
    log_index: opts.logIndex ?? 0,
    transaction_hash: TX_HASH,
    topic0: topics[0],
    topic1: topics[1],
    topic2: topics[2],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [25n, 125n]),
  };
}
```

Add the import after line 3:

```ts
import { svLaunchpadAbi } from "@/lib/launch/abi";
```

Replace the pinned-body test (lines 144-166, the `describe("fetch: request shape", …)` block) with:

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
          log: ["address", "block_number", "log_index", "transaction_hash", "topic0", "topic1", "topic2", "topic3", "data"],
          transaction: ["hash", "from"],
        },
      });
    });

    // Launchpad design, section 5: the launchpad joins as a second selection with no topic filter, at no extra
    // request, and only when an address is configured.
    it("adds the launchpad as a second selection with no topic filter when one is configured, lowercased", async () => {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(page([], 200)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, launchpad: LAUNCHPAD.toUpperCase().replace("0X", "0x") });
      await source.fetch(100, 199);
      const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as Record<string, unknown>;
      expect(body.logs).toEqual([
        { address: [POOL_MANAGER], topics: [[TOPIC0.initialize, TOPIC0.swap, TOPIC0.modifyLiquidity]] },
        { address: [LAUNCHPAD] },
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
```

Then append, inside `describe("fetch: decoding and joining", …)` after the "drops a log whose topic0…" test (after line 271):

```ts
    it("decodes a launchpad log by its address, and drops a PoolManager-shaped log from any other address", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          page(
            [
              {
                logs: [
                  contributedLog({ logIndex: 0 }),
                  swapLog({ logIndex: 1, address: "0x9999999999999999999999999999999999999999" }), // a decoy emitter
                  swapLog({ logIndex: 2 }),
                ],
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
        ["contributed", 0],
        ["swap", 2],
      ]);
      expect(events[0]).toMatchObject({ kind: "contributed", id: 3, wallet: CONTRIBUTOR, amount: 25n, raised: 125n, txFrom: TX_FROM.toLowerCase() });
    });

    it("drops a launchpad log while no launchpad is configured, even though the query would not have asked for it", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(page([{ logs: [contributedLog()], blocks: [{ number: 100, timestamp: "0x1" }], transactions: [{ hash: TX_HASH, from: TX_FROM }] }], 200)),
      );
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, launchpad: null });
      await expect(source.fetch(100, 199)).resolves.toMatchObject({ events: [] });
    });
```

- [ ] **Step 6: Run the source test to verify it fails**

Run: `npx vitest run src/lib/chain/hypersyncSource.test.ts`
Expected: FAIL: the pinned body lacks `"address"`, the second selection is missing, and the launchpad log decodes to nothing.

- [ ] **Step 7: Write the source changes**

Edit `src/lib/chain/hypersyncSource.ts`.

Add the import after line 1:

```ts
import { SVLAUNCHPAD_ADDRESS } from "@/lib/chain";
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
   * The SVLaunchpad's address (launchpad design, section 5). Undefined reads NEXT_PUBLIC_SVLAUNCHPAD_ADDRESS
   * through `SVLAUNCHPAD_ADDRESS`; null means no launchpad, so the query stays exactly what it was before.
   */
  launchpad?: string | null;
};
```

Replace lines 53-62 (`HyperSyncLog`) with:

```ts
type HyperSyncLog = {
  address: string;
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
  // Lowercased once: decode.ts compares addresses lowercase, and HyperSync wants the filter lowercase too.
  const launchpad = (opts.launchpad === undefined ? SVLAUNCHPAD_ADDRESS : opts.launchpad)?.toLowerCase() ?? null;
```

Replace lines 223-232 (the `queryBody` literal inside `fetch`) with:

```ts
      // The PoolManager's three events, plus every log of the launchpad when one is configured: a second
      // selection in the same request, no topic filter (the decoder drops what the fold does not consume).
      // `address` joins the log fields so decode.ts can route by emitter before topic0.
      const logs: { address: string[]; topics?: string[][] }[] = [
        { address: [POOL_MANAGER], topics: [[TOPIC0.initialize, TOPIC0.swap, TOPIC0.modifyLiquidity]] },
      ];
      if (launchpad) logs.push({ address: [launchpad] });
      const queryBody = {
        from_block: fromBlock,
        to_block: toBlock + 1, // HyperSync's to_block is exclusive
        logs,
        field_selection: {
          block: ["number", "timestamp"],
          log: ["address", "block_number", "log_index", "transaction_hash", "topic0", "topic1", "topic2", "topic3", "data"],
          transaction: ["hash", "from"],
        },
      };
```

Replace lines 270-280 (the `rawLog` literal and the decode call) with:

```ts
          const rawLog: RawLog = {
            address: log.address,
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
```

- [ ] **Step 8: Run the source and reader tests to verify they pass**

Run: `npx vitest run src/lib/chain src/lib/launch src/app/api/internal/sync`
Expected: PASS. (`run.test.ts`'s `FakeLogSource` and the sync route's `alwaysBehindSource` never decode, so they are untouched.)

- [ ] **Step 9: Commit**

```bash
git add src/lib/chain/decode.ts src/lib/chain/decode.test.ts src/lib/chain/hypersyncSource.ts src/lib/chain/hypersyncSource.test.ts src/lib/chain/types.ts src/lib/chain/fold.ts src/lib/chain/store.ts
git commit -m "Launchpad: the reader selects the launchpad's logs in the same request and decodes by address, then topic0"
```

---

### Task 4: The fold turns presale events into row operations

**Files:**
- Modify: `src/lib/chain/types.ts` (append the `PresaleOp` union; add `presales` to `FoldResult` at lines 176-214)
- Modify: `src/lib/chain/fold.ts:122-134` (`FoldContext.presales`), `:162-200` (dispatch and result), `:320-351` (`recomputePrimaryPool` keeps `SV`), append `presaleImage` and `handlePresale`
- Modify: `src/lib/chain/fold.test.ts` (append two describe blocks)
- Modify: `src/lib/chain/store.test.ts:81-86` (`result()` gains `presales: []`), `src/lib/chain/run.test.ts:42-52` (`seedToken` gains `presales: []`)
- Test: `src/lib/chain/fold.test.ts`

**Interfaces:**
- Consumes: `PresaleEvent` and its members (Task 2), `FoldState`, `FoldContext` (fold.ts).
- Produces:
  ```ts
  // types.ts
  export type PresaleCreateOp = { op: "create"; id: number; creator: string; quote: string; target: bigint; floor: bigint; saleTokens: bigint; startTs: number; deadlineTs: number; createdTs: number; createdBlock: number };
  export type PresaleMetadataOp = { op: "metadata"; id: number; name: string; symbol: string; image: string; website: string; x: string; telegram: string; ts: number };
  export type PresaleContributeOp = { op: "contribute"; id: number; wallet: string; amount: bigint; raised: bigint; ts: number };
  export type PresaleFinalizeOp = { op: "finalize"; id: number; token: string; poolId: string; sqrtPriceX96: bigint; raised: bigint; fee: bigint; quoteToPool: bigint; tokensToPool: bigint; tokensBurned: bigint; liquidity: bigint; ts: number };
  export type PresaleCloseOp = { op: "close"; id: number; raised: bigint; ts: number };
  export type PresaleRefundOp = { op: "refund"; id: number; wallet: string; amount: bigint; ts: number };
  export type PresaleClaimOp = { op: "claim"; id: number; wallet: string; amount: bigint; ts: number };
  export type PresaleCreatorClaimOp = { op: "creatorClaim"; id: number; amount: bigint; ts: number };
  export type PresaleFeesOp = { op: "fees"; id: number; creator0: bigint; creator1: bigint; platform0: bigint; platform1: bigint; ts: number };
  export type PresalePayoutOp = { op: "payout"; id: number; payout: string; ts: number };
  export type PresaleOp = PresaleCreateOp | PresaleMetadataOp | PresaleContributeOp | PresaleFinalizeOp | PresaleCloseOp | PresaleRefundOp | PresaleClaimOp | PresaleCreatorClaimOp | PresaleFeesOp | PresalePayoutOp;
  export type FoldResult = { …existing eight fields…; presales: PresaleOp[] };
  // fold.ts
  export function presaleImage(raw: string): string;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/chain/fold.test.ts`. First widen the type import at lines 3-10 to:

```ts
import type {
  ContributedEvent,
  FinalizedEvent,
  FoldState,
  InitializeEvent,
  SwapEvent,
  ModifyLiquidityEvent,
  PoolState,
  RaiseCreatedEvent,
  RaiseMetadataEvent,
  TokenState,
} from "./types";
```

and the value import at line 2 to:

```ts
import { foldEvents, newTokenCandidates, presaleImage } from "./fold";
```

Then append at the end of the file:

```ts
// Launchpad design, section 5: the launchpad's events fold into an ordered list of row operations
// (FoldResult.presales) that applyFold applies after the token and pool upserts in the same transaction.
describe("presale events (launchpad design, section 5)", () => {
  const LAUNCH_POOL = "0x" + "77".repeat(32);
  const RAISE_TX = "0x" + "cd".repeat(32);
  const SALE_TOKENS = 450_000_000n * 10n ** 18n;
  const presaleBase = (block: number, logIndex = 0) => ({ block, logIndex, timestamp: 1_700_000_000 + block, txHash: RAISE_TX, txFrom: WALLET });

  const raiseCreated = (over: Partial<RaiseCreatedEvent> = {}): RaiseCreatedEvent => ({
    ...presaleBase(200), kind: "raiseCreated", id: 7, creator: WALLET, quote: NVDA, target: 10n ** 21n, floor: 5n * 10n ** 20n,
    start: 1_700_000_300, deadline: 1_700_086_700, saleTokens: SALE_TOKENS, ...over,
  });
  const raiseMetadata = (over: Partial<RaiseMetadataEvent> = {}): RaiseMetadataEvent => ({
    ...presaleBase(200, 1), kind: "raiseMetadata", id: 7, name: "Tailor's Chalk", symbol: "CHALK", image: "https://img.test/chalk.png",
    website: "https://chalk.test", x: "https://x.com/chalk", telegram: "https://t.me/chalk", ...over,
  });
  const contributed = (over: Partial<ContributedEvent> = {}): ContributedEvent => ({
    ...presaleBase(210), kind: "contributed", id: 7, wallet: WALLET, amount: 25n, raised: 125n, ...over,
  });
  const finalized = (over: Partial<FinalizedEvent> = {}): FinalizedEvent => ({
    ...presaleBase(300, 3), kind: "finalized", id: 7, token: OTHER_TOKEN, poolId: LAUNCH_POOL, sqrtPriceX96: Q96, raised: 10n ** 21n, fee: 2n * 10n ** 19n,
    quoteToPool: 98n * 10n ** 19n, tokensToPool: 441_000_000n * 10n ** 18n, tokensBurned: 9_000_000n * 10n ** 18n, liquidity: 12_345n, ...over,
  });

  it("returns an empty presales list for a batch with no launchpad events", () => {
    expect(foldEvents([initEvent()], emptyState()).presales).toEqual([]);
  });

  it("turns RaiseCreated and RaiseMetadata into a create op and a metadata op, in order, touching no pool or token", () => {
    const state = emptyState();
    const result = foldEvents([raiseCreated(), raiseMetadata()], state);
    expect(result.presales).toEqual([
      {
        op: "create", id: 7, creator: WALLET, quote: NVDA, target: 10n ** 21n, floor: 5n * 10n ** 20n, saleTokens: SALE_TOKENS,
        startTs: 1_700_000_300, deadlineTs: 1_700_086_700, createdTs: 1_700_000_200, createdBlock: 200,
      },
      {
        op: "metadata", id: 7, name: "Tailor's Chalk", symbol: "CHALK", image: "https://img.test/chalk.png",
        website: "https://chalk.test", x: "https://x.com/chalk", telegram: "https://t.me/chalk", ts: 1_700_000_200,
      },
    ]);
    expect(result.pools).toEqual([]);
    expect(result.tokens).toEqual([]);
    expect(state.pools.size).toBe(0);
  });

  it("stores the image only when it is an https URL of at most 256 bytes, and empties it otherwise", () => {
    const long = "https://img.test/" + "a".repeat(256);
    expect(presaleImage("https://img.test/chalk.png")).toBe("https://img.test/chalk.png");
    expect(presaleImage("http://img.test/chalk.png")).toBe("");
    expect(presaleImage("ipfs://bafy/chalk.png")).toBe("");
    expect(presaleImage("data:image/png;base64,AAAA")).toBe("");
    expect(presaleImage("not a url")).toBe("");
    expect(presaleImage("")).toBe("");
    expect(presaleImage(long)).toBe("");
    // The rule is bytes, not characters: a 200-character URL with multi-byte characters can exceed 256 bytes.
    expect(presaleImage("https://img.test/" + "é".repeat(130))).toBe("");
    const metadata = foldEvents([raiseMetadata({ image: "http://img.test/chalk.png" })], emptyState()).presales[0];
    expect(metadata).toMatchObject({ op: "metadata", image: "" });
  });

  it("turns each of the other events into its op with the event's own amounts and the block timestamp", () => {
    const events = [
      contributed(),
      { ...presaleBase(220), kind: "closed" as const, id: 7, raised: 300n },
      { ...presaleBase(221), kind: "refunded" as const, id: 7, wallet: WALLET, amount: 25n },
      { ...presaleBase(222), kind: "claimed" as const, id: 7, wallet: WALLET, amount: 99n },
      { ...presaleBase(223), kind: "creatorClaimed" as const, id: 7, payout: WALLET, amount: 5n },
      { ...presaleBase(224), kind: "feesCollected" as const, id: 7, creator0: 1n, creator1: 2n, platform0: 3n, platform1: 4n },
      { ...presaleBase(225), kind: "payoutChanged" as const, id: 7, payout: OTHER_TOKEN },
    ];
    expect(foldEvents(events, emptyState()).presales).toEqual([
      { op: "contribute", id: 7, wallet: WALLET, amount: 25n, raised: 125n, ts: 1_700_000_210 },
      { op: "close", id: 7, raised: 300n, ts: 1_700_000_220 },
      { op: "refund", id: 7, wallet: WALLET, amount: 25n, ts: 1_700_000_221 },
      { op: "claim", id: 7, wallet: WALLET, amount: 99n, ts: 1_700_000_222 },
      { op: "creatorClaim", id: 7, amount: 5n, ts: 1_700_000_223 },
      { op: "fees", id: 7, creator0: 1n, creator1: 2n, platform0: 3n, platform1: 4n, ts: 1_700_000_224 },
      { op: "payout", id: 7, payout: OTHER_TOKEN, ts: 1_700_000_225 },
    ]);
  });

  it("Finalized in the launch transaction flips the new pool's and token's origin to SV and returns both, plus the finalize op", () => {
    const state = emptyState();
    // The launch transaction: Initialize (hookless, LP fee 1 %, spacing 200) then Finalized, same block.
    const init = initEvent({ poolId: LAUNCH_POOL, currency0: OTHER_TOKEN, currency1: NVDA, hooks: ZERO, fee: 10_000, tickSpacing: 200 }, 300);
    const result = foldEvents([init, finalized()], state);
    expect(state.pools.get(LAUNCH_POOL)?.origin).toBe("SV");
    expect(state.tokens.get(OTHER_TOKEN)?.origin).toBe("SV");
    expect(result.pools.map((p) => [p.id, p.origin])).toEqual([[LAUNCH_POOL, "SV"]]);
    expect(result.tokens.map((t) => [t.id, t.origin])).toEqual([[OTHER_TOKEN, "SV"]]);
    expect(result.presales).toEqual([
      {
        op: "finalize", id: 7, token: OTHER_TOKEN, poolId: LAUNCH_POOL, sqrtPriceX96: Q96, raised: 10n ** 21n, fee: 2n * 10n ** 19n,
        quoteToPool: 98n * 10n ** 19n, tokensToPool: 441_000_000n * 10n ** 18n, tokensBurned: 9_000_000n * 10n ** 18n, liquidity: 12_345n, ts: 1_700_000_300,
      },
    ]);
  });

  it("Finalized for a pool and token the fold does not know still produces the op and touches nothing", () => {
    const state = emptyState();
    const result = foldEvents([finalized()], state);
    expect(result.presales).toHaveLength(1);
    expect(result.pools).toEqual([]);
    expect(result.tokens).toEqual([]);
  });

  it("a launched token keeps its SV origin when a deeper second pool becomes its primary", () => {
    const P2 = "0x" + "78".repeat(32);
    const state = seededState({ id: LAUNCH_POOL, origin: "SV", hooks: ZERO }, { origin: "SV", primaryPoolId: LAUNCH_POOL, poolCount: 2 });
    state.pools.set(P2, poolFixture({ id: P2, origin: "Uniswap", hooks: ZERO, tvlToken: 10n ** 24n, tvlQuote: 10n ** 21n }));
    state.poolsByToken.set(AI, [LAUNCH_POOL, P2]);
    state.quotes.set(NVDA, { id: NVDA, decimals: 18, usdPrice: 180 });
    foldEvents([swapEvent(1000n * 10n ** 18n, -(10n ** 18n), 2n * Q96, 400, { poolId: P2 })], state);
    const token = state.tokens.get(AI)!;
    expect(token.primaryPoolId).toBe(P2); // the deeper pool wins the primary pick, as before
    expect(token.origin).toBe("SV"); // but the launched token's label stays
  });
});
```

- [ ] **Step 2: Run the fold test to verify it fails**

Run: `npx vitest run src/lib/chain/fold.test.ts`
Expected: FAIL with "presaleImage is not a function" and `result.presales` undefined.

- [ ] **Step 3: Add the op types and the fold handlers**

Edit `src/lib/chain/types.ts`. Inside `FoldResult` (after the `skippedLiquidity: number;` member, before the closing `};`) add:

```ts
  /**
   * The launchpad's row operations for this batch, in event order (launchpad design, section 5's
   * events-to-rows table). applyFold applies them after the token and pool upserts in the same
   * transaction; see src/lib/launch/store.ts for the SQL behind each `op`.
   */
  presales: PresaleOp[];
```

and append at the end of the file:

```ts
// --- Presale row operations (launchpad design, section 5) --------------------------------------
// One per folded launchpad event. Amounts stay bigint until the store casts them to numeric text.

export type PresaleCreateOp = {
  op: "create";
  id: number;
  creator: string;
  quote: string;
  target: bigint;
  floor: bigint;
  saleTokens: bigint;
  startTs: number;
  deadlineTs: number;
  createdTs: number;
  createdBlock: number;
};
export type PresaleMetadataOp = {
  op: "metadata";
  id: number;
  name: string;
  symbol: string;
  /** Already filtered by presaleImage: an https URL of at most 256 bytes, or "". */
  image: string;
  website: string;
  x: string;
  telegram: string;
  ts: number;
};
export type PresaleContributeOp = { op: "contribute"; id: number; wallet: string; amount: bigint; raised: bigint; ts: number };
export type PresaleFinalizeOp = {
  op: "finalize";
  id: number;
  token: string;
  poolId: string;
  sqrtPriceX96: bigint;
  raised: bigint;
  fee: bigint;
  quoteToPool: bigint;
  tokensToPool: bigint;
  tokensBurned: bigint;
  liquidity: bigint;
  ts: number;
};
export type PresaleCloseOp = { op: "close"; id: number; raised: bigint; ts: number };
export type PresaleRefundOp = { op: "refund"; id: number; wallet: string; amount: bigint; ts: number };
export type PresaleClaimOp = { op: "claim"; id: number; wallet: string; amount: bigint; ts: number };
export type PresaleCreatorClaimOp = { op: "creatorClaim"; id: number; amount: bigint; ts: number };
export type PresaleFeesOp = { op: "fees"; id: number; creator0: bigint; creator1: bigint; platform0: bigint; platform1: bigint; ts: number };
export type PresalePayoutOp = { op: "payout"; id: number; payout: string; ts: number };

export type PresaleOp =
  | PresaleCreateOp
  | PresaleMetadataOp
  | PresaleContributeOp
  | PresaleFinalizeOp
  | PresaleCloseOp
  | PresaleRefundOp
  | PresaleClaimOp
  | PresaleCreatorClaimOp
  | PresaleFeesOp
  | PresalePayoutOp;
```

Edit `src/lib/chain/fold.ts`:

1. Widen the type import (lines 83-94) to include `PresaleEvent` and `PresaleOp`:

```ts
import type {
  ChainEvent,
  InitializeEvent,
  SwapEvent,
  ModifyLiquidityEvent,
  PresaleEvent,
  PresaleOp,
  FoldState,
  FoldResult,
  PoolState,
  TokenState,
  CandleState,
  TradeRow,
} from "./types";
```

2. In `FoldContext` (lines 122-134) add, after `trades: TradeRow[];`:

```ts
  /** Launchpad row operations, in event order (launchpad design, section 5). */
  presales: PresaleOp[];
```

3. In `foldEvents` (lines 162-200): add `presales: [],` to the `ctx` literal after `trades: [],`; replace the `switch` with:

```ts
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
      default:
        // Every remaining kind is the launchpad's (types.ts's PresaleEvent).
        handlePresale(event, state, ctx);
        break;
    }
  }
```

and add `presales: ctx.presales,` to the returned literal after `trades: ctx.trades,`.

4. In `recomputePrimaryPool` (lines 348-353 once Task 3's `newTokenCandidates` edit is in; 345-350 before it) replace:

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
  // A launched token keeps its SV label whatever pool becomes primary (launchpad design, section 5 sets
  // tokens.origin to SV at launch): the label says where the token came from, not which hook its deepest pool has.
  const origin = token.origin === "SV" ? "SV" : bestPool.origin;
  if (token.primaryPoolId !== best || token.origin !== origin) {
    const updatedToken: TokenState = { ...token, primaryPoolId: best, origin };
    state.tokens.set(tokenId, updatedToken);
    ctx.touchedTokens.add(tokenId);
  }
```

5. Append at the end of the file:

```ts
/**
 * Launchpad design, section 5: RaiseMetadata's text fields are stored as given, except `image`, kept only when
 * it is an https: URL of at most 256 bytes and otherwise stored empty, so nothing an <img> would fetch over
 * http, a data: URI or an ipfs: scheme ever reaches the page. Bytes, not characters: the contract's own limit
 * is 256 bytes, and a multi-byte character counts as its bytes. Exported for its test.
 */
export function presaleImage(raw: string): string {
  if (new TextEncoder().encode(raw).length > 256) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  return url.protocol === "https:" ? raw : "";
}

/**
 * One launchpad event becomes one row operation (design section 5's table), in the order the events arrived.
 * The fold keeps no presale state of its own: every op is applied by src/lib/launch/store.ts against the rows
 * as they stand, so nothing here needs a presale loaded into FoldState. The one thing the fold does touch is
 * the launch pool and its token on Finalized, so the same batch's pool and token writes carry the SV origin.
 */
function handlePresale(event: PresaleEvent, state: FoldState, ctx: FoldContext): void {
  const ts = event.timestamp;
  switch (event.kind) {
    case "raiseCreated":
      ctx.presales.push({
        op: "create", id: event.id, creator: event.creator, quote: event.quote, target: event.target, floor: event.floor,
        saleTokens: event.saleTokens, startTs: event.start, deadlineTs: event.deadline, createdTs: ts, createdBlock: event.block,
      });
      return;
    case "raiseMetadata":
      ctx.presales.push({
        op: "metadata", id: event.id, name: event.name, symbol: event.symbol, image: presaleImage(event.image),
        website: event.website, x: event.x, telegram: event.telegram, ts,
      });
      return;
    case "contributed":
      ctx.presales.push({ op: "contribute", id: event.id, wallet: event.wallet, amount: event.amount, raised: event.raised, ts });
      return;
    case "finalized": {
      // The launch transaction emits Initialize, ModifyLiquidity and then Finalized (design section 5), so the
      // pool and its token are already in state, created by handleInitialize moments earlier in this batch with
      // origin "Uniswap" (no hook). Both flip here; the store repeats the flip by id (applyPresaleOps) for a
      // replayed launch whose rows exist already and were never loaded into this state.
      const pool = state.pools.get(event.poolId);
      if (pool && pool.origin !== "SV") {
        state.pools.set(pool.id, { ...pool, origin: "SV" });
        ctx.touchedPools.add(pool.id);
      }
      const token = state.tokens.get(event.token);
      if (token && token.origin !== "SV") {
        state.tokens.set(token.id, { ...token, origin: "SV" });
        ctx.touchedTokens.add(token.id);
      }
      ctx.presales.push({
        op: "finalize", id: event.id, token: event.token, poolId: event.poolId, sqrtPriceX96: event.sqrtPriceX96, raised: event.raised,
        fee: event.fee, quoteToPool: event.quoteToPool, tokensToPool: event.tokensToPool, tokensBurned: event.tokensBurned, liquidity: event.liquidity, ts,
      });
      return;
    }
    case "closed":
      ctx.presales.push({ op: "close", id: event.id, raised: event.raised, ts });
      return;
    case "refunded":
      ctx.presales.push({ op: "refund", id: event.id, wallet: event.wallet, amount: event.amount, ts });
      return;
    case "claimed":
      ctx.presales.push({ op: "claim", id: event.id, wallet: event.wallet, amount: event.amount, ts });
      return;
    case "creatorClaimed":
      ctx.presales.push({ op: "creatorClaim", id: event.id, amount: event.amount, ts });
      return;
    case "feesCollected":
      ctx.presales.push({
        op: "fees", id: event.id, creator0: event.creator0, creator1: event.creator1, platform0: event.platform0, platform1: event.platform1, ts,
      });
      return;
    case "payoutChanged":
      ctx.presales.push({ op: "payout", id: event.id, payout: event.payout, ts });
      return;
  }
}
```

6. Update the two `FoldResult` literals elsewhere so they keep type-checking. In `src/lib/chain/store.test.ts` line 84 replace `ignoredPools: 0, orphanedTokens: 0, skippedLiquidity: 0, ...o,` with `ignoredPools: 0, orphanedTokens: 0, skippedLiquidity: 0, presales: [], ...o,`. In `src/lib/chain/run.test.ts` line 46 replace `pools: [], candles: [], trades: [], newTokens: [id], ignoredPools: 0, orphanedTokens: 0, skippedLiquidity: 0,` with `pools: [], candles: [], trades: [], newTokens: [id], ignoredPools: 0, orphanedTokens: 0, skippedLiquidity: 0, presales: [],`.

- [ ] **Step 4: Run the fold, store and run tests to verify they pass**

Run: `npx vitest run src/lib/chain`
Expected: PASS. (`applyFold` ignores `presales` until Task 5; the literals only carry the new field.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/chain/types.ts src/lib/chain/fold.ts src/lib/chain/fold.test.ts src/lib/chain/store.test.ts src/lib/chain/run.test.ts
git commit -m "Launchpad: the fold turns the launchpad's events into ordered row operations and flips a launched pool and token to SV"
```

---

### Task 5: The store applies presale rows in the fold's transaction, the launch pool is listable, the cycle counts presale events

**Files:**
- Create: `src/lib/launch/store.ts`
- Create: `src/lib/launch/store.test.ts`
- Modify: `src/lib/chain/store.ts:1-7` (import), `:368-385` (`applyFold`)
- Modify: `src/lib/sync/writers.ts:164-168` (`LISTED_POOL`)
- Modify: `src/lib/market/backend.ts:56-58` and `src/lib/market/dbBackend.ts:84-86` (the two comments that say listing requires `swap_count > 0`)
- Modify: `src/lib/chain/run.ts:111-129` (`ChainRunReport.presaleEvents`), `:196-202` (`emptyReport`), `:444-452` (counter), `:463-474` (`finishRun` report)
- Modify: `src/lib/chain/store.test.ts` (append one `it` to `describe("applyFold")`), `src/lib/chain/run.test.ts:193-197` and `:229-233` (the report literals) and append one test
- Test: `src/lib/launch/store.test.ts`, `src/lib/chain/store.test.ts`, `src/lib/chain/run.test.ts`

**Interfaces:**
- Consumes: `PresaleOp` (Task 4), `Db` (`src/lib/db/client.ts:14`), `applyFold` (`src/lib/chain/store.ts:368`), `recomputeListedPools` (`src/lib/sync/writers.ts:170`), `finishRun` (`src/lib/sync/state.ts:106`).
- Produces:
  ```ts
  // src/lib/launch/store.ts
  export async function applyPresaleOps(db: Db, ops: readonly PresaleOp[], now: number): Promise<void>;
  // src/lib/chain/run.ts
  export type ChainRunReport = { …; presaleEvents: number; … };   // and finishRun's report gains presaleEvents
  ```
- How the listing rule changes: `LISTED_POOL` in `src/lib/sync/writers.ts` reads `(p.swap_count > 0 or p.origin = 'SV')` in both of its subselects where it read `p.swap_count > 0`. Everything else (the sane-price window, the primary-first preference, the swap-count ordering) is unchanged, so the nightly's `recomputeListedPools(db, "all")` keeps a launch pool listed too.

- [ ] **Step 1: Write the failing store tests**

Create `src/lib/launch/store.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyFold } from "@/lib/chain/store";
import type { FoldResult, PoolState, PresaleOp, TokenState } from "@/lib/chain/types";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { applyPresaleOps } from "./store";

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(() =>
  db.exec(
    "delete from market.quotes; delete from market.tokens; delete from market.pools; delete from market.swaps; delete from market.candles; delete from market.sync_state; delete from market.presales; delete from market.presale_contributions",
  ),
);

const hex = (n: number, digits: number) => "0x" + n.toString(16).padStart(digits, "0");
const addr = (n: number) => hex(n, 40);
const poolId = (n: number) => hex(n, 64);
const T0 = 1_789_000_000;
const QUOTE = addr(0xa1);
const CREATOR = addr(0xc1);
const WALLET_A = addr(0xd1);
const WALLET_B = addr(0xd2);
const TOKEN = addr(0xb7);
const LAUNCH_POOL = poolId(0x77);
const SALE_TOKENS = 450_000_000n * 10n ** 18n;

const create = (over: Partial<Extract<PresaleOp, { op: "create" }>> = {}): PresaleOp => ({
  op: "create", id: 7, creator: CREATOR, quote: QUOTE, target: 1_000_000_000n, floor: 500_000_000n, saleTokens: SALE_TOKENS,
  startTs: T0, deadlineTs: T0 + 86_400, createdTs: T0 - 10, createdBlock: 5_000, ...over,
});
const metadata = (over: Partial<Extract<PresaleOp, { op: "metadata" }>> = {}): PresaleOp => ({
  op: "metadata", id: 7, name: "Tailor's Chalk", symbol: "CHALK", image: "https://img.test/chalk.png", website: "https://chalk.test", x: "", telegram: "", ts: T0 - 10, ...over,
});
const contribute = (wallet: string, amount: bigint, raised: bigint, ts = T0 + 10): PresaleOp => ({ op: "contribute", id: 7, wallet, amount, raised, ts });
const finalize = (over: Partial<Extract<PresaleOp, { op: "finalize" }>> = {}): PresaleOp => ({
  op: "finalize", id: 7, token: TOKEN, poolId: LAUNCH_POOL, sqrtPriceX96: 2n ** 96n, raised: 1_000_000_000n, fee: 20_000_000n, quoteToPool: 980_000_000n,
  tokensToPool: 441_000_000n * 10n ** 18n, tokensBurned: 9_000_000n * 10n ** 18n, liquidity: 12_345n, ts: T0 + 500, ...over,
});

type PresaleRow = {
  id: number; creator: string; payout: string; quote_id: string; token_id: string; pool_id: string; name: string; symbol: string; image: string;
  target: string; floor: string; raised: string; sale_tokens: string; sqrt_price_x96: string; start_ts: number; deadline_ts: number; created_ts: number;
  launched_at: number; closed_at: number; created_block: number; contributors: number; fee: string; quote_to_pool: string; tokens_to_pool: string;
  tokens_burned: string; liquidity: string; creator_claimed: string; fees_creator_0: string; fees_creator_1: string; fees_platform_0: string; fees_platform_1: string;
};
const presale = async (id = 7) =>
  (await db.query<PresaleRow>(
    `select id, creator, payout, quote_id, token_id, pool_id, name, symbol, image, target::text as target, floor::text as floor, raised::text as raised,
       sale_tokens::text as sale_tokens, sqrt_price_x96::text as sqrt_price_x96, start_ts, deadline_ts, created_ts, launched_at, closed_at, created_block, contributors,
       fee::text as fee, quote_to_pool::text as quote_to_pool, tokens_to_pool::text as tokens_to_pool, tokens_burned::text as tokens_burned, liquidity::text as liquidity,
       creator_claimed::text as creator_claimed, fees_creator_0::text as fees_creator_0, fees_creator_1::text as fees_creator_1,
       fees_platform_0::text as fees_platform_0, fees_platform_1::text as fees_platform_1
     from market.presales where id = $1`,
    [id],
  ))[0];
const contribution = async (wallet: string, id = 7) =>
  (await db.query<{ amount: string; claimed_at: number; refunded_at: number }>(
    "select amount::text as amount, claimed_at, refunded_at from market.presale_contributions where id = $1 and wallet = $2",
    [id, wallet],
  ))[0];

describe("applyPresaleOps", () => {
  it("create then metadata inserts the row with RaiseCreated's numbers and RaiseMetadata's text, payout = creator, everything else 0 or empty", async () => {
    await applyPresaleOps(db, [create(), metadata()], T0);
    expect(await presale()).toMatchObject({
      id: 7, creator: CREATOR, payout: CREATOR, quote_id: QUOTE, token_id: "", pool_id: "", name: "Tailor's Chalk", symbol: "CHALK", image: "https://img.test/chalk.png",
      target: "1000000000", floor: "500000000", raised: "0", sale_tokens: SALE_TOKENS.toString(), sqrt_price_x96: "0",
      start_ts: T0, deadline_ts: T0 + 86_400, created_ts: T0 - 10, launched_at: 0, closed_at: 0, created_block: 5_000, contributors: 0, fee: "0", liquidity: "0",
    });
  });

  it("is idempotent for create and metadata: applying them twice leaves one unchanged row", async () => {
    await applyPresaleOps(db, [create(), metadata()], T0);
    const before = await presale();
    await applyPresaleOps(db, [create({ target: 5n }), metadata()], T0 + 1);
    const after = await presale();
    expect(after.target).toBe(before.target); // the second create is ignored
    expect(Number((await db.query<{ n: unknown }>("select count(*) as n from market.presales"))[0].n)).toBe(1);
  });

  it("contribute upserts the wallet's row additively, sets raised to the event's running total and recounts contributors", async () => {
    await applyPresaleOps(db, [create(), metadata()], T0);
    await applyPresaleOps(db, [contribute(WALLET_A, 100n, 100n), contribute(WALLET_B, 50n, 150n), contribute(WALLET_A, 25n, 175n)], T0 + 10);
    expect(await contribution(WALLET_A)).toEqual({ amount: "125", claimed_at: 0, refunded_at: 0 });
    expect(await contribution(WALLET_B)).toEqual({ amount: "50", claimed_at: 0, refunded_at: 0 });
    expect(await presale()).toMatchObject({ raised: "175", contributors: 2 });
  });

  it("finalize writes the launch numbers, flips the token's and pool's origin to SV, and leaves the contributions alone", async () => {
    // The token and pool rows a same-block Initialize would have created, with the hookless origin the fold gives them.
    await db.query(
      `insert into market.tokens (id, address, symbol, name, decimals, total_supply, holders_count, pool_count, origin, primary_pool_id, created_at, metadata_loaded, synced_at)
       values ($1, $1, 'CHALK', 'Tailor''s Chalk', 18, 0, 0, 1, 'Uniswap', $2, $3, true, $3)`,
      [TOKEN, LAUNCH_POOL, T0 + 500],
    );
    await db.query(
      `insert into market.pools (id, token_id, quote_id, token_is_currency0, hooks, fee, tick_spacing, origin, created_at, price_quote, tvl_token, tvl_quote, swap_count, last_swap_at, volume_quote_all_time, synced_at)
       values ($1, $2, $3, true, '0x0000000000000000000000000000000000000000', 10000, 200, 'Uniswap', $4, 0.0000022, 0, 0, 0, null, 0, $4)`,
      [LAUNCH_POOL, TOKEN, QUOTE, T0 + 500],
    );
    await applyPresaleOps(db, [create(), metadata(), contribute(WALLET_A, 1_000_000_000n, 1_000_000_000n)], T0);
    await applyPresaleOps(db, [finalize()], T0 + 500);
    expect(await presale()).toMatchObject({
      token_id: TOKEN, pool_id: LAUNCH_POOL, sqrt_price_x96: (2n ** 96n).toString(), launched_at: T0 + 500, raised: "1000000000", fee: "20000000",
      quote_to_pool: "980000000", tokens_to_pool: (441_000_000n * 10n ** 18n).toString(), tokens_burned: (9_000_000n * 10n ** 18n).toString(), liquidity: "12345", contributors: 1,
    });
    expect((await db.query<{ origin: string }>("select origin from market.tokens where id = $1", [TOKEN]))[0].origin).toBe("SV");
    expect((await db.query<{ origin: string }>("select origin from market.pools where id = $1", [LAUNCH_POOL]))[0].origin).toBe("SV");
    expect(await contribution(WALLET_A)).toEqual({ amount: "1000000000", claimed_at: 0, refunded_at: 0 });
  });

  it("close stamps closed_at once; refund stamps the wallet's row, subtracts the amount from raised and drops the wallet from contributors", async () => {
    await applyPresaleOps(db, [create(), metadata(), contribute(WALLET_A, 100n, 100n), contribute(WALLET_B, 50n, 150n)], T0);
    await applyPresaleOps(db, [{ op: "close", id: 7, raised: 150n, ts: T0 + 90_000 }], T0 + 90_000);
    await applyPresaleOps(db, [{ op: "close", id: 7, raised: 150n, ts: T0 + 91_000 }], T0 + 91_000); // a second Closed cannot move it
    expect((await presale()).closed_at).toBe(T0 + 90_000);
    await applyPresaleOps(db, [{ op: "refund", id: 7, wallet: WALLET_A, amount: 100n, ts: T0 + 90_100 }], T0 + 90_100);
    expect(await contribution(WALLET_A)).toEqual({ amount: "100", claimed_at: 0, refunded_at: T0 + 90_100 });
    expect(await presale()).toMatchObject({ raised: "50", contributors: 1 });
  });

  it("claim, creatorClaim, fees and payout write their columns; the running sums add up across calls", async () => {
    await applyPresaleOps(db, [create(), metadata(), contribute(WALLET_A, 100n, 100n)], T0);
    await applyPresaleOps(
      db,
      [
        { op: "claim", id: 7, wallet: WALLET_A, amount: 99n, ts: T0 + 600 },
        { op: "creatorClaim", id: 7, amount: 5n, ts: T0 + 601 },
        { op: "creatorClaim", id: 7, amount: 6n, ts: T0 + 602 },
        { op: "fees", id: 7, creator0: 1n, creator1: 2n, platform0: 3n, platform1: 4n, ts: T0 + 603 },
        { op: "fees", id: 7, creator0: 10n, creator1: 20n, platform0: 30n, platform1: 40n, ts: T0 + 604 },
        { op: "payout", id: 7, payout: WALLET_B, ts: T0 + 605 },
      ],
      T0 + 605,
    );
    expect(await contribution(WALLET_A)).toEqual({ amount: "100", claimed_at: T0 + 600, refunded_at: 0 });
    expect(await presale()).toMatchObject({ creator_claimed: "11", fees_creator_0: "11", fees_creator_1: "22", fees_platform_0: "33", fees_platform_1: "44", payout: WALLET_B });
  });

  it("an op for a raise that has no row (a lone metadata or contribute) writes what it can and never throws", async () => {
    await applyPresaleOps(db, [metadata({ id: 99 }), contribute(WALLET_A, 1n, 1n)], T0);
    expect(await presale(99)).toBeUndefined();
    expect(await contribution(WALLET_A)).toEqual({ amount: "1", claimed_at: 0, refunded_at: 0 });
  });
});

describe("applyFold with presales (launchpad design, section 5: one transaction with the trades and the cursor)", () => {
  const pool = (o: Partial<PoolState> = {}): PoolState => ({
    id: LAUNCH_POOL, tokenId: TOKEN, quoteId: QUOTE, tokenIsCurrency0: true, hooks: "0x0000000000000000000000000000000000000000", fee: 10_000, tickSpacing: 200,
    origin: "Uniswap", createdAt: T0 + 500, priceQuote: 0.0000022, sqrtPriceX96: 2n ** 96n, tvlToken: 441_000_000n * 10n ** 18n, tvlQuote: 980_000_000n,
    swapCount: 0, lastSwapAt: null, volumeQuoteAllTime: 0, baselineAt: 0, ...o,
  });
  const token = (o: Partial<TokenState> = {}): TokenState => ({
    id: TOKEN, address: TOKEN, symbol: "CHALK", name: "Tailor's Chalk", decimals: 18, poolCount: 1, origin: "Uniswap", primaryPoolId: LAUNCH_POOL, createdAt: T0 + 500, metadataLoaded: true, ...o,
  });
  const result = (o: Partial<FoldResult> = {}): FoldResult => ({
    pools: [], tokens: [], candles: [], trades: [], newTokens: [], ignoredPools: 0, orphanedTokens: 0, skippedLiquidity: 0, presales: [], ...o,
  });

  it("writes the presale rows in the same transaction as the cursor, and a throw rolls both back", async () => {
    await applyFold(db, result({ presales: [create(), metadata()] }), 5_000, T0);
    expect((await presale()).name).toBe("Tailor's Chalk");
    expect((await db.query<{ cursor: number }>("select cursor from market.sync_state where job = 'chain'"))[0].cursor).toBe(5_000);

    // A contribute op whose amount cannot be cast to numeric fails the statement; nothing of this batch may land.
    const bad = result({ presales: [{ op: "contribute", id: 7, wallet: WALLET_A, amount: 5n, raised: 5n, ts: T0 } as PresaleOp, { op: "metadata", id: 7, name: "X", symbol: "X", image: "", website: "", x: "", telegram: "", ts: T0 }] });
    (bad.presales[0] as { amount: unknown }).amount = { toString: () => "not-a-number" };
    await expect(applyFold(db, bad, 5_100, T0 + 100)).rejects.toThrow();
    expect((await presale()).name).toBe("Tailor's Chalk"); // the metadata op after the failing one never landed
    expect(await contribution(WALLET_A)).toBeUndefined();
    expect((await db.query<{ cursor: number }>("select cursor from market.sync_state where job = 'chain'"))[0].cursor).toBe(5_000);
  });

  it("lists a launched token's SV pool at launch, with zero swaps, because the fold's own pool and token writes come first", async () => {
    // The launch batch as the fold produces it: the pool and token already flipped to SV (fold.ts), plus the finalize op.
    await applyFold(
      db,
      result({ pools: [pool({ origin: "SV" })], tokens: [token({ origin: "SV" })], newTokens: [TOKEN], presales: [create(), metadata(), finalize()] }),
      6_000,
      T0 + 500,
    );
    const row = (await db.query<{ listed_pool_id: string | null; origin: string }>("select listed_pool_id, origin from market.tokens where id = $1", [TOKEN]))[0];
    expect(row).toEqual({ listed_pool_id: LAUNCH_POOL, origin: "SV" });
    expect((await presale()).token_id).toBe(TOKEN);
  });

  it("a replayed launch batch whose rows exist already still lands SV by id (the finalize op's own updates)", async () => {
    // Rows as an earlier batch left them, before the flip: the fold never loaded them, so it touches neither.
    await applyFold(db, result({ pools: [pool()], tokens: [token()], newTokens: [TOKEN] }), 6_000, T0 + 500);
    await applyFold(db, result({ presales: [finalize()] }), 6_001, T0 + 501);
    const tokenRow = (await db.query<{ listed_pool_id: string | null; origin: string }>("select listed_pool_id, origin from market.tokens where id = $1", [TOKEN]))[0];
    expect(tokenRow).toEqual({ listed_pool_id: LAUNCH_POOL, origin: "SV" });
    expect((await db.query<{ origin: string }>("select origin from market.pools where id = $1", [LAUNCH_POOL]))[0].origin).toBe("SV");
  });
});
```

Append to `src/lib/chain/store.test.ts`, inside `describe("applyFold", …)` after the test "recomputes listed_pool_id for a pool's token even when the fold returns no token for it" (after line 454):

```ts
  it("lists a never-traded pool of origin SV (a launch pool), and still not a never-traded pool of any other origin (launchpad design, section 5)", async () => {
    await applyFold(db, result({ pools: [pool({ swapCount: 0, lastSwapAt: null, volumeQuoteAllTime: 0, origin: "Uniswap" })], tokens: [token({ origin: "Uniswap" })] }), 100, T0);
    expect((await db.query<{ listed_pool_id: string | null }>("select listed_pool_id from market.tokens where id = $1", [TOKEN_A]))[0].listed_pool_id).toBeNull();
    await applyFold(db, result({ pools: [pool({ swapCount: 0, lastSwapAt: null, volumeQuoteAllTime: 0, origin: "SV" })], tokens: [token({ origin: "SV" })] }), 150, T0 + 1);
    expect((await db.query<{ listed_pool_id: string | null }>("select listed_pool_id from market.tokens where id = $1", [TOKEN_A]))[0].listed_pool_id).toBe(POOL_A);
  });
```

Edit `src/lib/chain/run.test.ts`: in both report literals (lines 193-197 and 229-233) insert `presaleEvents: 0,` right after `skippedLiquidity: 0,`. Widen the type import at line 8 to `import type { ChainEvent, InitializeEvent, RaiseCreatedEvent, RaiseMetadataEvent, SwapEvent, TransferEvent } from "./types";` and append this test at the end of `describe("runChainSync: the fetch/fold/apply loop", …)` (before its closing `});`):

```ts
  it("folds a launchpad batch into market.presales and reports presaleEvents, in the report and in the cycle's last_report (launchpad design, sections 5 and 8)", async () => {
    await seedCursor(db, 1000);
    const created: RaiseCreatedEvent = {
      kind: "raiseCreated", block: 1001, logIndex: 0, timestamp: 1_700_000_100, txHash: txHash(3), txFrom: WALLET,
      id: 7, creator: WALLET, quote: NVDA, target: 10n ** 21n, floor: 5n * 10n ** 20n, start: 1_700_000_200, deadline: 1_700_086_600, saleTokens: 450_000_000n * 10n ** 18n,
    };
    const metadata: RaiseMetadataEvent = {
      kind: "raiseMetadata", block: 1001, logIndex: 1, timestamp: 1_700_000_100, txHash: txHash(3), txFrom: WALLET,
      id: 7, name: "Tailor's Chalk", symbol: "CHALK", image: "https://img.test/chalk.png", website: "", x: "", telegram: "",
    };
    const source = new FakeLogSource({ head: 1001, batches: { 1001: { events: [created, metadata], nextBlock: 1002 } } });
    const report = await runChainSync(db, chainDeps({ source }), baseOpts({ maxRequests: 2 }));
    expect(report.error).toBeNull();
    expect(report.presaleEvents).toBe(2);
    expect(report.events).toBe(2);
    const row = (await db.query<{ name: string; target: string }>("select name, target::text as target from market.presales where id = 7"))[0];
    expect(row).toEqual({ name: "Tailor's Chalk", target: (10n ** 21n).toString() });
    const [state] = await db.query<{ last_report: Record<string, unknown> }>("select last_report from market.sync_state where job = 'chain'");
    expect(state.last_report).toMatchObject({ presaleEvents: 2, cursor: 1001 });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/launch/store.test.ts src/lib/chain/store.test.ts src/lib/chain/run.test.ts`
Expected: FAIL. `./store` does not exist; the listing test's second assertion gets `null`; the run test finds no presale row and `presaleEvents` undefined; the two report literals now differ by `presaleEvents`.

- [ ] **Step 3: Write the store, the listing rule and the report**

Create `src/lib/launch/store.ts`:

```ts
import type { PresaleOp } from "@/lib/chain/types";
import type { Db } from "@/lib/db/client";

/**
 * The SQL behind the launchpad design's events-to-rows table (section 5), one statement group per PresaleOp,
 * applied in the order the fold produced them inside applyFold's transaction (src/lib/chain/store.ts): after
 * the token and pool upserts, before the listing recompute, with the cursor. `create` and `metadata` are
 * idempotent (insert-if-absent, a plain update of the text fields); `finalize`, `close`, `claim` and `payout`
 * set absolute values. `contribute`, `refund`, `creatorClaim` and `fees` are additive, exactly like
 * applyHolderDeltas: a re-fold of the same block range would apply them twice, and the 300 s chain lease is
 * what makes that overlap impossible. `contributors` is recounted from the contributions table after every
 * contribute and refund: the wallets with a row that is not refunded (section 5).
 */
const CONTRIBUTORS_SQL = `update market.presales p
  set contributors = (select count(*)::int from market.presale_contributions c where c.id = p.id and c.refunded_at = 0 and c.amount > 0),
      updated_at = $2::int
  where p.id = $1::int`;

export async function applyPresaleOps(db: Db, ops: readonly PresaleOp[], now: number): Promise<void> {
  for (const op of ops) {
    switch (op.op) {
      case "create":
        // payout = creator at creation (spec section 4.2, create step 3); PayoutChanged moves it later.
        await db.query(
          `insert into market.presales (id, creator, payout, quote_id, target, floor, sale_tokens, start_ts, deadline_ts, created_ts, created_block, updated_at)
           values ($1::int, $2, $2, $3, $4::numeric, $5::numeric, $6::numeric, $7::int, $8::int, $9::int, $10::int, $11::int)
           on conflict (id) do nothing`,
          [op.id, op.creator, op.quote, op.target.toString(), op.floor.toString(), op.saleTokens.toString(), op.startTs, op.deadlineTs, op.createdTs, op.createdBlock, now],
        );
        break;
      case "metadata":
        await db.query(
          "update market.presales set name = $2, symbol = $3, image = $4, website = $5, x = $6, telegram = $7, updated_at = $8::int where id = $1::int",
          [op.id, op.name, op.symbol, op.image, op.website, op.x, op.telegram, now],
        );
        break;
      case "contribute":
        await db.query(
          `insert into market.presale_contributions (id, wallet, amount, claimed_at, refunded_at, updated_at)
           values ($1::int, $2, $3::numeric, 0, 0, $4::int)
           on conflict (id, wallet) do update set amount = market.presale_contributions.amount + excluded.amount, updated_at = excluded.updated_at`,
          [op.id, op.wallet, op.amount.toString(), now],
        );
        // The event's own running total, never a sum of rows: the contract trims the last contribution, and its `raised` is the truth.
        await db.query("update market.presales set raised = $2::numeric, updated_at = $3::int where id = $1::int", [op.id, op.raised.toString(), now]);
        await db.query(CONTRIBUTORS_SQL, [op.id, now]);
        break;
      case "finalize":
        await db.query(
          `update market.presales set token_id = $2, pool_id = $3, sqrt_price_x96 = $4::numeric, launched_at = $5::int, raised = $6::numeric,
             fee = $7::numeric, quote_to_pool = $8::numeric, tokens_to_pool = $9::numeric, tokens_burned = $10::numeric, liquidity = $11::numeric, updated_at = $12::int
           where id = $1::int`,
          [
            op.id, op.token, op.poolId, op.sqrtPriceX96.toString(), op.ts, op.raised.toString(), op.fee.toString(), op.quoteToPool.toString(),
            op.tokensToPool.toString(), op.tokensBurned.toString(), op.liquidity.toString(), now,
          ],
        );
        // Section 5: the token and its launch pool carry the SV origin from the launch block. The fold flipped both
        // in the batch that created them; this repeats it by id so a replayed launch, whose rows the fold never
        // loaded, lands the same way. The listing recompute that follows in applyFold then lists the pool.
        await db.query("update market.tokens set origin = 'SV' where id = $1", [op.token]);
        await db.query("update market.pools set origin = 'SV' where id = $1", [op.poolId]);
        break;
      case "close":
        await db.query(
          "update market.presales set closed_at = case when closed_at = 0 then $2::int else closed_at end, raised = $3::numeric, updated_at = $4::int where id = $1::int",
          [op.id, op.ts, op.raised.toString(), now],
        );
        break;
      case "refund":
        await db.query(
          "update market.presale_contributions set refunded_at = $3::int, updated_at = $4::int where id = $1::int and wallet = $2",
          [op.id, op.wallet, op.ts, now],
        );
        await db.query("update market.presales set raised = raised - $2::numeric, updated_at = $3::int where id = $1::int", [op.id, op.amount.toString(), now]);
        await db.query(CONTRIBUTORS_SQL, [op.id, now]);
        break;
      case "claim":
        await db.query(
          "update market.presale_contributions set claimed_at = $3::int, updated_at = $4::int where id = $1::int and wallet = $2",
          [op.id, op.wallet, op.ts, now],
        );
        break;
      case "creatorClaim":
        await db.query("update market.presales set creator_claimed = creator_claimed + $2::numeric, updated_at = $3::int where id = $1::int", [
          op.id, op.amount.toString(), now,
        ]);
        break;
      case "fees":
        await db.query(
          `update market.presales set fees_creator_0 = fees_creator_0 + $2::numeric, fees_creator_1 = fees_creator_1 + $3::numeric,
             fees_platform_0 = fees_platform_0 + $4::numeric, fees_platform_1 = fees_platform_1 + $5::numeric, updated_at = $6::int
           where id = $1::int`,
          [op.id, op.creator0.toString(), op.creator1.toString(), op.platform0.toString(), op.platform1.toString(), now],
        );
        break;
      case "payout":
        await db.query("update market.presales set payout = $2, updated_at = $3::int where id = $1::int", [op.id, op.payout, now]);
        break;
    }
  }
}
```

Edit `src/lib/chain/store.ts`. Add the import after line 5:

```ts
import { applyPresaleOps } from "@/lib/launch/store";
```

Replace `applyFold`'s transaction body (lines 377-386 once Task 3's `loadFoldState` edit is in; 375-384 before it) with:

```ts
  await db.tx(async (t) => {
    await upsertPools(t, result.pools.map(poolStateToRec), now);
    await upsertTokensFromFold(t, result.tokens, now, opts?.newTokenSupply);
    await insertTrades(t, result.trades);
    await upsertCandlesFromFold(t, result.candles);
    if (opts?.holderDeltas) await applyHolderDeltas(t, opts.holderDeltas);
    // Launchpad design, section 5: the presale rows land after the token and pool upserts, in this same transaction.
    await applyPresaleOps(t, result.presales, now);
    const tokenIds = [
      ...new Set([
        ...result.tokens.map((tok) => tok.id),
        ...result.pools.map((p) => p.tokenId),
        // A finalized raise's token: its SV pool is listable without a trade (writers.ts's LISTED_POOL), and the
        // finalize op above may have flipped rows this fold never returned (a replayed launch).
        ...result.presales.flatMap((op) => (op.op === "finalize" ? [op.token] : [])),
      ]),
    ];
    await recomputeListedPools(t, tokenIds);
    await saveCursors(t, CHAIN_JOB, { cursor: cursorBlock });
  });
```

Edit `src/lib/sync/writers.ts` lines 164-168. Replace with:

```ts
/**
 * Spec section 6: the primary pool when sane and traded, else the sane traded pool with the most swaps, else null.
 * Launchpad design, section 5: a pool of origin SV counts as traded from its launch block, so a launched token has
 * a table row and a page before its first swap. Its liquidity is real (the raise seeded it in the launch
 * transaction) and its price is the presale price, both written by that transaction's own Initialize and
 * ModifyLiquidity; the nightly's full recompute keeps it listed by this same rule.
 */
const LISTED_POOL = `coalesce(
  (select p.id from market.pools p where p.id = t.primary_pool_id and (p.swap_count > 0 or p.origin = 'SV') and p.price_quote > 1e-24 and p.price_quote < 1e18),
  (select p.id from market.pools p where p.token_id = t.id and (p.swap_count > 0 or p.origin = 'SV') and p.price_quote > 1e-24 and p.price_quote < 1e18
     order by p.swap_count desc, p.last_swap_at desc nulls last, p.id limit 1))`;
```

Two comments describe the old listing rule and would now be wrong. Edit `src/lib/market/backend.ts` lines 56-58, replacing:

```ts
   * - **Listed, for market data** — the table, the chart, the trade list. Decided by
   *   `listed_pool_id` / `recomputeListedPools`'s `LISTED_POOL` (spec section 6), which requires
   *   `swap_count > 0`. A product decision this method does not own or change.
```

with:

```ts
   * - **Listed, for market data** — the table, the chart, the trade list. Decided by
   *   `listed_pool_id` / `recomputeListedPools`'s `LISTED_POOL` (spec section 6), which requires
   *   `swap_count > 0` or the `SV` origin of a launch pool (launchpad design, section 5). A product
   *   decision this method does not own or change.
```

and `src/lib/market/dbBackend.ts` lines 85-87, replacing:

```ts
 * deterministic, and independent of `listed_pool_id` / `LISTED_POOL` (`writers.ts`, spec section 6,
 * untouched), which lists the *market table's* pool and requires `swap_count > 0`. The two rules
 * agree whenever the primary pool has traded; they can differ only for a sane, untraded primary,
```

with:

```ts
 * deterministic, and independent of `listed_pool_id` / `LISTED_POOL` (`writers.ts`, spec section 6),
 * which lists the *market table's* pool and requires `swap_count > 0` or the `SV` origin of a launch
 * pool (launchpad design, section 5). The two rules agree whenever the primary pool has traded; they
 * can differ only for a sane, untraded primary that is not a launch pool,
```

Edit `src/lib/chain/run.ts`:

1. In `ChainRunReport` (lines 111-129) add `presaleEvents: number;` after `skippedLiquidity: number;`.
2. In `emptyReport()` (lines 196-202) add `presaleEvents: 0,` after `skippedLiquidity: 0,`.
3. After line 452 (`report.skippedLiquidity += result.skippedLiquidity;`) add:

```ts
        report.presaleEvents += result.presales.length;
```

4. In the `finishRun` call's `report` literal (lines 469-473) add, after `holderReadsUnknown: holderOutcome.unknown,`:

```ts
            // Launchpad design, section 8: the launchpad events folded this cycle, for /api/health's sync.lastCycle.
            presaleEvents: result.presales.length,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/launch src/lib/chain src/lib/sync src/app/api/internal`
Expected: PASS, including the existing `writers.test.ts` listing cases (an untraded non-SV pool is still unlisted).

- [ ] **Step 5: Commit**

```bash
git add src/lib/launch/store.ts src/lib/launch/store.test.ts src/lib/chain/store.ts src/lib/chain/store.test.ts src/lib/sync/writers.ts src/lib/market/backend.ts src/lib/market/dbBackend.ts src/lib/chain/run.ts src/lib/chain/run.test.ts
git commit -m "Launchpad: presale rows land in the fold's transaction, a launched pool is listable from its launch block, the cycle counts presale events"
```

---

### Task 6: The backend read methods, the derived status SQL, and the two routes

**Files:**
- Modify: `src/lib/types.ts` (append `LaunchStatus`, `Launch`, `LaunchContribution`, `LaunchView`)
- Create: `src/lib/launch/read.ts`
- Create: `src/lib/launch/read.test.ts`
- Modify: `src/lib/market/backend.ts:5` (import) and `:44-74` (`MarketBackend` gains two methods)
- Modify: `src/lib/market/dbBackend.ts:9-11` (imports) and `:242-253` (add the two methods before `poolKey`)
- Modify: `src/lib/market/envioBackend.ts:92-96` (two stubs)
- Create: `src/app/api/launch/route.ts`, `src/app/api/launch/route.test.ts`
- Create: `src/app/api/launch/[id]/route.ts`, `src/app/api/launch/[id]/route.test.ts`

**Interfaces:**
- Consumes: `isStale` (`src/lib/envio/shape.ts:55`), `toHuman` (`src/lib/quote/math.ts:106`), `ttlCache` (`src/lib/envio/cache.ts:6`), `badRequest`, `cached`, `failure`, `isAddress` (`src/app/api/_lib/respond.ts`), `getBackend` (`src/lib/market/backend.ts:99`).
- Produces:
  ```ts
  // src/lib/types.ts
  export type LaunchStatus = "scheduled" | "open" | "launchable" | "launched" | "failed";
  export interface Launch { id: number; status: LaunchStatus; creator: Address; payout: Address; name: string; symbol: string; image: string; website: string; x: string; telegram: string; quoteId: Address; quoteSymbol: string; quoteDecimals: number; target: string; floor: string; raised: string; saleTokens: string; targetUsd: number | null; floorUsd: number | null; raisedUsd: number | null; contributors: number; startTs: number; deadlineTs: number; createdTs: number; launchedAt: number; closedAt: number; token: Address | null; poolId: Hex | null; sqrtPriceX96: string; fee: string; quoteToPool: string; tokensToPool: string; tokensBurned: string; liquidity: string; creatorClaimed: string; feesCreator0: string; feesCreator1: string; feesPlatform0: string; feesPlatform1: string; asOf: number }
  export interface LaunchContribution { wallet: Address; amount: string; claimedAt: number; refundedAt: number }
  export interface LaunchView { launch: Launch; contribution: LaunchContribution | null }
  // src/lib/launch/read.ts
  export const LAUNCH_STATUS_SQL: string;
  export async function readLaunches(db: Db, now: number): Promise<Launch[]>;
  export async function readLaunch(db: Db, id: number, wallet: string | undefined, now: number): Promise<LaunchView | null>;
  // src/lib/market/backend.ts
  interface MarketBackend { …; launches(): Promise<Launch[]>; launch(id: number, wallet?: string): Promise<LaunchView | null>; }
  // routes
  GET /api/launch  -> Launch[]  (200, Cache-Control: public, s-maxage=5, stale-while-revalidate=60)
  GET /api/launch/[id]?wallet=0x… -> LaunchView (200) | { error: "unknown raise" } (404, same cache header) | { error: "bad id" } / { error: "bad wallet" } (400)
  ```

- [ ] **Step 1: Write the failing read tests**

Create `src/lib/launch/read.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { readLaunch, readLaunches } from "./read";

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(() => db.exec("delete from market.quotes; delete from market.presales; delete from market.presale_contributions"));

const NOW = 1_789_547_000;
const addr = (c: string) => `0x${c.repeat(40)}`;
const NVDA = addr("1");
const USDG = addr("2");
const DEAD = addr("3");
const CREATOR = addr("c");
const WALLET = addr("d");
const TOKEN = addr("e");
const POOL = `0x${"f".repeat(64)}`;

async function seedQuotes() {
  await db.query(
    `insert into market.quotes (id, address, symbol, name, decimals, enabled, usd_price, usd_updated_at, aggregator) values
       ($1, $1, 'NVDA', 'NVIDIA', 18, true, 120.5, $4, '0xfeed'),
       ($2, $2, 'USDG', 'Global Dollar', 6, true, 1, $5, 'pinned'),
       ($3, $3, 'DEAD', 'Dead feed', 18, true, 50, $6, '0xfeed')`,
    [NVDA, USDG, DEAD, NOW - 60, NOW - 8_500_000, NOW - 400_000], // NVDA fresh, USDG pinned (never stale), DEAD 4 days old (stale)
  );
}

type Seed = {
  id: number; quote?: string; target?: bigint; floor?: bigint; raised?: bigint; start?: number; deadline?: number; launchedAt?: number; closedAt?: number; contributors?: number; token?: string; poolId?: string;
};
async function seedRaise(s: Seed) {
  await db.query(
    `insert into market.presales (id, creator, payout, quote_id, token_id, pool_id, name, symbol, target, floor, raised, sale_tokens, start_ts, deadline_ts, created_ts,
       launched_at, closed_at, created_block, contributors, updated_at)
     values ($1, $2, $2, $3, $4, $5, 'Chalk', 'CHALK', $6::numeric, $7::numeric, $8::numeric, 450000000000000000000000000, $9, $10, $11, $12, $13, 100, $14, $11)`,
    [
      s.id, CREATOR, s.quote ?? USDG, s.token ?? "", s.poolId ?? "", (s.target ?? 1_000_000_000n).toString(), (s.floor ?? 500_000_000n).toString(), (s.raised ?? 0n).toString(),
      s.start ?? NOW - 3600, s.deadline ?? NOW + 3600, NOW - 7200, s.launchedAt ?? 0, s.closedAt ?? 0, s.contributors ?? 0,
    ],
  );
}

describe("readLaunches: status derivation (launchpad design, section 6's table)", () => {
  beforeEach(seedQuotes);

  it("scheduled while now < start_ts", async () => {
    await seedRaise({ id: 1, start: NOW + 100, deadline: NOW + 90_000 });
    expect((await readLaunches(db, NOW))[0]).toMatchObject({ id: 1, status: "scheduled", asOf: NOW });
  });

  it("open between start and deadline while under the target", async () => {
    await seedRaise({ id: 1, raised: 10n });
    expect((await readLaunches(db, NOW))[0].status).toBe("open");
  });

  it("launchable the moment raised equals the target, and the moment the deadline passes at or above the floor", async () => {
    await seedRaise({ id: 1, raised: 1_000_000_000n });
    await seedRaise({ id: 2, raised: 500_000_000n, deadline: NOW }); // deadline_ts <= now, raised = floor
    await seedRaise({ id: 3, raised: 600_000_000n, deadline: NOW - 1 });
    const statuses = Object.fromEntries((await readLaunches(db, NOW)).map((l) => [l.id, l.status]));
    expect(statuses).toEqual({ 1: "launchable", 2: "launchable", 3: "launchable" });
  });

  it("failed when the deadline passed under the floor, before any Closed event, and whenever closed_at is set", async () => {
    await seedRaise({ id: 1, raised: 499_999_999n, deadline: NOW });
    await seedRaise({ id: 2, raised: 900_000_000n, closedAt: NOW - 5 }); // the stall valve tripped: Closed with no launch
    const statuses = Object.fromEntries((await readLaunches(db, NOW)).map((l) => [l.id, l.status]));
    expect(statuses).toEqual({ 1: "failed", 2: "failed" });
  });

  it("launched once launched_at is set, whatever the clock says", async () => {
    await seedRaise({ id: 1, raised: 1_000_000_000n, launchedAt: NOW - 100, token: TOKEN, poolId: POOL, deadline: NOW - 500 });
    const [l] = await readLaunches(db, NOW);
    expect(l).toMatchObject({ status: "launched", token: TOKEN, poolId: POOL, launchedAt: NOW - 100 });
  });

  it("failed once the stall valve opens, 7 days past the deadline, whatever was raised: refunds are open on chain, so never launchable then", async () => {
    await seedRaise({ id: 1, raised: 1_000_000_000n, deadline: NOW - 604_800 }); // met its target, nobody launched it, the valve is open
    await seedRaise({ id: 2, raised: 900_000_000n, deadline: NOW - 604_799 }); // one second before the valve: still launchable
    const statuses = Object.fromEntries((await readLaunches(db, NOW)).map((l) => [l.id, l.status]));
    expect(statuses).toEqual({ 1: "failed", 2: "launchable" });
  });
});

describe("readLaunches: order, USD and quote fields (launchpad design, section 7)", () => {
  beforeEach(seedQuotes);

  it("orders open by soonest deadline, then launchable, then scheduled by start, then launched newest first, then failed", async () => {
    await seedRaise({ id: 1, launchedAt: NOW - 1000, deadline: NOW - 2000 }); // launched, older
    await seedRaise({ id: 2, raised: 1n, deadline: NOW - 1 }); // failed
    await seedRaise({ id: 3, start: NOW + 500, deadline: NOW + 900 }); // scheduled, later
    await seedRaise({ id: 4, raised: 1n, deadline: NOW + 9000 }); // open, later deadline
    await seedRaise({ id: 5, raised: 1_000_000_000n }); // launchable
    await seedRaise({ id: 6, raised: 1n, deadline: NOW + 100 }); // open, soonest
    await seedRaise({ id: 7, start: NOW + 100, deadline: NOW + 900 }); // scheduled, sooner
    await seedRaise({ id: 8, launchedAt: NOW - 10, deadline: NOW - 20 }); // launched, newest
    expect((await readLaunches(db, NOW)).map((l) => l.id)).toEqual([6, 4, 5, 7, 3, 8, 1, 2]);
  });

  it("carries the quote's symbol and decimals, raw amounts as decimal strings, and USD through the quote's fresh price", async () => {
    await seedRaise({ id: 1, quote: NVDA, target: 10n ** 18n, floor: 5n * 10n ** 17n, raised: 25n * 10n ** 16n, contributors: 3 });
    const [l] = await readLaunches(db, NOW);
    expect(l).toMatchObject({
      quoteId: NVDA, quoteSymbol: "NVDA", quoteDecimals: 18, target: (10n ** 18n).toString(), floor: (5n * 10n ** 17n).toString(), raised: (25n * 10n ** 16n).toString(),
      contributors: 3, creator: CREATOR, payout: CREATOR, name: "Chalk", symbol: "CHALK", saleTokens: "450000000000000000000000000", token: null, poolId: null,
    });
    expect(l.targetUsd).toBeCloseTo(120.5, 9);
    expect(l.floorUsd).toBeCloseTo(60.25, 9);
    expect(l.raisedUsd).toBeCloseTo(30.125, 9);
  });

  it("USD is null, never 0, while the quote's price is stale; USDG is pinned and never stale", async () => {
    await seedRaise({ id: 1, quote: DEAD, target: 10n ** 18n });
    await seedRaise({ id: 2, quote: USDG, target: 250_000_000_000n });
    const byId = Object.fromEntries((await readLaunches(db, NOW)).map((l) => [l.id, l]));
    expect(byId[1]).toMatchObject({ targetUsd: null, floorUsd: null, raisedUsd: null });
    expect(byId[2].targetUsd).toBeCloseTo(250_000, 9);
  });
});

describe("readLaunch", () => {
  beforeEach(seedQuotes);

  it("answers null for an unknown id", async () => {
    expect(await readLaunch(db, 42, undefined, NOW)).toBeNull();
  });

  it("answers the raise with no contribution when no wallet is asked for", async () => {
    await seedRaise({ id: 1 });
    expect(await readLaunch(db, 1, undefined, NOW)).toMatchObject({ launch: { id: 1, status: "open" }, contribution: null });
  });

  it("answers the wallet's own row, lowercasing the wallet, and null when it never contributed", async () => {
    await seedRaise({ id: 1, raised: 25n });
    await db.query("insert into market.presale_contributions (id, wallet, amount, claimed_at, refunded_at, updated_at) values (1, $1, 25, 0, 0, $2)", [WALLET, NOW]);
    const view = await readLaunch(db, 1, WALLET.toUpperCase().replace("0X", "0x"), NOW);
    expect(view?.contribution).toEqual({ wallet: WALLET, amount: "25", claimedAt: 0, refundedAt: 0 });
    expect((await readLaunch(db, 1, addr("9"), NOW))?.contribution).toBeNull();
  });
});
```

- [ ] **Step 2: Run the read test to verify it fails**

Run: `npx vitest run src/lib/launch/read.test.ts`
Expected: FAIL with "Cannot find module './read'".

- [ ] **Step 3: Write the types, the reader and the backend methods**

Append to `src/lib/types.ts`:

```ts

// --- Launchpad (docs/superpowers/specs/2026-09-27-launchpad-design.md, sections 6 and 7) ---------------

/** A raise's state, derived in SQL from the stored facts and now (design section 6's table); never stored. */
export type LaunchStatus = "scheduled" | "open" | "launchable" | "launched" | "failed";

/**
 * One raise as GET /api/launch answers it. Raw quote-unit amounts are decimal strings, never numbers, the same
 * rule as every amount the chain will see: the contribute panel turns them back into bigint. The USD fields
 * are display only and null while the quote's Chainlink price is missing or stale, like TokenPair's.
 */
export interface Launch {
  id: number;
  status: LaunchStatus;
  creator: Address;
  payout: Address;
  name: string;
  symbol: string;
  /** An https URL of at most 256 bytes, or "" (the reader empties anything else). */
  image: string;
  website: string;
  x: string;
  telegram: string;
  quoteId: Address;
  quoteSymbol: string;
  quoteDecimals: number;
  target: string;
  floor: string;
  raised: string;
  saleTokens: string;
  targetUsd: number | null;
  floorUsd: number | null;
  raisedUsd: number | null;
  /** Wallets with a live contribution. */
  contributors: number;
  startTs: number;
  deadlineTs: number;
  createdTs: number;
  /** 0 until the event. */
  launchedAt: number;
  closedAt: number;
  /** The launched token's lowercase address, null before launch. */
  token: Address | null;
  poolId: Hex | null;
  sqrtPriceX96: string;
  fee: string;
  quoteToPool: string;
  tokensToPool: string;
  tokensBurned: string;
  liquidity: string;
  creatorClaimed: string;
  feesCreator0: string;
  feesCreator1: string;
  feesPlatform0: string;
  feesPlatform1: string;
  /** The server's clock when the status was derived, unix seconds. The countdowns tick on the browser's clock; this dates the status, and the raise page computes the creator's vested amount as of it. */
  asOf: number;
}

/** One wallet's row of a raise, public on chain in any case (design section 7). */
export interface LaunchContribution {
  wallet: Address;
  amount: string;
  claimedAt: number;
  refundedAt: number;
}

export interface LaunchView {
  launch: Launch;
  /** The `?wallet=` row; null when no wallet was asked for or it never contributed. */
  contribution: LaunchContribution | null;
}
```

Create `src/lib/launch/read.ts`:

```ts
import type { Db } from "@/lib/db/client";
import { isStale } from "@/lib/envio/shape";
import { toHuman } from "@/lib/quote/math";
import type { Address, Hex, Launch, LaunchContribution, LaunchStatus, LaunchView } from "@/lib/types";

/**
 * The read side of the launchpad (design sections 6 and 7): the derived status, the list's order and the USD
 * shaping, as plain SQL over market.presales joined to market.quotes. numeric columns are cast to text so both
 * drivers hand back the exact digits; the USD figures are the only floats, and they never go back to the chain.
 */

type LaunchRow = {
  id: number; creator: string; payout: string; quote_id: string; token_id: string; pool_id: string;
  name: string; symbol: string; image: string; website: string; x: string; telegram: string;
  target: string; floor: string; raised: string; sale_tokens: string; sqrt_price_x96: string;
  start_ts: number; deadline_ts: number; created_ts: number; launched_at: number; closed_at: number; contributors: number;
  fee: string; quote_to_pool: string; tokens_to_pool: string; tokens_burned: string; liquidity: string;
  creator_claimed: string; fees_creator_0: string; fees_creator_1: string; fees_platform_0: string; fees_platform_1: string;
  quote_symbol: string; quote_decimals: number; usd_price: number | null; usd_updated_at: number | null; aggregator: string | null;
  status: LaunchStatus;
};
type ContributionRow = { wallet: string; amount: string; claimed_at: number; refunded_at: number };

/** Design section 6's table, verbatim in SQL. `$1` is now, unix seconds. Exported for the store's tests. */
export const LAUNCH_STATUS_SQL = `case
  when p.launched_at > 0 then 'launched'
  when p.closed_at > 0 or (p.deadline_ts <= $1::int and p.raised < p.floor) or p.deadline_ts + 604800 <= $1::int then 'failed'
  when p.raised = p.target or p.deadline_ts <= $1::int then 'launchable'
  when $1::int < p.start_ts then 'scheduled'
  else 'open' end`;

const LAUNCH_SELECT = `select p.id, p.creator, p.payout, p.quote_id, p.token_id, p.pool_id, p.name, p.symbol, p.image, p.website, p.x, p.telegram,
    p.target::text as target, p.floor::text as floor, p.raised::text as raised, p.sale_tokens::text as sale_tokens, p.sqrt_price_x96::text as sqrt_price_x96,
    p.start_ts, p.deadline_ts, p.created_ts, p.launched_at, p.closed_at, p.contributors,
    p.fee::text as fee, p.quote_to_pool::text as quote_to_pool, p.tokens_to_pool::text as tokens_to_pool, p.tokens_burned::text as tokens_burned, p.liquidity::text as liquidity,
    p.creator_claimed::text as creator_claimed, p.fees_creator_0::text as fees_creator_0, p.fees_creator_1::text as fees_creator_1,
    p.fees_platform_0::text as fees_platform_0, p.fees_platform_1::text as fees_platform_1,
    q.symbol as quote_symbol, q.decimals as quote_decimals, q.usd_price, q.usd_updated_at, q.aggregator,
    ${LAUNCH_STATUS_SQL} as status
  from market.presales p join market.quotes q on q.id = p.quote_id`;

/** Design section 7: open by soonest deadline, then launchable, then scheduled by start, then launched newest first, then failed (newest deadline first). */
const LAUNCHES_SQL = `select * from (${LAUNCH_SELECT}) l
  order by case l.status when 'open' then 0 when 'launchable' then 1 when 'scheduled' then 2 when 'launched' then 3 else 4 end,
    case l.status when 'scheduled' then l.start_ts when 'launched' then -l.launched_at when 'failed' then -l.deadline_ts else l.deadline_ts end,
    l.id`;
const LAUNCH_SQL = `${LAUNCH_SELECT} where p.id = $2::int`;
const CONTRIBUTION_SQL = "select wallet, amount::text as amount, claimed_at, refunded_at from market.presale_contributions where id = $1::int and wallet = $2";

function launchFromRow(r: LaunchRow, now: number): Launch {
  // The same rule as dbBackend's quoteUsd: no feed row, or a feed older than three days that is not pinned, is no USD price at all.
  const fresh = r.usd_price !== null && r.usd_updated_at !== null && !isStale({ updatedAt: r.usd_updated_at, aggregator: r.aggregator ?? "" }, now);
  const usd = fresh ? r.usd_price : null;
  // Display only: the raw string beside it is what the screens sign against; this float never reaches the chain.
  const toUsd = (raw: string): number | null => (usd === null ? null : Number(toHuman(BigInt(raw), r.quote_decimals)) * usd);
  return {
    id: r.id,
    status: r.status,
    creator: r.creator as Address,
    payout: r.payout as Address,
    name: r.name,
    symbol: r.symbol,
    image: r.image,
    website: r.website,
    x: r.x,
    telegram: r.telegram,
    quoteId: r.quote_id as Address,
    quoteSymbol: r.quote_symbol,
    quoteDecimals: r.quote_decimals,
    target: r.target,
    floor: r.floor,
    raised: r.raised,
    saleTokens: r.sale_tokens,
    targetUsd: toUsd(r.target),
    floorUsd: toUsd(r.floor),
    raisedUsd: toUsd(r.raised),
    contributors: r.contributors,
    startTs: r.start_ts,
    deadlineTs: r.deadline_ts,
    createdTs: r.created_ts,
    launchedAt: r.launched_at,
    closedAt: r.closed_at,
    token: r.token_id === "" ? null : (r.token_id as Address),
    poolId: r.pool_id === "" ? null : (r.pool_id as Hex),
    sqrtPriceX96: r.sqrt_price_x96,
    fee: r.fee,
    quoteToPool: r.quote_to_pool,
    tokensToPool: r.tokens_to_pool,
    tokensBurned: r.tokens_burned,
    liquidity: r.liquidity,
    creatorClaimed: r.creator_claimed,
    feesCreator0: r.fees_creator_0,
    feesCreator1: r.fees_creator_1,
    feesPlatform0: r.fees_platform_0,
    feesPlatform1: r.fees_platform_1,
    asOf: now,
  };
}

export async function readLaunches(db: Db, now: number): Promise<Launch[]> {
  const rows = await db.query<LaunchRow>(LAUNCHES_SQL, [now]);
  return rows.map((r) => launchFromRow(r, now));
}

export async function readLaunch(db: Db, id: number, wallet: string | undefined, now: number): Promise<LaunchView | null> {
  const [row] = await db.query<LaunchRow>(LAUNCH_SQL, [now, id]);
  if (!row) return null;
  let contribution: LaunchContribution | null = null;
  if (wallet !== undefined) {
    const [c] = await db.query<ContributionRow>(CONTRIBUTION_SQL, [id, wallet.toLowerCase()]);
    if (c) contribution = { wallet: c.wallet as Address, amount: c.amount, claimedAt: c.claimed_at, refundedAt: c.refunded_at };
  }
  return { launch: launchFromRow(row, now), contribution };
}
```

Edit `src/lib/market/backend.ts`. Replace line 5 with:

```ts
import type { Candle, HoldersView, Launch, LaunchView, QuoteAsset, TokenPair, Trade } from "@/lib/types";
```

and inside `MarketBackend` (before `health(): Promise<HealthReport>;`) add:

```ts
  /** Every raise with its derived status, in the list page's order (launchpad design, section 7). */
  launches(): Promise<Launch[]>;
  /** One raise and, given a wallet, that wallet's own contribution row; null for an unknown id. */
  launch(id: number, wallet?: string): Promise<LaunchView | null>;
```

Edit `src/lib/market/dbBackend.ts`. After line 6 (`import { refreshRow, … } from "@/lib/holders/store";`) add:

```ts
import { readLaunch, readLaunches } from "@/lib/launch/read";
```

and in the `backend` literal, before `async poolKey(tokenId, quoteId) {` (line 242), add:

```ts
    // Launchpad design, section 7. No memo here: the routes hold their own 5 s ttlCache, like the holders route.
    launches: () => readLaunches(db, now()),
    launch: (id, wallet) => readLaunch(db, id, wallet, now()),
```

Edit `src/lib/market/envioBackend.ts`. After line 95 (`kind: "envio",`) add:

```ts
    // Envio never carried a raise (the launchpad postdates its decommissioning, 21 Sep 2026): empty, never a throw.
    async launches() {
      return [];
    },
    async launch() {
      return null;
    },
```

- [ ] **Step 4: Run the read test and the market tests to verify they pass**

Run: `npx vitest run src/lib/launch/read.test.ts src/lib/market`
Expected: PASS.

- [ ] **Step 5: Write the failing route tests**

Create `src/app/api/launch/route.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DbUnavailableError } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import type { Launch } from "@/lib/types";
import { GET } from "./route";

const { launches } = vi.hoisted(() => ({ launches: vi.fn<() => Promise<Launch[]>>() }));
vi.mock("@/lib/market/backend", () => ({ getBackend: () => ({ kind: "db", launches }) }));

const row = { id: 1, status: "open", name: "Chalk", symbol: "CHALK" } as Launch;

describe("GET /api/launch", () => {
  beforeEach(() => {
    clearTtlCache();
    launches.mockReset().mockResolvedValue([row]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("answers every raise with a 5 s cache header (design section 7)", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=5, stale-while-revalidate=60");
    await expect(res.json()).resolves.toEqual([row]);
  });

  it("memoises the list for 5 s in-process, then asks the backend again", async () => {
    vi.useFakeTimers();
    await GET();
    await GET();
    expect(launches).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_001);
    await GET();
    expect(launches).toHaveBeenCalledTimes(2);
  });

  it("answers 503 no-store when the store is unreachable", async () => {
    launches.mockRejectedValue(new DbUnavailableError("connection refused"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
```

Create `src/app/api/launch/[id]/route.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DbUnavailableError } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import type { LaunchView } from "@/lib/types";
import { GET } from "./route";

const { launch } = vi.hoisted(() => ({ launch: vi.fn<(id: number, wallet?: string) => Promise<LaunchView | null>>() }));
vi.mock("@/lib/market/backend", () => ({ getBackend: () => ({ kind: "db", launch }) }));

const WALLET = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const CACHE = "public, s-maxage=5, stale-while-revalidate=60";
const view = { launch: { id: 7, status: "open" }, contribution: null } as LaunchView;
const call = (id: string, query = "") => GET(new Request(`http://localhost:3000/api/launch/${id}${query}`), { params: Promise.resolve({ id }) });

describe("GET /api/launch/[id]", () => {
  beforeEach(() => {
    clearTtlCache();
    launch.mockReset().mockResolvedValue(view);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["abc", "0", "-1", "1.5", "007", "9999999999"])("rejects the id %s before touching the backend", async (id) => {
    const res = await call(id);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad id" });
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects a malformed wallet", async () => {
    const res = await call("7", "?wallet=not-an-address");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad wallet" });
    expect(launch).not.toHaveBeenCalled();
  });

  it("answers the raise with the 5 s cache header, passing the id as a number and no wallet", async () => {
    const res = await call("7");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
    await expect(res.json()).resolves.toEqual(view);
    expect(launch).toHaveBeenCalledWith(7, undefined);
  });

  it("passes ?wallet= lowercased, and memoises per (id, wallet)", async () => {
    await call("7", `?wallet=${WALLET.toUpperCase().replace("0X", "0x")}`);
    expect(launch).toHaveBeenCalledWith(7, WALLET);
    await call("7", `?wallet=${WALLET}`);
    await call("7");
    expect(launch).toHaveBeenCalledTimes(2); // one per distinct (id, wallet), the second wallet call served from the memo
  });

  it("answers 404 with the same cache header for an unknown raise", async () => {
    launch.mockResolvedValue(null);
    const res = await call("42");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
    await expect(res.json()).resolves.toEqual({ error: "unknown raise" });
  });

  it("answers 503 when the store is unreachable", async () => {
    launch.mockRejectedValue(new DbUnavailableError("connection refused"));
    const res = await call("7");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("15");
  });
});
```

- [ ] **Step 6: Run the route tests to verify they fail**

Run: `npx vitest run src/app/api/launch`
Expected: FAIL with "Cannot find module './route'" for both files.

- [ ] **Step 7: Write the routes**

Create `src/app/api/launch/route.ts`:

```ts
import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import { cached, failure } from "../_lib/respond";

export const dynamic = "force-dynamic";
/** Launchpad design, section 7: 5 s, in-process and at the CDN. The raise page polls at this cadence while a raise is live. */
const TTL = 5;
const MEMO_MS = 5_000;

/** Every raise with its derived status, in the list page's order. */
export async function GET() {
  try {
    return cached(await ttlCache("launches", MEMO_MS, () => getBackend().launches()), TTL);
  } catch (err) {
    return failure(err);
  }
}
```

Create `src/app/api/launch/[id]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import { badRequest, cached, failure, isAddress } from "../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 5;
const MEMO_MS = 5_000;
/** A raise id: a positive integer with no leading zero, at most nine digits so it always fits market.presales.id (int). */
const ID = /^[1-9]\d{0,8}$/;

/** One raise, and with `?wallet=` that wallet's own contribution row (public on chain in any case). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!ID.test(id)) return badRequest("bad id");
  const walletParam = new URL(req.url).searchParams.get("wallet");
  const wallet = walletParam === null ? undefined : walletParam.toLowerCase();
  if (wallet !== undefined && !isAddress(wallet)) return badRequest("bad wallet");
  try {
    const view = await ttlCache(`launch:${id}:${wallet ?? ""}`, MEMO_MS, () => getBackend().launch(Number(id), wallet));
    if (!view) {
      // Unknown is a fact for the next 5 s too, so the CDN may hold it as long as an answer.
      return NextResponse.json({ error: "unknown raise" }, { status: 404, headers: { "Cache-Control": `public, s-maxage=${TTL}, stale-while-revalidate=60` } });
    }
    return cached(view, TTL);
  } catch (err) {
    return failure(err);
  }
}
```

- [ ] **Step 8: Run the route tests to verify they pass**

Run: `npx vitest run src/app/api/launch src/lib/launch src/lib/market`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/types.ts src/lib/launch/read.ts src/lib/launch/read.test.ts src/lib/market/backend.ts src/lib/market/dbBackend.ts src/lib/market/envioBackend.ts src/app/api/launch
git commit -m "Launchpad: derived status in SQL, USD through the quote price, and GET /api/launch and /api/launch/[id]"
```

---

### Task 7: The data source methods, the query keys and the hooks

**Files:**
- Modify: `src/lib/types.ts:165-216` (`MarketsDataSource` gains two methods)
- Modify: `src/lib/data/envio.ts:2` (import), append two methods after `traders()` (line 146)
- Modify: `src/lib/data/mock.ts:1-19` (import), append two methods after `traders()` (line 303)
- Modify: `src/hooks/useMarketsData.ts:7` (import), `:9-23` (keys), append `LAUNCH_POLL_MS`, `useLaunches`, `useLaunch`
- Create: `src/lib/data/launch.test.ts`
- Modify: `src/hooks/useMarketsData.test.tsx:1-35` (the imports and the hoisted `ds`) and append a describe block

**Interfaces:**
- Consumes: `Launch`, `LaunchView`, `LaunchStatus` (Task 6); `useDataSource` (`src/context/DataSource.tsx`); `queryHarness`, `renderHook`, `waitFor` (`src/test/dom.tsx`).
- Produces:
  ```ts
  // src/lib/types.ts, MarketsDataSource
  launches(): Promise<Launch[]>;
  launch(id: number, wallet?: Address): Promise<LaunchView | null>;
  // src/hooks/useMarketsData.ts
  export const LAUNCH_POLL_MS = 5_000;
  keys.launches = ["launches"] as const; keys.launch = (id: number, wallet?: string) => ["launch", id, wallet ?? ""] as const;
  export function useLaunches(): UseQueryResult<Launch[]>;
  export const LAUNCH_INDEXING_POLL_MS = 180_000;
  export function useLaunch(id: number, wallet?: Address): UseQueryResult<LaunchView | null> & { indexing: boolean };   // polls every 5 s while scheduled, open or launchable, and while the store does not know the id yet (three minutes after mount); `indexing` is true during the latter
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/data/launch.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Launch, LaunchView } from "@/lib/types";
import { EnvioDataSource } from "./envio";
import { MockDataSource } from "./mock";

const WALLET = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18" as Address;
const row = { id: 7, status: "open", name: "Chalk", symbol: "CHALK" } as Launch;
const view: LaunchView = { launch: row, contribution: null };

let answer: { status: number; body: unknown } = { status: 200, body: view };
const fetchMock = vi.fn(async (input: string) => {
  const url = String(input);
  if (url === "/api/launch") return { ok: true, status: 200, json: async () => [row] } as unknown as Response;
  return { ok: answer.status < 400, status: answer.status, json: async () => answer.body } as unknown as Response;
});

describe("EnvioDataSource launches and launch (design section 7)", () => {
  beforeEach(() => {
    answer = { status: 200, body: view };
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads the list from GET /api/launch, uncached", async () => {
    await expect(new EnvioDataSource().launches()).resolves.toEqual([row]);
    expect(fetchMock).toHaveBeenCalledWith("/api/launch", { cache: "no-store" });
  });

  it("reads one raise from GET /api/launch/[id], adding ?wallet= lowercased only when a wallet is given", async () => {
    const ds = new EnvioDataSource();
    await expect(ds.launch(7)).resolves.toEqual(view);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/launch/7", { cache: "no-store" });
    await ds.launch(7, WALLET.toUpperCase().replace("0X", "0x") as Address);
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/launch/7?wallet=${WALLET}`, { cache: "no-store" });
  });

  it("turns the route's 404 into null and any other failure into an error naming the route", async () => {
    answer = { status: 404, body: { error: "unknown raise" } };
    await expect(new EnvioDataSource().launch(42)).resolves.toBeNull();
    answer = { status: 503, body: { error: "database unavailable" } };
    await expect(new EnvioDataSource().launch(42)).rejects.toThrow("/api/launch/42: 503");
  });
});

describe("MockDataSource launches and launch", () => {
  it("has no raises: an empty list and null, so the demo build's /launch renders its empty state", async () => {
    const ds = new MockDataSource({ latencyMs: 0 });
    await expect(ds.launches()).resolves.toEqual([]);
    await expect(ds.launch(1)).resolves.toBeNull();
  });
});
```

Edit `src/hooks/useMarketsData.test.tsx`. Replace lines 1-35 (the imports and the hoisted `ds`) with:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreUnavailableError } from "@/lib/data/envio";
import type { Address, Candle, HoldersView, Interval, LaunchView, TraderRow } from "@/lib/types";
import { queryHarness, renderHook, waitFor } from "@/test/dom";
import {
  HOLDERS_FAST_POLL_MS,
  HOLDERS_POLL_MS,
  HOLDERS_SLOW_POLL_MS,
  LAUNCH_INDEXING_POLL_MS,
  LAUNCH_POLL_MS,
  keys,
  useChartCandles,
  useHolders,
  useLaunch,
  useLaunches,
  useTraders,
  useVotes,
  useWatchlist,
} from "./useMarketsData";

const ROW: TraderRow = {
  wallet: "0x1111111111111111111111111111111111111111" as Address,
  volumeUsd: 10,
  trades: 2,
  tokens: 1,
};

const CANDLE: Candle = { t: 1_700_000_000_000, o: 1, h: 1.1, l: 0.9, c: 1.05, v: 100 };
const TOKEN = "0x000000000000000000000000000000000000000a";

const h = vi.hoisted(() => ({
  ds: {
    traders: vi.fn<(by: string) => Promise<TraderRow[]>>(),
    watchlist: vi.fn<() => Promise<string[]>>(),
    votes: vi.fn<() => Promise<Record<string, never>>>(),
    candles: vi.fn<(id: string, interval: Interval) => Promise<Candle[]>>(),
    holders: vi.fn<(id: string) => Promise<HoldersView>>(),
    launches: vi.fn<() => Promise<unknown[]>>(),
    launch: vi.fn<(id: number, wallet?: string) => Promise<LaunchView | null>>(),
  },
}));
```

and append at the end of the file:

```tsx
describe("useLaunches and useLaunch (launchpad design, section 7)", () => {
  const view = (status: LaunchView["launch"]["status"]): LaunchView => ({ launch: { id: 7, status } as LaunchView["launch"], contribution: null });

  beforeEach(() => {
    h.ds.launches.mockReset().mockResolvedValue([]);
    h.ds.launch.mockReset();
  });
  // The indexing case below freezes Date.now; restore it so the cases after it see a moving clock.
  afterEach(() => vi.restoreAllMocks());

  it("keys the list and one raise (with its wallet) distinctly, and asks the source with the wallet", async () => {
    h.ds.launch.mockResolvedValue(view("open"));
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => useLaunch(7, "0x1111111111111111111111111111111111111111"), { wrapper });
    await waitFor(() => expect(result.current.data?.launch.id).toBe(7));
    expect(h.ds.launch).toHaveBeenCalledWith(7, "0x1111111111111111111111111111111111111111");
    expect(keys.launches).toEqual(["launches"]);
    expect(keys.launch(7)).toEqual(["launch", 7, ""]);
    expect(keys.launch(7, "0xabc")).toEqual(["launch", 7, "0xabc"]);
    const list = renderHook(() => useLaunches(), { wrapper });
    await waitFor(() => expect(list.result.current.data).toEqual([]));
  });

  /** Resolves `refetchInterval` as React Query does (a function of the query), as the holders tests above do. */
  async function pollInterval(status: LaunchView["launch"]["status"] | null) {
    h.ds.launch.mockReset().mockResolvedValue(status === null ? null : view(status));
    const { client, wrapper } = queryHarness();
    const { result } = renderHook(() => useLaunch(7), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const query = client.getQueryCache().find({ queryKey: keys.launch(7) })!;
    const option = query.observers[0]!.options.refetchInterval;
    return typeof option === "function" ? option(query) : option;
  }

  it("polls every 5 s while the raise is scheduled, open or launchable", async () => {
    expect(LAUNCH_POLL_MS).toBe(5_000);
    expect(await pollInterval("scheduled")).toBe(5_000);
    expect(await pollInterval("open")).toBe(5_000);
    expect(await pollInterval("launchable")).toBe(5_000);
  });

  it("stops polling once launched or failed", async () => {
    expect(await pollInterval("launched")).toBe(false);
    expect(await pollInterval("failed")).toBe(false);
  });

  it("polls a raise the store does not know yet every 5 s for three minutes after mount, then stops, and reports `indexing` meanwhile", async () => {
    // A creator is sent to the raise's page the moment the receipt lands, before the reader's next cycle.
    expect(LAUNCH_INDEXING_POLL_MS).toBe(180_000);
    const clock = { t: 1_700_000_000_000 };
    vi.spyOn(Date, "now").mockImplementation(() => clock.t);
    h.ds.launch.mockReset().mockResolvedValue(null);
    const { client, wrapper } = queryHarness();
    const { result, rerender } = renderHook(() => useLaunch(7), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.indexing).toBe(true);
    const query = client.getQueryCache().find({ queryKey: keys.launch(7) })!;
    const option = query.observers[0]!.options.refetchInterval;
    const interval = () => (typeof option === "function" ? option(query) : option);
    expect(interval()).toBe(LAUNCH_POLL_MS);
    clock.t += LAUNCH_INDEXING_POLL_MS - 1;
    expect(interval()).toBe(LAUNCH_POLL_MS); // still inside the three minutes
    clock.t += 1;
    expect(interval()).toBe(false); // past them: a wrong id, not a young raise
    rerender();
    expect(result.current.indexing).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/data/launch.test.ts src/hooks/useMarketsData.test.tsx`
Expected: FAIL: `launches is not a function` on both sources, and the hooks file fails to import `useLaunch`.

- [ ] **Step 3: Write the data-source methods and the hooks**

Edit `src/lib/types.ts`. Inside `MarketsDataSource`, after the `traders(by: TradersBy): Promise<TraderRow[]>;` member (line 189) add:

```ts

  // --- Launchpad (design section 7) -------------------------------------
  /** Every raise with its derived status, in the list page's order. Public: no session is involved. */
  launches(): Promise<Launch[]>;
  /** One raise, with `wallet`'s own contribution row when a wallet is given; null when the id is unknown. */
  launch(id: number, wallet?: Address): Promise<LaunchView | null>;
```

Edit `src/lib/data/envio.ts`. Replace line 2 with:

```ts
import type { Address, Candle, Denom, HoldersView, Interval, Launch, LaunchView, MarketsDataSource, Quote, QuoteAsset, Side, SignMessage, TokenPair, Trade, TraderRow, TradersBy, VoteDir, VoteResult } from "@/lib/types";
```

and after the `traders()` method (after line 146) add:

```ts

  // --- Launchpad (design section 7) -------------------------------------

  launches(): Promise<Launch[]> {
    return getJson<Launch[]>("/api/launch");
  }

  /** 404 is "no such raise", the same null `pair()` answers for an unknown token; anything else throws. */
  async launch(id: number, wallet?: Address): Promise<LaunchView | null> {
    const query = wallet ? `?wallet=${wallet.toLowerCase()}` : "";
    const res = await fetch(`/api/launch/${id}${query}`, { cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`/api/launch/${id}: ${res.status}`);
    return (await res.json()) as LaunchView;
  }
```

Edit `src/lib/data/mock.ts`. Add `Launch,` and `LaunchView,` to the type import list (lines 1-19, alphabetical: after `Interval,`), and after the `traders()` method (after line 303) add:

```ts

  /**
   * The demo has no launchpad behind it and every mock token is a generated address: an empty list and null,
   * so /launch renders its empty sections and a deep link to a raise says it does not exist.
   */
  async launches(): Promise<Launch[]> {
    await this.delay();
    return [];
  }

  async launch(_id: number, _wallet?: Address): Promise<LaunchView | null> {
    await this.delay();
    return null;
  }
```

Edit `src/hooks/useMarketsData.ts`. Replace line 7 with:

```ts
import type { Address, Candle, Denom, Interval, LaunchStatus, LaunchView, Side, TokenPair, TradersBy } from "@/lib/types";
```

In `keys` (lines 9-23) add, after `traders: (by: TradersBy) => ["traders", by] as const,`:

```ts
  launches: ["launches"] as const,
  /** The wallet is part of the key: the view carries that wallet's own contribution row. */
  launch: (id: number, wallet?: string) => ["launch", id, wallet ?? ""] as const,
```

Append at the end of the file:

```ts

/** How often the raise page asks again while the raise can still change without a write from this browser (design section 7). */
export const LAUNCH_POLL_MS = 5_000;
/**
 * How long a page keeps asking about a raise the store does not know yet. A creator is sent to the raise's page
 * the moment the receipt lands, while the reader folds once a minute and the route memoises a 404 for 5 s, so
 * the first answers are null; three minutes covers a slow cycle with room, and past that the id is simply wrong.
 */
export const LAUNCH_INDEXING_POLL_MS = 180_000;
const LIVE_STATUSES: ReadonlySet<LaunchStatus> = new Set(["scheduled", "open", "launchable"]);

/** The public list of raises. The default 15 s staleTime: the list page shows countdowns from the rows' own timestamps, so it needs no poll. */
export function useLaunches() {
  const ds = useDataSource();
  return useQuery({ queryKey: keys.launches, queryFn: () => ds.launches() });
}

/**
 * One raise with the wallet's own row. Polled every 5 s while scheduled, open or launchable: another wallet's
 * contribution, the deadline passing or somebody else's "Launch now" all change what this page shows, and
 * none of them is a write from here. A launched or failed raise is final and is read once. A raise the store
 * does not know yet (a null answer) is polled too, for LAUNCH_INDEXING_POLL_MS after mount, and `indexing`
 * says so while that lasts, so the page can say "being indexed" rather than "no raise".
 */
export function useLaunch(id: number, wallet?: Address) {
  const ds = useDataSource();
  // Stamped in an effect, as useHolders does, and per raise id: a ref may only be written outside render.
  const mountedAt = useRef(0);
  useEffect(() => {
    mountedAt.current = Date.now();
  }, [id]);
  const indexingWindowOpen = () => mountedAt.current > 0 && Date.now() - mountedAt.current < LAUNCH_INDEXING_POLL_MS;
  const query = useQuery({
    queryKey: keys.launch(id, wallet),
    queryFn: () => ds.launch(id, wallet),
    refetchInterval: (q) => {
      const data = q.state.data as LaunchView | null | undefined;
      if (data === null) return indexingWindowOpen() ? LAUNCH_POLL_MS : false;
      const status = data?.launch.status;
      return status !== undefined && LIVE_STATUSES.has(status) ? LAUNCH_POLL_MS : false;
    },
  });
  // A read of the clock, not a write. Spreading the result tracks every field, as usePair's spread does, so each
  // poll's isFetching flip re-renders the caller and re-reads the clock; the poll that lands after the window
  // closes is what flips this false.
  return { ...query, indexing: query.data === null && indexingWindowOpen() };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/data src/hooks src/context`
Expected: PASS. (`AppState.test.tsx` builds a fake data source object; it does not implement the interface with `satisfies`, so the two new methods do not break it. If it does fail on a missing method, add `launches: async () => [], launch: async () => null` to that fake.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/data/envio.ts src/lib/data/mock.ts src/lib/data/launch.test.ts src/hooks/useMarketsData.ts src/hooks/useMarketsData.test.tsx
git commit -m "Launchpad: launches() and launch(id, wallet) on both data sources, and the hooks that poll a live raise every 5 s"
```

---

### Task 8: Wallet writes in `src/lib/launch.ts`, the mirror of `executeSwap`

**Files:**
- Create: `src/lib/launch.ts`
- Create: `src/lib/launch.test.ts`

**Interfaces:**
- Consumes: `svLaunchpadAbi` (Task 2), `SVLAUNCHPAD_ADDRESS`, `PERMIT2_ADDRESS`, `robinhoodChain` (`src/lib/chain.ts`), `erc20Abi` (`src/lib/swap/abi.ts:115`), `permitTypedData`, `randomNonce` (`src/lib/swap/permit.ts`).
- Produces:
  ```ts
  export type LaunchDeps = { wallet: WalletClient; publicClient: PublicClient; account: Address };
  export interface LaunchHandle<T> { hash: Address; confirmation: Promise<T> }
  export interface CreateRaiseParams { name: string; symbol: string; image: string; website: string; x: string; telegram: string; quote: Address; target: bigint; floor: bigint; start: bigint; duration: bigint }
  export class LaunchFailedError extends Error; export class LaunchUnconfirmedError extends Error; export class LaunchRejectedError extends Error;
  export function mapLaunchError(err: unknown, fallback: string): Error;
  export async function createRaise(params: CreateRaiseParams, deps: LaunchDeps): Promise<LaunchHandle<{ id: bigint }>>;
  export async function contribute(id: bigint, quote: Address, amount: bigint, deps: LaunchDeps): Promise<LaunchHandle<{ amount: bigint; raised: bigint }>>;
  export async function finalizeRaise(id: bigint, deps: LaunchDeps): Promise<LaunchHandle<{ token: Address; poolId: Hex }>>;
  export async function claimTokens(id: bigint, deps: LaunchDeps): Promise<LaunchHandle<{ amount: bigint }>>;
  export async function claimCreator(id: bigint, deps: LaunchDeps): Promise<LaunchHandle<{ amount: bigint }>>;
  export async function refundContribution(id: bigint, deps: LaunchDeps): Promise<LaunchHandle<{ amount: bigint }>>;
  export async function collectFees(id: bigint, deps: LaunchDeps): Promise<LaunchHandle<{ creator0: bigint; creator1: bigint; platform0: bigint; platform1: bigint }>>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/launch.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  maxUint256,
  type Hex,
  type Log,
  type PublicClient,
  type TypedDataDefinition,
  type WalletClient,
} from "viem";
import { PERMIT2_ADDRESS } from "@/lib/chain";
import type { Address } from "@/lib/types";
import { svLaunchpadAbi } from "./launch/abi";
import {
  LaunchFailedError,
  LaunchRejectedError,
  LaunchUnconfirmedError,
  claimCreator,
  claimTokens,
  collectFees,
  contribute,
  createRaise,
  finalizeRaise,
  refundContribution,
  type CreateRaiseParams,
  type LaunchDeps,
} from "./launch";

// vi.mock's factory is hoisted above every top-level const, so the address it returns must be declared through
// vi.hoisted (the same pattern as swap.test.ts).
const { LAUNCHPAD } = vi.hoisted(() => ({ LAUNCHPAD: "0x5555555555555555555555555555555555555555" as Address }));
vi.mock("@/lib/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain")>()),
  SVLAUNCHPAD_ADDRESS: LAUNCHPAD,
}));

const ACCOUNT = "0x8888888888888888888888888888888888888888" as Address;
const OTHER = "0x9999999999999999999999999999999999999999" as Address;
const DECOY = "0x6666666666666666666666666666666666666666" as Address;
const QUOTE = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const POOL_ID = `0x${"ab".repeat(32)}` as Hex;
const TX_HASH = `0x${"11".repeat(32)}` as Address;
const APPROVE_HASH = `0x${"22".repeat(32)}` as Address;
const SIGNATURE = `0x${"33".repeat(65)}` as Hex;
const NOW_SEC = 1_789_547_000;

const PARAMS: CreateRaiseParams = {
  name: "Tailor's Chalk", symbol: "CHALK", image: "https://img.test/chalk.png", website: "https://chalk.test", x: "", telegram: "",
  quote: QUOTE, target: 1_000_000_000n, floor: 500_000_000n, start: 0n, duration: 86_400n, // start 0: the block's own timestamp (spec 4.2)
};

type EventName = "RaiseCreated" | "Contributed" | "Finalized" | "Claimed" | "CreatorClaimed" | "Refunded" | "FeesCollected";
/** One launchpad log, built with viem so the encoding is the real one; `address` defaults to the launchpad. */
function launchpadLog(eventName: EventName, args: Record<string, unknown>, types: string[], values: unknown[], address: Address = LAUNCHPAD): Log {
  const topics = encodeEventTopics({ abi: svLaunchpadAbi, eventName, args } as Parameters<typeof encodeEventTopics>[0]);
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data: encodeAbiParameters(types.map((type) => ({ type })), values),
    blockHash: `0x${"00".repeat(32)}` as Hex,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    removed: false,
  };
}
const createdLog = (creator: Address = ACCOUNT, address: Address = LAUNCHPAD) =>
  // The contract resolves a zero start to block.timestamp before it emits: the event carries the real start and deadline.
  launchpadLog("RaiseCreated", { id: 7n, creator, quote: QUOTE }, ["uint256", "uint256", "uint64", "uint64", "uint256"], [1_000_000_000n, 500_000_000n, NOW_SEC, NOW_SEC + 86_400, 450_000_000n * 10n ** 18n], address);
const contributedLog = (wallet: Address = ACCOUNT, amount = 20n, id = 7n) => launchpadLog("Contributed", { id, wallet }, ["uint256", "uint256"], [amount, 120n]);

function reverted(errorName: "RaiseFull" | "WalletCapReached" | "NotLaunchable" | "unknown", functionName: "contribute" | "finalize"): Error {
  const data = errorName === "unknown" ? ("0xdeadbeef" as Hex) : encodeErrorResult({ abi: svLaunchpadAbi, errorName });
  return new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: svLaunchpadAbi, data, functionName }), {
    abi: svLaunchpadAbi, functionName, args: [],
  });
}

type Harness = {
  deps: LaunchDeps;
  readContract: ReturnType<typeof vi.fn>;
  writeContract: ReturnType<typeof vi.fn>;
  signTypedData: ReturnType<typeof vi.fn>;
  waitForTransactionReceipt: ReturnType<typeof vi.fn>;
};
function harness(allowance: bigint, logs: Log[]): Harness {
  const readContract = vi.fn().mockResolvedValue(allowance);
  const writeContract = vi.fn(async ({ functionName }: { functionName: string }) => (functionName === "approve" ? APPROVE_HASH : TX_HASH));
  const signTypedData = vi.fn().mockResolvedValue(SIGNATURE);
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: "success", logs });
  return {
    readContract, writeContract, signTypedData, waitForTransactionReceipt,
    deps: {
      wallet: { writeContract, signTypedData } as unknown as WalletClient,
      publicClient: { readContract, waitForTransactionReceipt } as unknown as PublicClient,
      account: ACCOUNT,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createRaise", () => {
  it("sends the params as the contract's one tuple and resolves the id from this creator's RaiseCreated", async () => {
    const h = harness(0n, [createdLog(OTHER), createdLog()]); // another creator's raise in the same block comes first
    const handle = await createRaise(PARAMS, h.deps);
    expect(handle.hash).toBe(TX_HASH);
    expect(h.writeContract).toHaveBeenCalledTimes(1);
    expect(h.writeContract.mock.calls[0][0]).toMatchObject({ address: LAUNCHPAD, functionName: "create", account: ACCOUNT, args: [PARAMS] });
    expect(h.readContract).not.toHaveBeenCalled(); // no allowance: create pulls no token
    await expect(handle.confirmation).resolves.toEqual({ id: 7n });
  });

  it("ignores a RaiseCreated emitted by another contract, and fails when none is ours", async () => {
    const h = harness(0n, [createdLog(ACCOUNT, DECOY)]);
    await expect((await createRaise(PARAMS, h.deps)).confirmation).rejects.toThrow("Creating the raise failed. Nothing was spent.");
  });

  it("maps a dismissed wallet to LaunchRejectedError", async () => {
    const h = harness(0n, []);
    h.writeContract.mockRejectedValue(
      new ContractFunctionExecutionError(new UserRejectedRequestError(new Error("User rejected the request.")), { abi: svLaunchpadAbi, functionName: "create", args: [] }),
    );
    await expect(createRaise(PARAMS, h.deps)).rejects.toBeInstanceOf(LaunchRejectedError);
    await expect(createRaise(PARAMS, h.deps)).rejects.toThrow("Cancelled in wallet. Nothing was spent.");
  });
});

describe("contribute", () => {
  it("sends no approval when the allowance already covers the amount", async () => {
    const h = harness(maxUint256, [contributedLog()]);
    await contribute(7n, QUOTE, 25n, h.deps);
    expect(h.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: QUOTE, functionName: "allowance", args: [ACCOUNT, PERMIT2_ADDRESS] }));
    expect(h.writeContract).toHaveBeenCalledTimes(1);
    expect(h.writeContract.mock.calls[0][0].functionName).toBe("contribute");
  });

  it("approves Permit2 for the maximum and waits for it before signing", async () => {
    const h = harness(0n, [contributedLog()]);
    await contribute(7n, QUOTE, 25n, h.deps);
    expect(h.writeContract.mock.calls[0][0]).toMatchObject({ address: QUOTE, functionName: "approve", args: [PERMIT2_ADDRESS, maxUint256], account: ACCOUNT });
    expect(h.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: APPROVE_HASH });
    expect(h.waitForTransactionReceipt.mock.invocationCallOrder[0]).toBeLessThan(h.signTypedData.mock.invocationCallOrder[0]);
  });

  it("signs a Permit2 message naming the launchpad as spender with a fresh nonce and a 20-minute deadline, and sends the same permit in the calldata", async () => {
    const h = harness(maxUint256, [contributedLog()]);
    await contribute(7n, QUOTE, 25n, h.deps);
    const typed = h.signTypedData.mock.calls[0][0] as TypedDataDefinition & { account: Address };
    expect(typed.account).toBe(ACCOUNT);
    expect(typed.domain).toEqual({ name: "Permit2", chainId: 4663, verifyingContract: PERMIT2_ADDRESS });
    const message = typed.message as { permitted: { token: Address; amount: bigint }; spender: Address; nonce: bigint; deadline: bigint };
    expect(message.permitted).toEqual({ token: QUOTE, amount: 25n });
    expect(message.spender).toBe(LAUNCHPAD);
    expect(message.deadline).toBe(BigInt(NOW_SEC + 1200));
    expect(message.nonce).toBeGreaterThan(0n);
    const sent = h.writeContract.mock.calls[0][0];
    expect(sent).toMatchObject({ address: LAUNCHPAD, functionName: "contribute", account: ACCOUNT });
    expect(sent.args).toEqual([7n, 25n, { permitted: { token: QUOTE, amount: 25n }, nonce: message.nonce, deadline: message.deadline }, SIGNATURE]);
  });

  it("resolves with the Contributed event's own amount, which can be smaller than what was asked (the last contribution is trimmed)", async () => {
    const h = harness(maxUint256, [contributedLog(OTHER, 999n), contributedLog(ACCOUNT, 20n)]);
    await expect((await contribute(7n, QUOTE, 25n, h.deps)).confirmation).resolves.toEqual({ amount: 20n, raised: 120n });
  });

  it("fails the confirmation when no Contributed names this wallet and this raise", async () => {
    const h = harness(maxUint256, [contributedLog(ACCOUNT, 20n, 8n)]);
    await expect((await contribute(7n, QUOTE, 25n, h.deps)).confirmation).rejects.toThrow("Contribution failed. Nothing was spent.");
  });

  it("refuses a zero amount before the wallet is touched", async () => {
    const h = harness(maxUint256, []);
    await expect(contribute(7n, QUOTE, 0n, h.deps)).rejects.toBeInstanceOf(LaunchFailedError);
    expect(h.readContract).not.toHaveBeenCalled();
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it.each([
    ["RaiseFull" as const, "The raise is already full. Nothing was spent."],
    ["WalletCapReached" as const, "This wallet is at its 10% cap for this raise. Nothing was spent."],
    ["unknown" as const, "Contribution failed. Nothing was spent."],
  ])("maps a %s revert to its message", async (errorName, message) => {
    const h = harness(maxUint256, []);
    h.writeContract.mockRejectedValue(reverted(errorName, "contribute"));
    await expect(contribute(7n, QUOTE, 25n, h.deps)).rejects.toBeInstanceOf(LaunchFailedError);
    await expect(contribute(7n, QUOTE, 25n, h.deps)).rejects.toThrow(message);
  });

  it("reports a mined revert as gas spent, and a receipt that cannot be read as unconfirmed, never as nothing spent", async () => {
    const h = harness(maxUint256, []);
    h.waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted", logs: [] });
    const mined = await contribute(7n, QUOTE, 25n, h.deps);
    await expect(mined.confirmation).rejects.toThrow("Nothing was spent except gas.");
    h.waitForTransactionReceipt.mockRejectedValueOnce(new Error("timed out"));
    const lost = await contribute(7n, QUOTE, 25n, h.deps);
    await expect(lost.confirmation).rejects.toBeInstanceOf(LaunchUnconfirmedError);
    const err = await lost.confirmation.then(() => { throw new Error("must reject"); }, (e: unknown) => e as Error);
    expect(err.message).not.toMatch(/nothing was spent/i);
  });
});

describe("finalizeRaise, claimTokens, refundContribution, collectFees", () => {
  it("finalize sends the id and resolves the token and pool from Finalized", async () => {
    const finalizedLog = launchpadLog("Finalized", { id: 7n, token: TOKEN, poolId: POOL_ID }, ["uint160", "uint256", "uint256", "uint256", "uint256", "uint256", "uint128"], [2n ** 96n, 1000n, 20n, 980n, 1n, 2n, 3n]);
    const h = harness(0n, [finalizedLog]);
    const handle = await finalizeRaise(7n, h.deps);
    expect(h.writeContract.mock.calls[0][0]).toMatchObject({ address: LAUNCHPAD, functionName: "finalize", args: [7n], account: ACCOUNT });
    await expect(handle.confirmation).resolves.toEqual({ token: TOKEN, poolId: POOL_ID });
  });

  it("finalize maps NotLaunchable to its message", async () => {
    const h = harness(0n, []);
    h.writeContract.mockRejectedValue(reverted("NotLaunchable", "finalize"));
    await expect(finalizeRaise(7n, h.deps)).rejects.toThrow("This raise cannot be launched yet. Nothing was spent.");
  });

  it("claim resolves this wallet's Claimed amount", async () => {
    const h = harness(0n, [launchpadLog("Claimed", { id: 7n, wallet: OTHER }, ["uint256"], [1n]), launchpadLog("Claimed", { id: 7n, wallet: ACCOUNT }, ["uint256"], [99n])]);
    const handle = await claimTokens(7n, h.deps);
    expect(h.writeContract.mock.calls[0][0]).toMatchObject({ functionName: "claim", args: [7n] });
    await expect(handle.confirmation).resolves.toEqual({ amount: 99n });
  });

  it("claimCreator sends the id and resolves the CreatorClaimed amount, whoever the payout address is", async () => {
    const h = harness(0n, [launchpadLog("CreatorClaimed", { id: 7n, payout: OTHER }, ["uint256"], [5n * 10n ** 25n])]);
    const handle = await claimCreator(7n, h.deps);
    expect(h.writeContract.mock.calls[0][0]).toMatchObject({ address: LAUNCHPAD, functionName: "claimCreator", args: [7n], account: ACCOUNT });
    await expect(handle.confirmation).resolves.toEqual({ amount: 5n * 10n ** 25n });
  });

  it("refund resolves this wallet's Refunded amount", async () => {
    const h = harness(0n, [launchpadLog("Refunded", { id: 7n, wallet: ACCOUNT }, ["uint256"], [25n])]);
    const handle = await refundContribution(7n, h.deps);
    expect(h.writeContract.mock.calls[0][0]).toMatchObject({ functionName: "refund", args: [7n] });
    await expect(handle.confirmation).resolves.toEqual({ amount: 25n });
  });

  it("collectFees resolves the four amounts", async () => {
    const h = harness(0n, [launchpadLog("FeesCollected", { id: 7n }, ["uint256", "uint256", "uint256", "uint256"], [1n, 2n, 3n, 4n])]);
    const handle = await collectFees(7n, h.deps);
    expect(h.writeContract.mock.calls[0][0]).toMatchObject({ functionName: "collectFees", args: [7n] });
    await expect(handle.confirmation).resolves.toEqual({ creator0: 1n, creator1: 2n, platform0: 3n, platform1: 4n });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/launch.test.ts`
Expected: FAIL with "Cannot find module './launch'".

- [ ] **Step 3: Write the wallet writes**

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
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
} from "viem";
import { PERMIT2_ADDRESS, SVLAUNCHPAD_ADDRESS, robinhoodChain } from "./chain";
import { svLaunchpadAbi } from "./launch/abi";
import { erc20Abi } from "./swap/abi";
import { permitTypedData, randomNonce } from "./swap/permit";
import type { Address } from "./types";

/**
 * SVLaunchpad execution (launchpad design, section 7), built exactly like src/lib/swap.ts: viem clients from
 * wagmi's hooks, no simulateContract, the ERC-20 allowance to Permit2 raised to the maximum when short, the
 * same permitTypedData helper and random nonce, writeContract directly, the receipt waited for, the event
 * that proves the outcome parsed from the launchpad's own logs, and the same three error classes. Every
 * failure message ends in "Nothing was spent." except a transaction that reached the chain and reverted,
 * which burned gas and says so, and a broadcast whose receipt could not be read, which must never say it.
 */

/** How long the Permit2 signature stays valid, in seconds; the same as the swap's. */
const DEADLINE_SEC = 1200;

export type LaunchDeps = { wallet: WalletClient; publicClient: PublicClient; account: Address };

export interface LaunchHandle<T> {
  /** Transaction hash, known once the wallet has signed and sent. */
  hash: Address;
  /** Resolves with the event's numbers; rejects with LaunchFailedError or LaunchUnconfirmedError. */
  confirmation: Promise<T>;
}

export interface CreateRaiseParams {
  name: string;
  symbol: string;
  image: string;
  website: string;
  x: string;
  telegram: string;
  quote: Address;
  target: bigint;
  floor: bigint;
  /** Unix seconds, or 0 for the block's own timestamp (spec 4.2, create step 2); otherwise now <= start <= now + 14 days at the block it lands in. */
  start: bigint;
  /** Seconds, 1 hour to 30 days. */
  duration: bigint;
}

export class LaunchFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchFailedError";
  }
}

/** Broadcast, but the receipt could not be read: it may have landed, so never "nothing was spent". */
export class LaunchUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchUnconfirmedError";
  }
}

/** The user dismissed the wallet. Nothing was signed and nothing was sent. */
export class LaunchRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchRejectedError";
  }
}

const CREATE_FAILED = "Creating the raise failed. Nothing was spent.";
const CONTRIBUTE_FAILED = "Contribution failed. Nothing was spent.";
const FINALIZE_FAILED = "Launching the raise failed. Nothing was spent.";
const CLAIM_FAILED = "Claiming failed. Nothing was spent.";
const CREATOR_CLAIM_FAILED = "Claiming the creator tokens failed. Nothing was spent.";
const REFUND_FAILED = "The refund failed. Nothing was spent.";
const COLLECT_FAILED = "Collecting the fees failed. Nothing was spent.";
const UNCONFIRMED = "Sent, but we could not confirm it. Check the transaction before trying again.";

/** The interface's named reverts (spec section 4.2), in the words a user reads. Anything else gets the call's own fallback. */
const REVERTS: Record<string, string> = {
  CreationClosed: "Creating raises is paused right now. Nothing was spent.",
  NotAllowedToLaunch: "This wallet holds no Suits NFT, so it cannot create a raise. Nothing was spent.",
  QuoteNotEnabled: "That asset is not enabled for raises. Nothing was spent.",
  TargetOutOfRange: "The target is outside the allowed range for that asset. Nothing was spent.",
  FloorOutOfRange: "The floor must be between half the target and the target. Nothing was spent.",
  StartOutOfRange: "The start must be now or within the next 14 days. Nothing was spent.",
  DurationOutOfRange: "The raise must run between 1 hour and 30 days. Nothing was spent.",
  TextTooLong: "One of the text fields is too long. Nothing was spent.",
  NotOpen: "This raise is no longer open. Nothing was spent.",
  NotStarted: "This raise has not opened yet. Nothing was spent.",
  Ended: "This raise has ended. Nothing was spent.",
  RaiseFull: "The raise is already full. Nothing was spent.",
  WalletCapReached: "This wallet is at its 10% cap for this raise. Nothing was spent.",
  PermitMismatch: "The signature did not match the raise's asset. Nothing was spent.",
  NotLaunchable: "This raise cannot be launched yet. Nothing was spent.",
  NotLaunched: "This raise has not launched. Nothing was spent.",
  NothingToClaim: "Nothing to claim for this wallet. Nothing was spent.",
  AlreadyClaimed: "Already claimed. Nothing was spent.",
  NotRefundable: "This raise cannot be refunded yet. Nothing was spent.",
  NotCreator: "Only the raise's creator can claim these tokens. Nothing was spent.",
};

function tryDecode(data: Hex): { errorName: string } | undefined {
  try {
    return decodeErrorResult({ abi: svLaunchpadAbi, data });
  } catch {
    return undefined;
  }
}

function revertName(err: BaseError): string | null {
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  const decoded: { errorName: string } | undefined = reverted.data ?? (reverted.raw ? tryDecode(reverted.raw) : undefined);
  return decoded?.errorName ?? null;
}

/** The only place a chain error becomes something a user reads; `fallback` is the call's own generic line. */
export function mapLaunchError(err: unknown, fallback: string): Error {
  if (err instanceof LaunchFailedError || err instanceof LaunchRejectedError) return err;
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) {
      return new LaunchRejectedError("Cancelled in wallet. Nothing was spent.");
    }
    const name = revertName(err);
    if (name && REVERTS[name]) return new LaunchFailedError(REVERTS[name]);
  }
  return new LaunchFailedError(fallback);
}

function requireLaunchpad(): Address {
  if (!SVLAUNCHPAD_ADDRESS) throw new LaunchFailedError("Raises go live when the launchpad is deployed. Nothing was spent.");
  return SVLAUNCHPAD_ADDRESS;
}

/**
 * Waits for the receipt and answers the launchpad's own logs from it, filtered by emitter with `isAddressEqual`
 * (the RPC cases the address however it likes, and a decoy contract in the same transaction could emit a
 * look-alike). A reverted receipt is the one failure that spent gas; an unreadable receipt is unconfirmed.
 */
async function launchpadLogs(deps: LaunchDeps, launchpad: Address, hash: Address, revertMessage: string): Promise<Log[]> {
  let receipt;
  try {
    receipt = await deps.publicClient.waitForTransactionReceipt({ hash });
  } catch {
    throw new LaunchUnconfirmedError(UNCONFIRMED);
  }
  if (receipt.status === "reverted") throw new LaunchFailedError(revertMessage);
  return receipt.logs.filter((log) => isAddressEqual(log.address, launchpad));
}

/** Keeps a caller that never awaits the confirmation from raising an unhandled rejection; the promise still rejects for one that does. */
function settle<T>(confirmation: Promise<T>): Promise<T> {
  void confirmation.catch(() => {});
  return confirmation;
}

export async function createRaise(params: CreateRaiseParams, deps: LaunchDeps): Promise<LaunchHandle<{ id: bigint }>> {
  const launchpad = requireLaunchpad();
  try {
    const hash = await deps.wallet.writeContract({
      address: launchpad,
      abi: svLaunchpadAbi,
      functionName: "create",
      args: [
        {
          name: params.name, symbol: params.symbol, image: params.image, website: params.website, x: params.x, telegram: params.telegram,
          quote: params.quote, target: params.target, floor: params.floor, start: params.start, duration: params.duration,
        },
      ],
      account: deps.account,
      chain: robinhoodChain,
    });
    const confirmation = (async () => {
      const logs = await launchpadLogs(deps, launchpad, hash, "Creating the raise reverted on-chain. Nothing was spent except gas.");
      // The id comes from this creator's RaiseCreated: one block can carry several raises, and the page opened
      // afterwards must be this one.
      const created = parseEventLogs({ abi: svLaunchpadAbi, eventName: "RaiseCreated", logs });
      const mine = created.find((e) => isAddressEqual(e.args.creator, deps.account));
      if (!mine) throw new LaunchFailedError(CREATE_FAILED);
      return { id: mine.args.id };
    })();
    return { hash, confirmation: settle(confirmation) };
  } catch (err) {
    throw mapLaunchError(err, CREATE_FAILED);
  }
}

/**
 * Allowance to Permit2, one signature naming the launchpad, one `contribute`. `amount` is what the wallet
 * offers; the contract takes what fits under the raise's target and the wallet's 10 % cap, and the Contributed
 * event's own `amount` is what the confirmation reports (the "up to" the panel promises).
 */
export async function contribute(id: bigint, quote: Address, amount: bigint, deps: LaunchDeps): Promise<LaunchHandle<{ amount: bigint; raised: bigint }>> {
  const launchpad = requireLaunchpad();
  if (amount <= 0n) throw new LaunchFailedError("Enter an amount. Nothing was spent.");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SEC);
  try {
    // 1. Permit2 pulls the quote asset, so it is the spender of the ERC-20 approval.
    const allowance = await deps.publicClient.readContract({
      address: quote,
      abi: erc20Abi,
      functionName: "allowance",
      args: [deps.account, PERMIT2_ADDRESS],
    });
    if (allowance < amount) {
      const approval = await deps.wallet.writeContract({
        address: quote,
        abi: erc20Abi,
        functionName: "approve",
        args: [PERMIT2_ADDRESS, maxUint256],
        account: deps.account,
        chain: robinhoodChain,
      });
      const approvalReceipt = await deps.publicClient.waitForTransactionReceipt({ hash: approval });
      if (approvalReceipt.status === "reverted") {
        throw new LaunchFailedError("Could not approve the asset for the raise. Nothing was spent.");
      }
    }

    // 2. One signature, one nonce: Permit2 nonces are unordered bits, so a random one needs no read.
    const nonce = randomNonce();
    const signature = await deps.wallet.signTypedData({
      ...permitTypedData({ token: quote, amount, spender: launchpad, nonce, deadline }),
      account: deps.account,
    });

    // 3. The contribution. The signed amount may exceed what the contract takes (spec 4.2, contribute step 3).
    const hash = await deps.wallet.writeContract({
      address: launchpad,
      abi: svLaunchpadAbi,
      functionName: "contribute",
      args: [id, amount, { permitted: { token: quote, amount }, nonce, deadline }, signature],
      account: deps.account,
      chain: robinhoodChain,
    });

    const confirmation = (async () => {
      const logs = await launchpadLogs(deps, launchpad, hash, "The contribution reverted on-chain: the raise filled or closed first. Nothing was spent except gas.");
      const events = parseEventLogs({ abi: svLaunchpadAbi, eventName: "Contributed", logs });
      const mine = events.find((e) => e.args.id === id && isAddressEqual(e.args.wallet, deps.account));
      if (!mine) throw new LaunchFailedError(CONTRIBUTE_FAILED);
      return { amount: mine.args.amount, raised: mine.args.raised };
    })();
    return { hash, confirmation: settle(confirmation) };
  } catch (err) {
    throw mapLaunchError(err, CONTRIBUTE_FAILED);
  }
}

/** Anyone may launch a raise that met its terms (spec 4.2, `finalize`). */
export async function finalizeRaise(id: bigint, deps: LaunchDeps): Promise<LaunchHandle<{ token: Address; poolId: Hex }>> {
  const launchpad = requireLaunchpad();
  try {
    const hash = await deps.wallet.writeContract({ address: launchpad, abi: svLaunchpadAbi, functionName: "finalize", args: [id], account: deps.account, chain: robinhoodChain });
    const confirmation = (async () => {
      const logs = await launchpadLogs(deps, launchpad, hash, "The launch reverted on-chain. Nothing was spent except gas.");
      const done = parseEventLogs({ abi: svLaunchpadAbi, eventName: "Finalized", logs }).find((e) => e.args.id === id);
      if (!done) throw new LaunchFailedError(FINALIZE_FAILED);
      return { token: done.args.token, poolId: done.args.poolId };
    })();
    return { hash, confirmation: settle(confirmation) };
  } catch (err) {
    throw mapLaunchError(err, FINALIZE_FAILED);
  }
}

export async function claimTokens(id: bigint, deps: LaunchDeps): Promise<LaunchHandle<{ amount: bigint }>> {
  const launchpad = requireLaunchpad();
  try {
    const hash = await deps.wallet.writeContract({ address: launchpad, abi: svLaunchpadAbi, functionName: "claim", args: [id], account: deps.account, chain: robinhoodChain });
    const confirmation = (async () => {
      const logs = await launchpadLogs(deps, launchpad, hash, "The claim reverted on-chain. Nothing was spent except gas.");
      const mine = parseEventLogs({ abi: svLaunchpadAbi, eventName: "Claimed", logs }).find((e) => e.args.id === id && isAddressEqual(e.args.wallet, deps.account));
      if (!mine) throw new LaunchFailedError(CLAIM_FAILED);
      return { amount: mine.args.amount };
    })();
    return { hash, confirmation: settle(confirmation) };
  } catch (err) {
    throw mapLaunchError(err, CLAIM_FAILED);
  }
}

/**
 * The creator's vested tenth (spec 4.2, `claimCreator`): creator only on chain, paid to the raise's payout
 * address, so the event is matched by id alone, since the payout may differ from the signer.
 */
export async function claimCreator(id: bigint, deps: LaunchDeps): Promise<LaunchHandle<{ amount: bigint }>> {
  const launchpad = requireLaunchpad();
  try {
    const hash = await deps.wallet.writeContract({ address: launchpad, abi: svLaunchpadAbi, functionName: "claimCreator", args: [id], account: deps.account, chain: robinhoodChain });
    const confirmation = (async () => {
      const logs = await launchpadLogs(deps, launchpad, hash, "The creator claim reverted on-chain. Nothing was spent except gas.");
      const done = parseEventLogs({ abi: svLaunchpadAbi, eventName: "CreatorClaimed", logs }).find((e) => e.args.id === id);
      if (!done) throw new LaunchFailedError(CREATOR_CLAIM_FAILED);
      return { amount: done.args.amount };
    })();
    return { hash, confirmation: settle(confirmation) };
  } catch (err) {
    throw mapLaunchError(err, CREATOR_CLAIM_FAILED);
  }
}

export async function refundContribution(id: bigint, deps: LaunchDeps): Promise<LaunchHandle<{ amount: bigint }>> {
  const launchpad = requireLaunchpad();
  try {
    const hash = await deps.wallet.writeContract({ address: launchpad, abi: svLaunchpadAbi, functionName: "refund", args: [id], account: deps.account, chain: robinhoodChain });
    const confirmation = (async () => {
      const logs = await launchpadLogs(deps, launchpad, hash, "The refund reverted on-chain. Nothing was spent except gas.");
      const mine = parseEventLogs({ abi: svLaunchpadAbi, eventName: "Refunded", logs }).find((e) => e.args.id === id && isAddressEqual(e.args.wallet, deps.account));
      if (!mine) throw new LaunchFailedError(REFUND_FAILED);
      return { amount: mine.args.amount };
    })();
    return { hash, confirmation: settle(confirmation) };
  } catch (err) {
    throw mapLaunchError(err, REFUND_FAILED);
  }
}

/** Anyone may collect a launched pool's accrued fees; the contract splits them between the creator's payout and the fee wallet. */
export async function collectFees(id: bigint, deps: LaunchDeps): Promise<LaunchHandle<{ creator0: bigint; creator1: bigint; platform0: bigint; platform1: bigint }>> {
  const launchpad = requireLaunchpad();
  try {
    const hash = await deps.wallet.writeContract({ address: launchpad, abi: svLaunchpadAbi, functionName: "collectFees", args: [id], account: deps.account, chain: robinhoodChain });
    const confirmation = (async () => {
      const logs = await launchpadLogs(deps, launchpad, hash, "Collecting the fees reverted on-chain. Nothing was spent except gas.");
      const done = parseEventLogs({ abi: svLaunchpadAbi, eventName: "FeesCollected", logs }).find((e) => e.args.id === id);
      if (!done) throw new LaunchFailedError(COLLECT_FAILED);
      return { creator0: done.args.creator0, creator1: done.args.creator1, platform0: done.args.platform0, platform1: done.args.platform1 };
    })();
    return { hash, confirmation: settle(confirmation) };
  } catch (err) {
    throw mapLaunchError(err, COLLECT_FAILED);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/launch.test.ts src/lib/swap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/launch.ts src/lib/launch.test.ts
git commit -m "Launchpad: create, contribute, finalize, claim, refund and collectFees through the wallet, mirroring executeSwap"
```

---

### Task 9: `fmtDuration`, the display arithmetic, the progress bar, the countdown, and the `/launch` list

**Files:**
- Modify: `src/lib/format.ts` (append `fmtDuration` after `fmtISODate`, line 143)
- Create: `src/lib/format.test.ts`
- Create: `src/lib/launch/math.ts`, `src/lib/launch/math.test.ts`
- Create: `src/components/RaiseProgress.tsx`, `src/components/RaiseProgress.test.tsx`
- Create: `src/components/Countdown.tsx`, `src/components/Countdown.test.tsx`
- Create: `src/components/LaunchList.tsx`, `src/components/LaunchList.test.tsx`
- Create: `src/app/launch/page.tsx`, `src/app/launch/page.test.tsx`

**Interfaces:**
- Consumes: `useLaunches` (Task 7), `Launch` (Task 6), `hasLaunchpad` (Task 2), `SALE_TOKENS`, `WALLET_CAP_BPS` (Task 2), `toHuman` (`src/lib/quote/math.ts`), `Avatar` (`src/components/ui.tsx`), `nowSec` (`src/lib/time.ts`).
- Produces:
  ```ts
  // src/lib/format.ts
  export function fmtDuration(sec: number): string;   // "2d 3h", "3h 05m", "14m 05s", "0m 00s"
  // src/lib/launch/math.ts
  export function rawToNumber(raw: string | bigint, decimals: number): number;
  export function pctOf(part: string | bigint, whole: string | bigint): number;   // 0..100, two decimals
  export function remainingAllowance(target: bigint, raised: bigint, mine: bigint): bigint;
  export function presalePrice(target: bigint, saleTokens: bigint, quoteDecimals: number): number;   // quote per token
  export function tokensPerQuoteUnit(target: bigint, saleTokens: bigint, quoteDecimals: number): number;
  export function launchSplit(target: bigint, feeBps: number): { fee: bigint; net: bigint };
  export function tokensForPool(target: bigint, net: bigint): bigint;
  export function creatorClaimable(launchedAt: number, now: number, creatorClaimed: bigint): bigint;   // the creator's tenth vested so far, minus what was claimed
  export function feesCollected(l: Pick<Launch, "token" | "quoteId" | "feesCreator0" | "feesCreator1" | "feesPlatform0" | "feesPlatform1">): { token: bigint; quote: bigint };
  // components
  export default function RaiseProgress({ raisedPct, floorPct }: { raisedPct: number; floorPct: number }): ReactElement;
  export default function Countdown({ to, className? }: { to: number; className?: string }): ReactElement;   // `to` unix seconds
  export function raisedOfTarget(l: Launch): string;   // in LaunchList.tsx, reused by RaiseView
  export default function LaunchList(): ReactElement;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fmtDuration } from "./format";

describe("fmtDuration (countdowns on the launch screens)", () => {
  it("days and hours past a day, hours and minutes past an hour, minutes and seconds below, never negative", () => {
    expect(fmtDuration(2 * 86_400 + 3 * 3600 + 59)).toBe("2d 3h");
    expect(fmtDuration(3 * 3600 + 5 * 60 + 9)).toBe("3h 05m");
    expect(fmtDuration(14 * 60 + 5)).toBe("14m 05s");
    expect(fmtDuration(59)).toBe("0m 59s");
    expect(fmtDuration(0)).toBe("0m 00s");
    expect(fmtDuration(-30)).toBe("0m 00s");
    expect(fmtDuration(86_400)).toBe("1d 0h");
  });
});
```

Create `src/lib/launch/math.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Address } from "@/lib/types";
import { SALE_TOKENS } from "./constants";
import { creatorClaimable, feesCollected, launchSplit, pctOf, presalePrice, rawToNumber, remainingAllowance, tokensForPool, tokensPerQuoteUnit } from "./math";

describe("launch display arithmetic", () => {
  it("rawToNumber scales a raw string by the asset's decimals, for display only", () => {
    expect(rawToNumber("1000000000", 6)).toBe(1000);
    expect(rawToNumber(25n * 10n ** 16n, 18)).toBe(0.25);
  });

  it("pctOf is exact on 30-digit raw amounts, two decimals, 0 for an empty whole and capped at 100", () => {
    expect(pctOf("250000000", "1000000000")).toBe(25);
    expect(pctOf(1n, 3n * 10n ** 30n)).toBe(0);
    expect(pctOf(10n ** 30n, 3n * 10n ** 30n)).toBe(33.33);
    expect(pctOf(5n, 0n)).toBe(0);
    expect(pctOf(7n, 5n)).toBe(100);
  });

  it("remainingAllowance is the smaller of the wallet's cap left and the raise's room, never negative", () => {
    const target = 1_000_000_000n; // cap 100_000_000
    expect(remainingAllowance(target, 0n, 0n)).toBe(100_000_000n);
    expect(remainingAllowance(target, 0n, 30_000_000n)).toBe(70_000_000n);
    expect(remainingAllowance(target, 950_000_000n, 0n)).toBe(50_000_000n); // the raise has less room than the cap
    expect(remainingAllowance(target, 1_000_000_000n, 0n)).toBe(0n);
    expect(remainingAllowance(target, 0n, 100_000_000n)).toBe(0n);
    expect(remainingAllowance(target, 0n, 200_000_000n)).toBe(0n); // over the cap somehow: still 0, not negative
  });

  it("presalePrice and tokensPerQuoteUnit: 1,000 USDG for 450M tokens", () => {
    expect(presalePrice(1_000_000_000n, SALE_TOKENS, 6)).toBeCloseTo(1000 / 450_000_000, 15);
    expect(tokensPerQuoteUnit(1_000_000_000n, SALE_TOKENS, 6)).toBeCloseTo(450_000, 6);
    expect(presalePrice(1_000_000_000n, 0n, 6)).toBe(0);
    expect(tokensPerQuoteUnit(0n, SALE_TOKENS, 6)).toBe(0);
  });

  it("launchSplit floors the fee like the contract, and tokensForPool follows net / target", () => {
    expect(launchSplit(1_000_000_000n, 200)).toEqual({ fee: 20_000_000n, net: 980_000_000n });
    expect(launchSplit(1_000_000_001n, 200)).toEqual({ fee: 20_000_000n, net: 980_000_001n });
    expect(tokensForPool(1_000_000_000n, 980_000_000n)).toBe((SALE_TOKENS * 98n) / 100n);
    expect(tokensForPool(0n, 0n)).toBe(0n);
  });

  it("creatorClaimable vests the creator's 100M tokens linearly over 90 days from launch, minus what was claimed, never negative", () => {
    const launchedAt = 1_700_000_000;
    expect(creatorClaimable(0, launchedAt + 10, 0n)).toBe(0n); // not launched
    expect(creatorClaimable(launchedAt, launchedAt, 0n)).toBe(0n);
    expect(creatorClaimable(launchedAt, launchedAt + 45 * 86_400, 0n)).toBe(50_000_000n * 10n ** 18n);
    expect(creatorClaimable(launchedAt, launchedAt + 45 * 86_400, 20_000_000n * 10n ** 18n)).toBe(30_000_000n * 10n ** 18n);
    expect(creatorClaimable(launchedAt, launchedAt + 400 * 86_400, 0n)).toBe(100_000_000n * 10n ** 18n); // capped at the whole tenth
    expect(creatorClaimable(launchedAt, launchedAt + 45 * 86_400, 60_000_000n * 10n ** 18n)).toBe(0n);
  });

  it("feesCollected sums the creator's and the fee wallet's shares per side, and names the sides by v4's currency order", () => {
    const fees = { feesCreator0: "7", feesCreator1: "20", feesPlatform0: "3", feesPlatform1: "10" };
    const low = "0x0000000000000000000000000000000000000001" as Address;
    const mid = "0x0000000000000000000000000000000000000002" as Address;
    const high = "0x0000000000000000000000000000000000000003" as Address;
    expect(feesCollected({ ...fees, token: low, quoteId: mid })).toEqual({ token: 10n, quote: 30n }); // the token is currency0
    expect(feesCollected({ ...fees, token: high, quoteId: mid })).toEqual({ token: 30n, quote: 10n }); // the quote is currency0
    expect(feesCollected({ ...fees, token: null, quoteId: mid })).toEqual({ token: 30n, quote: 10n }); // before launch nothing is collected anyway
  });
});
```

Create `src/components/RaiseProgress.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/dom";
import RaiseProgress from "./RaiseProgress";

describe("RaiseProgress", () => {
  it("fills to the raised share and marks the floor", () => {
    render(<RaiseProgress raisedPct={37.5} floorPct={50} />);
    const bar = screen.getByRole("progressbar", { name: "Raised" });
    expect(bar.getAttribute("aria-valuenow")).toBe("38");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("37.5%");
    expect((screen.getByTitle("Floor at 50%") as HTMLElement).style.left).toBe("50%");
  });

  it("draws no marker for an all-or-nothing raise (floor at 100%) and clamps the fill", () => {
    render(<RaiseProgress raisedPct={140} floorPct={100} />);
    expect(screen.queryByTitle(/Floor at/)).toBeNull();
    expect((screen.getByRole("progressbar").firstElementChild as HTMLElement).style.width).toBe("100%");
  });
});
```

Create `src/components/Countdown.test.tsx`:

```tsx
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/dom";
import Countdown from "./Countdown";

const NOW_SEC = 1_789_547_000;

describe("Countdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
  });
  afterEach(() => vi.useRealTimers());

  it("shows the time until `to` and ticks once a second", () => {
    render(<Countdown to={NOW_SEC + 3 * 3600 + 5 * 60} />);
    expect(screen.getByText("3h 05m")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("3h 04m")).toBeTruthy();
  });

  it("stops at zero once `to` has passed", () => {
    render(<Countdown to={NOW_SEC - 10} />);
    expect(screen.getByText("0m 00s")).toBeTruthy();
  });
});
```

Create `src/components/LaunchList.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Launch } from "@/lib/types";
import { queryHarness, render, screen, within } from "@/test/dom";
import LaunchList from "./LaunchList";

const NOW_SEC = 1_789_547_000;
const base = {
  creator: "0xc", payout: "0xc", name: "Tailor's Chalk", symbol: "CHALK", image: "", website: "", x: "", telegram: "",
  quoteId: "0xq", quoteSymbol: "USDG", quoteDecimals: 6, target: "1000000000", floor: "500000000", raised: "250000000", saleTokens: "450000000000000000000000000",
  targetUsd: 1000, floorUsd: 500, raisedUsd: 250, contributors: 3, startTs: NOW_SEC - 3600, deadlineTs: NOW_SEC + 7200, createdTs: NOW_SEC - 7200, launchedAt: 0, closedAt: 0,
  token: null, poolId: null, sqrtPriceX96: "0", fee: "0", quoteToPool: "0", tokensToPool: "0", tokensBurned: "0", liquidity: "0",
  creatorClaimed: "0", feesCreator0: "0", feesCreator1: "0", feesPlatform0: "0", feesPlatform1: "0", asOf: NOW_SEC,
} as unknown as Launch;
const raise = (over: Partial<Launch>): Launch => ({ ...base, ...over });

const h = vi.hoisted(() => ({
  launches: { data: undefined as Launch[] | undefined, isPending: false, isError: false, error: undefined as Error | undefined, refetch: vi.fn() },
  launchpad: true,
}));
vi.mock("@/hooks/useMarketsData", () => ({ useLaunches: () => h.launches }));
vi.mock("@/lib/chain", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/chain")>()), hasLaunchpad: () => h.launchpad }));

function show() {
  const { wrapper } = queryHarness();
  return render(<LaunchList />, { wrapper });
}
const section = (name: string) => within(screen.getByRole("region", { name }));

describe("LaunchList (design section 7: Live, Upcoming, Launched, Did not launch)", () => {
  beforeEach(() => {
    h.launches = { data: undefined, isPending: false, isError: false, error: undefined, refetch: vi.fn() };
    h.launchpad = true;
  });

  it("groups raises into the four sections and says so when a section is empty", () => {
    h.launches.data = [
      raise({ id: 1, status: "open" }),
      raise({ id: 2, status: "launchable", name: "Ready One", raised: "1000000000", raisedUsd: 1000 }),
      raise({ id: 3, status: "scheduled", name: "Soon One", startTs: NOW_SEC + 600 }),
      raise({ id: 4, status: "launched", name: "Done One", token: "0x000000000000000000000000000000000000000a", launchedAt: NOW_SEC - 100 }),
    ];
    show();
    expect(section("Live").getAllByRole("link", { name: /Tailor's Chalk|Ready One/ })).toHaveLength(2);
    expect(section("Upcoming").getByText("Soon One")).toBeTruthy();
    expect(section("Launched").getByText("Done One")).toBeTruthy();
    expect(section("Did not launch").getByText("Every raise so far reached its floor.")).toBeTruthy();
  });

  it("a card carries the raise's link, USD raised of target, the progress bar with its floor, time left and contributors", () => {
    h.launches.data = [raise({ id: 1, status: "open" })];
    show();
    const card = section("Live");
    expect(card.getByRole("link", { name: /Tailor's Chalk/ }).getAttribute("href")).toBe("/launch/1");
    expect(card.getByText("$250 of $1.0K")).toBeTruthy();
    expect(card.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
    expect(card.getByTitle("Floor at 50%")).toBeTruthy();
    expect(card.getByText(/Ends in/)).toBeTruthy();
    expect(card.getByText("3 contributors")).toBeTruthy();
  });

  it("a launched card links to the token page; a failed card says why", () => {
    h.launches.data = [
      raise({ id: 4, status: "launched", token: "0x000000000000000000000000000000000000000a", launchedAt: NOW_SEC - 100 }),
      raise({ id: 5, status: "failed", name: "Fell Short", raised: "100000000", raisedUsd: 100, deadlineTs: NOW_SEC - 10 }),
    ];
    show();
    expect(section("Launched").getByRole("link", { name: "Open CHALK" }).getAttribute("href")).toBe("/t/0x000000000000000000000000000000000000000a");
    expect(section("Did not launch").getByText("Did not reach its floor")).toBeTruthy();
  });

  it("shows the raw quote amounts while the quote's price is stale, never a zero dollar figure", () => {
    h.launches.data = [raise({ id: 1, status: "open", targetUsd: null, raisedUsd: null })];
    show();
    expect(section("Live").getByText("250 of 1,000 USDG")).toBeTruthy();
  });

  it("renders skeletons while loading, an inline error with Retry on failure, and the deploy note without a launchpad", () => {
    h.launches.isPending = true;
    const { unmount } = show();
    expect(screen.getByLabelText("Loading raises")).toBeTruthy();
    unmount();
    h.launches = { data: undefined, isPending: false, isError: true, error: new Error("/api/launch: 503"), refetch: vi.fn() };
    const second = show();
    expect(screen.getByText("Couldn't load the raises.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    second.unmount();
    h.launches = { data: [], isPending: false, isError: false, error: undefined, refetch: vi.fn() };
    h.launchpad = false;
    show();
    expect(screen.getByText("Raises go live when the launchpad is deployed.")).toBeTruthy();
  });
});
```

Create `src/app/launch/page.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { queryHarness, render, screen } from "@/test/dom";
import LaunchPage, { metadata } from "./page";

vi.mock("@/hooks/useMarketsData", () => ({ useLaunches: () => ({ data: [], isPending: false, isError: false, error: undefined, refetch: vi.fn() }) }));

describe("LaunchPage", () => {
  it("titles the tab 'Launch', links to the create form and mounts the list", () => {
    expect(metadata.title).toBe("Launch");
    const { wrapper } = queryHarness();
    render(<LaunchPage />, { wrapper });
    expect(screen.getByRole("heading", { level: 1, name: "Launch" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create a raise" }).getAttribute("href")).toBe("/launch/new");
    expect(screen.getByText("No raise is open right now.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/format.test.ts src/lib/launch/math.test.ts src/components/RaiseProgress.test.tsx src/components/Countdown.test.tsx src/components/LaunchList.test.tsx src/app/launch/page.test.tsx`
Expected: FAIL: `fmtDuration` is not exported; the other modules do not exist.

- [ ] **Step 3: Write the helper, the arithmetic and the components**

Append to `src/lib/format.ts` after `fmtISODate` (after line 143):

```ts

/** `2d 3h` / `3h 05m` / `14m 05s` from a number of seconds; never negative. The launch screens' countdowns. */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad2(m)}m`;
  return `${m}m ${pad2(r)}s`;
}
```

Create `src/lib/launch/math.ts`:

```ts
import { toHuman } from "@/lib/quote/math";
import type { Launch } from "@/lib/types";
import { CREATOR_TOKENS, CREATOR_VESTING_SEC, SALE_TOKENS, WALLET_CAP_BPS } from "./constants";

/**
 * Display arithmetic over a raise's raw amounts (launchpad design, section 7's screens). Every input is a raw
 * quote-unit or token-unit integer, as a decimal string or bigint; every number out is for the screen only and
 * never becomes an amount the chain sees. The one bigint out, remainingAllowance, is what the contribute panel
 * shows as "up to" and does not sign for anything by itself.
 */

/** A raw amount scaled by the asset's decimals. Display only. */
export function rawToNumber(raw: string | bigint, decimals: number): number {
  return Number(toHuman(BigInt(raw), decimals));
}

/** part / whole in percent to two decimals, computed in integers so a 30-digit amount keeps its digits; 0 for an empty whole; capped at 100. */
export function pctOf(part: string | bigint, whole: string | bigint): number {
  const w = BigInt(whole);
  if (w <= 0n) return 0;
  const p = BigInt(part);
  if (p >= w) return 100;
  return Number((p * 10_000n) / w) / 100;
}

/** What this wallet may still put in: the smaller of its cap left (10 % of the target minus its own contribution) and the raise's room. Never negative. */
export function remainingAllowance(target: bigint, raised: bigint, mine: bigint): bigint {
  const cap = (target * WALLET_CAP_BPS) / 10_000n;
  const capLeft = cap > mine ? cap - mine : 0n;
  const room = target > raised ? target - raised : 0n;
  return capLeft < room ? capLeft : room;
}

/** Quote per token at the presale price: target over the tokens on sale, both in human units (spec section 2). */
export function presalePrice(target: bigint, saleTokens: bigint, quoteDecimals: number): number {
  if (saleTokens <= 0n) return 0;
  return rawToNumber(target, quoteDecimals) / rawToNumber(saleTokens, 18);
}

/** Tokens one whole unit of the quote buys at the presale price. */
export function tokensPerQuoteUnit(target: bigint, saleTokens: bigint, quoteDecimals: number): number {
  const price = presalePrice(target, saleTokens, quoteDecimals);
  return price > 0 ? 1 / price : 0;
}

/** The launch fee and what reaches the pool for a target at feeBps, floored like the contract's integer division. */
export function launchSplit(target: bigint, feeBps: number): { fee: bigint; net: bigint } {
  const fee = (target * BigInt(feeBps)) / 10_000n;
  return { fee, net: target - fee };
}

/** The tokens paired into the pool at success: saleTokens times net over target (spec 4.2, _finalize step 4). */
export function tokensForPool(target: bigint, net: bigint): bigint {
  return target <= 0n ? 0n : (SALE_TOKENS * net) / target;
}

/**
 * The creator's tenth vested so far, minus what was claimed: the contract's own `claimCreator` arithmetic
 * (spec 4.2), linear over CREATOR_VESTING_SEC from launch. 0 before launch, capped at the whole tenth, never
 * negative. For the button's label; the contract computes its own number when the claim lands.
 */
export function creatorClaimable(launchedAt: number, now: number, creatorClaimed: bigint): bigint {
  if (launchedAt <= 0) return 0n;
  const elapsed = BigInt(Math.max(0, Math.min(now - launchedAt, CREATOR_VESTING_SEC)));
  const vested = (CREATOR_TOKENS * elapsed) / BigInt(CREATOR_VESTING_SEC);
  return vested > creatorClaimed ? vested - creatorClaimed : 0n;
}

/**
 * The pool's collected fees so far, by side: the launchpad reports them per currency, and currency0 is the
 * lower of the two addresses (v4's order), which the token's address decides once it exists. Before launch
 * the order is unknowable and nothing has been collected, so either assignment is right.
 */
export function feesCollected(
  l: Pick<Launch, "token" | "quoteId" | "feesCreator0" | "feesCreator1" | "feesPlatform0" | "feesPlatform1">,
): { token: bigint; quote: bigint } {
  const side0 = BigInt(l.feesCreator0) + BigInt(l.feesPlatform0);
  const side1 = BigInt(l.feesCreator1) + BigInt(l.feesPlatform1);
  const tokenIsCurrency0 = l.token !== null && l.token.toLowerCase() < l.quoteId.toLowerCase();
  return tokenIsCurrency0 ? { token: side0, quote: side1 } : { token: side1, quote: side0 };
}
```

Create `src/components/RaiseProgress.tsx`:

```tsx
/**
 * A raise's progress toward its target with the floor marked (launchpad design, section 7): the one
 * progress bar in the app, so it is its own small piece rather than a table recipe. Both inputs are
 * percentages, 0 to 100; an all-or-nothing raise (floor at 100) draws no marker.
 */
export default function RaiseProgress({ raisedPct, floorPct }: { raisedPct: number; floorPct: number }) {
  const fill = Math.min(100, Math.max(0, raisedPct));
  const floor = Math.min(100, Math.max(0, floorPct));
  return (
    <div
      role="progressbar"
      aria-label="Raised"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fill)}
      className="relative h-[6px] w-full bg-[rgba(244,238,218,0.08)]"
    >
      <div className="h-full bg-chalk" style={{ width: `${fill}%` }} />
      {floor > 0 && floor < 100 ? (
        <span
          title={`Floor at ${floor}%`}
          className="absolute -top-[3px] h-3 w-px bg-ink-60"
          style={{ left: `${floor}%` }}
        />
      ) : null}
    </div>
  );
}
```

Create `src/components/Countdown.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { fmtDuration } from "@/lib/format";
import { nowSec } from "@/lib/time";

/**
 * The seconds until `to` (unix seconds), ticking once a second; "0m 00s" once it has passed, and the parent
 * decides what to say then. The first paint uses the browser's clock, which differs from the server's by the
 * hydration gap, so the text is allowed to differ between the two renders.
 */
export default function Countdown({ to, className = "" }: { to: number; className?: string }) {
  const [now, setNow] = useState(nowSec);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(nowSec()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span suppressHydrationWarning className={`font-mono tabular-nums ${className}`}>
      {fmtDuration(to - now)}
    </span>
  );
}
```

Create `src/components/LaunchList.tsx`:

```tsx
"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useLaunches } from "@/hooks/useMarketsData";
import { hasLaunchpad } from "@/lib/chain";
import { fmtAmt, fmtInt, fmtUsd } from "@/lib/format";
import { pctOf, rawToNumber } from "@/lib/launch/math";
import type { Launch, LaunchStatus } from "@/lib/types";
import Countdown from "./Countdown";
import RaiseProgress from "./RaiseProgress";
import { Avatar } from "./ui";

/** Design section 7: four sections, in this order. Live holds open and launchable raises. */
const SECTIONS: ReadonlyArray<{ title: string; statuses: readonly LaunchStatus[]; empty: string }> = [
  { title: "Live", statuses: ["open", "launchable"], empty: "No raise is open right now." },
  { title: "Upcoming", statuses: ["scheduled"], empty: "Nothing scheduled." },
  { title: "Launched", statuses: ["launched"], empty: "No token has launched yet." },
  { title: "Did not launch", statuses: ["failed"], empty: "Every raise so far reached its floor." },
];

/** "$250 of $1.0K" with a fresh price, else the raw quote amounts: a dash would hide the one number the raise is about. */
export function raisedOfTarget(l: Launch): string {
  if (l.raisedUsd !== null && l.targetUsd !== null) return `${fmtUsd(l.raisedUsd)} of ${fmtUsd(l.targetUsd)}`;
  return `${fmtAmt(rawToNumber(l.raised, l.quoteDecimals))} of ${fmtAmt(rawToNumber(l.target, l.quoteDecimals))} ${l.quoteSymbol}`;
}

function timeLine(l: Launch): ReactNode {
  switch (l.status) {
    case "scheduled":
      return (
        <>
          Opens in <Countdown to={l.startTs} />
        </>
      );
    case "open":
      return (
        <>
          Ends in <Countdown to={l.deadlineTs} />
        </>
      );
    case "launchable":
      return "Ready to launch";
    case "launched":
      return "Launched";
    case "failed":
      return "Did not reach its floor";
  }
}

function RaiseCard({ launch }: { launch: Launch }) {
  return (
    <div className="border border-hairline p-4">
      <Link href={`/launch/${launch.id}`} className="block hover:bg-hover-soft">
        <div className="flex items-center gap-3">
          <Avatar ticker={launch.symbol} logoUrl={launch.image || undefined} size={32} fontSize={12} />
          <div className="min-w-0">
            <div className="truncate text-[14px] font-medium tracking-[0.01em]">{launch.name}</div>
            <div className="truncate font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-45">
              {launch.symbol} · raise in {launch.quoteSymbol}
            </div>
          </div>
        </div>
        <div className="mt-4 flex items-baseline justify-between font-mono text-[12px] tabular-nums">
          <span>{raisedOfTarget(launch)}</span>
          <span className="text-ink-45">{fmtInt(launch.contributors)} contributor{launch.contributors === 1 ? "" : "s"}</span>
        </div>
        <div className="mt-2">
          <RaiseProgress raisedPct={pctOf(launch.raised, launch.target)} floorPct={pctOf(launch.floor, launch.target)} />
        </div>
        <div className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-50">{timeLine(launch)}</div>
      </Link>
      {launch.status === "launched" && launch.token ? (
        <Link
          href={`/t/${launch.token}`}
          className="mt-3 inline-flex h-8 items-center border border-hairline-btn px-3 font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink hover:border-[rgba(240,232,214,0.5)]"
        >
          Open {launch.symbol}
        </Link>
      ) : null}
    </div>
  );
}

function SkeletonCards() {
  return (
    <div aria-busy aria-label="Loading raises" className="grid gap-3 tablet:grid-cols-2 desktop:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="border border-hairline p-4">
          <span className="skeleton block h-[12px] w-[140px]" />
          <span className="skeleton mt-3 block h-[10px] w-[220px]" />
          <span className="skeleton mt-4 block h-[6px] w-full" />
        </div>
      ))}
    </div>
  );
}

export default function LaunchList() {
  const query = useLaunches();
  const rows = query.data ?? [];
  return (
    <>
      {hasLaunchpad() ? null : (
        <div className="mt-[14px] font-mono text-[10.5px] text-ink-50">Raises go live when the launchpad is deployed.</div>
      )}
      {query.isError ? (
        <div className="px-4 py-16 text-center">
          <div className="text-[16px]">Couldn&apos;t load the raises.</div>
          <div className="mt-[6px] text-[12.5px] text-ink-50">{query.error.message}</div>
          <button
            type="button"
            onClick={() => query.refetch()}
            className="mt-[18px] h-[30px] border border-hairline-btn bg-transparent px-[14px] font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink hover:border-[rgba(240,232,214,0.5)]"
          >
            Retry
          </button>
        </div>
      ) : query.isPending ? (
        <div className="mt-[18px]">
          <SkeletonCards />
        </div>
      ) : (
        SECTIONS.map((s) => {
          const slug = `launch-${s.title.replace(/\s+/g, "-").toLowerCase()}`;
          const list = rows.filter((l) => s.statuses.includes(l.status));
          return (
            <section key={s.title} aria-labelledby={slug} className="mt-[26px]">
              <h2 id={slug} className="border-b border-hairline pb-2 font-mono text-[10.5px] uppercase tracking-[0.22em] text-ink-50">
                {s.title}
              </h2>
              {list.length === 0 ? (
                <div className="py-[18px] text-[12.5px] text-ink-45">{s.empty}</div>
              ) : (
                <div className="mt-3 grid gap-3 tablet:grid-cols-2 desktop:grid-cols-3">
                  {list.map((l) => (
                    <RaiseCard key={l.id} launch={l} />
                  ))}
                </div>
              )}
            </section>
          );
        })
      )}
    </>
  );
}
```

Create `src/app/launch/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import LaunchList from "@/components/LaunchList";

export const metadata: Metadata = { title: "Launch" };

export default function LaunchPage() {
  return (
    <section className="px-4 pb-8 tablet:px-5 desktop:px-6">
      <div className="mt-[18px] flex items-baseline gap-[14px]">
        <h1 className="text-[18px] font-medium tracking-[-0.01em]">Launch</h1>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-40">Presale, then pool</span>
        <Link
          href="/launch/new"
          className="ml-auto flex h-8 items-center bg-chalk px-[14px] font-mono text-[10px] uppercase tracking-[0.2em] text-onlight hover:bg-white"
        >
          Create a raise
        </Link>
      </div>
      <LaunchList />
    </section>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/format.test.ts src/lib/launch/math.test.ts src/components/RaiseProgress.test.tsx src/components/Countdown.test.tsx src/components/LaunchList.test.tsx src/app/launch/page.test.tsx`
Expected: PASS. (A `<section aria-labelledby>` has the `region` role in jsdom's accessibility tree, which is what `section("Live")` queries.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/format.ts src/lib/format.test.ts src/lib/launch/math.ts src/lib/launch/math.test.ts src/components/RaiseProgress.tsx src/components/RaiseProgress.test.tsx src/components/Countdown.tsx src/components/Countdown.test.tsx src/components/LaunchList.tsx src/components/LaunchList.test.tsx src/app/launch/page.tsx src/app/launch/page.test.tsx
git commit -m "Launchpad: the /launch list with a progress bar that marks the floor and a countdown"
```

---

### Task 10: `/launch/new`, the create form with the live summary panel and the gate message

**Files:**
- Modify: `src/lib/suits.ts:12` (`export` the `erc721BalanceAbi` const; nothing else changes)
- Create: `src/components/CreateRaiseForm.tsx`, `src/components/CreateRaiseForm.test.tsx`
- Create: `src/app/launch/new/page.tsx`

**Interfaces:**
- Consumes: `createRaise`, the three error classes (Task 8), `svLaunchpadAbi` (Task 2), the constants (Task 2), `launchSplit`, `presalePrice`, `rawToNumber`, `tokensForPool`, `tokensPerQuoteUnit` (Task 9), `useQuotes`, `keys` (`src/hooks/useMarketsData.ts`), `useAppState` (`src/context/AppState.tsx`), `toBase` (`src/lib/quote/math.ts:93`), `fmtAmt`, `fmtQuote`, `fmtUsd` (`src/lib/format.ts`).
- Produces: `export default function CreateRaiseForm(): ReactElement`; `src/lib/suits.ts` exports `erc721BalanceAbi`.

- [ ] **Step 1: Write the failing test**

Create `src/components/CreateRaiseForm.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, QuoteAsset } from "@/lib/types";
import { fireEvent, queryHarness, render, screen, waitFor } from "@/test/dom";
import CreateRaiseForm from "./CreateRaiseForm";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" as Address;
const GATE = "0x4444444444444444444444444444444444444444" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";
const NOW_SEC = 1_789_547_000;

const QUOTES: QuoteAsset[] = [
  { symbol: "USDG", name: "Global Dollar", address: USDG, decimals: 6, usdPrice: 1, pairs: 10, vol24h: 1000, stale: false },
  { symbol: "NVDA", name: "NVIDIA", address: NVDA, decimals: 18, usdPrice: 120, pairs: 5, vol24h: 500, stale: false },
];

const h = vi.hoisted(() => ({
  state: { address: "0x1111111111111111111111111111111111111111", isConnected: true, addToast: vi.fn(() => 1), updateToast: vi.fn() },
  reads: {} as Record<string, unknown>,
  launchpad: true,
  createRaise: vi.fn(),
  push: vi.fn(),
  wallet: { id: "wallet-client" } as unknown,
  publicClient: { id: "public-client" } as unknown,
}));

vi.mock("@/context/AppState", () => ({ useAppState: () => h.state }));
vi.mock("@/hooks/useMarketsData", () => ({ useQuotes: () => ({ data: QUOTES }), keys: { launches: ["launches"] } }));
vi.mock("wagmi", () => ({
  usePublicClient: () => h.publicClient,
  useWalletClient: () => ({ data: h.wallet }),
  useReadContract: ({ functionName }: { functionName: string }) => ({ data: h.reads[functionName] }),
}));
vi.mock("@/lib/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain")>()),
  hasLaunchpad: () => h.launchpad,
  SVLAUNCHPAD_ADDRESS: "0x5555555555555555555555555555555555555555",
}));
vi.mock("@/lib/launch", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/launch")>()), createRaise: h.createRaise }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));

function show() {
  const { wrapper } = queryHarness();
  return render(<CreateRaiseForm />, { wrapper });
}
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const createButton = () => screen.getByRole("button", { name: "Create the raise" });

/** Fills every field the contract requires, so a test can then break one thing. */
function fillValid() {
  type("Name", "Tailor's Chalk");
  type("Symbol", "CHALK");
  type("Target", "1000");
}

describe("CreateRaiseForm (design section 7)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW_SEC * 1000);
    h.state = { address: WALLET, isConnected: true, addToast: vi.fn(() => 1), updateToast: vi.fn() };
    h.reads = { feeBps: 200, launcherGate: ZERO, creationOpen: true, quoteLimits: [1_000_000_000n, 250_000_000_000n], balanceOf: 0n };
    h.launchpad = true;
    h.createRaise.mockReset();
    h.push.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("says so instead of failing at signing when a gate is set and this wallet holds no Suits NFT", () => {
    h.reads.launcherGate = GATE;
    h.reads.balanceOf = 0n;
    show();
    fillValid();
    expect(screen.getByText("Only Suits NFT holders can create a raise right now. This wallet holds none.")).toBeTruthy();
    expect(createButton().hasAttribute("disabled")).toBe(true);
  });

  it("lets a gate holder through", () => {
    h.reads.launcherGate = GATE;
    h.reads.balanceOf = 1n;
    show();
    fillValid();
    expect(createButton().hasAttribute("disabled")).toBe(false);
  });

  it("explains a paused launchpad, a missing deployment and a missing wallet", () => {
    h.reads.creationOpen = false;
    const first = show();
    expect(screen.getByText("Creating raises is paused right now.")).toBeTruthy();
    first.unmount();
    h.launchpad = false;
    const second = show();
    expect(screen.getByText("Raises go live when the launchpad is deployed.")).toBeTruthy();
    second.unmount();
    h.launchpad = true;
    h.reads.creationOpen = true;
    h.state.isConnected = false;
    show();
    expect(screen.getByText("Connect a wallet to create a raise.")).toBeTruthy();
  });

  it("checks the target against the asset's limits and the fields against the contract's sizes", () => {
    show();
    fillValid();
    type("Target", "500");
    expect(screen.getByText("Target: between 1,000 and 250,000 USDG.")).toBeTruthy();
    type("Target", "1000");
    type("Symbol", "TWELVECHARSX");
    expect(screen.getByText("Symbol: 1 to 11 characters.")).toBeTruthy();
    type("Symbol", "CHALK");
    type("Image", "http://img.test/chalk.png");
    expect(screen.getByText("Image: an https link, or leave it empty.")).toBeTruthy();
    type("Image", "");
    type("Floor", "40");
    expect(screen.getByText("Floor: 50 to 100 percent of the target.")).toBeTruthy();
    type("Floor", "100");
    type("Duration", "800");
    expect(screen.getByText("Duration: 1 hour to 30 days.")).toBeTruthy();
  });

  it("names an asset that is not enabled for raises", () => {
    h.reads.quoteLimits = [0n, 0n];
    show();
    fillValid();
    expect(screen.getByText("USDG is not enabled for raises.")).toBeTruthy();
  });

  it("shows the live summary: opening price, tokens per unit, pool depth at success, launch fee, per-wallet cap", () => {
    show();
    fillValid();
    const panel = screen.getByRole("region", { name: "Summary" });
    expect(panel.textContent).toContain("0.00000222 USDG");
    expect(panel.textContent).toContain("450,000 CHALK per USDG");
    expect(panel.textContent).toContain("980 USDG and 441,000,000 CHALK");
    expect(panel.textContent).toContain("2% · 20 USDG");
    expect(panel.textContent).toContain("100 USDG per wallet");
  });

  it("sends one transaction with the raw amounts and opens the new raise's page from the RaiseCreated id", async () => {
    h.createRaise.mockResolvedValue({ hash: "0xdeadbeef", confirmation: Promise.resolve({ id: 7n }) });
    show();
    fillValid();
    type("Floor", "50");
    type("Duration", "24");
    fireEvent.click(createButton());
    await waitFor(() => expect(h.createRaise).toHaveBeenCalledTimes(1));
    const [params, deps] = h.createRaise.mock.calls[0];
    expect(params).toMatchObject({ name: "Tailor's Chalk", symbol: "CHALK", image: "", website: "", x: "", telegram: "", quote: USDG, target: 1_000_000_000n, floor: 500_000_000n, duration: 86_400n });
    expect(params.start).toBe(0n); // "now": the contract reads block.timestamp for a zero start (spec 4.2, create step 2)
    expect(deps).toEqual({ wallet: h.wallet, publicClient: h.publicClient, account: WALLET });
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/launch/7"));
    expect(h.state.updateToast).toHaveBeenCalledWith(1, { hash: "0xdeadbeef" });
    expect(h.state.updateToast).toHaveBeenCalledWith(1, { kind: "confirmed", message: "Raise 7 created. Opening its page." });
  });

  it("renders the write's own message when the wallet rejects, and stays on the form", async () => {
    const { LaunchRejectedError } = await import("@/lib/launch");
    h.createRaise.mockRejectedValue(new LaunchRejectedError("Cancelled in wallet. Nothing was spent."));
    show();
    fillValid();
    fireEvent.click(createButton());
    await waitFor(() => expect(h.state.updateToast).toHaveBeenCalledWith(1, { kind: "failed", message: "Cancelled in wallet. Nothing was spent." }));
    expect(h.push).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Tailor's Chalk");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/CreateRaiseForm.test.tsx`
Expected: FAIL with "Cannot find module './CreateRaiseForm'".

- [ ] **Step 3: Write the form and the page**

Edit `src/lib/suits.ts` line 12: change `const erc721BalanceAbi = [` to `export const erc721BalanceAbi = [` (the create form reads the gate's `balanceOf` with it).

Create `src/components/CreateRaiseForm.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePublicClient, useReadContract, useWalletClient } from "wagmi";
import { useAppState } from "@/context/AppState";
import { keys, useQuotes } from "@/hooks/useMarketsData";
import { SVLAUNCHPAD_ADDRESS, ZERO_ADDRESS, hasLaunchpad, robinhoodChain } from "@/lib/chain";
import { fmtAmt, fmtQuote, fmtUsd } from "@/lib/format";
import { LaunchFailedError, LaunchRejectedError, LaunchUnconfirmedError, createRaise } from "@/lib/launch";
import { svLaunchpadAbi } from "@/lib/launch/abi";
import { MAX_DURATION_SEC, MAX_START_DELAY_SEC, MIN_DURATION_SEC, SALE_TOKENS } from "@/lib/launch/constants";
import { launchSplit, presalePrice, rawToNumber, tokensForPool, tokensPerQuoteUnit } from "@/lib/launch/math";
import { toBase } from "@/lib/quote/math";
import { erc721BalanceAbi } from "@/lib/suits";
import { nowSec } from "@/lib/time";
import type { Address } from "@/lib/types";
import { Spinner } from "./ui";

const AMOUNT_RE = /^\d*\.?\d*$/;
const FIELD = "mt-[6px] h-[34px] w-full border border-hairline-strong bg-transparent px-[10px] font-mono text-[11.5px] outline-none focus:border-hairline-focus";
const LABEL = "block font-mono text-[10px] uppercase tracking-[0.18em] text-ink-45";
/** The contract's limits are bytes; a multi-byte character counts as its bytes. */
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** The hint sits outside the <label>: Testing Library's label text is every text node under it, so a hint inside would make "Floor" unfindable. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="block">
        <span className={LABEL}>{label}</span>
        {children}
      </label>
      {hint ? <span className="mt-1 block text-[11px] text-ink-45">{hint}</span> : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline-soft py-[10px] font-mono text-[11.5px] tabular-nums">
      <span className="flex-none text-[10px] uppercase tracking-[0.16em] text-ink-40">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

/** Design section 7's create form: one transaction, then the raise's own page. */
export default function CreateRaiseForm() {
  const { address, isConnected, addToast, updateToast } = useAppState();
  const publicClient = usePublicClient({ chainId: robinhoodChain.id });
  const { data: walletClient } = useWalletClient({ chainId: robinhoodChain.id });
  const qc = useQueryClient();
  const router = useRouter();
  const quotes = useQuotes();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState("");
  const [website, setWebsite] = useState("");
  const [x, setX] = useState("");
  const [telegram, setTelegram] = useState("");
  const [quoteSymbol, setQuoteSymbol] = useState("USDG");
  const [target, setTarget] = useState("");
  const [floorPct, setFloorPct] = useState("100");
  const [startMode, setStartMode] = useState<"now" | "later">("now");
  const [startAt, setStartAt] = useState("");
  const [hours, setHours] = useState("24");
  const [pending, setPending] = useState(false);

  const launchpad = SVLAUNCHPAD_ADDRESS;
  const configured = hasLaunchpad();
  const quote = quotes.data?.find((q) => q.symbol === quoteSymbol);
  const feeRead = useReadContract({ address: launchpad, abi: svLaunchpadAbi, functionName: "feeBps", chainId: robinhoodChain.id, query: { enabled: configured } });
  const gateRead = useReadContract({ address: launchpad, abi: svLaunchpadAbi, functionName: "launcherGate", chainId: robinhoodChain.id, query: { enabled: configured } });
  const openRead = useReadContract({ address: launchpad, abi: svLaunchpadAbi, functionName: "creationOpen", chainId: robinhoodChain.id, query: { enabled: configured } });
  const limitsRead = useReadContract({
    address: launchpad, abi: svLaunchpadAbi, functionName: "quoteLimits", args: quote ? [quote.address] : undefined, chainId: robinhoodChain.id,
    query: { enabled: configured && Boolean(quote) },
  });
  // The gate is an ERC-721: a wallet with no balance sees the reason before signing, never a revert.
  const gate = gateRead.data && gateRead.data.toLowerCase() !== ZERO_ADDRESS ? (gateRead.data as Address) : undefined;
  const gateBalance = useReadContract({
    address: gate, abi: erc721BalanceAbi, functionName: "balanceOf", args: address ? [address] : undefined, chainId: robinhoodChain.id,
    query: { enabled: Boolean(gate && address) },
  });

  // Display and gating only: the raw target below is what the transaction carries.
  const targetNum = parseFloat(target) || 0;
  const floorNum = parseFloat(floorPct) || 0;
  const hoursNum = parseFloat(hours) || 0;
  const decimals = quote?.decimals ?? 18;
  let targetRaw = 0n;
  try {
    targetRaw = target && AMOUNT_RE.test(target) ? toBase(target, decimals) : 0n;
  } catch {
    targetRaw = 0n;
  }
  const feeBps = feeRead.data === undefined ? null : Number(feeRead.data);
  const startTs = startMode === "later" && startAt ? Math.floor(new Date(startAt).getTime() / 1000) : 0;
  const limits = limitsRead.data;

  let reason = "";
  if (!configured) reason = "Raises go live when the launchpad is deployed.";
  else if (openRead.data === false) reason = "Creating raises is paused right now.";
  else if (!isConnected || !address) reason = "Connect a wallet to create a raise.";
  else if (gate && gateBalance.data !== undefined && gateBalance.data === 0n) reason = "Only Suits NFT holders can create a raise right now. This wallet holds none.";
  else if (bytes(name) < 1 || bytes(name) > 32) reason = "Name: 1 to 32 characters.";
  else if (bytes(symbol) < 1 || bytes(symbol) > 11) reason = "Symbol: 1 to 11 characters.";
  else if ([image, website, x, telegram].some((s) => bytes(s) > 256)) reason = "Links: at most 256 characters each.";
  else if (image && !/^https:\/\//.test(image)) reason = "Image: an https link, or leave it empty.";
  else if (!quote) reason = "Pick the asset to raise in.";
  else if (!(targetNum > 0) || targetRaw <= 0n) reason = "Enter a target.";
  else if (limits && limits[1] === 0n) reason = `${quote.symbol} is not enabled for raises.`;
  else if (limits && (targetRaw < limits[0] || targetRaw > limits[1])) {
    reason = `Target: between ${fmtAmt(rawToNumber(limits[0], quote.decimals), 0)} and ${fmtAmt(rawToNumber(limits[1], quote.decimals), 0)} ${quote.symbol}.`;
  } else if (!(floorNum >= 50 && floorNum <= 100)) reason = "Floor: 50 to 100 percent of the target.";
  else if (!(hoursNum * 3600 >= MIN_DURATION_SEC && hoursNum * 3600 <= MAX_DURATION_SEC)) reason = "Duration: 1 hour to 30 days.";
  else if (startMode === "later" && !(startTs > nowSec())) reason = "Start: a time in the future.";
  else if (startMode === "later" && startTs > nowSec() + MAX_START_DELAY_SEC) reason = "Start: within the next 14 days.";
  else if (!walletClient || !publicClient) reason = "Connecting to your wallet…";

  // The summary panel, from the raw target and the contract's constants (design section 7).
  const price = quote ? presalePrice(targetRaw, SALE_TOKENS, quote.decimals) : 0;
  const perUnit = quote ? tokensPerQuoteUnit(targetRaw, SALE_TOKENS, quote.decimals) : 0;
  const split = launchSplit(targetRaw, feeBps ?? 0);
  const poolTokens = tokensForPool(targetRaw, split.net);
  const usd = quote && quote.stale === false ? quote.usdPrice : null;
  const inUsd = (v: number) => (usd === null ? "" : ` (${fmtUsd(v * usd)})`);
  const ticker = symbol || "TOKEN";

  const submit = async () => {
    if (reason || pending || !quote || !address || !walletClient || !publicClient) return;
    setPending(true);
    const toastId = addToast({ kind: "pending", message: `Creating the ${ticker} raise` });
    try {
      const handle = await createRaise(
        {
          name, symbol, image, website, x, telegram, quote: quote.address, target: targetRaw,
          floor: (targetRaw * BigInt(Math.round(floorNum * 100))) / 10_000n,
          // 0 is "the block's own timestamp" (spec 4.2, create step 2): no clock buffer, no StartOutOfRange on a slow wallet.
          start: BigInt(startMode === "now" ? 0 : startTs),
          duration: BigInt(Math.round(hoursNum * 3600)),
        },
        { wallet: walletClient, publicClient, account: address },
      );
      updateToast(toastId, { hash: handle.hash });
      const { id } = await handle.confirmation;
      updateToast(toastId, { kind: "confirmed", message: `Raise ${id} created. Opening its page.` });
      void qc.invalidateQueries({ queryKey: keys.launches });
      router.push(`/launch/${id}`);
    } catch (err) {
      if (err instanceof LaunchUnconfirmedError) {
        updateToast(toastId, { kind: "unconfirmed", message: err.message });
      } else {
        updateToast(toastId, {
          kind: "failed",
          message: err instanceof LaunchRejectedError || err instanceof LaunchFailedError ? err.message : "Creating the raise failed. Nothing was spent.",
        });
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-5 flex flex-col gap-6 twocol:flex-row twocol:items-start twocol:gap-8">
      <form
        className="grid w-full min-w-0 flex-1 gap-4 tablet:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} className={FIELD} autoComplete="off" /></Field>
        <Field label="Symbol"><input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className={FIELD} autoComplete="off" /></Field>
        <Field label="Image"><input value={image} onChange={(e) => setImage(e.target.value)} placeholder="https://" className={FIELD} autoComplete="off" /></Field>
        <Field label="Website"><input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" className={FIELD} autoComplete="off" /></Field>
        <Field label="X"><input value={x} onChange={(e) => setX(e.target.value)} placeholder="https://x.com/" className={FIELD} autoComplete="off" /></Field>
        <Field label="Telegram"><input value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="https://t.me/" className={FIELD} autoComplete="off" /></Field>
        <Field label="Raise in">
          <select value={quoteSymbol} onChange={(e) => setQuoteSymbol(e.target.value)} className={FIELD}>
            {(quotes.data ?? []).map((q) => (
              <option key={q.symbol} value={q.symbol}>{q.symbol}</option>
            ))}
          </select>
        </Field>
        <Field label="Target">
          <input value={target} onChange={(e) => { if (AMOUNT_RE.test(e.target.value)) setTarget(e.target.value); }} placeholder="0.00" inputMode="decimal" className={FIELD} autoComplete="off" />
        </Field>
        <Field label="Floor" hint="Percent of the target the raise must reach by its deadline. 100 is all or nothing.">
          <input value={floorPct} onChange={(e) => { if (AMOUNT_RE.test(e.target.value)) setFloorPct(e.target.value); }} inputMode="decimal" className={FIELD} />
        </Field>
        <Field label="Duration" hint="Hours, from 1 to 720.">
          <input value={hours} onChange={(e) => { if (AMOUNT_RE.test(e.target.value)) setHours(e.target.value); }} inputMode="decimal" className={FIELD} />
        </Field>
        <div className="tablet:col-span-2">
          <span className={LABEL}>Start</span>
          <div className="mt-[6px] grid grid-cols-2 border border-hairline-strong" role="group" aria-label="Start">
            <button type="button" aria-pressed={startMode === "now"} onClick={() => setStartMode("now")} className={`h-8 font-mono text-[10.5px] uppercase tracking-[0.22em] ${startMode === "now" ? "bg-chalk-10 text-chalk" : "bg-transparent text-ink-50"}`}>Now</button>
            <button type="button" aria-pressed={startMode === "later"} onClick={() => setStartMode("later")} className={`h-8 border-l border-hairline-strong font-mono text-[10.5px] uppercase tracking-[0.22em] ${startMode === "later" ? "bg-chalk-10 text-chalk" : "bg-transparent text-ink-50"}`}>Later</button>
          </div>
          <span className="mt-1 block text-[11px] text-ink-45">Now means the block your transaction lands in.</span>
          {startMode === "later" ? (
            <Field label="Opens at">
              <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} className={FIELD} />
            </Field>
          ) : null}
        </div>
        <div className="tablet:col-span-2">
          {pending ? (
            <>
              <button type="button" disabled className="flex h-11 w-full cursor-wait items-center justify-center gap-[10px] bg-[rgba(244,238,218,0.55)] font-mono text-[11px] uppercase tracking-[0.22em] text-onlight">
                <Spinner dark />
                Confirm in wallet
              </button>
              <div className="mt-2 text-center font-mono text-[10.5px] text-ink-50">Waiting for your signature.</div>
            </>
          ) : reason ? (
            <>
              <button type="submit" disabled className="h-11 w-full cursor-not-allowed border border-hairline-mid bg-[rgba(244,238,218,0.06)] font-mono text-[11px] uppercase tracking-[0.22em] text-ink-34">
                Create the raise
              </button>
              <div className="mt-2 text-center font-mono text-[10.5px] text-ink-50">{reason}</div>
            </>
          ) : (
            <button type="submit" className="h-11 w-full bg-chalk font-mono text-[11px] uppercase tracking-[0.22em] text-onlight hover:bg-white">
              Create the raise
            </button>
          )}
        </div>
      </form>
      <section aria-label="Summary" className="w-full flex-none border border-hairline p-4 twocol:w-[360px]">
        <div className="font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-40">At success</div>
        <Row label="Opening price" value={quote && targetRaw > 0n ? `${fmtQuote(price)} ${quote.symbol}${inUsd(price)}` : "Enter a target"} />
        <Row label="Tokens per unit" value={quote && targetRaw > 0n ? `${fmtAmt(perUnit, 0)} ${ticker} per ${quote.symbol}` : "Enter a target"} />
        <Row
          label="Pool depth"
          value={quote && targetRaw > 0n ? `${fmtAmt(rawToNumber(split.net, quote.decimals))} ${quote.symbol} and ${fmtAmt(rawToNumber(poolTokens, 18), 0)} ${ticker}` : "Enter a target"}
        />
        <Row label="Launch fee" value={quote && feeBps !== null && targetRaw > 0n ? `${feeBps / 100}% · ${fmtAmt(rawToNumber(split.fee, quote.decimals))} ${quote.symbol}` : feeBps === null ? "Reading the fee" : "Enter a target"} />
        <Row label="Per-wallet cap" value={quote && targetRaw > 0n ? `${fmtAmt(rawToNumber(targetRaw / 10n, quote.decimals))} ${quote.symbol} per wallet` : "10% of the target"} />
        <div className="mt-3 text-[11.5px] leading-[1.5] text-ink-45">
          Everyone pays the same price. At success the token is deployed, the pool opens at that price with the whole raise after the fee, and its liquidity is locked. If the raise misses its floor, everyone is refunded in full.
        </div>
      </section>
    </div>
  );
}
```

Create `src/app/launch/new/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import CreateRaiseForm from "@/components/CreateRaiseForm";

export const metadata: Metadata = { title: "Create a raise" };

export default function NewRaisePage() {
  return (
    <section className="px-4 pb-8 tablet:px-5 desktop:px-6">
      <Link href="/launch" className="mt-[14px] inline-block font-mono text-[10px] uppercase tracking-[0.2em] text-ink-45 hover:text-ink">
        ← Launch
      </Link>
      <div className="mt-[10px] flex items-baseline gap-[14px]">
        <h1 className="text-[18px] font-medium tracking-[-0.01em]">Create a raise</h1>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-40">One transaction</span>
      </div>
      <CreateRaiseForm />
    </section>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/CreateRaiseForm.test.tsx src/lib/suits.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/suits.ts src/components/CreateRaiseForm.tsx src/components/CreateRaiseForm.test.tsx src/app/launch/new/page.tsx
git commit -m "Launchpad: /launch/new, the create form with its live summary and the gate message"
```

---

### Task 11: `/launch/[id]`, the raise page with every status branch

**Files:**
- Create: `src/components/RaiseView.tsx`, `src/components/RaiseView.test.tsx`
- Create: `src/app/launch/[id]/page.tsx`

**Interfaces:**
- Consumes: `useLaunch` (with its `indexing` flag), `keys` (Task 7), `contribute`, `finalizeRaise`, `claimTokens`, `claimCreator`, `refundContribution`, `collectFees`, the error classes (Task 8), `RaiseProgress`, `Countdown`, `raisedOfTarget` (Task 9), `pctOf`, `rawToNumber`, `remainingAllowance`, `presalePrice`, `creatorClaimable`, `feesCollected` (Task 9), `hasLaunchpad`, `addressUrl` (`src/lib/chain.ts`), `toBase` (`src/lib/quote/math.ts`), `Spinner` (`src/components/ui.tsx`), viem's `erc20Abi` (as `useTokenBalance.ts` does).
- Produces: `export default function RaiseView({ id }: { id: number }): ReactElement`.

- [ ] **Step 1: Write the failing test**

Create `src/components/RaiseView.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Launch, LaunchView } from "@/lib/types";
import { fireEvent, queryHarness, render, screen, waitFor } from "@/test/dom";
import RaiseView from "./RaiseView";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const TOKEN = "0x000000000000000000000000000000000000000a" as Address;
const NOW_SEC = 1_789_547_000;

const base = {
  id: 7, creator: "0xcccccccccccccccccccccccccccccccccccccccc", payout: "0xcccccccccccccccccccccccccccccccccccccccc", name: "Tailor's Chalk", symbol: "CHALK",
  image: "", website: "https://chalk.test", x: "", telegram: "", quoteId: USDG, quoteSymbol: "USDG", quoteDecimals: 6,
  target: "1000000000", floor: "500000000", raised: "250000000", saleTokens: "450000000000000000000000000",
  targetUsd: 1000, floorUsd: 500, raisedUsd: 250, contributors: 3, startTs: NOW_SEC - 3600, deadlineTs: NOW_SEC + 7200, createdTs: NOW_SEC - 7200,
  launchedAt: 0, closedAt: 0, token: null, poolId: null, sqrtPriceX96: "0", fee: "0", quoteToPool: "0", tokensToPool: "0", tokensBurned: "0", liquidity: "0",
  creatorClaimed: "0", feesCreator0: "0", feesCreator1: "0", feesPlatform0: "0", feesPlatform1: "0", asOf: NOW_SEC,
} as unknown as Launch;
const view = (over: Partial<Launch>, contribution: LaunchView["contribution"] = null): LaunchView => ({ launch: { ...base, ...over }, contribution });

const h = vi.hoisted(() => ({
  state: { address: "0x1111111111111111111111111111111111111111", isConnected: true, addToast: vi.fn(() => 1), updateToast: vi.fn() },
  query: { data: undefined as LaunchView | null | undefined, isPending: false, isError: false, isFetching: false, indexing: false },
  balance: 5_000_000_000n,
  launchpad: true,
  contribute: vi.fn(),
  finalizeRaise: vi.fn(),
  claimTokens: vi.fn(),
  claimCreator: vi.fn(),
  refundContribution: vi.fn(),
  collectFees: vi.fn(),
  wallet: { id: "wallet-client" } as unknown,
  publicClient: { id: "public-client" } as unknown,
}));

vi.mock("@/context/AppState", () => ({ useAppState: () => h.state }));
vi.mock("@/hooks/useMarketsData", () => ({ useLaunch: () => h.query, keys: { launches: ["launches"], launch: (id: number, wallet?: string) => ["launch", id, wallet ?? ""] } }));
vi.mock("wagmi", () => ({
  usePublicClient: () => h.publicClient,
  useWalletClient: () => ({ data: h.wallet }),
  useReadContract: () => ({ data: h.balance }),
}));
vi.mock("@/lib/chain", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/chain")>()), hasLaunchpad: () => h.launchpad }));
vi.mock("@/lib/launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/launch")>()),
  contribute: h.contribute,
  finalizeRaise: h.finalizeRaise,
  claimTokens: h.claimTokens,
  claimCreator: h.claimCreator,
  refundContribution: h.refundContribution,
  collectFees: h.collectFees,
}));

function show() {
  const { wrapper } = queryHarness();
  return render(<RaiseView id={7} />, { wrapper });
}
const handle = (confirmation: unknown) => ({ hash: "0xdeadbeef", confirmation: Promise.resolve(confirmation) });

describe("RaiseView (design section 1's states, section 7's page)", () => {
  beforeEach(() => {
    h.state = { address: WALLET, isConnected: true, addToast: vi.fn(() => 1), updateToast: vi.fn() };
    h.query = { data: undefined, isPending: false, isError: false, isFetching: false, indexing: false };
    h.balance = 5_000_000_000n;
    h.launchpad = true;
    for (const fn of [h.contribute, h.finalizeRaise, h.claimTokens, h.claimCreator, h.refundContribution, h.collectFees]) fn.mockReset();
  });

  it("scheduled: a countdown to open and the terms, no contribute panel", () => {
    h.query.data = view({ status: "scheduled", startTs: NOW_SEC + 600 });
    show();
    expect(screen.getAllByText("Opens in").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Amount")).toBeNull();
    expect(screen.getByText("Opening price")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Website" }).getAttribute("href")).toBe("https://chalk.test");
  });

  it("open: progress with its floor, contributors, time left, and the contribute panel with the wallet's remaining allowance in 'up to' words", () => {
    h.query.data = view({ status: "open" }, { wallet: WALLET, amount: "30000000", claimedAt: 0, refundedAt: 0 });
    show();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByTitle("Floor at 50%")).toBeTruthy();
    expect(screen.getByText("3 contributors")).toBeTruthy();
    expect(screen.getByText("Ends in")).toBeTruthy();
    // cap 100 USDG, 30 already in: 70 left for this wallet, and the raise has room for 750.
    expect(screen.getByText("Up to 70 USDG more for this wallet.")).toBeTruthy();
    expect(screen.getByText("You put in 30 USDG.")).toBeTruthy();
  });

  it("open: contributes the typed amount as raw units and reports what the contract actually took", async () => {
    h.query.data = view({ status: "open" });
    h.contribute.mockResolvedValue(handle({ amount: 20_000_000n, raised: 270_000_000n }));
    show();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Contribute up to 25 USDG" }));
    await waitFor(() => expect(h.contribute).toHaveBeenCalledWith(7n, USDG, 25_000_000n, { wallet: h.wallet, publicClient: h.publicClient, account: WALLET }));
    await waitFor(() => expect(h.state.updateToast).toHaveBeenCalledWith(1, { kind: "confirmed", message: "Put in 20 USDG. The raise took what still fit." }));
  });

  it("open: the button explains a missing wallet, a missing amount, a balance too small and a cap already reached", () => {
    h.query.data = view({ status: "open" }, { wallet: WALLET, amount: "100000000", claimedAt: 0, refundedAt: 0 });
    const first = show();
    expect(screen.getByText("This wallet is at its 10% cap for this raise.")).toBeTruthy();
    first.unmount();
    h.query.data = view({ status: "open" });
    h.balance = 1_000_000n;
    const second = show();
    expect(screen.getByText("Enter an amount.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
    expect(screen.getByText("Insufficient USDG balance.")).toBeTruthy();
    second.unmount();
    h.state.isConnected = false;
    show();
    expect(screen.getByText("Connect a wallet to contribute.")).toBeTruthy();
  });

  it("launchable: anyone can press Launch now", async () => {
    h.query.data = view({ status: "launchable", raised: "1000000000", raisedUsd: 1000 });
    h.finalizeRaise.mockResolvedValue(handle({ token: TOKEN, poolId: "0xab" }));
    show();
    expect(screen.getAllByText("Ready to launch").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Launch now" }));
    await waitFor(() => expect(h.finalizeRaise).toHaveBeenCalledWith(7n, { wallet: h.wallet, publicClient: h.publicClient, account: WALLET }));
    await waitFor(() => expect(h.state.updateToast).toHaveBeenCalledWith(1, { kind: "confirmed", message: "CHALK launched. Its pool is open." }));
  });

  it("launched: links to the token page and offers Claim to a wallet that contributed and has not claimed", async () => {
    h.query.data = view({ status: "launched", token: TOKEN, launchedAt: NOW_SEC - 100, raised: "1000000000" }, { wallet: WALLET, amount: "30000000", claimedAt: 0, refundedAt: 0 });
    h.claimTokens.mockResolvedValue(handle({ amount: 13_500_000n * 10n ** 18n }));
    show();
    expect(screen.getAllByText("Launched").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Open CHALK" }).getAttribute("href")).toBe(`/t/${TOKEN}`);
    fireEvent.click(screen.getByRole("button", { name: "Claim 13,500,000 CHALK" }));
    await waitFor(() => expect(h.claimTokens).toHaveBeenCalledWith(7n, expect.anything()));
    await waitFor(() => expect(h.state.updateToast).toHaveBeenCalledWith(1, { kind: "confirmed", message: "Claimed 13,500,000 CHALK." }));
  });

  it("launched: says so once claimed, and offers nothing to a wallet that never contributed", () => {
    h.query.data = view({ status: "launched", token: TOKEN, launchedAt: NOW_SEC - 100 }, { wallet: WALLET, amount: "30000000", claimedAt: NOW_SEC - 50, refundedAt: 0 });
    const first = show();
    expect(screen.getByText("You claimed your CHALK.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Claim/ })).toBeNull();
    first.unmount();
    h.query.data = view({ status: "launched", token: TOKEN, launchedAt: NOW_SEC - 100 });
    show();
    expect(screen.getByText("This wallet did not contribute.")).toBeTruthy();
  });

  it("failed: explains the floor and offers Refund to a wallet with a live contribution", async () => {
    h.query.data = view({ status: "failed", deadlineTs: NOW_SEC - 10, raised: "250000000" }, { wallet: WALLET, amount: "30000000", claimedAt: 0, refundedAt: 0 });
    h.refundContribution.mockResolvedValue(handle({ amount: 30_000_000n }));
    show();
    expect(screen.getAllByText("Did not reach its floor").length).toBeGreaterThan(0);
    expect(screen.getByText("It raised $250 of the $500 floor by its deadline, so nothing launched and every contribution can be taken back in full.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refund 30 USDG" }));
    await waitFor(() => expect(h.refundContribution).toHaveBeenCalledWith(7n, expect.anything()));
    await waitFor(() => expect(h.state.updateToast).toHaveBeenCalledWith(1, { kind: "confirmed", message: "Refunded 30 USDG." }));
  });

  it("failed: says so once refunded", () => {
    h.query.data = view({ status: "failed", deadlineTs: NOW_SEC - 10 }, { wallet: WALLET, amount: "30000000", claimedAt: 0, refundedAt: NOW_SEC - 5 });
    show();
    expect(screen.getByText("Your 30 USDG were refunded.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Refund/ })).toBeNull();
  });

  it("failed by the stall valve: says the launch could not happen in time, and still offers Refund", () => {
    h.query.data = view({ status: "failed", deadlineTs: NOW_SEC - 8 * 86_400, raised: "900000000", raisedUsd: 900 }, { wallet: WALLET, amount: "30000000", claimedAt: 0, refundedAt: 0 });
    show();
    expect(screen.getByText("It met its floor but could not be launched within 7 days of its deadline, so refunds are open.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refund 30 USDG" })).toBeTruthy();
  });

  it("launched: the connected creator sees Claim creator tokens with the amount vested so far, and claims it", async () => {
    // 100M creator tokens vest over 90 days: half at day 45, and 20M of that were claimed already.
    h.query.data = view({ status: "launched", token: TOKEN, launchedAt: NOW_SEC - 45 * 86_400, creator: WALLET, creatorClaimed: "20000000000000000000000000" });
    h.claimCreator.mockResolvedValue(handle({ amount: 30_000_000n * 10n ** 18n }));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Claim creator tokens: 30,000,000 CHALK" }));
    await waitFor(() => expect(h.claimCreator).toHaveBeenCalledWith(7n, { wallet: h.wallet, publicClient: h.publicClient, account: WALLET }));
    await waitFor(() => expect(h.state.updateToast).toHaveBeenCalledWith(1, { kind: "confirmed", message: "Claimed 30,000,000 CHALK of creator tokens." }));
  });

  it("launched: nobody but the creator sees the creator button, and everyone sees Collect fees with the totals so far", async () => {
    h.query.data = view({
      status: "launched", token: TOKEN, launchedAt: NOW_SEC - 100,
      feesCreator0: "7000000000000000000000", feesPlatform0: "3000000000000000000000", feesCreator1: "70000000", feesPlatform1: "30000000",
    });
    h.collectFees.mockResolvedValue(handle({ creator0: 700n * 10n ** 18n, creator1: 7_000_000n, platform0: 300n * 10n ** 18n, platform1: 3_000_000n }));
    show();
    expect(screen.queryByRole("button", { name: /Claim creator tokens/ })).toBeNull();
    // TOKEN sorts below USDG's address, so the token is currency0: side 0 is CHALK, side 1 is USDG.
    expect(screen.getByText(/10,000 CHALK and 100 USDG/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
    await waitFor(() => expect(h.collectFees).toHaveBeenCalledWith(7n, expect.anything()));
    await waitFor(() => expect(h.state.updateToast).toHaveBeenCalledWith(1, { kind: "confirmed", message: "Collected 1,000 CHALK and 10 USDG in fees." }));
  });

  it("renders a skeleton while loading, 'being indexed' while a young raise is still polled, and a plain note for an unknown raise", () => {
    h.query = { data: undefined, isPending: true, isError: false, isFetching: true, indexing: false };
    const first = show();
    expect(screen.getByLabelText("Loading raise")).toBeTruthy();
    first.unmount();
    h.query = { data: null, isPending: false, isError: false, isFetching: false, indexing: true };
    const second = show();
    expect(screen.getByText("Your raise is being indexed.")).toBeTruthy();
    expect(screen.getByText("This takes up to a minute.")).toBeTruthy();
    second.unmount();
    h.query = { data: null, isPending: false, isError: false, isFetching: false, indexing: false };
    show();
    expect(screen.getByText("No raise with id 7.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/RaiseView.test.tsx`
Expected: FAIL with "Cannot find module './RaiseView'".

- [ ] **Step 3: Write the raise page**

Create `src/components/RaiseView.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { erc20Abi } from "viem";
import { usePublicClient, useReadContract, useWalletClient } from "wagmi";
import { useAppState } from "@/context/AppState";
import { keys, useLaunch } from "@/hooks/useMarketsData";
import { addressUrl, hasLaunchpad, robinhoodChain } from "@/lib/chain";
import { fmtAmt, fmtHHMM, fmtISODate, fmtInt, fmtQuote, fmtUsd, short } from "@/lib/format";
import {
  LaunchFailedError,
  LaunchRejectedError,
  LaunchUnconfirmedError,
  claimCreator,
  claimTokens,
  collectFees,
  contribute,
  finalizeRaise,
  refundContribution,
  type LaunchDeps,
  type LaunchHandle,
} from "@/lib/launch";
import { creatorClaimable, feesCollected, pctOf, presalePrice, rawToNumber, remainingAllowance } from "@/lib/launch/math";
import { toBase } from "@/lib/quote/math";
import type { Address, Launch, LaunchContribution } from "@/lib/types";
import Countdown from "./Countdown";
import { raisedOfTarget } from "./LaunchList";
import RaiseProgress from "./RaiseProgress";
import { Avatar, Spinner } from "./ui";

const GUTTER = "px-4 pb-4 tablet:px-5 tablet:pb-5 desktop:px-6 desktop:pb-6";
const AMOUNT_RE = /^\d*\.?\d*$/;
const PRIMARY = "mt-[14px] h-11 w-full bg-chalk font-mono text-[11px] uppercase tracking-[0.22em] text-onlight hover:bg-white";
const DISABLED = "mt-[14px] h-11 w-full cursor-not-allowed border border-hairline-mid bg-[rgba(244,238,218,0.06)] font-mono text-[11px] uppercase tracking-[0.22em] text-ink-34";
const PENDING = "mt-[14px] flex h-11 w-full cursor-wait items-center justify-center gap-[10px] bg-[rgba(244,238,218,0.55)] font-mono text-[11px] uppercase tracking-[0.22em] text-onlight";
const REASON = "mt-2 text-center font-mono text-[10.5px] text-ink-50";

function BackLink() {
  return (
    <Link href="/launch" className="mt-[14px] inline-block font-mono text-[10px] uppercase tracking-[0.2em] text-ink-45 hover:text-ink">
      ← Launch
    </Link>
  );
}

function Row({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-hairline-soft py-[11px] font-mono text-[12px] tabular-nums">
      <span className="flex-none text-[10px] uppercase tracking-[0.16em] text-ink-40">{label}</span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="truncate text-right text-ink-70 hover:text-ink">{value}</a>
      ) : (
        <span className="truncate text-right">{value}</span>
      )}
    </div>
  );
}

function Card({ kicker, title, children }: { kicker: string; title: string; children?: ReactNode }) {
  return (
    <div className="border border-hairline px-[22px] py-[34px] text-center">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-40">{kicker}</div>
      <div className="mb-2 mt-3 text-[17px]">{title}</div>
      {children}
    </div>
  );
}

/** A wallet write's toast flow, shared by the four actions: pending, hash, confirmed; or unconfirmed / failed. */
function useAction() {
  const { addToast, updateToast } = useAppState();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const run = async <T,>(id: number, pendingMessage: string, write: () => Promise<LaunchHandle<T>>, done: (result: T) => string, fallback: string) => {
    setPending(true);
    const toastId = addToast({ kind: "pending", message: pendingMessage });
    try {
      const handle = await write();
      updateToast(toastId, { hash: handle.hash });
      const result = await handle.confirmation;
      updateToast(toastId, { kind: "confirmed", message: done(result) });
      void qc.invalidateQueries({ queryKey: ["launch", id] });
      void qc.invalidateQueries({ queryKey: keys.launches });
      void qc.invalidateQueries({ queryKey: ["readContract"] });
    } catch (err) {
      if (err instanceof LaunchUnconfirmedError) updateToast(toastId, { kind: "unconfirmed", message: err.message });
      else updateToast(toastId, { kind: "failed", message: err instanceof LaunchRejectedError || err instanceof LaunchFailedError ? err.message : fallback });
    } finally {
      setPending(false);
    }
  };
  return { pending, run };
}

function ActionButton({ label, reason, pending, onClick }: { label: string; reason: string; pending: boolean; onClick: () => void }) {
  if (pending) {
    return (
      <>
        <button type="button" disabled className={PENDING}><Spinner dark />Confirm in wallet</button>
        <div className={REASON}>Waiting for your signature.</div>
      </>
    );
  }
  if (reason) {
    return (
      <>
        <button type="button" disabled className={DISABLED}>{label}</button>
        <div className={REASON}>{reason}</div>
      </>
    );
  }
  return <button type="button" onClick={onClick} className={PRIMARY}>{label}</button>;
}

function walletReason(isConnected: boolean, deps: LaunchDeps | null, verb: string): string {
  if (!hasLaunchpad()) return "Raises go live when the launchpad is deployed.";
  if (!isConnected) return `Connect a wallet to ${verb}.`;
  if (!deps) return "Connecting to your wallet…";
  return "";
}

function ContributePanel({ launch, mine, deps, isConnected }: { launch: Launch; mine: LaunchContribution | null; deps: LaunchDeps | null; isConnected: boolean }) {
  const { pending, run } = useAction();
  const [amount, setAmount] = useState("");
  const balance = useReadContract({
    address: launch.quoteId, abi: erc20Abi, functionName: "balanceOf", args: deps ? [deps.account] : undefined, chainId: robinhoodChain.id,
    query: { enabled: Boolean(deps) },
  });
  const target = BigInt(launch.target);
  const allowance = remainingAllowance(target, BigInt(launch.raised), BigInt(mine?.amount ?? "0"));
  const allowanceNum = rawToNumber(allowance, launch.quoteDecimals);
  const amountNum = parseFloat(amount) || 0;
  let amountRaw = 0n;
  try {
    amountRaw = amount && AMOUNT_RE.test(amount) ? toBase(amount, launch.quoteDecimals) : 0n;
  } catch {
    amountRaw = 0n;
  }
  const balanceRaw = balance.data ?? 0n;

  let reason = walletReason(isConnected, deps, "contribute");
  if (!reason) {
    if (allowance === 0n) reason = BigInt(launch.raised) >= target ? "The raise is full." : "This wallet is at its 10% cap for this raise.";
    else if (!(amountNum > 0) || amountRaw <= 0n) reason = "Enter an amount.";
    else if (amountRaw > balanceRaw) reason = `Insufficient ${launch.quoteSymbol} balance.`;
  }
  const label = `Contribute up to ${fmtAmt(amountNum)} ${launch.quoteSymbol}`;
  return (
    <div className="border border-hairline p-4">
      <div className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-ink-45">
        <span>You put in</span>
        <span className="normal-case tracking-[0.04em] tabular-nums">Balance {fmtAmt(rawToNumber(balanceRaw, launch.quoteDecimals))} {launch.quoteSymbol}</span>
      </div>
      <div className="mt-2 flex h-[52px] items-center border border-hairline-strong focus-within:border-hairline-focus">
        <input
          value={amount}
          onChange={(e) => { if (AMOUNT_RE.test(e.target.value)) setAmount(e.target.value); }}
          placeholder="0.00"
          inputMode="decimal"
          autoComplete="off"
          aria-label="Amount"
          className="h-full min-w-0 flex-1 bg-transparent px-3 font-mono text-[20px] tabular-nums outline-none"
        />
        <span className="mr-[12px] font-mono text-[11px] text-ink-45">{launch.quoteSymbol}</span>
      </div>
      <div className="mt-2 text-[11.5px] text-ink-50">Up to {fmtAmt(allowanceNum)} {launch.quoteSymbol} more for this wallet.</div>
      <div className="mt-1 text-[11.5px] text-ink-45">The raise takes what still fits under its target and your 10% cap; the rest stays in your wallet.</div>
      {mine && BigInt(mine.amount) > 0n ? <div className="mt-2 font-mono text-[11.5px] tabular-nums">You put in {fmtAmt(rawToNumber(mine.amount, launch.quoteDecimals))} {launch.quoteSymbol}.</div> : null}
      <ActionButton
        label={label}
        reason={reason}
        pending={pending}
        onClick={() => {
          if (!deps) return;
          void run(
            launch.id,
            `Putting up to ${fmtAmt(amountNum)} ${launch.quoteSymbol} into ${launch.symbol}`,
            () => contribute(BigInt(launch.id), launch.quoteId, amountRaw, deps),
            (r) => `Put in ${fmtAmt(rawToNumber(r.amount, launch.quoteDecimals))} ${launch.quoteSymbol}. The raise took what still fit.`,
            "Contribution failed. Nothing was spent.",
          ).then(() => setAmount(""));
        }}
      />
    </div>
  );
}

function LaunchPanel({ launch, deps, isConnected }: { launch: Launch; deps: LaunchDeps | null; isConnected: boolean }) {
  const { pending, run } = useAction();
  return (
    <Card kicker="Ready to launch" title="This raise met its terms">
      <div className="text-pretty text-[12.5px] leading-[1.5] text-ink-50">
        Anyone can launch it. The token, its pool and the locked liquidity are created in that one transaction, and contributors can then claim.
      </div>
      <ActionButton
        label="Launch now"
        reason={walletReason(isConnected, deps, "launch it")}
        pending={pending}
        onClick={() => {
          if (!deps) return;
          void run(launch.id, `Launching ${launch.symbol}`, () => finalizeRaise(BigInt(launch.id), deps), () => `${launch.symbol} launched. Its pool is open.`, "Launching the raise failed. Nothing was spent.");
        }}
      />
    </Card>
  );
}

function LaunchedPanel({ launch, mine, deps, isConnected }: { launch: Launch; mine: LaunchContribution | null; deps: LaunchDeps | null; isConnected: boolean }) {
  const claim = useAction();
  const creator = useAction();
  const fees = useAction();
  // contributed × saleTokens / target: the contract's own claim arithmetic (spec 4.2), for the button's label only.
  const owed = mine ? (BigInt(mine.amount) * BigInt(launch.saleTokens)) / BigInt(launch.target) : 0n;
  const owedText = `${fmtAmt(rawToNumber(owed, 18), 0)} ${launch.symbol}`;
  // The creator's tenth, vested linearly over 90 days from launch, as of the server's clock (design section 7).
  const isCreator = deps !== null && deps.account.toLowerCase() === launch.creator.toLowerCase();
  const creatorOwed = creatorClaimable(launch.launchedAt, launch.asOf, BigInt(launch.creatorClaimed));
  const creatorOwedText = `${fmtAmt(rawToNumber(creatorOwed, 18), 0)} ${launch.symbol}`;
  // Collected so far, by side, from the running sums the reader keeps; collection is permissionless (spec 4.2).
  const collected = feesCollected(launch);
  const feesText = (token: bigint, quote: bigint) =>
    `${fmtAmt(rawToNumber(token, 18), 0)} ${launch.symbol} and ${fmtAmt(rawToNumber(quote, launch.quoteDecimals))} ${launch.quoteSymbol}`;
  return (
    <Card kicker="Launched" title={`${launch.symbol} is live`}>
      {launch.token ? (
        <Link
          href={`/t/${launch.token}`}
          className="mt-2 inline-flex h-[34px] items-center border border-wallet-border px-4 font-mono text-[9.5px] uppercase tracking-[0.22em] hover:border-wallet-border-hover hover:bg-wallet-hover"
        >
          Open {launch.symbol}
        </Link>
      ) : null}
      {!mine || BigInt(mine.amount) === 0n ? (
        <div className="mt-4 text-[12.5px] text-ink-50">This wallet did not contribute.</div>
      ) : mine.claimedAt > 0 ? (
        <div className="mt-4 text-[12.5px] text-ink-50">You claimed your {launch.symbol}.</div>
      ) : (
        <ActionButton
          label={`Claim ${owedText}`}
          reason={walletReason(isConnected, deps, "claim")}
          pending={claim.pending}
          onClick={() => {
            if (!deps) return;
            void claim.run(launch.id, `Claiming ${owedText}`, () => claimTokens(BigInt(launch.id), deps), (r) => `Claimed ${fmtAmt(rawToNumber(r.amount, 18), 0)} ${launch.symbol}.`, "Claiming failed. Nothing was spent.");
          }}
        />
      )}
      {isCreator ? (
        <div className="mt-5 border-t border-hairline pt-4">
          <div className="text-[12.5px] text-ink-50">Your creator tokens vest over 90 days from launch. Vested and not yet claimed: {creatorOwedText}.</div>
          <ActionButton
            label={`Claim creator tokens: ${creatorOwedText}`}
            reason={creatorOwed === 0n ? "Nothing has vested yet." : walletReason(isConnected, deps, "claim")}
            pending={creator.pending}
            onClick={() => {
              if (!deps) return;
              void creator.run(
                launch.id,
                `Claiming ${creatorOwedText} of creator tokens`,
                () => claimCreator(BigInt(launch.id), deps),
                (r) => `Claimed ${fmtAmt(rawToNumber(r.amount, 18), 0)} ${launch.symbol} of creator tokens.`,
                "Claiming the creator tokens failed. Nothing was spent.",
              );
            }}
          />
        </div>
      ) : null}
      <div className="mt-5 border-t border-hairline pt-4">
        <div className="text-[12.5px] text-ink-50">
          Trading fees collected so far: {feesText(collected.token, collected.quote)}. Anyone can collect; each call pays the creator&apos;s payout address and the fee wallet their shares.
        </div>
        <ActionButton
          label="Collect fees"
          reason={walletReason(isConnected, deps, "collect fees")}
          pending={fees.pending}
          onClick={() => {
            if (!deps) return;
            void fees.run(
              launch.id,
              `Collecting ${launch.symbol} fees`,
              () => collectFees(BigInt(launch.id), deps),
              (r) => {
                const paid = feesCollected({
                  token: launch.token, quoteId: launch.quoteId,
                  feesCreator0: r.creator0.toString(), feesCreator1: r.creator1.toString(), feesPlatform0: r.platform0.toString(), feesPlatform1: r.platform1.toString(),
                });
                return `Collected ${feesText(paid.token, paid.quote)} in fees.`;
              },
              "Collecting the fees failed. Nothing was spent.",
            );
          }}
        />
      </div>
    </Card>
  );
}

function FailedPanel({ launch, mine, deps, isConnected }: { launch: Launch; mine: LaunchContribution | null; deps: LaunchDeps | null; isConnected: boolean }) {
  const { pending, run } = useAction();
  // Two ways to fail (spec section 1): under the floor at the deadline, or the stall valve 7 days later on a raise that met it.
  const metFloor = BigInt(launch.raised) >= BigInt(launch.floor);
  const raised = launch.raisedUsd !== null ? fmtUsd(launch.raisedUsd) : `${fmtAmt(rawToNumber(launch.raised, launch.quoteDecimals))} ${launch.quoteSymbol}`;
  const floor = launch.floorUsd !== null ? fmtUsd(launch.floorUsd) : `${fmtAmt(rawToNumber(launch.floor, launch.quoteDecimals))} ${launch.quoteSymbol}`;
  const mineText = mine ? `${fmtAmt(rawToNumber(mine.amount, launch.quoteDecimals))} ${launch.quoteSymbol}` : "";
  return (
    <Card kicker="Did not launch" title="Did not reach its floor">
      <div className="text-pretty text-[12.5px] leading-[1.5] text-ink-50">
        {metFloor
          ? "It met its floor but could not be launched within 7 days of its deadline, so refunds are open."
          : `It raised ${raised} of the ${floor} floor by its deadline, so nothing launched and every contribution can be taken back in full.`}
      </div>
      {!mine || BigInt(mine.amount) === 0n ? (
        <div className="mt-4 text-[12.5px] text-ink-50">This wallet did not contribute.</div>
      ) : mine.refundedAt > 0 ? (
        <div className="mt-4 text-[12.5px] text-ink-50">Your {mineText} were refunded.</div>
      ) : (
        <ActionButton
          label={`Refund ${mineText}`}
          reason={walletReason(isConnected, deps, "take the refund")}
          pending={pending}
          onClick={() => {
            if (!deps) return;
            void run(launch.id, `Refunding ${mineText}`, () => refundContribution(BigInt(launch.id), deps), (r) => `Refunded ${fmtAmt(rawToNumber(r.amount, launch.quoteDecimals))} ${launch.quoteSymbol}.`, "The refund failed. Nothing was spent.");
          }}
        />
      )}
    </Card>
  );
}

function Terms({ launch }: { launch: Launch }) {
  const price = presalePrice(BigInt(launch.target), BigInt(launch.saleTokens), launch.quoteDecimals);
  const when = (ts: number) => `${fmtISODate(ts * 1000)} ${fmtHHMM(ts * 1000)}`;
  return (
    <div className="mt-[18px]">
      <Row label="Opening price" value={`${fmtQuote(price)} ${launch.quoteSymbol} per ${launch.symbol}`} />
      <Row label="Target" value={`${fmtAmt(rawToNumber(launch.target, launch.quoteDecimals))} ${launch.quoteSymbol}${launch.targetUsd !== null ? ` (${fmtUsd(launch.targetUsd)})` : ""}`} />
      <Row label="Floor" value={`${pctOf(launch.floor, launch.target)}% of the target`} />
      <Row label="Per-wallet cap" value={`${fmtAmt(rawToNumber(BigInt(launch.target) / 10n, launch.quoteDecimals))} ${launch.quoteSymbol}`} />
      <Row label="Opens" value={when(launch.startTs)} />
      <Row label="Deadline" value={when(launch.deadlineTs)} />
      <Row label="Creator" value={short(launch.creator)} href={addressUrl(launch.creator)} />
    </div>
  );
}

export default function RaiseView({ id }: { id: number }) {
  const { address, isConnected } = useAppState();
  const publicClient = usePublicClient({ chainId: robinhoodChain.id });
  const { data: walletClient } = useWalletClient({ chainId: robinhoodChain.id });
  const query = useLaunch(id, address as Address | undefined);
  const deps: LaunchDeps | null = address && walletClient && publicClient ? { wallet: walletClient, publicClient, account: address as Address } : null;

  if (query.isPending) {
    return (
      <section className={GUTTER}>
        <BackLink />
        <div aria-busy aria-label="Loading raise" className="border-b border-hairline py-[18px]">
          <span className="skeleton block h-[12px] w-[140px]" />
          <span className="skeleton mt-2 block h-[10px] w-[220px]" />
        </div>
      </section>
    );
  }
  if (!query.data) {
    return (
      <section className={GUTTER}>
        <BackLink />
        <div className="px-4 py-16 text-center">
          {query.indexing ? (
            // A creator lands here straight from the receipt; the hook keeps asking every 5 s for three minutes.
            <>
              <div className="flex items-center justify-center gap-2 text-[16px]"><Spinner />Your raise is being indexed.</div>
              <div className="mt-[6px] text-[12.5px] text-ink-50">This takes up to a minute.</div>
            </>
          ) : (
            <>
              <div className="text-[16px]">No raise with id {id}.</div>
              <div className="mt-[6px] text-[12.5px] text-ink-50">{query.isError ? "It could not be loaded right now." : "It may not be indexed yet, or the id is wrong."}</div>
            </>
          )}
        </div>
      </section>
    );
  }
  const { launch, contribution } = query.data;
  const mine = contribution && BigInt(contribution.amount) > 0n ? contribution : null;

  const timeLine: ReactNode =
    launch.status === "scheduled" ? (
      <><span>Opens in</span> <Countdown to={launch.startTs} /></>
    ) : launch.status === "open" ? (
      <><span>Ends in</span> <Countdown to={launch.deadlineTs} /></>
    ) : launch.status === "launchable" ? (
      "Ready to launch"
    ) : launch.status === "launched" ? (
      "Launched"
    ) : (
      "Did not reach its floor"
    );

  return (
    <section className={GUTTER}>
      <BackLink />
      <div className="flex flex-col gap-[18px] border-b border-hairline py-[18px] hdr:flex-row hdr:items-center hdr:justify-between hdr:gap-6">
        <div className="flex min-w-0 items-center gap-[14px]">
          <Avatar ticker={launch.symbol} logoUrl={launch.image || undefined} size={40} fontSize={14} className="text-ink-80" />
          <div className="min-w-0">
            <div className="flex items-baseline gap-[10px] overflow-hidden whitespace-nowrap">
              <span className="text-[20px] font-medium leading-[1.1] tracking-[-0.01em]">{launch.symbol}</span>
              <span className="truncate text-[13px] text-ink-50">{launch.name}</span>
            </div>
            <div className="mt-[6px] flex flex-wrap items-center gap-[10px] font-mono text-[11px] text-ink-50">
              <span className="text-ink-65">Raise in {launch.quoteSymbol}</span>
              {launch.website ? <a href={launch.website} target="_blank" rel="noreferrer" className="hover:text-ink">Website</a> : null}
              {launch.x ? <a href={launch.x} target="_blank" rel="noreferrer" className="hover:text-ink">X</a> : null}
              {launch.telegram ? <a href={launch.telegram} target="_blank" rel="noreferrer" className="hover:text-ink">Telegram</a> : null}
              <a href={addressUrl(launch.creator)} target="_blank" rel="noreferrer" className="hover:text-ink">by {short(launch.creator)}</a>
            </div>
          </div>
        </div>
        <div className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-50">{timeLine}</div>
      </div>
      <div className="mt-5 flex flex-col gap-6 twocol:flex-row twocol:items-start twocol:gap-8">
        <div className="order-2 w-full min-w-0 flex-1 twocol:order-1">
          <div className="flex items-baseline justify-between font-mono text-[13px] tabular-nums">
            <span>{raisedOfTarget(launch)}</span>
            <span className="text-ink-45">{fmtInt(launch.contributors)} contributor{launch.contributors === 1 ? "" : "s"}</span>
          </div>
          <div className="mt-2">
            <RaiseProgress raisedPct={pctOf(launch.raised, launch.target)} floorPct={pctOf(launch.floor, launch.target)} />
          </div>
          <Terms launch={launch} />
        </div>
        <div className="order-1 w-full flex-none twocol:order-2 twocol:w-[360px]">
          {launch.status === "scheduled" ? (
            <Card kicker="Scheduled" title="Not open yet">
              <div className="text-[12.5px] text-ink-50">Contributions open in <Countdown to={launch.startTs} />.</div>
            </Card>
          ) : launch.status === "open" ? (
            <ContributePanel launch={launch} mine={mine} deps={deps} isConnected={isConnected} />
          ) : launch.status === "launchable" ? (
            <LaunchPanel launch={launch} deps={deps} isConnected={isConnected} />
          ) : launch.status === "launched" ? (
            <LaunchedPanel launch={launch} mine={mine} deps={deps} isConnected={isConnected} />
          ) : (
            <FailedPanel launch={launch} mine={mine} deps={deps} isConnected={isConnected} />
          )}
        </div>
      </div>
    </section>
  );
}
```

Create `src/app/launch/[id]/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import RaiseView from "@/components/RaiseView";

interface Props {
  params: Promise<{ id: string }>;
}

/** The same shape the route accepts: a positive integer with no leading zero, at most nine digits. */
const ID = /^[1-9]\d{0,8}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Raise ${id}` };
}

export default async function RaisePage({ params }: Props) {
  const { id } = await params;
  if (!ID.test(id)) {
    return (
      <section className="px-4 pb-8 tablet:px-5 desktop:px-6">
        <Link href="/launch" className="mt-[14px] inline-block font-mono text-[10px] uppercase tracking-[0.2em] text-ink-45 hover:text-ink">
          ← Launch
        </Link>
        <div className="px-4 py-16 text-center">
          <div className="text-[16px]">No raise at this address.</div>
          <div className="mt-[6px] text-[12.5px] text-ink-50">A raise is numbered from 1.</div>
        </div>
      </section>
    );
  }
  return <RaiseView id={Number(id)} />;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/RaiseView.test.tsx src/components/LaunchList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/RaiseView.tsx src/components/RaiseView.test.tsx src/app/launch/[id]/page.tsx
git commit -m "Launchpad: /launch/[id], the raise page with contribute, launch now, claim, refund, the creator's claim and fee collection by status"
```

---

### Task 12: The token page chip, the `SV` badge tooltip and filter entry, and the `Launch` nav item

**Files:**
- Modify: `src/lib/types.ts:65-102` (`TokenPair` gains `launchId?: number`)
- Modify: `src/lib/market/dbShape.ts:4-19` (`PairRow.launch_id`, the left join) and `:37-67` (`pairFromRow`)
- Modify: `src/lib/market/dbShape.test.ts:7-15` (the fixture) and append one describe
- Modify: `src/lib/market/dbBackend.test.ts` (append one `it` inside `describe("createDbBackend reads", …)`)
- Create: `src/components/OriginBadge.tsx`, `src/components/OriginBadge.test.tsx`
- Modify: `src/components/TokenHeader.tsx:3-14` (imports) and `:55-68` (the badge line, the chip)
- Create: `src/components/TokenHeader.test.tsx`
- Modify: `src/components/PairsTable.tsx:18` (import) and `:188-190` (the badge)
- Modify: `src/lib/markets.ts:36-45` (`ORIGIN_OPTIONS`)
- Modify: `src/components/TopBar.tsx:10-14` (`NAV`) and the four `pathname === n.href` tests (lines 67-68 and 102-103)
- Create: `src/components/TopBar.test.tsx`

**Interfaces:**
- Consumes: `Badge` (`src/components/ui.tsx:28`), `Origin`, `TokenPair` (`src/lib/types.ts`), `PAIR_SELECT`, `pairFromRow` (`src/lib/market/dbShape.ts`).
- Produces:
  ```ts
  // src/lib/types.ts
  interface TokenPair { …; /** The raise this token launched from (market.presales.id); absent for every other token. */ launchId?: number }
  // src/components/OriginBadge.tsx
  export const SV_TOOLTIP = "Launched on LongMarkets";
  export default function OriginBadge({ origin }: { origin: Origin }): ReactElement;
  // src/lib/markets.ts: ORIGIN_OPTIONS gains { key: "SV", label: "SV" } before OTHER
  // src/components/TopBar.tsx: NAV gains { href: "/launch", label: "Launch" }; a nav item is active on its own path and any path beneath it
  ```

- [ ] **Step 1: Write the failing tests**

Edit `src/lib/market/dbShape.test.ts`: add `launch_id: null,` to the `row` fixture (after `routable: null,` on line 13) and append:

```ts
describe("pairFromRow launchId (launchpad design, section 7)", () => {
  it("carries the raise id when market.presales has the token, and no key at all otherwise", () => {
    expect(pairFromRow({ ...row, launch_id: 7 }, undefined, NOW).launchId).toBe(7);
    expect("launchId" in pairFromRow({ ...row, launch_id: null }, undefined, NOW)).toBe(false);
  });
});
```

Append inside `describe("createDbBackend reads", …)` of `src/lib/market/dbBackend.test.ts` (before its closing `});`), which already has `db`, `backend`, `A`, `NOW` and the seeded listed tokens in scope:

```ts
  it("pair() carries the raise id for a token market.presales knows (launchpad design, section 7), and nothing for the rest", async () => {
    await db.query(
      `insert into market.presales (id, creator, payout, quote_id, token_id, target, floor, sale_tokens, start_ts, deadline_ts, created_ts, created_block, updated_at)
       values (1, '0xc', '0xc', $1, $2, 1, 1, 1, $3, $3, $3, 1, $3)`,
      [NVDA, A, NOW - 100],
    );
    try {
      expect((await backend().pair(A))?.launchId).toBe(1);
      expect("launchId" in ((await backend().pair(B)) ?? {})).toBe(false);
    } finally {
      await db.query("delete from market.presales where id = 1");
    }
  });
```

Create `src/components/OriginBadge.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@/test/dom";
import OriginBadge, { SV_TOOLTIP } from "./OriginBadge";

describe("OriginBadge", () => {
  it("prints the origin upper-cased with no tooltip for every origin but SV", () => {
    render(<OriginBadge origin="Pons" />);
    expect(screen.getByText("PONS")).toBeTruthy();
    fireEvent.mouseEnter(screen.getByText("PONS"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows 'Launched on LongMarkets' on hover and on focus for SV (launchpad design, section 7)", () => {
    render(<OriginBadge origin="SV" />);
    const badge = screen.getByText("SV");
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(badge);
    expect(screen.getByRole("tooltip").textContent).toBe(SV_TOOLTIP);
    fireEvent.mouseLeave(badge);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(badge.parentElement!);
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });
});
```

Create `src/components/TokenHeader.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import type { TokenPair } from "@/lib/types";
import { render, screen } from "@/test/dom";
import TokenHeader from "./TokenHeader";

vi.mock("@/context/AppState", () => ({
  useAppState: () => ({ stars: new Set<string>(), toggleStar: vi.fn(), votes: {}, vote: vi.fn(), votePending: new Set<string>() }),
}));

const pair = {
  id: "0x000000000000000000000000000000000000000a", ticker: "CHALK", name: "Tailor's Chalk", address: "0x000000000000000000000000000000000000000a",
  quote: "USDG", origin: "SV", priceUsd: 0.01, priceQuote: 0.01, change24h: 1.5, bull: 0, bear: 0,
} as TokenPair;

describe("TokenHeader launchpad chip (design section 7)", () => {
  it("links 'Launched on LongMarkets' to the raise beside the SV badge when the token came from one", () => {
    render(<TokenHeader pair={{ ...pair, launchId: 7 }} />);
    expect(screen.getByRole("link", { name: "Launched on LongMarkets" }).getAttribute("href")).toBe("/launch/7");
    expect(screen.getByText("SV")).toBeTruthy();
  });

  it("shows no chip for a token with no raise", () => {
    render(<TokenHeader pair={pair} />);
    expect(screen.queryByRole("link", { name: "Launched on LongMarkets" })).toBeNull();
  });
});
```

Create `src/components/TopBar.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/dom";
import TopBar from "./TopBar";

const h = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname, useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/context/AppState", () => ({ useAppState: () => ({ filters: { query: "" }, setQuery: vi.fn() }) }));
vi.mock("./WalletButton", () => ({ default: () => null }));
// `SuitsMark` wraps `next/image`, which no test in the repo renders under jsdom; the mark is not what this test checks.
vi.mock("./ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui")>()),
  SuitsMark: () => <span aria-hidden data-testid="suits-mark" />,
}));

describe("TopBar nav (launchpad design, section 7)", () => {
  beforeEach(() => {
    h.pathname = "/";
  });

  it("carries a Launch item in both navs, pointing at /launch", () => {
    render(<TopBar />);
    const links = screen.getAllByRole("link", { name: "Launch" });
    expect(links).toHaveLength(2); // the tablet-and-up nav and the phone row
    for (const link of links) expect(link.getAttribute("href")).toBe("/launch");
  });

  it("marks Launch current on /launch and beneath it, and Markets only on / itself", () => {
    h.pathname = "/launch/7";
    const { unmount } = render(<TopBar />);
    for (const link of screen.getAllByRole("link", { name: "Launch" })) expect(link.getAttribute("aria-current")).toBe("page");
    for (const link of screen.getAllByRole("link", { name: "Markets" })) expect(link.getAttribute("aria-current")).toBeNull();
    unmount();
    h.pathname = "/";
    render(<TopBar />);
    for (const link of screen.getAllByRole("link", { name: "Markets" })) expect(link.getAttribute("aria-current")).toBe("page");
    for (const link of screen.getAllByRole("link", { name: "Launch" })) expect(link.getAttribute("aria-current")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/market/dbShape.test.ts src/lib/market/dbBackend.test.ts src/components/OriginBadge.test.tsx src/components/TokenHeader.test.tsx src/components/TopBar.test.tsx`
Expected: FAIL: `launchId` undefined, `./OriginBadge` missing, no chip, one "Launch" link short.

- [ ] **Step 3: Write the changes**

Edit `src/lib/types.ts`: inside `TokenPair`, after `feeTier: string;` (line 101) add:

```ts
  /** The raise this token launched from (market.presales.id, launchpad design section 7); absent for every other token. */
  launchId?: number;
```

Edit `src/lib/market/dbShape.ts`. In `PairRow` (lines 4-9) add `launch_id: number | null;` after `routable: boolean | null;`. Replace `PAIR_SELECT` (lines 12-19) with:

```ts
/** One row per listed token. numeric(78,0) columns are cast to text so both drivers hand back strings. The presale join is a left join: only a launched token has a row there (design section 7's chip). */
export const PAIR_SELECT = `
select t.id, t.symbol, t.name, t.address, t.decimals, t.total_supply::text as total_supply, t.holders_count,
  p.id as pool_id, p.quote_id, p.origin as pool_origin, p.hooks, p.fee, p.created_at as pool_created_at,
  p.price_quote, p.tvl_token::text as tvl_token, p.tvl_quote::text as tvl_quote, p.routable,
  q.symbol as quote_symbol, q.decimals as quote_decimals, q.usd_price, q.usd_updated_at, q.aggregator,
  ps.id as launch_id
from market.tokens t
join market.pools p on p.id = t.listed_pool_id
join market.quotes q on q.id = p.quote_id
left join market.presales ps on ps.token_id = t.id`;
```

In `pairFromRow`'s returned literal, after `feeTier: feeTierLabel(row.fee),` add:

```ts
    // Only when present: the M1 parity check compares this shape with shapePairs(), which knows no raises.
    ...(row.launch_id === null ? {} : { launchId: row.launch_id }),
```

Create `src/components/OriginBadge.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { Origin } from "@/lib/types";
import { Badge } from "./ui";

export const SV_TOOLTIP = "Launched on LongMarkets";

/**
 * The origin badge, printed upper-cased exactly as before. An SV badge alone carries a tooltip (launchpad
 * design, section 7), in the same hover pattern as WalletButton's holder badge, and reachable by keyboard.
 */
export default function OriginBadge({ origin }: { origin: Origin }) {
  const [tip, setTip] = useState(false);
  if (origin !== "SV") return <Badge>{origin.toUpperCase()}</Badge>;
  return (
    <span
      className="relative inline-flex"
      tabIndex={0}
      onMouseEnter={() => setTip(true)}
      onMouseLeave={() => setTip(false)}
      onFocus={() => setTip(true)}
      onBlur={() => setTip(false)}
    >
      <Badge>SV</Badge>
      {tip ? (
        <span
          role="tooltip"
          className="absolute left-0 top-[18px] z-[5] whitespace-nowrap border border-hairline-strong bg-panel px-[9px] py-[6px] text-[9.5px] normal-case tracking-[0.06em] text-ink"
        >
          {SV_TOOLTIP}
        </span>
      ) : null}
    </span>
  );
}
```

Edit `src/components/TokenHeader.tsx`. Add `import Link from "next/link";` after line 3, replace line 13 (`import { Avatar, Badge } from "./ui";`) with:

```ts
import OriginBadge from "./OriginBadge";
import { Avatar } from "./ui";
```

and replace line 59 (`<Badge>{pair.origin.toUpperCase()}</Badge>`) with:

```tsx
            <OriginBadge origin={pair.origin} />
            {pair.launchId !== undefined ? (
              <Link
                href={`/launch/${pair.launchId}`}
                className="inline-block border border-hairline-strong px-[6px] py-px font-mono text-[8.5px] leading-[1.3] tracking-[0.14em] text-chalk hover:border-hairline-hover"
              >
                Launched on LongMarkets
              </Link>
            ) : null}
```

Edit `src/components/PairsTable.tsx`. Replace line 18 (`import { Avatar, Badge } from "./ui";`) with:

```ts
import OriginBadge from "./OriginBadge";
import { Avatar } from "./ui";
```

and line 189 (`<Badge>{pad}</Badge>`) with `<OriginBadge origin={pair.origin} />`. (`pad` stays: the phone sub-line at line 194 still prints it.)

Edit `src/lib/markets.ts` lines 36-45. Replace with:

```ts
export const ORIGIN_OPTIONS: ReadonlyArray<{
  key: OriginFilter;
  label: string;
}> = [
  { key: "all", label: "All" },
  { key: "LONG", label: "LONG" },
  { key: "Pons", label: "PONS" },
  { key: "Uniswap", label: "UNISWAP" },
  // Tokens launched here (launchpad design, section 7). Their badge prints the value as is, like every other.
  { key: "SV", label: "SV" },
  { key: "Other", label: "OTHER" },
];
```

Edit `src/components/TopBar.tsx`. Replace lines 10-14 with:

```ts
const NAV = [
  { href: "/", label: "Markets" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/traders", label: "Traders" },
  { href: "/launch", label: "Launch" },
] as const;

/** A nav item is current on its own path and on any path beneath it (/launch/new, /launch/7); Markets only on / itself. */
function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
```

Then replace both `navClass(pathname === n.href)` occurrences (lines 67 and 102) with `navClass(isActive(pathname, n.href))` and both `aria-current={pathname === n.href ? "page" : undefined}` occurrences (lines 68 and 103) with `aria-current={isActive(pathname, n.href) ? "page" : undefined}`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/market src/components src/app`
Expected: PASS. (`dbBackend.test.ts`'s parity against `shapePairs()` still holds: `launchId` is omitted, not `undefined`, when there is no raise.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/market/dbShape.ts src/lib/market/dbShape.test.ts src/lib/market/dbBackend.test.ts src/components/OriginBadge.tsx src/components/OriginBadge.test.tsx src/components/TokenHeader.tsx src/components/TokenHeader.test.tsx src/components/PairsTable.tsx src/lib/markets.ts src/components/TopBar.tsx src/components/TopBar.test.tsx
git commit -m "Launchpad: the token page's raise chip, the SV badge tooltip and filter, and the Launch nav item"
```

---

### Task 13: Health's `presaleEvents`, the quotes JSON script, and the README sections

**Files:**
- Modify: `src/lib/market/backend.ts:18` (`lastCycle` gains `presaleEvents`)
- Modify: `src/lib/market/dbBackend.ts:163` (`lastCycleFrom`'s key list; line 162 before Task 6's import)
- Modify: `src/lib/market/dbBackend.test.ts` (the stored report and the expectation in the `surfaces the chain job's last cycle` case, lines 360 and 364 before Task 12's appended test moves them down)
- Create: `src/lib/launch/quotes.ts`, `src/lib/launch/quotes.test.ts`
- Create: `scripts/launchpad-quotes.mts`
- Modify: `package.json:17` (a script after `chain:gapfill`)
- Modify: `.gitignore` (append `launchpad-quotes.json`, the script's output)
- Modify: `README.md:21-27` (Routes), `:51-67` (a Launchpad bullet after Sync), `:82-85` (Scripts), `:87-98` (the variables table), `:136-153` (Layout)
- Modify: `scripts/README.md:8-14` (the command table)

**Interfaces:**
- Consumes: `QuoteAsset` (`src/lib/types.ts:53`), `SALE_TOKENS` (Task 2), `readQuotePrices`, `createChainClient` (`src/lib/chain/onchain.ts`), `QUOTES` (`src/lib/chain/math/quotes.ts`), `createDbBackend` (`src/lib/market/dbBackend.ts`), `createDb` (`src/lib/db/client.ts:119`).
- Produces:
  ```ts
  // src/lib/market/backend.ts
  sync?.lastCycle?: { ageSec; blocks; trades; holderPairs; holderDeltaApplied; holderReadsUnknown; presaleEvents: number };
  // src/lib/launch/quotes.ts
  export const MIN_SQRT_PRICE = 4_295_128_739n; export const MAX_SQRT_PRICE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n;
  export const USD_MIN = 1_000n; export const USD_MAX = 250_000n; export const STOCK_QUOTES = 10;
  export type LaunchQuoteRow = { asset: string; symbol: string; decimals: number; minTarget: string; maxTarget: string };
  export function isqrt(n: bigint): bigint;
  export function priceE8(usdPrice: number): bigint;
  export function rawForUsd(usd: bigint, decimals: number, usdPriceE8: bigint): bigint;
  export function launchQuoteRow(asset: string, symbol: string, decimals: number, usdPriceE8: bigint): LaunchQuoteRow;
  export function priceBoundsCheck(target: bigint): { ok: true } | { ok: false; reason: string };
  export function pickLaunchQuotes(quotes: readonly QuoteAsset[], n?: number): QuoteAsset[];
  // npm run launchpad:quotes -- [--out <path>]  -> writes launchpad-quotes.json at the repo root (git-ignored; the contracts deploy receives its text in QUOTES_JSON) unless --out names another file, and prints the array
  ```

- [ ] **Step 1: Write the failing tests**

Edit `src/lib/market/dbBackend.test.ts`, in the case titled "surfaces the chain job's last cycle (holder-count reads) and the RPC hosts, and neither when absent (23 Sep 2026)" (lines 353-367 before Task 12's appended test moves it down). Inside the `report:` object (line 360 before the move), add `presaleEvents: 3` after `holderReadsUnknown: 40`; inside the expected `lastCycle` (line 364 before the move), add `presaleEvents: 3` after `holderReadsUnknown: 40`. Then append, inside the same `describe`, right after that test:

```ts
  it("reads no lastCycle from a report written before presaleEvents existed, rather than inventing a zero (launchpad design, section 8)", async () => {
    await finishRun(db, "chain", {
      now: NOW - 20, ok: true, rows: 10, queries: 4,
      report: { at: NOW - 20, cursor: 990, blocks: 30, trades: 280, holderPairs: 190, holderDeltaApplied: 150, holderReadsUnknown: 40 },
    });
    expect((await backend().health()).sync).not.toHaveProperty("lastCycle");
  });
```

Create `src/lib/launch/quotes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Address, QuoteAsset } from "@/lib/types";
import { SALE_TOKENS } from "./constants";
import { MAX_SQRT_PRICE, MIN_SQRT_PRICE, isqrt, launchQuoteRow, pickLaunchQuotes, priceBoundsCheck, priceE8, rawForUsd } from "./quotes";

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const quote = (symbol: string, vol24h: number, over: Partial<QuoteAsset> = {}): QuoteAsset => ({
  symbol, name: symbol, address: `0x${symbol.toLowerCase().padEnd(40, "0")}` as Address, decimals: 18, usdPrice: 100, pairs: 1, vol24h, stale: false, ...over,
});

describe("isqrt", () => {
  it("floors the square root exactly at any size", () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(15n)).toBe(3n);
    expect(isqrt(16n)).toBe(4n);
    expect(isqrt(1n << 192n)).toBe(1n << 96n);
    expect(isqrt((1n << 192n) - 1n)).toBe((1n << 96n) - 1n);
  });
});

describe("rawForUsd and launchQuoteRow (spec decision 5: USD 1,000 to 250,000 at the Chainlink price)", () => {
  it("USDG at 1.00 with 6 decimals", () => {
    expect(rawForUsd(1_000n, 6, 100_000_000n)).toBe(1_000_000_000n);
    expect(rawForUsd(250_000n, 6, 100_000_000n)).toBe(250_000_000_000n);
  });

  it("an 18-decimal stock at 120.50, floored", () => {
    // 10^29 / 12,050,000,000 = 8,298,755,186,721,991,701.24…
    expect(rawForUsd(1_000n, 18, 12_050_000_000n)).toBe(8_298_755_186_721_991_701n);
    expect(launchQuoteRow("0xAF3D76F1834A1D425780943C99EA8A608F8A93F9", "AAPL", 18, priceE8(120.5))).toEqual({
      asset: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
      symbol: "AAPL",
      decimals: 18,
      minTarget: "8298755186721991701",
      maxTarget: "2074688796680497925311",
    });
  });

  it("priceE8 recovers Chainlink's own 8-decimal integer from the float the reader hands back", () => {
    expect(priceE8(120.5)).toBe(12_050_000_000n);
    expect(priceE8(1)).toBe(100_000_000n);
    expect(priceE8(0.03)).toBe(3_000_000n);
  });
});

describe("priceBoundsCheck (spec section 4.3, both currency orders)", () => {
  it("accepts every default target for a 6-decimal and an 18-decimal quote", () => {
    for (const target of [1_000_000_000n, 250_000_000_000n, 8_298_755_186_721_991_701n, 2_074_688_796_680_497_925_311n]) {
      expect(priceBoundsCheck(target)).toEqual({ ok: true });
    }
  });

  it("rejects a target whose price would overflow mulDiv at either end, and a zero target", () => {
    expect(priceBoundsCheck(0n)).toMatchObject({ ok: false });
    expect(priceBoundsCheck(1n)).toMatchObject({ ok: false, reason: expect.stringContaining("mulDiv overflows") });
    // With SALE_TOKENS fixed at 4.5e26, the token-as-currency0 ratio overflows 2^256 for any target above about
    // 8.3e45, so a huge target fails the overflow check first; the [MIN, MAX) branch is defensive and never reached.
    expect(priceBoundsCheck(10n ** 66n)).toMatchObject({ ok: false, reason: expect.stringContaining("mulDiv overflows") });
  });

  it("pins the bounds and the sale size it checks against", () => {
    expect(MIN_SQRT_PRICE).toBe(4_295_128_739n);
    expect(MAX_SQRT_PRICE).toBe(1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n);
    expect(SALE_TOKENS).toBe(450_000_000n * 10n ** 18n);
  });
});

describe("pickLaunchQuotes (spec decision 4: USDG plus the ten deepest stock tokens)", () => {
  it("puts USDG first, then the n stock tokens with the most 24-hour volume that have a fresh price", () => {
    const quotes = [
      quote("AMZN", 50),
      quote("USDG", 5, { address: USDG as Address, decimals: 6, usdPrice: 1 }),
      quote("NVDA", 900),
      quote("DEAD", 999, { stale: true }), // a stale feed is never a raise asset
      quote("AAPL", 300),
      quote("GLD", 800, { usdPrice: 0, stale: true }), // no feed at all
      quote("TSLA", 300), // ties break by symbol
    ];
    expect(pickLaunchQuotes(quotes, 3).map((q) => q.symbol)).toEqual(["USDG", "NVDA", "AAPL", "TSLA"]);
    expect(pickLaunchQuotes(quotes).map((q) => q.symbol)).toEqual(["USDG", "NVDA", "AAPL", "TSLA", "AMZN"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/market/dbBackend.test.ts src/lib/launch/quotes.test.ts`
Expected: FAIL: the health expectation lacks `presaleEvents` (the stored report carries a key the reader ignores, so `toMatchObject` sees no `presaleEvents` in `lastCycle`), and `./quotes` does not exist.

- [ ] **Step 3: Write the health field, the arithmetic and the script**

Edit `src/lib/market/backend.ts` line 18. Replace with:

```ts
    /** The chain job's last cycle (23 Sep 2026): its holder-count upkeep, how many of its pairs' balance reads got through, and (launchpad design, section 8) the launchpad events it folded. Absent until the reader has written one carrying every field. */
    lastCycle?: { ageSec: number; blocks: number; trades: number; holderPairs: number; holderDeltaApplied: number; holderReadsUnknown: number; presaleEvents: number };
```

Edit `src/lib/market/dbBackend.ts` line 163 (162 before Task 6's import; the `reportNumbers(stored, [...])` call in `lastCycleFrom`). Replace with:

```ts
  const n = reportNumbers(stored, ["at", "blocks", "trades", "holderPairs", "holderDeltaApplied", "holderReadsUnknown", "presaleEvents"] as const);
```

(`reportNumbers` already answers null when any key is missing, so a report from before this deploy yields no `lastCycle` for one cycle rather than a zero that reads like "no launchpad events".)

Create `src/lib/launch/quotes.ts`:

```ts
import type { QuoteAsset } from "@/lib/types";
import { SALE_TOKENS } from "./constants";

/**
 * The arithmetic behind scripts/launchpad-quotes.mts (launchpad design, sections 3, 4.3 and 4.5): which quote
 * assets a raise may be held in, the raw minimum and maximum targets for USD 1,000 and 250,000 at the
 * Chainlink price, and the check that every such target prices a pool inside Uniswap v4's sqrtPriceX96 bounds
 * in either currency order. All integer arithmetic: the raw amounts go into the deploy's setQuote calls.
 */

/** Uniswap v4 TickMath's MIN_SQRT_PRICE and MAX_SQRT_PRICE: `initialize` reverts outside [MIN, MAX). */
export const MIN_SQRT_PRICE = 4_295_128_739n;
export const MAX_SQRT_PRICE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n;
/** Spec decision 5. */
export const USD_MIN = 1_000n;
export const USD_MAX = 250_000n;
/** Spec decision 4: USDG plus this many stock tokens. */
export const STOCK_QUOTES = 10;
const Q192 = 1n << 192n;
const TWO_256 = 1n << 256n;

export type LaunchQuoteRow = { asset: string; symbol: string; decimals: number; minTarget: string; maxTarget: string };

/** Floor of the square root, by Newton's method from n itself; exact at any size. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt of a negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/** Chainlink's own 8-decimal integer, recovered from the float readQuotePrices hands back; exact for any price below about 90 million dollars. */
export function priceE8(usdPrice: number): bigint {
  return BigInt(Math.round(usdPrice * 1e8));
}

/** `usd` dollars as raw units of a quote asset priced at `usdPriceE8` dollars times 1e8; floored. */
export function rawForUsd(usd: bigint, decimals: number, usdPriceE8: bigint): bigint {
  if (usdPriceE8 <= 0n) throw new RangeError("usdPriceE8 must be positive");
  return (usd * 10n ** BigInt(decimals) * 100_000_000n) / usdPriceE8;
}

export function launchQuoteRow(asset: string, symbol: string, decimals: number, usdPriceE8: bigint): LaunchQuoteRow {
  return {
    asset: asset.toLowerCase(),
    symbol,
    decimals,
    minTarget: rawForUsd(USD_MIN, decimals, usdPriceE8).toString(),
    maxTarget: rawForUsd(USD_MAX, decimals, usdPriceE8).toString(),
  };
}

/**
 * Spec 4.3: sqrtPriceX96 = sqrt(mulDiv(amount1, 2^192, amount0)) with the token and the quote in currency order.
 * The token's address is only known at launch, so both orders are checked. mulDiv reverts when its result
 * exceeds 2^256, and initialize reverts outside [MIN_SQRT_PRICE, MAX_SQRT_PRICE); a target that fails here
 * could be created and then never launch, which is exactly what the deploy must not allow.
 *
 * With SALE_TOKENS fixed at 4.5e26 the bounds branch is defensive: the token-as-currency0 ratio overflows
 * 2^256 for any target above about 8.3e45, before either order's sqrt can leave [MIN, MAX) (the upper bound
 * would need a ratio above 2^256, the lower one a target above 1.5e65). It stays so that a future change of
 * SALE_TOKENS cannot silently let a target through that initialize would reject.
 */
export function priceBoundsCheck(target: bigint): { ok: true } | { ok: false; reason: string } {
  if (target <= 0n) return { ok: false, reason: "target is zero" };
  const orders: ReadonlyArray<readonly [bigint, bigint, string]> = [
    [SALE_TOKENS, target, "token as currency0"],
    [target, SALE_TOKENS, "quote as currency0"],
  ];
  for (const [amount0, amount1, order] of orders) {
    const ratio = (amount1 * Q192) / amount0;
    if (ratio >= TWO_256) return { ok: false, reason: `${order}: mulDiv overflows` };
    const sqrt = isqrt(ratio);
    if (sqrt < MIN_SQRT_PRICE || sqrt >= MAX_SQRT_PRICE) return { ok: false, reason: `${order}: sqrtPriceX96 ${sqrt} is outside the pool's bounds` };
  }
  return { ok: true };
}

/** Spec decision 4: USDG first, then the `n` stock tokens with the most 24-hour volume on the table that have a fresh Chainlink price; ties by symbol. */
export function pickLaunchQuotes(quotes: readonly QuoteAsset[], n: number = STOCK_QUOTES): QuoteAsset[] {
  const usdg = quotes.find((q) => q.symbol === "USDG");
  const stocks = quotes
    .filter((q) => q.symbol !== "USDG" && q.stale === false && q.usdPrice > 0)
    .sort((a, b) => b.vol24h - a.vol24h || a.symbol.localeCompare(b.symbol))
    .slice(0, n);
  return usdg ? [usdg, ...stocks] : stocks;
}
```

Create `scripts/launchpad-quotes.mts`:

```ts
/**
 * Writes the QUOTES_JSON the contracts repo's script/DeployLaunchpad.s.sol reads (launchpad design, sections 3,
 * 4.5 and 10): USDG plus the 10 stock tokens with the most 24-hour volume on the table, each with the raw minimum
 * and maximum targets equal to USD 1,000 and 250,000 at the current Chainlink price, each checked against the
 * launch pool's price bounds (section 4.3). Writes `launchpad-quotes.json` at this repo's root, git-ignored (the
 * deploy receives the file's text in QUOTES_JSON, since the contracts repo keeps fs_permissions empty), unless
 * `--out <path>` names another file; prints the array to stdout as well. Exits non-zero, naming the asset, when
 * a price is missing or a bound fails.
 * Run: npm run launchpad:quotes
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { QUOTES } from "@/lib/chain/math/quotes";
import { createChainClient, readQuotePrices } from "@/lib/chain/onchain";
import { createDb } from "@/lib/db/client";
import { launchQuoteRow, pickLaunchQuotes, priceBoundsCheck, priceE8, type LaunchQuoteRow } from "@/lib/launch/quotes";
import { createDbBackend } from "@/lib/market/dbBackend";
import { nowSec } from "@/lib/time";

const url = process.env.DATABASE_URL_DIRECT;
if (!url) {
  console.error("DATABASE_URL_DIRECT is not set (see .env.example)");
  process.exit(1);
}
/** The repo root whatever the working directory: this file lives in scripts/. */
const DEFAULT_OUT = fileURLToPath(new URL("../launchpad-quotes.json", import.meta.url));
const outIndex = process.argv.indexOf("--out");
const outPath = outIndex >= 0 && process.argv[outIndex + 1] ? process.argv[outIndex + 1] : DEFAULT_OUT;

const db = createDb(url, { max: 1 });
const problems: string[] = [];
try {
  // The table's own volumes decide the ten stocks; the prices are read fresh from Chainlink, not from the store.
  const picked = pickLaunchQuotes(await createDbBackend(db).quotes());
  const feeds = QUOTES.filter((q) => picked.some((p) => p.address.toLowerCase() === q.address));
  const prices = new Map((await readQuotePrices(createChainClient(), feeds, nowSec())).map((p) => [p.id, p.usdPrice]));

  const rows: LaunchQuoteRow[] = [];
  for (const q of picked) {
    const price = prices.get(q.address.toLowerCase());
    if (price === undefined) {
      problems.push(`${q.symbol}: no Chainlink price right now`);
      continue;
    }
    const row = launchQuoteRow(q.address, q.symbol, q.decimals, priceE8(price));
    for (const [label, target] of [["minTarget", BigInt(row.minTarget)], ["maxTarget", BigInt(row.maxTarget)]] as const) {
      const check = priceBoundsCheck(target);
      if (!check.ok) problems.push(`${q.symbol} ${label} ${target}: ${check.reason}`);
    }
    rows.push(row);
  }
  if (problems.length === 0) {
    const json = JSON.stringify(rows, null, 2);
    await writeFile(outPath, `${json}\n`);
    console.log(json);
    console.error(`${rows.length} quotes (${rows.map((r) => r.symbol).join(", ")}) written to ${outPath}`);
  }
} finally {
  await db.end();
}
// After the finally, never inside the try: exiting there would skip db.end() and leave the connection open.
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
```

Edit `package.json`: after line 17 (`"chain:gapfill": …,`) add:

```json
    "launchpad:quotes": "node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/launchpad-quotes.mts",
```

Edit `.gitignore`: append at the end of the file, after the `.env.fork` block:

```gitignore

# The launchpad deploy's quotes JSON (scripts/launchpad-quotes.mts): generated from the table
# and the Chainlink prices at deploy time, handed to the contracts deploy as QUOTES_JSON. Never source.
launchpad-quotes.json
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/market src/lib/launch src/app/api/health`
Expected: PASS.

- [ ] **Step 5: Write the README sections**

Edit `README.md`.

1. In the Routes table (lines 23-27), after the `/t/[address]` row add:

```markdown
| `/launch` | Raises: live, upcoming, launched, did not launch |
| `/launch/new` | Create a raise, one transaction |
| `/launch/[id]` | One raise: progress, contribute, launch now, claim or refund, the creator's vested claim, fee collection |
```

2. After the **Sync** bullet (it ends at line 67, "…its balance upserts being additive too.") add this bullet:

```markdown
- **Launchpad** (`src/lib/launch`, `src/lib/launch.ts`, design
  `docs/superpowers/specs/2026-09-27-launchpad-design.md`): while
  `NEXT_PUBLIC_SVLAUNCHPAD_ADDRESS` is set, the chain reader also selects every log
  of the `SVLaunchpad` contract in its one HyperSync request a minute and decodes by
  address then topic0; the fold turns the launchpad's events into row operations that
  `applyFold` applies to `market.presales` and `market.presale_contributions` after
  the token and pool upserts, in the same transaction as the trades and the cursor.
  `Finalized` sets the token's and the launch pool's origin to `SV`, and the listing
  rule counts an `SV` pool as traded, so a launched token has a table row and a page
  from its launch block. A raise's status (`scheduled`, `open`, `launchable`,
  `launched`, `failed`) is derived in SQL from the row and now, never stored.
  `GET /api/launch` and `GET /api/launch/[id]?wallet=` serve the rows with a 5 s cache,
  and the raise page polls every 5 s while a raise is live. Every write (`create`,
  `contribute`, `finalize`, `claim`, `claimCreator`, `refund`, `collectFees`) is a wallet transaction
  through `src/lib/launch.ts`, built like the swap: allowance to Permit2, one
  signature, one call, the receipt's own event. `GET /api/health`'s
  `sync.lastCycle.presaleEvents` counts the launchpad events folded in the last cycle.
```

3. In the **Scripts** bullet (lines 82-85), replace "`npm run db:parity`. They read" with "`npm run db:parity`, and `npm run launchpad:quotes`, which writes `launchpad-quotes.json` at the repo root (git-ignored), the `QUOTES_JSON` whose text the contracts deploy receives: USDG plus the ten deepest stock tokens, with raw minimum and maximum targets for USD 1,000 and 250,000 at the current Chainlink price. They read".

4. Replace line 87 ("Live mode needs these variables; all but the first are server-only:") with "Live mode needs these variables; all but the first two are server-only:" and, in the table, after the `NEXT_PUBLIC_DATA_SOURCE` row (line 91) add:

```markdown
| `NEXT_PUBLIC_SVLAUNCHPAD_ADDRESS` | the deployed `SVLaunchpad`; read by the browser (the create form and the raise page sign against it) and by the chain reader (its second log selection). Unset means no launchpad: the screens say so and the reader's query is unchanged. Set it and apply the migration before the first raise is created, so no launchpad event predates the reader's filter |
```

5. In the Layout block (lines 138-153), replace the `src/lib` line with `src/lib            types, formatting, market filters, chain, wagmi, SVRouter swap, SVLaunchpad writes, quote math` and after the `src/lib/holders` line add `src/lib/launch     the launchpad: ABI and constants, presale row writes, derived-status reads, display arithmetic, the deploy's quotes JSON`.

Edit `scripts/README.md`: in the command table (lines 8-14), after the `npm run db:parity` row add:

```markdown
| `npm run launchpad:quotes -- [--out <path>]` | Writes `launchpad-quotes.json` at the repo root (git-ignored; `--out` names another file) and prints it: the `QUOTES_JSON` that `script/DeployLaunchpad.s.sol` in the contracts repo receives as text. USDG plus the 10 stock tokens with the most 24-hour volume on the table, one row `{ asset, symbol, decimals, minTarget, maxTarget }` each, the two targets as raw amounts for USD 1,000 and 250,000 at the current Chainlink price, each checked against the launch pool's price bounds in both currency orders. Exits non-zero, naming the asset, when a price is missing or a bound fails. Needs `DATABASE_URL_DIRECT` (the table's volumes) and the chain RPC (the prices). |
```

- [ ] **Step 6: Lint and commit**

Run: `npm run lint`
Expected: clean (the script is under `scripts/`, which ESLint covers; `docs/**` is ignored).

```bash
git add src/lib/market/backend.ts src/lib/market/dbBackend.ts src/lib/market/dbBackend.test.ts src/lib/launch/quotes.ts src/lib/launch/quotes.test.ts scripts/launchpad-quotes.mts package.json .gitignore README.md scripts/README.md
git commit -m "Launchpad: health counts presale events, the quotes JSON for the contracts deploy, and the README sections"
```

---

### Task 14: The final gate

**Files:** none created or modified unless a gate fails.

- [ ] **Step 1: The whole suite**

Run: `npm test`
Expected: PASS across both projects (`node` and `dom`), no skipped files. If a PGlite file times out on a loaded machine, run it alone once: `npx vitest run <file>`.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors. Warnings are only the existing `@typescript-eslint/no-unused-vars` class, and none should be new.

- [ ] **Step 3: Type-check and build**

Run: `npm run build`
Expected: `next build` completes; the type check inside it passes (there is no separate `typecheck` script). Three new routes appear in the output: `/launch`, `/launch/new`, `/launch/[id]`, plus `/api/launch` and `/api/launch/[id]`.

- [ ] **Step 4: What ships and in what order (spec section 10)**

Nothing to commit here; every task committed its own work. Section 10's numbering, each step feeding the next:

1. `npm run launchpad:quotes` against the production database (it reads `DATABASE_URL_DIRECT` from `.env.local`). It writes `launchpad-quotes.json` at this repo's root, git-ignored; the contracts deploy receives that file's text in `QUOTES_JSON`, which is why it comes first.
2. The contracts repo deploys the launchpad from that JSON (Kobe's EOA as owner and fee wallet, the default quotes set from the rows, Blockscout verification, the address and block recorded in the contracts README). This step is what produces the address the next one needs.
3. `npm run db:migrate` against production (the two new tables are empty, so it is instant) and set `NEXT_PUBLIC_SVLAUNCHPAD_ADDRESS` on Vercel to the deployed launchpad. Both before any raise is created, so no launchpad event predates the reader's filter.
4. Push. The reader's next cycle carries the launchpad selection and the screens go live.
5. Rehearsal on the real chain, as section 10 lists it: the admin temporarily lowers USDG's minimum; a test raise with a small target is created; two wallets contribute; the raise auto-launches; the token shows on the table with the badge and is traded through the site; fees are collected and split; the creator claims vested tokens. Then a second raise is left to miss its floor and both wallets take refunds, and the minimum is restored. Ownership and the fee wallet go to MAXLONG at handover.

If a gate fails, fix inside the task that owns the file, re-run that task's tests, and re-run this gate.

---

## Self-Review

**1. Spec coverage, sections 5 to 8 and the named extras.**

| Spec item | Task |
|---|---|
| 5: the launchpad joins as a second `logs` selection `{ address: [LAUNCHPAD] }` with no topic filter, only when the address is configured; `address` joins the log field selection | 3 |
| 5: decoding routes by address then topic0 against the launchpad ABI | 2 (ABI), 3 (decoder) |
| 5: folded in the same pure pass, written by `applyFold` in the same transaction as the trades and the cursor | 4 (fold), 5 (store) |
| 5: discovery creates the token and pool rows from `Initialize` as for any pool; the presale part, applied after the token and pool upserts, sets `tokens.origin = 'SV'` and marks the launch pool listable | 4 (state flip on `Finalized`), 5 (`finalize` op's SQL, `LISTED_POOL` change, `applyFold` order) |
| 5: events-to-rows table, every row (`RaiseCreated` + `RaiseMetadata` insert; `Contributed` additive upsert, `raised = event.raised`, `contributors` recount; `Finalized` columns; `Closed`; `Refunded` with `raised −= amount`; `Claimed`; `CreatorClaimed`, `FeesCollected`, `PayoutChanged` running sums and payout) | 4 (ops), 5 (SQL, tested per op) |
| 5: `image` kept only as an https URL of at most 256 bytes, else empty | 4 (`presaleImage`) |
| 6: the two tables, column for column, the three indexes and the contributions index | 1 |
| 6: conventions (snake_case, lower-case hex, `numeric` cast to text on read, `int` seconds, no foreign keys), one migration file applied with `npm run db:migrate` | 1, Global Constraints, 14 |
| 6: status derived in SQL, never stored, the five rules, `failed` including the stall valve (`deadline_ts + 604800 ≤ now`) so a stalled raise shows Refund and never "Launch now" | 6 (`LAUNCH_STATUS_SQL`, tested rule by rule, the valve's edge one second each side), 11 (the failed branch's wording) |
| 7: routes in the existing conventions (`force-dynamic`, `badRequest`, `cached(data, 5)`, `failure`, 5 s `ttlCache`, `getBackend()`) | 6 |
| 7: `GET /api/launch` with derived status, quote symbol and decimals, USD for target and raised through the quote-price rule, contributors, time fields, and the five-part order | 6 |
| 7: `GET /api/launch/[id]` with `?wallet=` answering that wallet's row | 6 |
| 7: no write routes | 6 (none exist) |
| 7: `MarketsDataSource` gains `launches()` and `launch(id, wallet?)`, keys and hooks beside the existing ones, 5 s poll while scheduled, open or launchable (and, so the creator's redirect lands on a page that fills itself in, the same 5 s poll of a not-yet-indexed id for three minutes after mount, with `indexing` for the page's wording) | 7 |
| 7: two new small components, a progress bar with a floor marker and a countdown | 9 |
| 7: `/launch` with four sections and the card's contents; a launched card links to `/t/[token]` | 9 |
| 7: `/launch/new` form fields, the live summary panel (opening price, tokens per unit, pool depth at success, launch fee, per-wallet cap), one transaction, redirect from the `RaiseCreated` log, the gate message before signing | 10 |
| 7: `/launch/[id]` header (image, links, creator), progress, floor, contributors, countdown; contribute panel with remaining allowance, "up to" wording, Permit2 allowance, sign, send; the wallet's own contribution; Claim, Refund or Launch now by status; launched links to the token page; failed explains the floor, or says the launch could not happen within 7 days of the deadline when the raise had met it; a launched raise shows the connected creator "Claim creator tokens" with the amount vested so far (from `launched_at`, the 90-day schedule and `creator_claimed`, computed client-side by `creatorClaimable`) and shows everyone "Collect fees" with the totals collected so far from the `fees_*` sums | 11 (every branch tested, both failure wordings, the creator's button shown only to the creator, the fees button and its toast) |
| 7: token page chip "Launched on LongMarkets" linking to `/launch/[id]` when `market.presales` has the token | 12 (`launchId` through the pairs query) |
| 7: the `SV` badge with the tooltip and the origin filter entry | 12 |
| 7: the "Launch" item in `NAV` | 12 |
| 7: wallet writes in `src/lib/launch.ts` following `executeSwap` (allowance to Permit2 raised to `maxUint256`, `permitTypedData` and random nonce, `writeContract`, receipt wait, log parse for the id, three error classes, four toast kinds) | 8 (the writes), 10 and 11 (the toasts) |
| 7: the ABI as an `as const` array in `src/lib/launch/abi.ts`; the address `NEXT_PUBLIC_SVLAUNCHPAD_ADDRESS` read by browser and reader; the reader adds the selection only when set | 2, 3 |
| 8: `sync.lastCycle` gains `presaleEvents`, nothing else changes | 5 (written), 13 (read) |
| 4.5: `scripts/launchpad-quotes.mts` producing the JSON rows `{ asset, symbol, decimals, minTarget, maxTarget }`, USD 1,000 and 250,000 at the current Chainlink price, USDG plus the ten stock tokens with the most 24-hour volume, each checked against section 4.3's bounds; written to `launchpad-quotes.json` at the repo root, git-ignored, whose text the contracts deploy receives in `QUOTES_JSON` | 13 (the script's default `--out`, the `.gitignore` line) |
| README additions in the existing style | 13 |
| Section 10's order: quotes JSON, contracts deploy, migration and env var, push, rehearsal | 14 |

No gap found. The function ABI is spec section 4.2's "Function signatures" block verbatim (Task 2), pinned by `abi.test.ts` selector by selector and by `getRaise`'s and `poolKey`'s output layouts; "start now" is sent as `start = 0`, which `create` reads as the block's own timestamp (spec 4.2, create step 2); and every view the screens read (`feeBps`, `launcherGate`, `creationOpen`, `quoteLimits`) is in the block. Nothing in this plan decides a shape the spec leaves open.

**2. Placeholder scan.** Searched the plan for "TBD", "TODO", "implement later", "fill in", "add appropriate", "add validation", "handle edge cases", "similar to Task", "write tests for". None present. Every code step carries the code; every test step carries the test; every run step names its command and expected outcome. The two places that say "as before" or "exactly as" point at code quoted in the same task (the PoolManager decode branch, the toast flow) rather than at another task.

**3. Type consistency across tasks.** Checked name by name:
- `svLaunchpadAbi`, `PRESALE_TOPIC0` (Task 2) are what Task 3's decoder, Task 8's writes and Task 10's reads import.
- `SVLAUNCHPAD_ADDRESS` / `hasLaunchpad()` (Task 2) are what Tasks 3, 8, 9, 10, 11 use; the tests mock the same two names.
- `PresaleEvent` kinds (`raiseCreated`, `raiseMetadata`, `contributed`, `finalized`, `closed`, `refunded`, `claimed`, `creatorClaimed`, `feesCollected`, `payoutChanged`) are produced by Task 3 and consumed by Task 4's `handlePresale` with the same field names (`id`, `wallet`, `amount`, `raised`, `token`, `poolId`, `payout`, `creator0..platform1`).
- `PresaleOp` `op` values (`create`, `metadata`, `contribute`, `finalize`, `close`, `refund`, `claim`, `creatorClaim`, `fees`, `payout`) and field names are the same in Task 4's fold, Task 4's tests, Task 5's `applyPresaleOps` and Task 5's tests. `FoldResult.presales` is added in Task 4 and read by Task 5's `applyFold` and `run.ts`.
- `ChainRunReport.presaleEvents` and the `finishRun` report key `presaleEvents` (Task 5) are the key Task 13's `lastCycleFrom` reads and the `HealthReport` field it types.
- `Launch`, `LaunchStatus`, `LaunchContribution`, `LaunchView` (Task 6) are what `readLaunches` / `readLaunch` return, what the routes serve, what `MarketsDataSource.launches()` / `launch()` (Task 7) return, and what `useLaunches` / `useLaunch`, `LaunchList`, `RaiseView` and the tests build. The wallet-facing raw fields are strings everywhere (`target`, `floor`, `raised`, `saleTokens`, `amount`), and `Launch.token` / `poolId` are `null` before launch in the reader, the fixtures and the screens alike.
- `MarketBackend.launches()` / `launch(id: number, wallet?: string)` (Task 6) match `dbBackend`'s and `envioBackend`'s implementations and the routes' calls (`getBackend().launch(Number(id), wallet)`).
- `keys.launches` / `keys.launch(id, wallet)` (Task 7) are what `CreateRaiseForm` invalidates and what `RaiseView`'s `useAction` invalidates by prefix `["launch", id]`; the hook test pins the shapes. `useLaunch`'s result carries `indexing` (Task 7), which `RaiseView`'s null branch reads and its test fixture's `query` object includes; `LAUNCH_INDEXING_POLL_MS` is exported and pinned.
- `LaunchDeps`, `LaunchHandle<T>`, `createRaise`, `contribute(id, quote, amount, deps)`, `finalizeRaise`, `claimTokens`, `claimCreator`, `refundContribution`, `collectFees` and the three error classes (Task 8) are the exact names and signatures Tasks 10 and 11 import and their tests mock; `collectFees`'s result fields (`creator0`, `creator1`, `platform0`, `platform1`) are what `LaunchedPanel`'s toast sums through `feesCollected`.
- `fmtDuration`, `rawToNumber`, `pctOf`, `remainingAllowance`, `presalePrice`, `tokensPerQuoteUnit`, `launchSplit`, `tokensForPool`, `creatorClaimable(launchedAt, now, creatorClaimed)`, `feesCollected(launch)`, `raisedOfTarget`, `RaiseProgress({ raisedPct, floorPct })`, `Countdown({ to })` (Task 9) are used with those names and argument orders in Tasks 10 and 11; `CREATOR_TOKENS` and `CREATOR_VESTING_SEC` (Task 2) are what `creatorClaimable` reads.
- `erc721BalanceAbi` is exported by Task 10's one-line edit of `src/lib/suits.ts` and imported by `CreateRaiseForm`.
- `TokenPair.launchId` (Task 12) is optional and omitted when null, which is what `TokenHeader` checks with `!== undefined` and what the parity test relies on.
- `OriginBadge` replaces the two `<Badge>` uses (Task 12) and `SV_TOOLTIP` is the string both the tooltip and its test use.
- `LaunchQuoteRow`, `priceBoundsCheck`, `pickLaunchQuotes`, `launchQuoteRow`, `priceE8`, `rawForUsd`, `isqrt` (Task 13) are what the script imports.

One fix made during this review: `TokenHeader` and `PairsTable` both dropped their `Badge` import once `OriginBadge` took over, so the unused-import warning can't appear (the edit steps in Task 12 spell out both import lines).
