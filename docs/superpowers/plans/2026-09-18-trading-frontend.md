# Trading frontend (M2) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the trade panel prices a swap with the V4 Quoter and executes it through SVRouter, with real balances, a real holder check, and a fork harness that proves the path before the contract is deployed.

**Architecture:** the pool key and the price come from the app's own API route, which alone talks to the Quoter; the browser signs a Permit2 transfer and calls `SVRouter.swapExactIn` with the route's numbers verbatim, then reads the real output from the `Trade` event.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, viem 2.56, wagmi 3.7, RainbowKit 2.2, TanStack Query 5, Vitest 4, Foundry (anvil) for the fork.

**Spec:** `docs/superpowers/specs/2026-09-18-trading-frontend-design.md`

## Global Constraints

- Base units are `bigint`; human units are decimal strings. A `number` never holds a token amount on the execution path.
- Rounding: the router fee floors, the exact-output gross-up ceilings, `amountOutMin` floors, `toBase` truncates.
- The browser never recomputes an amount the route returned; it signs and sends the `call` block verbatim.
- No secret, address or RPC URL reaches a log or an error message.
- A quoter revert that is not the quoter's own return value means "not routable"; an unreachable node is a 503, never a dead pool. A genuine `0` from the Quoter is an honest zero, not "not routable".
- Every new file has a test file beside it; every route has a handler test.
- Gates at every commit: `npm test`, `npx tsc --noEmit`, `npx eslint .`, `npm run build`.
- Commit trailer on every commit:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` then
  `Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467`
- Never print, commit or push `.env.local` or `.env.fork`. No real private key anywhere; anvil's published test keys only.

## Verified chain and tooling facts

These were probed against the live chain, the live indexer and the installed
packages on 18 Sep 2026, not recalled. Treat them as given; do not re-derive.

- **V4 Quoter** `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` is deployed. Both
  `quoteExactInputSingle` and `quoteExactOutputSingle` answer through a plain
  `eth_call` and each returns two words, `(amount, gasEstimate)`. The tuple is
  `((address,address,uint24,int24,address),bool,uint128,bytes)`.
- **Worked example** on AI/NVDA (`fee 8388608`, `tickSpacing 200`, hook
  `0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544`, `zeroForOne: false`):
  1e18 NVDA in → `0x054250e7ec6578928c7c72f7` out; 1e21 AI out → `0x7466611729` in.
- **The indexer carries every pool-key field**, including `quote.address`.
  Ids and `hooks` are lowercase; `token.address` and `quote.address` are
  checksummed. `priceQuote` arrives as a **string, sometimes in exponent
  notation** (`"4.915190615229291e-10"`) and can be `0`, meaning "no usable
  price": price impact must parse defensively and yield `0`, never `NaN`.
- **anvil forks this chain faithfully**: `--chain-id 4663`, and the Quoter
  returns the identical value on the fork and on the live chain at the same
  block. `anvil_setBalance`, `anvil_setStorageAt` and `anvil_impersonateAccount`
  all work. Test accounts hold **no** ERC-20, so the e2e script funds itself by
  impersonating a holder discovered from the fork's own `Transfer` logs; never
  hard-code a whale. Set `FOUNDRY_DISABLE_NIGHTLY_WARNING=1` or the banner
  corrupts captured output.
- **Vitest is 4.1.11**: `environmentMatchGlobs` is gone, and the root config
  sets the `react-server` condition globally, under which React exports no
  client hooks. A DOM project is therefore a second `test.projects` entry that
  does **not** extend the root config.

## Rulings that override the task text below

Three planners drafted these tasks in parallel against one contract. Where
their drafts disagree with each other or with the contract, the ruling here
wins and the task text is read as amended.

1. **`QuoterUnavailableError` exists** (contract amendment). `src/lib/quote/quoter.ts`
   exports `class QuoterUnavailableError extends Error` and throws it when viem
   raises a transport failure (`HttpRequestError`, `TimeoutError`, or any error
   that is not a contract revert). Task 2 adds it; Task 3's route catches it and
   answers 503 `{ error: "rpc unavailable" }` instead of sniffing viem's error
   classes itself. This keeps viem's taxonomy inside the quoter module, matching
   `DbUnavailableError` and `EnvioUnavailableError` elsewhere.
2. **`priceImpactPct` takes the net amount**, what the pool actually swapped,
   not the gross input. Task 2 renames its first parameter to `netIn` and says so
   in the doc comment. Task 3 already passes `net`; no change there.
3. **Task 4 owns every `src/lib/types.ts` change.** It adds BOTH
   `routable?: boolean` and `call?: SwapCall` to `Quote`, plus the type-only
   re-export of `SwapCall`. Task 6 consumes them and edits `types.ts` no further.
4. **Task 4 makes the minimal `TradePanel.tsx` edit** needed to keep the build
   green under `executeSwap`'s new signature, including widening the catch so
   `SwapRejectedError` is not reported as a generic failure. Task 6 then does the
   full wiring. Task 4 runs before Task 6; they are the only tasks that touch
   that file, in that order.
5. **`SwapRejectedError extends Error`**, as the contract says. Task 4's catch
   handles it explicitly rather than relying on inheritance.
6. **`ttlCache` is load-through only.** Routability is cached by pricing inside
   the loader and caching the boolean; there is no peek or set. Stated here so no
   task tries to invent one.
7. **`toHuman` never uses exponent notation, never emits trailing zeros after
   the decimal point, and never ends in a bare decimal point.** `1.5`, `1`,
   `0.000001` are right; `1.500000`, `1.`, `1e-6` are wrong. Task 2's test pins it.
8. **The demo data source keeps `localQuote`.** Its tokens are generated
   addresses no backend knows, so routing its panel through the quote route would
   404 on every call. Task 6 documents this in the file.
9. **A quote at amount 0 is answered locally**, without a network call, so the
   panel can show the rate and fee rows before anything is typed.
10. **The DOM test project is its own reviewable unit** inside Task 5. If it
    proves unworkable, the panel tests in spec section 8 may be dropped and the
    task still ships; nothing else depends on it.

---
### Task 1: Chain constants and the pool key

**Files:**
- Create: `src/lib/market/poolKey.ts`, `src/lib/chain.test.ts`, `src/lib/market/poolKey.test.ts`
- Modify: `src/lib/chain.ts` (four constants and `hasRouter()`), `src/lib/market/backend.ts` (one method on `MarketBackend`), `src/lib/market/dbBackend.ts`, `src/lib/market/envioBackend.ts`, `src/lib/envio/queries.ts` (one document and two row types), `src/lib/envio/shape.ts` (`num` exported, `resolvePool` made generic), `src/lib/envio/fixtures.ts` (the `POOL_KEY_QUERY` fixture)
- Test: `src/lib/chain.test.ts`, `src/lib/market/poolKey.test.ts`, `src/lib/market/dbBackend.test.ts` (one new `describe`), `src/lib/market/envioBackend.test.ts` (two new `it`s)

**Interfaces:**
- Consumes: `Address` from `src/lib/types.ts`; `Db` from `src/lib/db/client.ts`; `gql` from `src/lib/envio/client.ts`; `resolvePool`, `num` from `src/lib/envio/shape.ts`; `testDb()` from `src/test/db.ts`; `FakeSource`, `upsertQuotes`, `upsertTokens`, `upsertPools`, `recomputeListedPools` in the tests.
- Produces: `PERMIT2_ADDRESS`, `UNIVERSAL_ROUTER_ADDRESS`, `V4_QUOTER_ADDRESS`, `SVROUTER_ADDRESS`, `hasRouter()` from `src/lib/chain.ts`; `PoolKeyRow`, `PoolKeyParts`, `poolKeyRow()` from `src/lib/market/poolKey.ts`; `MarketBackend.poolKey(tokenId)` implemented by both backends; `POOL_KEY_QUERY`, `PoolKeyPoolRow`, `PoolKeyTokenRow` from `src/lib/envio/queries.ts`; `aiPoolKey` from `src/lib/envio/fixtures.ts`. Signatures exactly as in the contract.

Decisions where the contract is silent (each one line):
- `poolKey.ts` gains one function beyond the contract's type, `poolKeyRow(parts)`: it is the single place a `PoolKeyRow` is built, which is what makes "both backends return the same row for the same token" true by construction rather than by two parallel edits, and it gives the file the test rule 6 asks for.
- Every address in a `PoolKeyRow` is lowercased. The indexer returns `Token.address` and `Quote.address` checksummed but its ids lowercase, and the store keeps both as the indexer sent them; viem accepts a lowercase address, so lowercasing is the only normalisation that makes the two backends comparable.
- `currency0`/`currency1` come from the stored `token_is_currency0` flag, never from a string comparison: that flag is how the pool was created, and it is what the indexer and the store already agree on.
- `SVROUTER_ADDRESS` is `undefined` unless the variable matches `/^0x[0-9a-fA-F]{40}$/`. An unset `NEXT_PUBLIC_*` reaches the bundle as `""`, and `""` as an address would be signed against.
- The Envio side gets its own document, `POOL_KEY_QUERY`, rather than a wider `POOL_FIELDS`: the only field it adds is `Quote.address`, which `QUOTES_QUERY` already selects on the same entity, and no existing document, row type or fixture changes shape.
- `resolvePool` becomes generic over the pool row so the listed-pool rule (sane primary, else the sane traded pool with the most swaps) stays written once; `num` is exported for the same reason — every Hasura numeric must pass through it.
- `market.pools.tick_spacing` and `market.quotes.address` already exist in `supabase/migrations/20260917000000_market.sql`; this task needs no migration.

- [ ] **Step 1: Write the failing chain-constants test**

`src/lib/chain.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { PERMIT2_ADDRESS, UNIVERSAL_ROUTER_ADDRESS, V4_QUOTER_ADDRESS, robinhoodChain } from "./chain";

/** The module reads NEXT_PUBLIC_SVROUTER_ADDRESS once, at import, so a stubbed value needs a fresh module. */
async function reload(value: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SVROUTER_ADDRESS", value);
  return import("./chain");
}

describe("chain constants", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("pins Permit2, the Universal Router and the V4 Quoter as chain facts, not environment variables", () => {
    expect(robinhoodChain.id).toBe(4663);
    expect(PERMIT2_ADDRESS).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
    expect(UNIVERSAL_ROUTER_ADDRESS).toBe("0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99");
    expect(V4_QUOTER_ADDRESS).toBe("0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94");
  });

  it("has no router until one is deployed, which disables execution and nothing else", async () => {
    const m = await reload("");
    expect(m.SVROUTER_ADDRESS).toBeUndefined();
    expect(m.hasRouter()).toBe(false);
  });

  it("takes a configured router address", async () => {
    const m = await reload("0x1111111111111111111111111111111111111111");
    expect(m.SVROUTER_ADDRESS).toBe("0x1111111111111111111111111111111111111111");
    expect(m.hasRouter()).toBe(true);
  });

  it("ignores a malformed router address rather than signing a permit against it", async () => {
    for (const bad of ["not-an-address", "0x1234", "0x111111111111111111111111111111111111111", "0xzzzz111111111111111111111111111111111111"]) {
      const m = await reload(bad);
      expect(m.SVROUTER_ADDRESS).toBeUndefined();
      expect(m.hasRouter()).toBe(false);
    }
  });
});
```

Run: `npx vitest run src/lib/chain.test.ts`
Expected: FAIL. Vitest's SSR transform hands back `undefined` for an export that does not exist, so the three address assertions fail on `undefined` and the router tests fail with `m.hasRouter is not a function`.

- [ ] **Step 2: Add the constants and `hasRouter()` to `src/lib/chain.ts`**

Change the import line at the top of `src/lib/chain.ts`:

```ts
import type { Address, Origin } from "./types";
```

and append to the end of the file, after `ORIGIN_URLS`:

```ts
/** Permit2, the same canonical address on every chain it is deployed to. */
export const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** Uniswap's Universal Router on 4663 (contracts spec section 2). */
export const UNIVERSAL_ROUTER_ADDRESS: Address = "0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99";

/** The V4 Quoter on 4663. The contracts fork suite asserts it agrees with the Universal Router to the wei on all three live pools. */
export const V4_QUOTER_ADDRESS: Address = "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * SVRouter is a deployment choice rather than a chain fact, so it stays an environment variable.
 * An unset `NEXT_PUBLIC_*` reaches the bundle as the empty string, and a malformed one would be
 * signed against, so anything that is not an address is `undefined`: execution is disabled, the
 * quote route is not. `process.env.NEXT_PUBLIC_…` is substituted at build time and must therefore
 * be read by direct member access, which is what happens twice below.
 */
export const SVROUTER_ADDRESS: Address | undefined = ADDRESS.test(process.env.NEXT_PUBLIC_SVROUTER_ADDRESS ?? "")
  ? (process.env.NEXT_PUBLIC_SVROUTER_ADDRESS as Address)
  : undefined;

/** false renders the panel's "trading goes live when the router is deployed" state; the quote still prices. */
export function hasRouter(): boolean {
  return SVROUTER_ADDRESS !== undefined;
}
```

Run: `npx vitest run src/lib/chain.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3: Write the failing pool-key builder test**

`src/lib/market/poolKey.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { poolKeyRow, type PoolKeyParts } from "./poolKey";

/** The indexer's own casing: ids lowercase, `Token.address` and `Quote.address` checksummed. */
const parts: PoolKeyParts = {
  poolId: "0xCBDFEA90430A30EE4469C9902E120A77E7C7E4711D5643671C1D1957F2F1CE27",
  hooks: "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544",
  fee: 8388608,
  tickSpacing: 200,
  tokenIsCurrency0: true,
  priceQuote: 0.000866,
  tokenAddress: "0x68082B7EA5eE83cA3BD992f038ef02c0180b9Ba3",
  tokenDecimals: 18,
  quoteAddress: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  quoteDecimals: 18,
};
const AI = "0x68082b7ea5ee83ca3bd992f038ef02c0180b9ba3";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";

describe("poolKeyRow", () => {
  it("lowercases every address, so a row from the store equals a row from the indexer", () => {
    expect(poolKeyRow(parts)).toEqual({
      poolId: "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27",
      currency0: AI,
      currency1: NVDA,
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544",
      tokenIsCurrency0: true,
      priceQuote: 0.000866,
      tokenAddress: AI,
      tokenDecimals: 18,
      quoteAddress: NVDA,
      quoteDecimals: 18,
    });
  });

  it("orders the currencies by the flag the pool was created with, never by a string comparison", () => {
    expect(poolKeyRow({ ...parts, tokenIsCurrency0: false })).toMatchObject({
      currency0: NVDA,
      currency1: AI,
      tokenIsCurrency0: false,
      tokenAddress: AI,
      quoteAddress: NVDA,
    });
  });

  it("carries the fields the chain never sees: the stored price and both decimals", () => {
    const row = poolKeyRow({ ...parts, priceQuote: 0.5, tokenDecimals: 8, quoteDecimals: 6 });
    expect(row).toMatchObject({ priceQuote: 0.5, tokenDecimals: 8, quoteDecimals: 6 });
  });
});
```

Run: `npx vitest run src/lib/market/poolKey.test.ts`
Expected: FAIL, "Cannot find module ./poolKey".

- [ ] **Step 4: Write `src/lib/market/poolKey.ts`**

`src/lib/market/poolKey.ts`:

```ts
import type { Address } from "@/lib/types";

/**
 * Everything a swap needs to know about a token's listed pool: the v4 PoolKey's five fields, the
 * direction flag, both assets' decimals and the stored quote-per-token price the route measures
 * price impact against. `TokenPair` carries none of this; widening it would push a PoolKey into
 * every screen that lists a row.
 */
export type PoolKeyRow = {
  poolId: Address;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  tokenIsCurrency0: boolean;
  priceQuote: number;
  tokenAddress: Address;
  tokenDecimals: number;
  quoteAddress: Address;
  quoteDecimals: number;
};

/** What a backend has read about the listed pool, in either source's own casing. */
export type PoolKeyParts = {
  poolId: string;
  hooks: string;
  fee: number;
  tickSpacing: number;
  tokenIsCurrency0: boolean;
  priceQuote: number;
  tokenAddress: string;
  tokenDecimals: number;
  quoteAddress: string;
  quoteDecimals: number;
};

const lower = (a: string): Address => a.toLowerCase() as Address;

/**
 * The one place a PoolKeyRow is built, so the store and the indexer cannot drift. Addresses are
 * lowercased because the indexer returns ids lowercase but `Token.address` and `Quote.address`
 * checksummed; viem accepts a lowercase address, and `tokenIsCurrency0` — the flag the pool was
 * created with — decides the currency order, so nothing here depends on string comparison.
 */
export function poolKeyRow(p: PoolKeyParts): PoolKeyRow {
  const tokenAddress = lower(p.tokenAddress);
  const quoteAddress = lower(p.quoteAddress);
  return {
    poolId: lower(p.poolId),
    currency0: p.tokenIsCurrency0 ? tokenAddress : quoteAddress,
    currency1: p.tokenIsCurrency0 ? quoteAddress : tokenAddress,
    fee: p.fee,
    tickSpacing: p.tickSpacing,
    hooks: lower(p.hooks),
    tokenIsCurrency0: p.tokenIsCurrency0,
    priceQuote: p.priceQuote,
    tokenAddress,
    tokenDecimals: p.tokenDecimals,
    quoteAddress,
    quoteDecimals: p.quoteDecimals,
  };
}
```

Run: `npx vitest run src/lib/market/poolKey.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing `poolKey` test for the store backend**

Append to the end of `src/lib/market/dbBackend.test.ts`:

```ts
describe("createDbBackend poolKey", () => {
  let db: Db;
  const backend = () => createDbBackend(db, new FakeSource({}), () => NOW);
  // One more token whose pool was created with the quote as currency0; the fixtures above are all token-first.
  const F = addr("8");
  const PF = poolId("8");

  beforeAll(async () => {
    db = await testDb();
    await upsertQuotes(db, quotes, prices);
    await upsertTokens(db, [...tokens, tokenRec(F, "FFF", "LONG", PF)], NOW);
    await upsertPools(db, [...pools, poolRec(PF, F, USDG, { tokenIsCurrency0: false, fee: 500, tickSpacing: 10, lastSwapAt: NOW - 3000 })], NOW);
    await recomputeListedPools(db, "all");
  });
  afterAll(() => db.end());

  it("builds the listed pool's key, with the token as currency0", async () => {
    expect(await backend().poolKey(A)).toEqual({
      poolId: PA,
      currency0: A,
      currency1: NVDA,
      fee: 3000,
      tickSpacing: 60,
      hooks: addr("9"),
      tokenIsCurrency0: true,
      priceQuote: 0.000866,
      tokenAddress: A,
      tokenDecimals: 18,
      quoteAddress: NVDA,
      quoteDecimals: 18,
    });
  });

  it("puts the quote first when the pool was created that way", async () => {
    expect(await backend().poolKey(F)).toMatchObject({
      poolId: PF,
      currency0: USDG,
      currency1: F,
      tokenIsCurrency0: false,
      fee: 500,
      tickSpacing: 10,
      tokenAddress: F,
      quoteAddress: USDG,
      quoteDecimals: 6,
    });
  });

  it("reads the recovered pool, not the broken primary, exactly as the listing does", async () => {
    expect(await backend().poolKey(B)).toMatchObject({ poolId: PB, currency1: USDG, priceQuote: 0.5, quoteDecimals: 6 });
  });

  it("is null for a token with no listed pool and for one that does not exist", async () => {
    expect(await backend().poolKey(D)).toBeNull();
    expect(await backend().poolKey(addr("0"))).toBeNull();
  });
});
```

Run: `npx vitest run src/lib/market/dbBackend.test.ts`
Expected: FAIL, four times with "backend(...).poolKey is not a function". Every test in the other three `describe`s still passes.

- [ ] **Step 6: Add `poolKey` to the interface and implement it against the store**

In `src/lib/market/backend.ts`, add the import beside the other type imports:

```ts
import type { PoolKeyRow } from "./poolKey";
```

and the method to `MarketBackend`, between `holders` and `health`:

```ts
  /** The listed pool's v4 PoolKey, the direction flag and both assets' decimals; null when the token has no listed pool. */
  poolKey(tokenId: string): Promise<PoolKeyRow | null>;
```

In `src/lib/market/dbBackend.ts`, add the import beside `./dbShape`:

```ts
import { poolKeyRow } from "./poolKey";
```

add the row type beside the other `type` declarations near the top:

```ts
type PoolKeyCols = {
  pool_id: string; hooks: string; fee: number; tick_spacing: number; token_is_currency0: boolean; price_quote: number;
  token_address: string; token_decimals: number; quote_address: string; quote_decimals: number;
};
```

add the statement beside the other SQL constants, after `HOLDERS_SQL`:

```ts
const POOL_KEY_SQL = `select p.id as pool_id, p.hooks, p.fee, p.tick_spacing, p.token_is_currency0, p.price_quote,
  t.address as token_address, t.decimals as token_decimals, q.address as quote_address, q.decimals as quote_decimals
  from market.tokens t join market.pools p on p.id = t.listed_pool_id join market.quotes q on q.id = p.quote_id where t.id = $1`;
```

and the method to the `backend` object, between `holders` and `health`:

```ts
    async poolKey(tokenId) {
      const row = (await db.query<PoolKeyCols>(POOL_KEY_SQL, [tokenId]))[0];
      if (!row) return null; // no such token, or no listed pool: the join drops it either way
      return poolKeyRow({
        poolId: row.pool_id,
        hooks: row.hooks,
        fee: row.fee,
        tickSpacing: row.tick_spacing,
        tokenIsCurrency0: row.token_is_currency0,
        priceQuote: row.price_quote,
        tokenAddress: row.token_address,
        tokenDecimals: row.token_decimals,
        quoteAddress: row.quote_address,
        quoteDecimals: row.quote_decimals,
      });
    },
```

Run: `npx vitest run src/lib/market/dbBackend.test.ts`
Expected: PASS. `npx tsc --noEmit` is still red with one error, `createEnvioBackend` missing `poolKey`; Step 9 closes it.

- [ ] **Step 7: Add the Envio document and open the two seams in `shape.ts`**

In `src/lib/envio/queries.ts`, add the two row types after `BalanceRow`:

```ts
/** Only what a swap needs: the v4 PoolKey's five fields, the direction, the stored price and both assets' decimals. */
export type PoolKeyPoolRow = {
  id: string; quote_id: string; tokenIsCurrency0: boolean; hooks: string; fee: number; tickSpacing: number;
  priceQuote: Numeric; quote: { address: string; decimals: number };
};
export type PoolKeyTokenRow = {
  id: string; address: string; decimals: number;
  primaryPool: PoolKeyPoolRow | null;
  /** Best sane pool by swap count, as in TOKEN_QUERY. */
  fallbackPool?: PoolKeyPoolRow[];
};
```

and the document immediately after `TOKEN_QUERY`:

```ts
const POOL_KEY_FIELDS = "id quote_id tokenIsCurrency0 hooks fee tickSpacing priceQuote quote { address decimals }";

/**
 * One token's listed pool, resolved by the same primary-then-fallback rule as TOKEN_QUERY, with
 * the quote's own address — the field QUOTES_QUERY already selects on the same entity — because a
 * PoolKey needs both currencies and `quote_id` is an id, not an address the swap can sign over.
 */
export const POOL_KEY_QUERY = `
query PoolKey($id: String!) {
  Token(where: { id: { _eq: $id } }, limit: 1) {
    id address decimals
    primaryPool { ${POOL_KEY_FIELDS} }
    fallbackPool: pools(where: { swapCount: { _gt: 0 }, ${SANE_PRICE} }, order_by: { swapCount: desc }, limit: 1) { ${POOL_KEY_FIELDS} }
  }
}`;
```

In `src/lib/envio/shape.ts`, export `num` and widen the two pool helpers so the listed-pool rule stays written once. Replace the three declarations:

```ts
export const num = (v: Numeric): number => (typeof v === "number" ? v : Number(v));
```

```ts
/** A pool parked at a tick boundary quotes ~3.4e50 or ~0; both are unusable as a price. Structural, so a narrower row can be checked too. */
export function isSanePool(p: { priceQuote: Numeric }): boolean {
  const q = num(p.priceQuote);
  return q > 1e-24 && q < 1e18;
}

/** The indexer's TVL-ranked `primaryPool` is wrong for 1000+ tokens; prefer it only when it prices sanely. Generic so POOL_KEY_QUERY's narrower rows use the same rule. */
export function resolvePool<P extends { priceQuote: Numeric }>(t: { primaryPool: P | null; fallbackPool?: P[] }): P | null {
  if (t.primaryPool && isSanePool(t.primaryPool)) return t.primaryPool;
  const fallback = t.fallbackPool?.[0];
  return fallback && isSanePool(fallback) ? fallback : null;
}
```

Run: `npx vitest run src/lib/envio`
Expected: PASS, everything green and unchanged — the widening is source-compatible and `TokenRow` still infers `P = PoolRow` at every existing call site.

- [ ] **Step 8: Add the fixture and write the failing `poolKey` test for the Envio backend**

Append to the end of `src/lib/envio/fixtures.ts`:

```ts
/** The same two pools as `aiTokenBroken`, as POOL_KEY_QUERY selects them: no TVL, no origin, the quote's address instead of its symbol. */
const poolKeyPool = (p: PoolRow, address: string): PoolKeyPoolRow => ({
  id: p.id, quote_id: p.quote_id, tokenIsCurrency0: p.tokenIsCurrency0, hooks: p.hooks,
  fee: p.fee, tickSpacing: p.tickSpacing, priceQuote: p.priceQuote, quote: { address, decimals: p.quote.decimals },
});

/** AI through POOL_KEY_QUERY: a broken primary against USDG, the real LONG/NVDA pool as the fallback. */
export const aiPoolKey: PoolKeyTokenRow = {
  id: aiToken.id,
  address: aiToken.address,
  decimals: aiToken.decimals,
  primaryPool: poolKeyPool(brokenPool, USDG),
  fallbackPool: [poolKeyPool(aiToken.primaryPool!, quotes[0]!.address)],
};
```

and widen its first import line to carry the two new types:

```ts
import type { TokenRow, PoolRow, PoolKeyPoolRow, PoolKeyTokenRow, QuotePriceRow, WindowRow, CandleRow, SwapRow, BalanceRow, QuoteRow } from "./queries";
```

In `src/lib/market/envioBackend.test.ts`, widen the two import lines:

```ts
import { AI, NOW, NVDA, POOL, aiPoolKey, aiTokenBroken, prices, windowRows } from "@/lib/envio/fixtures";
import { POOL_KEY_QUERY, TOKEN_QUERY } from "@/lib/envio/queries";
```

and add two tests inside the existing `describe("createEnvioBackend")`, after the `pair()` tests:

```ts
  it("poolKey() resolves the same listed pool as pair() and lowercases every address", async () => {
    gqlMock.mockImplementation(async (query) => {
      if (query === POOL_KEY_QUERY) return { Token: [aiPoolKey] } as never;
      throw new Error(`unexpected query ${query.slice(0, 30)}`);
    });
    expect(await backend.poolKey(AI)).toEqual({
      poolId: POOL,
      currency0: AI,
      currency1: NVDA,
      fee: 8388608,
      tickSpacing: 8,
      hooks: "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544",
      tokenIsCurrency0: true,
      priceQuote: 0.000866,
      tokenAddress: AI,
      tokenDecimals: 18,
      quoteAddress: NVDA,
      quoteDecimals: 18,
    });
    // One document, one round trip: the quote route calls this on every keystroke's quote.
    expect(gqlMock).toHaveBeenCalledTimes(1);
    expect(gqlMock).toHaveBeenCalledWith(POOL_KEY_QUERY, { id: AI });
  });

  it("poolKey() is null for an unknown token and for one whose every pool is parked at a boundary", async () => {
    gqlMock.mockResolvedValue({ Token: [] });
    expect(await backend.poolKey(AI)).toBeNull();
    gqlMock.mockResolvedValue({ Token: [{ ...aiPoolKey, fallbackPool: [] }] });
    expect(await backend.poolKey(AI)).toBeNull();
  });
```

Run: `npx vitest run src/lib/market/envioBackend.test.ts`
Expected: FAIL, twice with "backend.poolKey is not a function". The four existing tests still pass.

- [ ] **Step 9: Implement `poolKey` on the Envio backend**

In `src/lib/market/envioBackend.ts`, widen the two imports:

```ts
import {
  CANDLES_QUERY, HEALTH_QUERY, HOLDERS_QUERY, POOL_KEY_QUERY, QUOTES_QUERY, TOKEN_QUERY, TRADES_QUERY, windowQuery,
  type BalanceRow, type CandleRow, type PoolKeyTokenRow, type QuotePriceRow, type QuoteRow, type SwapRow, type TokenRow, type WindowRow,
} from "@/lib/envio/queries";
import { isStale, num, resolvePool, shapeCandles, shapeHolders, shapePairs, shapeQuotes, shapeTrades, usdMap, windowStats } from "@/lib/envio/shape";
```

add the import of the builder beside `./backend`:

```ts
import { poolKeyRow } from "./poolKey";
```

and add the method between `holders` and `health`:

```ts
    async poolKey(tokenId) {
      const t = await gql<{ Token: PoolKeyTokenRow[] }>(POOL_KEY_QUERY, { id: tokenId });
      const token = t.Token[0];
      const pool = token ? resolvePool(token) : null;
      if (!token || !pool) return null;
      return poolKeyRow({
        poolId: pool.id,
        hooks: pool.hooks,
        fee: pool.fee,
        tickSpacing: pool.tickSpacing,
        tokenIsCurrency0: pool.tokenIsCurrency0,
        // Hasura sends every numeric as a string; `+` on one of these would concatenate.
        priceQuote: num(pool.priceQuote),
        tokenAddress: token.address,
        tokenDecimals: token.decimals,
        quoteAddress: pool.quote.address,
        quoteDecimals: pool.quote.decimals,
      });
    },
```

Run: `npx vitest run src/lib/market`
Expected: PASS, every test in all four market test files.

- [ ] **Step 10: Run the gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green. `grep -rn "NEXT_PUBLIC_SVROUTER_ADDRESS" src` matches `src/lib/chain.ts` twice and `src/lib/chain.test.ts` once (its stub), and nothing else: no other module reads the variable.

- [ ] **Step 11: Commit**

```bash
git add src/lib/chain.ts src/lib/chain.test.ts src/lib/market/poolKey.ts src/lib/market/poolKey.test.ts \
  src/lib/market/backend.ts src/lib/market/dbBackend.ts src/lib/market/dbBackend.test.ts \
  src/lib/market/envioBackend.ts src/lib/market/envioBackend.test.ts \
  src/lib/envio/queries.ts src/lib/envio/shape.ts src/lib/envio/fixtures.ts
git commit -m "Pin the M2 chain constants and read a token's PoolKey from either backend" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

### Task 2: Quote math and the quoter client

**Files:**
- Create: `src/lib/quote/math.ts`, `src/lib/quote/quoter.ts`
- Test: `src/lib/quote/math.test.ts`, `src/lib/quote/quoter.test.ts`

**Interfaces:**
- Consumes: `V4_QUOTER_ADDRESS`, `robinhoodChain` from `src/lib/chain.ts` (Task 1); `PoolKeyRow` from `src/lib/market/poolKey.ts` (Task 1); `Address` from `src/lib/types.ts`; viem's `createPublicClient`, `http`, `BaseError`, `ContractFunctionRevertedError`, `ContractFunctionZeroDataError`, `PublicClient`.
- Produces: `ROUTER_FEE_BPS`, `HOLDER_FEE_BPS`, `feeFor`, `grossUp`, `withSlippage`, `priceImpactPct`, `toBase`, `toHuman` from `src/lib/quote/math.ts`; `QuoterCall`, `Quoter`, `NotRoutableError`, `createQuoter`, `QUOTER_ABI` from `src/lib/quote/quoter.ts`. Signatures exactly as in the contract; `QUOTER_ABI` is the one addition, so the test can assert the fragment that is sent rather than re-describe it.

Decisions where the contract is silent (each one line):
- `src/lib/quote.ts` (the M1 `localQuote` approximation) stays exactly where it is: a file `quote.ts` and a directory `quote/` are different names, `@/lib/quote` keeps resolving to the file and `@/lib/quote/math` to the new module. M3 deletes the file when the panel stops falling back to it.
- `toBase` truncates digits past the token's decimals rather than rounding: rounding up would let "100 %" of a balance exceed that balance, and the pay amount is what Permit2 transfers.
- `toBase` accepts `123`, `1.5`, `.5` and `1.` and nothing else — no sign, no exponent, no whitespace, no separators — because the only caller is a route parsing a typed number, and `Number()`'s tolerance is what lets `1e30` through as an amount.
- `toHuman` prints a sign when handed a negative, though `toBase` never accepts one: a display helper in a render path must be total, and a difference can be negative.
- Both take `decimals` in 0..36 and throw `RangeError` outside it; 18 is the largest any listed token uses and the ceiling still catches a swapped argument.
- `feeBps` is an integer in 0..9999 (a 100 % fee has no gross-up) and `slippageBps` an integer in 0..10000, where 10000 floors to zero output; anything else is a `RangeError`.
- `priceImpactPct` is signed — a stale stored `price_quote` can read better than the pool and that is worth showing — and returns 0 rather than `Infinity`/`NaN` for a zero amount or a zero stored price.
- The Quoter's `exactAmount` is `uint128`, so a non-positive or oversized amount is a `RangeError` raised before any RPC call rather than an opaque encoding failure.
- `hookData` is always `0x`: the Doppler and Pons hooks on these pools read the swap, not an argument.
- Only a contract revert (`ContractFunctionRevertedError`) or an empty answer (`ContractFunctionZeroDataError`) becomes `NotRoutableError`; a transport failure travels as itself, so the route can tell 200 `{ routable: false }` from 503.
- `NotRoutableError`'s message names no address: rule 4.

- [ ] **Step 1: Write the failing math test**

`src/lib/quote/math.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HOLDER_FEE_BPS, ROUTER_FEE_BPS, feeFor, grossUp, priceImpactPct, toBase, toHuman, withSlippage } from "./math";

const ONE = 10n ** 18n;

describe("feeFor", () => {
  it("takes 0.5 % from everyone and nothing from a Suits holder", () => {
    expect(ROUTER_FEE_BPS).toBe(50);
    expect(HOLDER_FEE_BPS).toBe(0);
    expect(feeFor(1_000_000n, ROUTER_FEE_BPS)).toEqual({ fee: 5_000n, net: 995_000n });
    expect(feeFor(1_000_000n, HOLDER_FEE_BPS)).toEqual({ fee: 0n, net: 1_000_000n });
  });

  it("floors the fee, exactly as the contract's integer division does", () => {
    expect(feeFor(199n, 50)).toEqual({ fee: 0n, net: 199n }); // 0.995 wei
    expect(feeFor(200n, 50)).toEqual({ fee: 1n, net: 199n });
    expect(feeFor(399n, 50)).toEqual({ fee: 1n, net: 398n }); // 1.995 wei
  });

  it("leaves one wei whole: the smallest trade pays nothing rather than everything", () => {
    expect(feeFor(1n, 50)).toEqual({ fee: 0n, net: 1n });
    expect(feeFor(0n, 50)).toEqual({ fee: 0n, net: 0n });
  });

  it("holds at 18 decimals with no float in sight", () => {
    expect(feeFor(ONE, 50)).toEqual({ fee: 5n * 10n ** 15n, net: 995n * 10n ** 15n });
    expect(feeFor(2n ** 200n, 50).fee + feeFor(2n ** 200n, 50).net).toBe(2n ** 200n);
  });

  it("refuses a negative amount and a fee that is not an integer in 0..9999", () => {
    expect(() => feeFor(-1n, 50)).toThrow(RangeError);
    expect(() => feeFor(100n, -1)).toThrow(RangeError);
    expect(() => feeFor(100n, 10_000)).toThrow(RangeError);
    expect(() => feeFor(100n, 0.5)).toThrow(RangeError);
    expect(() => feeFor(100n, Number.NaN)).toThrow(RangeError);
  });
});

describe("grossUp", () => {
  it("inverts feeFor exactly when the division is exact", () => {
    expect(grossUp(995_000n, 50)).toBe(1_000_000n);
    expect(feeFor(grossUp(995_000n, 50), 50).net).toBe(995_000n);
    expect(grossUp(995n, 50)).toBe(1_000n);
  });

  it("ceilings, so the pool is never a wei short of the net the quote promised", () => {
    expect(grossUp(1n, 50)).toBe(2n); // 1.005… wei
    expect(grossUp(996n, 50)).toBe(1_002n); // 1001.005… wei
    for (const net of [1n, 7n, 996n, 12_345n, ONE, ONE + 1n]) {
      expect(feeFor(grossUp(net, 50), 50).net).toBeGreaterThanOrEqual(net);
    }
  });

  it("is the identity for a holder, and zero grosses up to zero", () => {
    expect(grossUp(1_234n, HOLDER_FEE_BPS)).toBe(1_234n);
    expect(grossUp(0n, 50)).toBe(0n);
  });

  it("refuses a negative net and a 100 % fee, which has no gross", () => {
    expect(() => grossUp(-1n, 50)).toThrow(RangeError);
    expect(() => grossUp(1n, 10_000)).toThrow(RangeError);
  });
});

describe("withSlippage", () => {
  it("floors the minimum the user will accept", () => {
    expect(withSlippage(1_000_000n, 50)).toBe(995_000n);
    expect(withSlippage(1_000_000n, 100)).toBe(990_000n);
    expect(withSlippage(199n, 50)).toBe(198n); // 198.005
    expect(withSlippage(1n, 1)).toBe(0n); // one wei at any tolerance: zero is the honest floor
  });

  it("is the identity at zero and nothing at 100 %", () => {
    expect(withSlippage(1_234n, 0)).toBe(1_234n);
    expect(withSlippage(1_234n, 10_000)).toBe(0n);
  });

  it("refuses more than 100 %, a negative and a fraction", () => {
    expect(() => withSlippage(1_234n, 10_001)).toThrow(RangeError);
    expect(() => withSlippage(1_234n, -1)).toThrow(RangeError);
    expect(() => withSlippage(1_234n, 12.5)).toThrow(RangeError);
    expect(() => withSlippage(-1n, 50)).toThrow(RangeError);
  });
});

describe("toBase", () => {
  it("scales a decimal string by the token's decimals", () => {
    expect(toBase("1", 18)).toBe(ONE);
    expect(toBase("0.5", 18)).toBe(5n * 10n ** 17n);
    expect(toBase("1.5", 6)).toBe(1_500_000n);
    expect(toBase("0", 18)).toBe(0n);
    expect(toBase("123", 0)).toBe(123n);
  });

  it("accepts the shapes a keyboard produces", () => {
    expect(toBase(".5", 6)).toBe(500_000n);
    expect(toBase("1.", 6)).toBe(1_000_000n);
    expect(toBase("0001.500", 6)).toBe(1_500_000n);
  });

  it("truncates past the token's decimals, so 100 % of a balance can never exceed it", () => {
    expect(toBase("1.2345678", 6)).toBe(1_234_567n);
    expect(toBase("0.9999999", 6)).toBe(999_999n);
    expect(toBase("0.0000001", 6)).toBe(0n);
  });

  it("holds a uint256-sized number exactly", () => {
    expect(toBase("115792089237316195423570985008687907853269984665640564039457.584007913129639935", 18)).toBe(2n ** 256n - 1n);
  });

  it("throws RangeError on junk, including the shapes Number() would happily accept", () => {
    for (const bad of ["", " ", ".", "-1", "+1", "1e18", "1E18", "1.2.3", "abc", "0x1", "1 000", "1,000", "Infinity", "NaN", "1n"]) {
      expect(() => toBase(bad, 18)).toThrow(RangeError);
    }
  });

  it("throws RangeError on impossible decimals", () => {
    expect(() => toBase("1", -1)).toThrow(RangeError);
    expect(() => toBase("1", 1.5)).toThrow(RangeError);
    expect(() => toBase("1", 78)).toThrow(RangeError);
  });
});

describe("toHuman", () => {
  it("is the inverse of toBase", () => {
    for (const [base, decimals] of [[ONE, 18], [1n, 18], [1_500_000n, 6], [0n, 18], [123n, 0], [2n ** 256n - 1n, 18]] as const) {
      expect(toBase(toHuman(base, decimals), decimals)).toBe(base);
    }
  });

  it("never produces exponent notation, however small or large", () => {
    expect(toHuman(1n, 18)).toBe("0.000000000000000001");
    expect(toHuman(10n ** 30n, 18)).toBe("1000000000000");
    expect(toHuman(2n ** 256n - 1n, 18)).toBe("115792089237316195423570985008687907853269984665640564039457.584007913129639935");
    // What the route would have sent if a float had held the amount.
    expect(String(Number(toHuman(1n, 18)))).toContain("e");
    expect(toHuman(1n, 18)).not.toContain("e");
  });

  it("strips trailing zeros and the point with them", () => {
    expect(toHuman(0n, 18)).toBe("0");
    expect(toHuman(1_000_000n, 6)).toBe("1");
    expect(toHuman(1_500_000n, 6)).toBe("1.5");
    expect(toHuman(1_234_567n, 6)).toBe("1.234567");
    expect(toHuman(123n, 0)).toBe("123");
  });

  it("prints a sign, though toBase never accepts one", () => {
    expect(toHuman(-1_500_000n, 6)).toBe("-1.5");
  });

  it("refuses impossible decimals", () => {
    expect(() => toHuman(1n, -1)).toThrow(RangeError);
    expect(() => toHuman(1n, 1.5)).toThrow(RangeError);
  });
});

describe("priceImpactPct", () => {
  it("is zero when the realised rate equals the pool's stored price", () => {
    // Stored price 2 quote per token. Buy: 2 quote in, 1 token out.
    expect(priceImpactPct(2n * ONE, ONE, 18, 18, 2, true)).toBeCloseTo(0, 12);
    // Sell: 1 token in, 2 quote out.
    expect(priceImpactPct(ONE, 2n * ONE, 18, 18, 2, false)).toBeCloseTo(0, 12);
  });

  it("is positive when the swap is worse than the stored price, in both directions", () => {
    expect(priceImpactPct(21n * 10n ** 17n, ONE, 18, 18, 2, true)).toBeCloseTo(5, 12); // paid 2.1 for one token
    expect(priceImpactPct(ONE, 19n * 10n ** 17n, 18, 18, 2, false)).toBeCloseTo((2 / 1.9 - 1) * 100, 12);
  });

  it("is negative when a stale stored price reads worse than the pool", () => {
    expect(priceImpactPct(19n * 10n ** 17n, ONE, 18, 18, 2, true)).toBeCloseTo(-5, 12);
  });

  it("scales each side by its own decimals", () => {
    // 2.1 USDG (6 decimals) for one 18-decimal token, stored price 2.
    expect(priceImpactPct(2_100_000n, ONE, 6, 18, 2, true)).toBeCloseTo(5, 12);
  });

  it("returns 0 rather than Infinity or NaN on a degenerate input", () => {
    expect(priceImpactPct(0n, ONE, 18, 18, 2, true)).toBe(0);
    expect(priceImpactPct(ONE, 0n, 18, 18, 2, true)).toBe(0);
    expect(priceImpactPct(ONE, ONE, 18, 18, 0, true)).toBe(0);
    expect(priceImpactPct(ONE, ONE, 18, 18, Number.NaN, false)).toBe(0);
  });
});
```

Run: `npx vitest run src/lib/quote/math.test.ts`
Expected: FAIL, "Cannot find module ./math".

- [ ] **Step 2: Write `src/lib/quote/math.ts`**

`src/lib/quote/math.ts`:

```ts
/**
 * Quote arithmetic in base units. Every amount is a bigint: a float never holds an amount the
 * chain will see. Rounding always favours the pool — the fee floors, the gross-up ceilings and
 * `withSlippage` floors — so no rounding here can revert a swap on the user's behalf.
 */

/** SVRouter takes 0.5 % of the input before the swap (contracts spec section 5, D34). */
export const ROUTER_FEE_BPS = 50;
/** A Suits NFT holder pays no router fee. */
export const HOLDER_FEE_BPS = 0;

const BPS = 10_000n;
/** Generous: no listed token is past 18, and the ceiling still catches a swapped argument. */
const MAX_DECIMALS = 36;
/** Digits with an optional point. No sign, no exponent, no separators, no whitespace: a typed amount is a positive decimal or it is junk. */
const DECIMAL = /^(?:\d+|\d*\.\d+|\d+\.\d*)$/;

function checkBps(name: string, bps: number, max: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > max) throw new RangeError(`${name}: ${bps} is not an integer in 0..${max}`);
  return BigInt(bps);
}

function checkDecimals(decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(`decimals: ${decimals} is not an integer in 0..${MAX_DECIMALS}`);
  }
  return decimals;
}

/** The router's fee and what reaches the pool. Floors, as the contract's integer division does, so one wei pays nothing. */
export function feeFor(amountIn: bigint, feeBps: number): { fee: bigint; net: bigint } {
  if (amountIn < 0n) throw new RangeError("feeFor: amountIn is negative");
  const bps = checkBps("feeFor", feeBps, 9_999);
  const fee = (amountIn * bps) / BPS;
  return { fee, net: amountIn - fee };
}

/** The input whose net is at least `net`. Ceilings: flooring here would hand the pool a wei less than the quote promised. */
export function grossUp(net: bigint, feeBps: number): bigint {
  if (net < 0n) throw new RangeError("grossUp: net is negative");
  const bps = checkBps("grossUp", feeBps, 9_999);
  const denominator = BPS - bps;
  return (net * BPS + denominator - 1n) / denominator;
}

/** The least output the user will accept. Floors: rounding up would revert the swap for a wei. */
export function withSlippage(amountOut: bigint, slippageBps: number): bigint {
  if (amountOut < 0n) throw new RangeError("withSlippage: amountOut is negative");
  const bps = checkBps("withSlippage", slippageBps, 10_000);
  return (amountOut * (BPS - bps)) / BPS;
}

/**
 * How far the realised rate is from the pool's stored `price_quote`, in percent, signed: a stale
 * stored price can read better than the pool and that is worth showing. Both directions are
 * converted to quote-per-token first, so a buy and a sell are measured the same way. Display only
 * — a float never decides an amount — and 0 for a degenerate input rather than Infinity or NaN.
 */
export function priceImpactPct(
  amountIn: bigint,
  amountOut: bigint,
  inDecimals: number,
  outDecimals: number,
  poolPriceQuote: number,
  payingQuote: boolean,
): number {
  checkDecimals(inDecimals);
  checkDecimals(outDecimals);
  if (amountIn <= 0n || amountOut <= 0n || !(poolPriceQuote > 0)) return 0;
  const inHuman = Number(amountIn) / 10 ** inDecimals;
  const outHuman = Number(amountOut) / 10 ** outDecimals;
  const realised = payingQuote ? inHuman / outHuman : outHuman / inHuman;
  if (!Number.isFinite(realised) || realised <= 0) return 0;
  // Paying the quote, a higher realised price is worse; paying the token, a lower one is.
  return payingQuote ? (realised / poolPriceQuote - 1) * 100 : (poolPriceQuote / realised - 1) * 100;
}

/**
 * A typed decimal string in base units. Digits past the token's decimals are truncated, never
 * rounded up: 100 % of a balance must stay inside that balance, because this number is what
 * Permit2 transfers.
 */
export function toBase(human: string, decimals: number): bigint {
  checkDecimals(decimals);
  if (!DECIMAL.test(human)) throw new RangeError(`toBase: ${JSON.stringify(human)} is not a decimal amount`);
  const [whole = "", fraction = ""] = human.split(".");
  const scaled = `${whole}${fraction.slice(0, decimals).padEnd(decimals, "0")}`;
  return scaled === "" ? 0n : BigInt(scaled);
}

/**
 * Base units as a decimal string, at any size and with no exponent notation: `Number` prints
 * 1e-18 for a wei, and the route's JSON must stay parseable as a decimal. A negative prints its
 * sign, though `toBase` never accepts one — a display helper has to be total.
 */
export function toHuman(base: bigint, decimals: number): string {
  checkDecimals(decimals);
  const negative = base < 0n;
  const digits = (negative ? -base : base).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}
```

Run: `npx vitest run src/lib/quote/math.test.ts`
Expected: PASS (28 tests).

- [ ] **Step 3: Write the failing quoter test**

`src/lib/quote/quoter.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ContractFunctionRevertedError, ContractFunctionZeroDataError, type PublicClient } from "viem";
import { V4_QUOTER_ADDRESS } from "@/lib/chain";
import type { PoolKeyRow } from "@/lib/market/poolKey";
import { NotRoutableError, QUOTER_ABI, createQuoter } from "./quoter";

// The AI/NVDA pool as `cast call` reported it on 18 Sep 2026, numbers included.
const AI = "0x68082b7ea5ee83ca3bd992f038ef02c0180b9ba3";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const HOOK = "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544";
const POOL = "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27";
const pool: PoolKeyRow = {
  poolId: POOL, currency0: AI, currency1: NVDA, fee: 8388608, tickSpacing: 200, hooks: HOOK,
  tokenIsCurrency0: true, priceQuote: 0.000866,
  tokenAddress: AI, tokenDecimals: 18, quoteAddress: NVDA, quoteDecimals: 18,
};
const KEY = { currency0: AI, currency1: NVDA, fee: 8388608, tickSpacing: 200, hooks: HOOK };

function fake() {
  const simulateContract = vi.fn();
  return { simulateContract, client: { simulateContract } as unknown as PublicClient };
}

describe("createQuoter", () => {
  it("simulates quoteExactInputSingle and returns the output, dropping the gas estimate", async () => {
    const { simulateContract, client } = fake();
    simulateContract.mockResolvedValue({ result: [1_627_596_220_751_955_204_094_325_495n, 82_000n] });
    const out = await createQuoter({ client }).exactIn({ poolKey: pool, zeroForOne: false, exactAmount: 10n ** 18n });
    expect(out).toBe(1_627_596_220_751_955_204_094_325_495n);
    expect(simulateContract).toHaveBeenCalledWith({
      address: V4_QUOTER_ADDRESS,
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: KEY, zeroForOne: false, exactAmount: 10n ** 18n, hookData: "0x" }],
    });
  });

  it("simulates quoteExactOutputSingle for the input an exact output needs", async () => {
    const { simulateContract, client } = fake();
    simulateContract.mockResolvedValue({ result: [499_933_845_289n, 91_000n] });
    const need = await createQuoter({ client }).exactOut({ poolKey: pool, zeroForOne: false, exactAmount: 10n ** 21n });
    expect(need).toBe(499_933_845_289n);
    expect(simulateContract).toHaveBeenCalledWith({
      address: V4_QUOTER_ADDRESS,
      abi: QUOTER_ABI,
      functionName: "quoteExactOutputSingle",
      args: [{ poolKey: KEY, zeroForOne: false, exactAmount: 10n ** 21n, hookData: "0x" }],
    });
  });

  it("sends the PoolKey's five fields and nothing else: decimals and the stored price never reach the chain", async () => {
    const { simulateContract, client } = fake();
    simulateContract.mockResolvedValue({ result: [1n, 1n] });
    await createQuoter({ client }).exactIn({ poolKey: pool, zeroForOne: true, exactAmount: 1n });
    const [call] = simulateContract.mock.calls[0]!;
    expect(Object.keys(call.args[0].poolKey)).toEqual(["currency0", "currency1", "fee", "tickSpacing", "hooks"]);
    expect(Object.keys(call.args[0])).toEqual(["poolKey", "zeroForOne", "exactAmount", "hookData"]);
  });

  it("carries the ABI the chain was probed with: nonpayable, one tuple in, two words out", () => {
    // Indexed, not searched: `find` would hand back a union of the two fragments and `.map` on a union of tuples does not typecheck.
    const [exactIn, exactOut] = QUOTER_ABI;
    expect(exactIn.name).toBe("quoteExactInputSingle");
    expect(exactOut.name).toBe("quoteExactOutputSingle");
    // Both revert to return their value, so a view call would be refused and `simulateContract` is the only way to read them.
    expect(exactIn.stateMutability).toBe("nonpayable");
    expect(exactOut.stateMutability).toBe("nonpayable");
    expect(exactIn.outputs.map((o) => o.type)).toEqual(["uint256", "uint256"]);
    expect(exactOut.outputs.map((o) => o.type)).toEqual(["uint256", "uint256"]);
    expect(exactIn.inputs[0].components.map((c) => c.type)).toEqual(["tuple", "bool", "uint128", "bytes"]);
    expect(exactIn.inputs[0].components[0].components.map((c) => c.type)).toEqual(["address", "address", "uint24", "int24", "address"]);
  });

  it("turns a revert into NotRoutableError, on either function", async () => {
    const { simulateContract, client } = fake();
    simulateContract.mockRejectedValue(
      new ContractFunctionRevertedError({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", message: "execution reverted" }),
    );
    const quoter = createQuoter({ client });
    await expect(quoter.exactIn({ poolKey: pool, zeroForOne: true, exactAmount: 1n })).rejects.toBeInstanceOf(NotRoutableError);
    await expect(quoter.exactOut({ poolKey: pool, zeroForOne: true, exactAmount: 1n })).rejects.toBeInstanceOf(NotRoutableError);
  });

  it("turns an empty answer — nothing deployed at the address — into NotRoutableError", async () => {
    const { simulateContract, client } = fake();
    simulateContract.mockRejectedValue(new ContractFunctionZeroDataError({ functionName: "quoteExactOutputSingle" }));
    await expect(createQuoter({ client }).exactOut({ poolKey: pool, zeroForOne: true, exactAmount: 1n })).rejects.toBeInstanceOf(NotRoutableError);
  });

  it("names no address in the message it hands the route", async () => {
    const { simulateContract, client } = fake();
    simulateContract.mockRejectedValue(new ContractFunctionRevertedError({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", message: "execution reverted" }));
    const err = await createQuoter({ client }).exactIn({ poolKey: pool, zeroForOne: true, exactAmount: 1n }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("the pool cannot be routed");
    expect((err as Error).name).toBe("NotRoutableError");
  });

  it("lets a transport failure travel as itself, so the route answers 503 rather than 'not routed'", async () => {
    const { simulateContract, client } = fake();
    simulateContract.mockRejectedValue(new Error("fetch failed"));
    const err = await createQuoter({ client }).exactIn({ poolKey: pool, zeroForOne: true, exactAmount: 1n }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(NotRoutableError);
    expect((err as Error).message).toBe("fetch failed");
  });

  it("refuses an amount the Quoter's uint128 cannot hold, before any RPC call", async () => {
    const { simulateContract, client } = fake();
    const quoter = createQuoter({ client });
    await expect(quoter.exactIn({ poolKey: pool, zeroForOne: true, exactAmount: 0n })).rejects.toBeInstanceOf(RangeError);
    await expect(quoter.exactIn({ poolKey: pool, zeroForOne: true, exactAmount: -1n })).rejects.toBeInstanceOf(RangeError);
    await expect(quoter.exactOut({ poolKey: pool, zeroForOne: true, exactAmount: 1n << 128n })).rejects.toBeInstanceOf(RangeError);
    expect(simulateContract).not.toHaveBeenCalled();
  });
});
```

Run: `npx vitest run src/lib/quote/quoter.test.ts`
Expected: FAIL, "Cannot find module ./quoter".

- [ ] **Step 4: Write `src/lib/quote/quoter.ts`**

`src/lib/quote/quoter.ts`:

```ts
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  http,
  type PublicClient,
} from "viem";
import { V4_QUOTER_ADDRESS, robinhoodChain } from "@/lib/chain";
import type { PoolKeyRow } from "@/lib/market/poolKey";
import type { Address } from "@/lib/types";

/**
 * IV4Quoter, as `cast call` reported it on 4663 (18 Sep 2026):
 *   quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))
 *   quoteExactOutputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))
 * Both are non-view — they run the swap and revert with the encoded result, which the Quoter's own
 * entry point catches and returns — so `simulateContract` is the right call and `readContract`
 * would refuse them. Each answers two words, `(amount, gasEstimate)`, which arrive as `result`.
 */
export const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "quoteExactOutputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export type QuoterCall = { poolKey: PoolKeyRow; zeroForOne: boolean; exactAmount: bigint };

export interface Quoter {
  /** Output for an exact input. Throws NotRoutableError when the pool cannot be routed. */
  exactIn(call: QuoterCall): Promise<bigint>;
  /** Input an exact output needs. Throws NotRoutableError when the pool cannot be routed. */
  exactOut(call: QuoterCall): Promise<bigint>;
}

/** The pool cannot be routed: the Quoter reverted with something other than its own return value. Carries no address, by rule 4. */
export class NotRoutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotRoutableError";
  }
}

const UINT128_MAX = (1n << 128n) - 1n;
/** These pools' hooks read the swap, not an argument. */
const NO_HOOK_DATA = "0x" as const;

type ExactSingleParams = {
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  zeroForOne: boolean;
  exactAmount: bigint;
  hookData: `0x${string}`;
};

/** The Quoter's parameter, and only it: the row's decimals and stored price stay on the server. */
function paramsOf(call: QuoterCall): readonly [ExactSingleParams] {
  if (call.exactAmount <= 0n || call.exactAmount > UINT128_MAX) {
    throw new RangeError("quoter: exactAmount must be a positive uint128");
  }
  const k = call.poolKey;
  return [
    {
      poolKey: { currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks },
      zeroForOne: call.zeroForOne,
      exactAmount: call.exactAmount,
      hookData: NO_HOOK_DATA,
    },
  ];
}

/**
 * A revert — a hook rejecting the swap, a pool with no liquidity, a pair that is not a pool — means
 * "not routable". Anything else (an unreachable RPC, a timeout) travels as itself, so the route can
 * tell 200 `{ routable: false }` from 503.
 */
function quoterError(err: unknown): unknown {
  const reverted =
    err instanceof BaseError &&
    err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) !== null;
  return reverted ? new NotRoutableError("the pool cannot be routed") : err;
}

/** Talks to the V4 Quoter at `V4_QUOTER_ADDRESS`. The tests inject `client`; production builds one on the chain's RPC. */
export function createQuoter(opts: { client?: PublicClient } = {}): Quoter {
  const client = opts.client ?? createPublicClient({ chain: robinhoodChain, transport: http() });
  return {
    async exactIn(call) {
      try {
        const { result } = await client.simulateContract({
          address: V4_QUOTER_ADDRESS,
          abi: QUOTER_ABI,
          functionName: "quoteExactInputSingle",
          args: paramsOf(call),
        });
        return result[0];
      } catch (err) {
        throw quoterError(err);
      }
    },
    async exactOut(call) {
      try {
        const { result } = await client.simulateContract({
          address: V4_QUOTER_ADDRESS,
          abi: QUOTER_ABI,
          functionName: "quoteExactOutputSingle",
          args: paramsOf(call),
        });
        return result[0];
      } catch (err) {
        throw quoterError(err);
      }
    },
  };
}
```

Run: `npx vitest run src/lib/quote`
Expected: PASS, both files, 37 tests, and no network access — `createQuoter` is never called without a client.

- [ ] **Step 5: Run the gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green. `grep -c "Number(" src/lib/quote/math.ts` answers 2, both inside `priceImpactPct`: no amount on the execution path passes through a float.

- [ ] **Step 6: Commit**

```bash
git add src/lib/quote/math.ts src/lib/quote/math.test.ts src/lib/quote/quoter.ts src/lib/quote/quoter.test.ts
git commit -m "Add the bigint quote math and the V4 Quoter simulation client" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---
### Task 3: The pricing brain and the quote route

**Files:**
- Create: `src/lib/quote/price.ts`, `src/app/api/tokens/[address]/quote/route.ts`
- Test: `src/lib/quote/price.test.ts`, `src/app/api/tokens/[address]/quote/route.test.ts`

**Interfaces:**
- Consumes: `PoolKeyRow` from `src/lib/market/poolKey.ts` and `MarketBackend.poolKey(tokenId)` through `getBackend()` from `src/lib/market/backend.ts` (Task 1); `ROUTER_FEE_BPS`, `HOLDER_FEE_BPS`, `feeFor`, `grossUp`, `withSlippage`, `priceImpactPct`, `toBase`, `toHuman` from `src/lib/quote/math.ts` and `Quoter`, `QuoterCall`, `NotRoutableError`, `createQuoter` from `src/lib/quote/quoter.ts` (Task 2); `badRequest`, `failure`, `isAddress` from `src/app/api/_lib/respond.ts`; `ttlCache`, `clearTtlCache` from `src/lib/envio/cache.ts`; `Address`, `Denom`, `Side` from `src/lib/types.ts`; `DbUnavailableError` from `src/lib/db/client.ts` (test only).
- Produces: `PriceRequest`, `PriceResult`, `SwapCall`, `priceSwap` from `src/lib/quote/price.ts`; `GET`, `dynamic`, `maxDuration` from `src/app/api/tokens/[address]/quote/route.ts`. Signatures exactly as in the contract. Task 4 consumes `SwapCall`; Task 5 consumes the route.

Decisions where the contract is silent (each one line):
- `denom` names the pay side when `denom === (side === "buy" ? "quote" : "token")`, since a buy pays the quote asset and a sell pays the pair token; everything else is the inverted path.
- `priceImpactPct` is fed `net`, not `amountIn`: the pool only ever saw the amount after the router fee, and charging the fee to price impact would show 0.5 % of slippage that no pool caused.
- `poolFeePct` is `pool.fee / 10_000`, because a v4 `fee` is hundredths of a basis point (3000 is 0.30 %).
- A quoter answer of `0` is an honest zero, not "not routable" (contract rule 5 reads both ways); only `NotRoutableError` produces `{ routable: false }`, so one dust-sized quote can never cache a live pool as dead.
- `amountIn <= 0n` throws `RangeError` from `priceSwap` as `toBase` does for junk, and the route turns any `RangeError` into its `bad amount` 400, so the brain is safe to call directly from a script.
- A pool row whose `currency0`/`currency1` carry neither pay asset throws a plain `Error` (→ 500): that is a broken row in the store, not a user mistake. Its message names no address (rule 4).
- The route detects a dead RPC itself and answers 503 `{ error: "rpc unavailable" }`: `failure()` maps only `DbUnavailableError` and `EnvioUnavailableError` to 503, and a viem transport failure would otherwise leave as a 500. Everything else still goes through `failure()`.
- The D28 cache is a load-through: the first quote for a pool prices inside the `ttlCache` loader and returns only the boolean, so a pool already known to be unroutable answers without an RPC call, and a routable pool is re-priced on every request. No priced answer is ever cached.
- Every answer, including the 404, is `Cache-Control: no-store`: a price is never a CDN fact.
- The tests read the human fields through `Number()`. `toHuman`'s exact spelling (trailing zeros or not) is `math.ts`'s business and its own test's; the base-unit fields in `call` are asserted as exact strings because this task produces them.

- [ ] **Step 1: Write the failing priceSwap test**

`src/lib/quote/price.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { PoolKeyRow } from "@/lib/market/poolKey";
import type { Address } from "@/lib/types";
import { NotRoutableError, type Quoter, type QuoterCall } from "./quoter";
import { priceSwap, type PriceRequest, type PriceResult } from "./price";

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const QUOTE = "0x2222222222222222222222222222222222222222" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * The token is currency0, so a buy (paying the quote asset) is one-for-zero and a sell is
 * zero-for-one; both directions are exercised. The quote asset carries 6 decimals and the token 18,
 * so a decimals mix-up cannot pass. At the stored price one token costs 0.5 quote.
 */
const POOL: PoolKeyRow = {
  poolId: `0x${"ab".repeat(32)}` as Address,
  currency0: TOKEN,
  currency1: QUOTE,
  fee: 3000,
  tickSpacing: 60,
  hooks: ZERO,
  tokenIsCurrency0: true,
  priceQuote: 0.5,
  tokenAddress: TOKEN,
  tokenDecimals: 18,
  quoteAddress: QUOTE,
  quoteDecimals: 6,
};

type Answer = bigint | Error;
type Recorded = { fn: "exactIn" | "exactOut"; zeroForOne: boolean; exactAmount: bigint; poolId: Address };

/** Answers in order; an Error entry is thrown instead of returned, so a revert is one list entry. */
function fakeQuoter(answers: Answer[]): { quoter: Quoter; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let i = 0;
  const next = (fn: "exactIn" | "exactOut", call: QuoterCall): bigint => {
    calls.push({ fn, zeroForOne: call.zeroForOne, exactAmount: call.exactAmount, poolId: call.poolKey.poolId });
    const answer = answers[i++];
    if (answer === undefined) throw new Error(`the fake quoter has no answer for call ${i}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return {
    calls,
    quoter: {
      exactIn: async (call) => next("exactIn", call),
      exactOut: async (call) => next("exactOut", call),
    },
  };
}

const req = (over: Partial<PriceRequest> = {}): PriceRequest => ({
  side: "buy",
  amount: "100",
  denom: "quote",
  slippageBps: 100,
  holder: false,
  pool: POOL,
  ...over,
});

/** Narrows and fails loudly, so a routable:false regression does not read as a missing field. */
function routable(result: PriceResult) {
  if (!result.routable) throw new Error("expected a routable quote");
  return result;
}

describe("priceSwap", () => {
  it("buys with the quote asset, taking the 0.5 % fee off the input before the swap", async () => {
    const { quoter, calls } = fakeQuoter([199n * 10n ** 18n]);
    const res = routable(await priceSwap(quoter, req()));
    // 100 quote in, 0.5 quote of fee, 99.5 quote reaching the pool.
    expect(calls).toEqual([
      { fn: "exactIn", zeroForOne: false, exactAmount: 99_500_000n, poolId: POOL.poolId },
    ]);
    expect(res.routerFeePct).toBe(0.5);
    expect(res.poolFeePct).toBe(0.3);
    expect([Number(res.payAmount), Number(res.receiveAmount), Number(res.minReceived), Number(res.routerFeeAmount)])
      .toEqual([100, 199, 197.01, 0.5]);
    expect(res.call).toEqual({
      poolKey: { currency0: TOKEN, currency1: QUOTE, fee: 3000, tickSpacing: 60, hooks: ZERO },
      zeroForOne: false,
      amountIn: "100000000",
      amountOutMin: "197010000000000000000",
      tokenIn: QUOTE,
      tokenOut: TOKEN,
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
    });
    // 99.5 quote for 199 tokens is exactly the stored 0.5: impact is measured on what the pool saw,
    // not on what the wallet paid. Computing it on amountIn would read about +0.5 % here.
    expect(res.priceImpactPct).toBeCloseTo(0, 6);
  });

  it("charges a Suits holder nothing, so the whole input reaches the pool", async () => {
    const { quoter, calls } = fakeQuoter([200n * 10n ** 18n]);
    const res = routable(await priceSwap(quoter, req({ holder: true })));
    expect(calls[0].exactAmount).toBe(100_000_000n);
    expect(res.routerFeePct).toBe(0);
    expect(Number(res.routerFeeAmount)).toBe(0);
    expect(Number(res.receiveAmount)).toBe(200);
    expect(res.call.amountIn).toBe("100000000");
    expect(res.priceImpactPct).toBeCloseTo(0, 6);
  });

  it("sells the pair token, which is currency0, so the swap is zero-for-one", async () => {
    const { quoter, calls } = fakeQuoter([49_750_000n]);
    const res = routable(await priceSwap(quoter, req({ side: "sell", denom: "token" })));
    expect(calls).toEqual([
      { fn: "exactIn", zeroForOne: true, exactAmount: 99_500_000_000_000_000_000n, poolId: POOL.poolId },
    ]);
    expect(res.call.tokenIn).toBe(TOKEN);
    expect(res.call.tokenOut).toBe(QUOTE);
    expect(res.call.tokenInDecimals).toBe(18);
    expect(res.call.tokenOutDecimals).toBe(6);
    expect([Number(res.payAmount), Number(res.receiveAmount)]).toEqual([100, 49.75]);
    expect(res.call.amountOutMin).toBe("49252500");
    expect(res.priceImpactPct).toBeCloseTo(0, 6);
  });

  it("inverts a buy typed in the token: exact-output, gross up past the fee, then re-quote exact-in", async () => {
    // The pool needs 99.6 quote net for the 200 tokens asked; grossed up that is 100.100503 quote,
    // whose net of 99.600001 buys a shade more than the 200 typed — and that is what is reported.
    const { quoter, calls } = fakeQuoter([99_600_000n, 200_001_000_000_000_000_000n]);
    const res = routable(await priceSwap(quoter, req({ side: "buy", denom: "token", amount: "200" })));
    expect(calls).toEqual([
      { fn: "exactOut", zeroForOne: false, exactAmount: 200n * 10n ** 18n, poolId: POOL.poolId },
      { fn: "exactIn", zeroForOne: false, exactAmount: 99_600_001n, poolId: POOL.poolId },
    ]);
    // ceil(99_600_000 * 10000 / 9950) = 100_100_503; floor(100_100_503 * 50 / 10000) = 500_502.
    expect(res.call.amountIn).toBe("100100503");
    expect(Number(res.routerFeeAmount)).toBe(0.500502);
    expect(Number(res.payAmount)).toBe(100.100503);
    expect(Number(res.receiveAmount)).toBe(200.001);
    expect(res.call.amountOutMin).toBe("198000990000000000000");
  });

  it("inverts a sell typed in the quote asset the same way", async () => {
    const { quoter, calls } = fakeQuoter([100n * 10n ** 18n, 50_000_100n]);
    const res = routable(await priceSwap(quoter, req({ side: "sell", denom: "quote", amount: "50" })));
    expect(calls[0]).toEqual({ fn: "exactOut", zeroForOne: true, exactAmount: 50_000_000n, poolId: POOL.poolId });
    // ceil(100e18 * 10000 / 9950) = 100502512562814070352, whose net is 100000000000000000001 — never
    // below the 100e18 the pool asked for, because the gross-up ceilings and the fee floors.
    expect(res.call.amountIn).toBe("100502512562814070352");
    expect(calls[1]).toEqual({
      fn: "exactIn",
      zeroForOne: true,
      exactAmount: 100_000_000_000_000_000_001n,
      poolId: POOL.poolId,
    });
    expect(Number(res.receiveAmount)).toBe(50.0001);
  });

  it("reports not routable when the quoter refuses the pool, on either leg", async () => {
    const direct = fakeQuoter([new NotRoutableError("pool cannot be routed")]);
    expect(await priceSwap(direct.quoter, req())).toEqual({ routable: false });

    const inverted = fakeQuoter([new NotRoutableError("pool cannot be routed")]);
    expect(await priceSwap(inverted.quoter, req({ denom: "token" }))).toEqual({ routable: false });
    expect(inverted.calls).toHaveLength(1); // the exact-out leg failed; no second call was made
  });

  it("lets a failure that is not a routability verdict through", async () => {
    const { quoter } = fakeQuoter([new Error("rpc unreachable")]);
    await expect(priceSwap(quoter, req())).rejects.toThrow("rpc unreachable");
  });

  it("refuses an amount of zero before asking the quoter", async () => {
    const { quoter, calls } = fakeQuoter([]);
    await expect(priceSwap(quoter, req({ amount: "0" }))).rejects.toBeInstanceOf(RangeError);
    await expect(priceSwap(quoter, req({ amount: "0.0", denom: "token" }))).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a pool row whose key does not carry the pay asset", async () => {
    const { quoter, calls } = fakeQuoter([]);
    const broken: PoolKeyRow = { ...POOL, currency0: ZERO, currency1: ZERO };
    await expect(priceSwap(quoter, req({ pool: broken }))).rejects.toThrow(/pool key/);
    expect(calls).toHaveLength(0);
  });
});
```

Run: `npx vitest run src/lib/quote/price.test.ts`
Expected: FAIL, `Cannot find module './price'` (Vitest 4's wording; `./quoter` and `./math` already exist from Task 2).

- [ ] **Step 2: Write the pricing brain**

`src/lib/quote/price.ts`:

```ts
import type { PoolKeyRow } from "@/lib/market/poolKey";
import type { Address, Denom, Side } from "@/lib/types";
import {
  HOLDER_FEE_BPS,
  ROUTER_FEE_BPS,
  feeFor,
  grossUp,
  priceImpactPct,
  toBase,
  toHuman,
  withSlippage,
} from "./math";
import { NotRoutableError, type Quoter } from "./quoter";

export type PriceRequest = {
  side: Side;
  amount: string;
  denom: Denom;
  slippageBps: number;
  holder: boolean;
  pool: PoolKeyRow;
};

export type SwapCall = {
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  zeroForOne: boolean;
  amountIn: string;
  amountOutMin: string;
  tokenIn: Address;
  tokenOut: Address;
  tokenInDecimals: number;
  tokenOutDecimals: number;
};

export type PriceResult =
  | { routable: false }
  | {
      routable: true;
      payAmount: string;
      receiveAmount: string;
      minReceived: string;
      routerFeePct: 0 | 0.5;
      routerFeeAmount: string;
      poolFeePct: number;
      priceImpactPct: number;
      call: SwapCall;
    };

/** Which way round the trade runs, decided once and used by both legs. */
type Direction = {
  tokenIn: Address;
  tokenOut: Address;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  zeroForOne: boolean;
  feeBps: number;
  /** true when `amount` names the asset leaving the wallet, false when it names the one arriving. */
  typedThePaySide: boolean;
};

/** What the quoter settled: the amounts the call block and the display are both built from. */
type Priced = { amountIn: bigint; fee: bigint; net: bigint; amountOut: bigint };

function direction(req: PriceRequest): Direction {
  const { pool, side, denom, holder } = req;
  // A buy pays the quote asset and receives the pair token; a sell is the other way round.
  const buy = side === "buy";
  const tokenIn = buy ? pool.quoteAddress : pool.tokenAddress;
  const tokenOut = buy ? pool.tokenAddress : pool.quoteAddress;
  const zeroForOne = tokenIn === pool.currency0;
  if (!zeroForOne && tokenIn !== pool.currency1) {
    // Every address in the store is lowercase, so this is a broken row, not a user mistake.
    // The message names no address: rule 4.
    throw new Error("pool key does not carry the pay asset");
  }
  return {
    tokenIn,
    tokenOut,
    tokenInDecimals: buy ? pool.quoteDecimals : pool.tokenDecimals,
    tokenOutDecimals: buy ? pool.tokenDecimals : pool.quoteDecimals,
    zeroForOne,
    feeBps: holder ? HOLDER_FEE_BPS : ROUTER_FEE_BPS,
    typedThePaySide: denom === (buy ? "quote" : "token"),
  };
}

/**
 * The router is exact-input only, so a number typed on the receive side is inverted:
 * `quoteExactOutputSingle` gives the net input the pool needs, the gross-up puts the fee back on top,
 * and the amount reported to the user is a fresh exact-in quote of that gross amount's net — the
 * amount they will really receive, not the one they typed. The gross-up ceilings and the fee floors,
 * so the re-quoted net is never below what the pool asked for.
 */
async function quote(q: Quoter, req: PriceRequest, d: Direction): Promise<Priced> {
  const { pool } = req;
  if (d.typedThePaySide) {
    const amountIn = toBase(req.amount, d.tokenInDecimals);
    if (amountIn <= 0n) throw new RangeError("amount must be greater than zero");
    const { fee, net } = feeFor(amountIn, d.feeBps);
    const amountOut = await q.exactIn({ poolKey: pool, zeroForOne: d.zeroForOne, exactAmount: net });
    return { amountIn, fee, net, amountOut };
  }
  const wanted = toBase(req.amount, d.tokenOutDecimals);
  if (wanted <= 0n) throw new RangeError("amount must be greater than zero");
  const needed = await q.exactOut({ poolKey: pool, zeroForOne: d.zeroForOne, exactAmount: wanted });
  const amountIn = grossUp(needed, d.feeBps);
  const { fee, net } = feeFor(amountIn, d.feeBps);
  const amountOut = await q.exactIn({ poolKey: pool, zeroForOne: d.zeroForOne, exactAmount: net });
  return { amountIn, fee, net, amountOut };
}

/**
 * One priced swap, with no I/O of its own: the `Quoter` is the only seam, so the whole brain runs
 * against a fake in tests and against `simulateContract` in the route.
 */
export async function priceSwap(q: Quoter, req: PriceRequest): Promise<PriceResult> {
  const { pool, holder, slippageBps } = req;
  const d = direction(req);
  const priced = await quote(q, req, d).catch((err: unknown) => {
    // Contract rule 5: only the quoter's own verdict means "not routable". Anything else is a
    // failure to ask, and the route must answer 503 rather than pretend the pool is dead.
    if (err instanceof NotRoutableError) return null;
    throw err;
  });
  if (!priced) return { routable: false };

  const amountOutMin = withSlippage(priced.amountOut, slippageBps);
  return {
    routable: true,
    payAmount: toHuman(priced.amountIn, d.tokenInDecimals),
    receiveAmount: toHuman(priced.amountOut, d.tokenOutDecimals),
    minReceived: toHuman(amountOutMin, d.tokenOutDecimals),
    routerFeePct: holder ? 0 : 0.5,
    routerFeeAmount: toHuman(priced.fee, d.tokenInDecimals),
    // A v4 fee is hundredths of a basis point: 3000 is 0.30 %.
    poolFeePct: pool.fee / 10_000,
    // Measured on `net`: the pool never saw the router's fee, so the fee is not price impact.
    priceImpactPct: priceImpactPct(
      priced.net,
      priced.amountOut,
      d.tokenInDecimals,
      d.tokenOutDecimals,
      pool.priceQuote,
      req.side === "buy",
    ),
    call: {
      poolKey: {
        currency0: pool.currency0,
        currency1: pool.currency1,
        fee: pool.fee,
        tickSpacing: pool.tickSpacing,
        hooks: pool.hooks,
      },
      zeroForOne: d.zeroForOne,
      amountIn: priced.amountIn.toString(),
      amountOutMin: amountOutMin.toString(),
      tokenIn: d.tokenIn,
      tokenOut: d.tokenOut,
      tokenInDecimals: d.tokenInDecimals,
      tokenOutDecimals: d.tokenOutDecimals,
    },
  };
}
```

Run: `npx vitest run src/lib/quote/price.test.ts`
Expected: PASS (9 tests). If the two `priceImpactPct` assertions fail while everything else passes, `math.ts`'s formula disagrees about which side `payingQuote` names — fix `math.ts`, not the call: a quote of exactly the stored price must read zero impact in both directions.

- [ ] **Step 3: Write the failing quote route test**

`src/app/api/tokens/[address]/quote/route.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpRequestError } from "viem";
import { DbUnavailableError } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import type { PoolKeyRow } from "@/lib/market/poolKey";
// The mock below spreads the real module, so this is the very class priceSwap checks against.
import { NotRoutableError, type QuoterCall } from "@/lib/quote/quoter";
import type { Address } from "@/lib/types";
import { GET } from "./route";

const { poolKey, exactIn, exactOut } = vi.hoisted(() => ({
  poolKey: vi.fn<(id: string) => Promise<PoolKeyRow | null>>(),
  exactIn: vi.fn<(call: QuoterCall) => Promise<bigint>>(),
  exactOut: vi.fn<(call: QuoterCall) => Promise<bigint>>(),
}));
vi.mock("@/lib/market/backend", () => ({ getBackend: () => ({ kind: "db", poolKey }) }));
// Only the factory is replaced: importOriginal keeps NotRoutableError the very class priceSwap
// checks with `instanceof`, so the not-routable path is the real one.
vi.mock("@/lib/quote/quoter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/quote/quoter")>()),
  createQuoter: () => ({ exactIn, exactOut }),
}));

const ADDR = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const QUOTE = "0x2222222222222222222222222222222222222222" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const POOL: PoolKeyRow = {
  poolId: `0x${"ab".repeat(32)}` as Address,
  currency0: TOKEN,
  currency1: QUOTE,
  fee: 3000,
  tickSpacing: 60,
  hooks: ZERO,
  tokenIsCurrency0: true,
  priceQuote: 0.5,
  tokenAddress: TOKEN,
  tokenDecimals: 18,
  quoteAddress: QUOTE,
  quoteDecimals: 6,
};

const OK = "side=buy&amount=100&denom=quote&slippageBps=100";
const call = (address: string, query: string) =>
  GET(new Request(`http://localhost:3000/api/tokens/${address}/quote?${query}`), {
    params: Promise.resolve({ address }),
  });

describe("GET /api/tokens/[address]/quote", () => {
  beforeEach(() => {
    clearTtlCache();
    poolKey.mockReset();
    exactIn.mockReset();
    exactOut.mockReset();
    poolKey.mockResolvedValue(POOL);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("rejects a malformed address before touching the backend", async () => {
    const res = await call("not-an-address", OK);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad address" });
    expect(poolKey).not.toHaveBeenCalled();
  });

  it.each([
    ["amount=1&denom=quote&slippageBps=100", "bad side"],
    ["side=long&amount=1&denom=quote&slippageBps=100", "bad side"],
    ["side=buy&amount=1&slippageBps=100", "bad denom"],
    ["side=buy&amount=1&denom=usd&slippageBps=100", "bad denom"],
    ["side=buy&denom=quote&slippageBps=100", "bad amount"],
    ["side=buy&amount=0&denom=quote&slippageBps=100", "bad amount"],
    ["side=buy&amount=-1&denom=quote&slippageBps=100", "bad amount"],
    ["side=buy&amount=1e9&denom=quote&slippageBps=100", "bad amount"],
    ["side=buy&amount=one&denom=quote&slippageBps=100", "bad amount"],
    ["side=buy&amount=1&denom=quote", "bad slippageBps"],
    ["side=buy&amount=1&denom=quote&slippageBps=0", "bad slippageBps"],
    ["side=buy&amount=1&denom=quote&slippageBps=5001", "bad slippageBps"],
    ["side=buy&amount=1&denom=quote&slippageBps=1.5", "bad slippageBps"],
    ["side=buy&amount=1&denom=quote&slippageBps=100&holder=yes", "bad holder"],
  ])("answers 400 for ?%s", async (query, error) => {
    const res = await call(ADDR, query);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error });
    expect(poolKey).not.toHaveBeenCalled();
  });

  it("answers 404 when the token has no listed pool", async () => {
    poolKey.mockResolvedValue(null);
    const res = await call(ADDR, OK);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ error: "no listed pool" });
    expect(poolKey).toHaveBeenCalledWith(ADDR);
  });

  it("answers 200 with the whole priced shape and never lets it be cached", async () => {
    exactIn.mockResolvedValue(199n * 10n ** 18n);
    const res = await call(ADDR.toUpperCase().replace("0X", "0x"), OK);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "call",
      "minReceived",
      "payAmount",
      "poolFeePct",
      "priceImpactPct",
      "receiveAmount",
      "routable",
      "routerFeeAmount",
      "routerFeePct",
    ]);
    expect(body.routable).toBe(true);
    expect(body.routerFeePct).toBe(0.5);
    expect(body.poolFeePct).toBe(0.3);
    expect([
      Number(body.payAmount),
      Number(body.receiveAmount),
      Number(body.minReceived),
      Number(body.routerFeeAmount),
    ]).toEqual([100, 199, 197.01, 0.5]);
    expect(body.call).toEqual({
      poolKey: { currency0: TOKEN, currency1: QUOTE, fee: 3000, tickSpacing: 60, hooks: ZERO },
      zeroForOne: false,
      amountIn: "100000000",
      amountOutMin: "197010000000000000000",
      tokenIn: QUOTE,
      tokenOut: TOKEN,
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
    });
    // The path segment is lowercased before the lookup, and the fee came off the input.
    expect(poolKey).toHaveBeenCalledWith(ADDR);
    expect(exactIn).toHaveBeenCalledWith({ poolKey: POOL, zeroForOne: false, exactAmount: 99_500_000n });
  });

  it("passes holder=1 through to the fee, and inverts when the amount names the receive side", async () => {
    exactOut.mockResolvedValue(100_000_000n);
    exactIn.mockResolvedValue(200n * 10n ** 18n);
    const res = await call(ADDR, "side=buy&amount=200&denom=token&slippageBps=50&holder=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.routerFeePct).toBe(0);
    expect(Number(body.routerFeeAmount)).toBe(0);
    // A holder pays no fee, so the gross-up is the identity and the net equals the input.
    expect(exactOut).toHaveBeenCalledWith({ poolKey: POOL, zeroForOne: false, exactAmount: 200n * 10n ** 18n });
    expect(exactIn).toHaveBeenCalledWith({ poolKey: POOL, zeroForOne: false, exactAmount: 100_000_000n });
    expect((body.call as { amountIn: string }).amountIn).toBe("100000000");
  });

  it("answers 200 routable:false and remembers it, so a reload does not re-probe", async () => {
    exactIn.mockRejectedValue(new NotRoutableError("pool cannot be routed"));
    const first = await call(ADDR, OK);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    await expect(first.json()).resolves.toEqual({ routable: false });

    const second = await call(ADDR, "side=sell&amount=5&denom=token&slippageBps=100");
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ routable: false });
    // D28: the pool's routability is cached under routable:{poolId} for 300 s.
    expect(exactIn).toHaveBeenCalledTimes(1);
  });

  it("answers 503 when the chain cannot be reached, without echoing the endpoint", async () => {
    exactIn.mockRejectedValue(new HttpRequestError({ url: "https://rpc.internal.example/secret-key" }));
    const res = await call(ADDR, OK);
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("15");
    await expect(res.json()).resolves.toEqual({ error: "rpc unavailable" });
    const logged = vi.mocked(console.warn).mock.calls.flat().join(" ");
    expect(logged).not.toContain("secret-key");
  });

  it("answers 503 when the market store is unavailable", async () => {
    poolKey.mockRejectedValue(new DbUnavailableError("database unavailable (ECONNREFUSED)"));
    const res = await call(ADDR, OK);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "database unavailable" });
  });
});
```

Run: `npx vitest run "src/app/api/tokens/[address]/quote/route.test.ts"`
Expected: FAIL, `Cannot find module './route'`.

- [ ] **Step 4: Write the quote route**

`src/app/api/tokens/[address]/quote/route.ts`:

```ts
import { NextResponse } from "next/server";
import { BaseError, HttpRequestError, TimeoutError } from "viem";
import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import { priceSwap, type PriceResult } from "@/lib/quote/price";
import { createQuoter } from "@/lib/quote/quoter";
import { badRequest, failure, isAddress } from "../../../_lib/respond";

/** A price is never a CDN fact: the route is dynamic and every answer is no-store. */
export const dynamic = "force-dynamic";
/** Two quoter simulations plus one store read, comfortably inside the platform's limit. */
export const maxDuration = 15;

/** D28: how long one pool's routability verdict stands, in this process only. */
const ROUTABLE_TTL_MS = 300_000;
const AMOUNT = /^\d+(\.\d+)?$/;
const INTEGER = /^\d+$/;
const NO_STORE = { "Cache-Control": "no-store" };

function answer(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * A transport failure, not a contract answer: the chain could not be asked at all. `failure()` maps
 * only the store's own unavailable errors to 503, so this one is decided here.
 */
function isRpcDown(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError) !== null;
}

export async function GET(req: Request, ctx: { params: Promise<{ address: string }> }): Promise<Response> {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  if (!isAddress(id)) return badRequest("bad address");

  const params = new URL(req.url).searchParams;
  const side = params.get("side");
  if (side !== "buy" && side !== "sell") return badRequest("bad side");
  const denom = params.get("denom");
  if (denom !== "quote" && denom !== "token") return badRequest("bad denom");
  const amount = params.get("amount") ?? "";
  if (!AMOUNT.test(amount) || Number(amount) <= 0) return badRequest("bad amount");
  const slippage = params.get("slippageBps") ?? "";
  const slippageBps = Number(slippage);
  if (!INTEGER.test(slippage) || slippageBps < 1 || slippageBps > 5000) return badRequest("bad slippageBps");
  const holder = params.get("holder") ?? "0";
  if (holder !== "0" && holder !== "1") return badRequest("bad holder");

  try {
    const pool = await getBackend().poolKey(id);
    if (!pool) return answer({ error: "no listed pool" }, 404);

    const request = { side, amount, denom, slippageBps, holder: holder === "1", pool };
    const quoter = createQuoter();
    // The first quote for this pool prices inside the loader and records only the verdict, so a pool
    // already known to be unroutable answers with no RPC call at all — and no priced answer is kept.
    const probe: { priced: PriceResult | null } = { priced: null };
    const routable = await ttlCache(`routable:${pool.poolId}`, ROUTABLE_TTL_MS, async () => {
      probe.priced = await priceSwap(quoter, request);
      return probe.priced.routable;
    });
    if (!routable) return answer({ routable: false });
    return answer(probe.priced ?? (await priceSwap(quoter, request)));
  } catch (err) {
    // toBase() rejects anything the query validation let through; the user sees one message.
    if (err instanceof RangeError) return badRequest("bad amount");
    if (isRpcDown(err)) {
      // No URL, no key: rule 4. The error object carries both.
      console.warn("quote rpc unavailable");
      return NextResponse.json(
        { error: "rpc unavailable" },
        { status: 503, headers: { ...NO_STORE, "Retry-After": "15" } },
      );
    }
    return failure(err);
  }
}
```

Run: `npx vitest run "src/app/api/tokens/[address]/quote/route.test.ts"`
Expected: PASS (8 `it`s, 14 of them from the `it.each` table — 21 tests).

- [ ] **Step 5: Run the gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green. `npm run build` lists `/api/tokens/[address]/quote` as a dynamic route (ƒ), never a static one; `grep -rn "s-maxage" "src/app/api/tokens/[address]/quote/route.ts"` matches nothing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/quote/price.ts src/lib/quote/price.test.ts "src/app/api/tokens/[address]/quote/route.ts" "src/app/api/tokens/[address]/quote/route.test.ts"
git commit -m "Price swaps through the V4 Quoter and serve them from the quote route" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

### Task 4: The client swap

**Files:**
- Create: `src/lib/swap/abi.ts`, `src/lib/swap/permit.ts`
- Modify: `src/lib/swap.ts` (the stub becomes the real path), `src/lib/types.ts` (one optional field on `Quote`), `src/components/TradePanel.tsx` (the call site, so the gates stay green)
- Test: `src/lib/swap/abi.test.ts`, `src/lib/swap/permit.test.ts`, `src/lib/swap.test.ts`

**Interfaces:**
- Consumes: `PERMIT2_ADDRESS`, `SVROUTER_ADDRESS`, `robinhoodChain` from `src/lib/chain.ts` (Task 1); `SwapCall` from `src/lib/quote/price.ts` (Task 3, type-only); `Address`, `Side`, `Quote` from `src/lib/types.ts`; viem's `WalletClient`, `PublicClient`, `parseEventLogs`, `decodeErrorResult`, `maxUint256`, `BaseError`, `ContractFunctionRevertedError`, `UserRejectedRequestError`; wagmi's `useWalletClient`, `usePublicClient` (the call site only).
- Produces: `svRouterAbi`, `erc20Abi`, `permit2Abi` from `src/lib/swap/abi.ts`; `permitTypedData`, `randomNonce`, `PERMIT_TRANSFER_FROM_TYPES` from `src/lib/swap/permit.ts`; `SwapRequest`, `SwapHandle`, `SwapReceipt`, `SwapDeps`, `SwapFailedError`, `SwapRejectedError`, `executeSwap` from `src/lib/swap.ts`. Signatures exactly as in the contract. Task 5 consumes `SwapReceipt` for the confirmed toast and fills `Quote.call` from the route.

Decisions where the contract is silent (each one line):
- The ABI is transcribed from `SuitVenturesMarket-contracts/src/interfaces/ISVRouter.sol`, and `abi.test.ts` pins every selector against the Solidity signature, so a mistyped field cannot ship: `swapExactIn` is `0x4d20a50e` and `Trade` is `0xae40db53…`.
- `svRouterAbi` also carries `ExecutionFailed`, `TransactionDeadlinePassed` and `V4TooLittleReceived`, which the router does not declare: the Universal Router raises them through it and they must decode for the error mapping. They are in the ABI to be read, never to be called.
- `approve` names **Permit2** as the spender, not SVRouter: Permit2 is what pulls the token, and the router is the spender inside the signed message.
- One deadline, `now + 1200 s`, on the permit, the params and nothing else; the permit's deadline is enforced by Permit2 and the params' by the router.
- `mapSwapError` walks the viem error chain rather than matching message text, and unwraps one level of `ExecutionFailed(commandIndex, message)` so a v4 revert raised through the Universal Router still reads as `V4TooLittleReceived`.
- Every message ends in "Nothing was spent.", the rejection included, because the router pulls funds only after its checks pass.
- `SwapRejectedError extends Error` as the contract says, so the panel must catch it explicitly; until Task 5 does, a rejection renders the panel's generic failure text, which is also true.
- A receipt with `status: "reverted"`, or one with no `Trade` log, is a `SwapFailedError`: without the event there is no honest number to report.
- `executeSwap` refuses with a `SwapFailedError` when `SVROUTER_ADDRESS` is empty; the panel's disabled state is the first line of defence, this is the second.
- `Quote.call` is added as optional so this task can compile the call site without pre-empting Task 5's hook work; the import is type-only in both directions, so the `types.ts` ↔ `quote/price.ts` cycle is erased at build time.

- [ ] **Step 1: Write the failing ABI test**

`src/lib/swap/abi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  decodeErrorResult,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  maxUint256,
  toEventSelector,
  toFunctionSelector,
  type Hex,
} from "viem";
import type { Address } from "@/lib/types";
import { erc20Abi, permit2Abi, svRouterAbi } from "./abi";

/** The signatures the deployed contracts actually answer to, copied from the Solidity. */
const SWAP_EXACT_IN =
  "swapExactIn(((address,address,uint24,int24,address),bool,uint128,uint128,bytes,uint256),((address,uint256),uint256,uint256),bytes)";
const TRADE = "Trade(address,bytes32,address,address,uint256,uint256,uint256,bool)";

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

describe("svRouterAbi", () => {
  it("encodes swapExactIn with the interface's own selector", () => {
    const data = encodeFunctionData({
      abi: svRouterAbi,
      functionName: "swapExactIn",
      args: [
        {
          key: { currency0: A, currency1: B, fee: 3000, tickSpacing: 60, hooks: ZERO },
          zeroForOne: true,
          amountIn: 5n,
          amountOutMin: 1n,
          hookData: "0x",
          deadline: 9n,
        },
        { permitted: { token: A, amount: 5n }, nonce: 7n, deadline: 9n },
        "0xabcd",
      ],
    });
    expect(data.slice(0, 10)).toBe(toFunctionSelector(SWAP_EXACT_IN));
    expect(data.slice(0, 10)).toBe("0x4d20a50e");
  });

  it("carries the Trade event the router emits", () => {
    const topics = encodeEventTopics({ abi: svRouterAbi, eventName: "Trade" });
    expect(topics[0]).toBe(toEventSelector(TRADE));
    expect(topics[0]).toBe("0xae40db530a6f81e9282323b921d77b7a760136cb1ac63e1d0d00d6b4c6a837aa");
  });

  it.each([
    ["Expired", "0x203d82d8"],
    ["ZeroAmount", "0x1f2a2005"],
    ["ZeroAddress", "0xd92e233d"],
    ["PermitMismatch", "0xceaf57ba"],
    ["FeeTooHigh", "0xcd4e6167"],
    ["RenounceDisabled", "0x89051165"],
    ["TransactionDeadlinePassed", "0x5bf6f916"],
  ] as ReadonlyArray<[string, Hex]>)("decodes the %s revert from its selector", (name, selector) => {
    expect(toFunctionSelector(`${name}()`)).toBe(selector);
    expect(decodeErrorResult({ abi: svRouterAbi, data: selector }).errorName).toBe(name);
  });

  it("decodes the reverts that carry numbers, including the one the Universal Router wraps", () => {
    const short = encodeErrorResult({ abi: svRouterAbi, errorName: "InsufficientOutput", args: [90n, 100n] });
    expect(short.slice(0, 10)).toBe(toFunctionSelector("InsufficientOutput(uint256,uint256)"));
    expect(decodeErrorResult({ abi: svRouterAbi, data: short }).errorName).toBe("InsufficientOutput");

    const inner = encodeErrorResult({ abi: svRouterAbi, errorName: "V4TooLittleReceived", args: [100n, 90n] });
    expect(inner.slice(0, 10)).toBe(toFunctionSelector("V4TooLittleReceived(uint256,uint256)"));
    const outer = encodeErrorResult({ abi: svRouterAbi, errorName: "ExecutionFailed", args: [0n, inner] });
    const decoded = decodeErrorResult({ abi: svRouterAbi, data: outer });
    expect(decoded.errorName).toBe("ExecutionFailed");
    const nested = (decoded.args as readonly unknown[])[1] as Hex;
    expect(decodeErrorResult({ abi: svRouterAbi, data: nested }).errorName).toBe("V4TooLittleReceived");
  });
});

describe("erc20Abi and permit2Abi", () => {
  it("carry exactly what the swap reads and writes", () => {
    expect(erc20Abi.map((item) => item.name).sort()).toEqual(["allowance", "approve", "balanceOf", "decimals"]);
    expect(
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [A, maxUint256] }).slice(0, 10),
    ).toBe("0x095ea7b3");
    expect(
      encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [A, B] }).slice(0, 10),
    ).toBe("0xdd62ed3e");
    expect(
      encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [A] }).slice(0, 10),
    ).toBe("0x70a08231");
    expect(
      encodeFunctionData({ abi: permit2Abi, functionName: "nonceBitmap", args: [A, 0n] }).slice(0, 10),
    ).toBe("0x4fe02b44");
  });
});
```

Run: `npx vitest run src/lib/swap/abi.test.ts`
Expected: FAIL, `Cannot find module './abi'`.

- [ ] **Step 2: Write the ABI fragment**

`src/lib/swap/abi.ts`:

```ts
/**
 * The pieces of the on-chain interfaces this app touches, transcribed from
 * `SuitVenturesMarket-contracts/src/interfaces/ISVRouter.sol` and `src/SVRouter.sol`. `abi.test.ts`
 * pins every selector against the Solidity signature, so a mistyped field fails the suite rather
 * than a transaction.
 *
 * `PoolKey` is v4-core's struct: `Currency` and `IHooks` are user-defined value types over
 * `address`, so they are plain addresses in the ABI; `fee` is `uint24` and `tickSpacing` `int24`.
 * `ISignatureTransfer.PermitTransferFrom` carries no `spender` — the router is the spender because
 * it is the caller; the EIP-712 message signed off-chain does name it (see `permit.ts`).
 */
export const svRouterAbi = [
  {
    type: "function",
    name: "swapExactIn",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          {
            name: "key",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMin", type: "uint128" },
          { name: "hookData", type: "bytes" },
          { name: "deadline", type: "uint256" },
        ],
      },
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
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "event",
    name: "Trade",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "tokenIn", type: "address", indexed: true },
      { name: "tokenOut", type: "address", indexed: false },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
      { name: "holderRate", type: "bool", indexed: false },
    ],
  },
  // The router's own reverts.
  { type: "error", name: "Expired", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "PermitMismatch", inputs: [] },
  { type: "error", name: "FeeTooHigh", inputs: [] },
  { type: "error", name: "RenounceDisabled", inputs: [] },
  {
    type: "error",
    name: "InsufficientOutput",
    inputs: [
      { name: "received", type: "uint256" },
      { name: "minimum", type: "uint256" },
    ],
  },
  // Raised through the router by the Universal Router and by v4; here so a revert can be read, never
  // to be called. ExecutionFailed wraps the inner revert's calldata in `message`.
  {
    type: "error",
    name: "ExecutionFailed",
    inputs: [
      { name: "commandIndex", type: "uint256" },
      { name: "message", type: "bytes" },
    ],
  },
  { type: "error", name: "TransactionDeadlinePassed", inputs: [] },
  {
    type: "error",
    name: "V4TooLittleReceived",
    inputs: [
      { name: "minAmountOutReceived", type: "uint256" },
      { name: "amountReceived", type: "uint256" },
    ],
  },
] as const;

/** The four functions the swap and the balances need, and nothing else. */
export const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

/**
 * Permit2 is signed, not called, by this app: the only readable thing worth having is the nonce
 * bitmap, for diagnosing a replayed nonce from a script.
 */
export const permit2Abi = [
  {
    type: "function",
    name: "nonceBitmap",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "wordPos", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
```

Run: `npx vitest run src/lib/swap/abi.test.ts`
Expected: PASS (10 tests: 2 + the 7-row table + 1). A selector mismatch means the ABI, not the test: compare the failing field against `ISVRouter.sol`.

- [ ] **Step 3: Write the failing permit test**

`src/lib/swap/permit.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashTypedData } from "viem";
import { PERMIT2_ADDRESS, robinhoodChain } from "@/lib/chain";
import type { Address } from "@/lib/types";
import { permitTypedData, randomNonce } from "./permit";

const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const SPENDER = "0x9999999999999999999999999999999999999999" as Address;
const ARGS = { token: TOKEN, amount: 1234567890n, spender: SPENDER, nonce: 42n, deadline: 1_789_548_200n };

describe("permitTypedData", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses Permit2's own domain, which has no version field", () => {
    const typed = permitTypedData(ARGS);
    expect(typed.domain).toEqual({
      name: "Permit2",
      chainId: robinhoodChain.id,
      verifyingContract: PERMIT2_ADDRESS,
    });
    // A `version` here would change the domain separator and every signature would be rejected.
    expect(Object.keys(typed.domain ?? {}).sort()).toEqual(["chainId", "name", "verifyingContract"]);
    expect(robinhoodChain.id).toBe(4663);
  });

  it("spells the types exactly as PermitHash.sol does", () => {
    const typed = permitTypedData(ARGS);
    expect(typed.primaryType).toBe("PermitTransferFrom");
    expect(typed.types).toEqual({
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    });
    expect(typed.message).toEqual({
      permitted: { token: TOKEN, amount: 1234567890n },
      spender: SPENDER,
      nonce: 42n,
      deadline: 1_789_548_200n,
    });
  });

  it("hashes to the digest Permit2 will recompute on chain 4663", () => {
    // Golden value, built independently from the Solidity typehashes in
    // permit2/src/libraries/PermitHash.sol and the domain in permit2/src/EIP712.sol.
    expect(hashTypedData(permitTypedData(ARGS))).toBe(
      "0xe4f208cf84e3cffdc0ea8848ae7a5308a2793278b6fc19a89280ad5ef9012f53",
    );
  });
});

describe("randomNonce", () => {
  // stubGlobal rather than spyOn: getRandomValues lives on Crypto.prototype, not on the instance.
  afterEach(() => vi.unstubAllGlobals());

  it("reads 256 bits from the platform's CSPRNG, big-endian", () => {
    const fill = (value: number, last?: number) => (bytes: Uint8Array) => {
      bytes.fill(value);
      if (last !== undefined) bytes[31] = last;
      return bytes;
    };
    vi.stubGlobal("crypto", { getRandomValues: fill(0xff) });
    expect(randomNonce()).toBe(2n ** 256n - 1n);

    vi.stubGlobal("crypto", { getRandomValues: fill(0, 1) });
    expect(randomNonce()).toBe(1n);
  });

  it("does not repeat itself, on the real CSPRNG", () => {
    const seen = new Set<bigint>();
    for (let i = 0; i < 64; i++) seen.add(randomNonce());
    expect(seen.size).toBe(64);
  });
});
```

Run: `npx vitest run src/lib/swap/permit.test.ts`
Expected: FAIL, `Cannot find module './permit'`.

- [ ] **Step 4: Write the Permit2 typed data**

`src/lib/swap/permit.ts`:

```ts
import type { TypedDataDefinition } from "viem";
import { PERMIT2_ADDRESS, robinhoodChain } from "@/lib/chain";
import type { Address } from "@/lib/types";

/**
 * The EIP-712 types Permit2 hashes in `PermitHash.sol`:
 *
 *   PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)
 *   TokenPermissions(address token,uint256 amount)
 *
 * The signed message names the spender even though the calldata struct does not: on chain Permit2
 * hashes `msg.sender` into the same slot, which is what binds a signature to this router alone.
 */
export const PERMIT_TRANSFER_FROM_TYPES = {
  PermitTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const;

/**
 * Permit2's domain is `EIP712Domain(string name,uint256 chainId,address verifyingContract)` with the
 * name "Permit2" — no `version`. Adding one changes the domain separator, and every signature would
 * come back as an invalid signer.
 */
export function permitTypedData(args: {
  token: Address;
  amount: bigint;
  spender: Address;
  nonce: bigint;
  deadline: bigint;
}): TypedDataDefinition {
  return {
    domain: { name: "Permit2", chainId: robinhoodChain.id, verifyingContract: PERMIT2_ADDRESS },
    types: PERMIT_TRANSFER_FROM_TYPES,
    primaryType: "PermitTransferFrom",
    message: {
      permitted: { token: args.token, amount: args.amount },
      spender: args.spender,
      nonce: args.nonce,
      deadline: args.deadline,
    },
  };
}

/**
 * 256 random bits. Permit2 nonces are unordered bits in a bitmap, not a counter, so a fresh random
 * one needs no read and no coordination; a collision reverts the transaction rather than mis-spending.
 */
export function randomNonce(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let nonce = 0n;
  for (const byte of bytes) nonce = (nonce << 8n) | BigInt(byte);
  return nonce;
}
```

Run: `npx vitest run src/lib/swap/permit.test.ts`
Expected: PASS (5 tests). A failing digest means the domain or the type strings drifted; the golden value is the Solidity's, not viem's.

- [ ] **Step 5: Write the failing swap client test**

`src/lib/swap.test.ts`:

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
import type { SwapCall } from "@/lib/quote/price";
import type { Address } from "@/lib/types";
import { svRouterAbi } from "./swap/abi";
import { SwapFailedError, SwapRejectedError, executeSwap, type SwapDeps, type SwapRequest } from "./swap";

const ROUTER = "0x7777777777777777777777777777777777777777" as Address;
vi.mock("@/lib/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain")>()),
  SVROUTER_ADDRESS: ROUTER,
}));

const ACCOUNT = "0x8888888888888888888888888888888888888888" as Address;
const TOKEN_IN = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN_OUT = "0x1111111111111111111111111111111111111111" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const POOL_ID = `0x${"ab".repeat(32)}` as Hex;
const SWAP_HASH = `0x${"11".repeat(32)}` as Address;
const APPROVE_HASH = `0x${"22".repeat(32)}` as Address;
const SIGNATURE = `0x${"33".repeat(65)}` as Hex;
const NOW_SEC = 1_789_547_000;

const CALL: SwapCall = {
  poolKey: { currency0: TOKEN_OUT, currency1: TOKEN_IN, fee: 3000, tickSpacing: 60, hooks: ZERO },
  zeroForOne: false,
  amountIn: "100000000",
  amountOutMin: "197010000000000000000",
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  tokenInDecimals: 6,
  tokenOutDecimals: 18,
};

const REQUEST: SwapRequest = {
  ticker: "AI",
  side: "buy",
  payAmount: 100,
  payAsset: "NVDA",
  receiveAmount: 199,
  receiveAsset: "AI",
  slippagePct: 1,
  account: ACCOUNT,
  isSuitHolder: false,
  call: CALL,
};

/** A Trade log the router would have emitted, built with viem so the encoding is the real one. */
function tradeLog(args: { amountOut: bigint; fee: bigint; holderRate: boolean }): Log {
  const topics = encodeEventTopics({
    abi: svRouterAbi,
    eventName: "Trade",
    args: { user: ACCOUNT, poolId: POOL_ID, tokenIn: TOKEN_IN },
  });
  return {
    address: ROUTER,
    topics: topics as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }],
      [TOKEN_OUT, 100_000_000n, args.fee, args.amountOut, args.holderRate],
    ),
    blockHash: `0x${"00".repeat(32)}` as Hex,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: SWAP_HASH,
    transactionIndex: 0,
    removed: false,
  };
}

function reverted(errorName: "Expired" | "InsufficientOutput" | "V4TooLittleReceived" | "unknown"): Error {
  const data =
    errorName === "unknown"
      ? ("0xdeadbeef" as Hex)
      : errorName === "Expired"
        ? encodeErrorResult({ abi: svRouterAbi, errorName: "Expired" })
        : errorName === "InsufficientOutput"
          ? encodeErrorResult({ abi: svRouterAbi, errorName: "InsufficientOutput", args: [90n, 100n] })
          : encodeErrorResult({
              abi: svRouterAbi,
              errorName: "ExecutionFailed",
              args: [0n, encodeErrorResult({ abi: svRouterAbi, errorName: "V4TooLittleReceived", args: [100n, 90n] })],
            });
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: svRouterAbi, data, functionName: "swapExactIn" }),
    { abi: svRouterAbi, functionName: "swapExactIn", args: [] },
  );
}

type Harness = {
  deps: SwapDeps;
  readContract: ReturnType<typeof vi.fn>;
  writeContract: ReturnType<typeof vi.fn>;
  signTypedData: ReturnType<typeof vi.fn>;
  waitForTransactionReceipt: ReturnType<typeof vi.fn>;
};

function harness(allowance: bigint): Harness {
  const readContract = vi.fn().mockResolvedValue(allowance);
  const writeContract = vi.fn(async ({ functionName }: { functionName: string }) =>
    functionName === "approve" ? APPROVE_HASH : SWAP_HASH,
  );
  const signTypedData = vi.fn().mockResolvedValue(SIGNATURE);
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({
    status: "success",
    logs: [tradeLog({ amountOut: 198_500_000_000_000_000_000n, fee: 500_000n, holderRate: false })],
  });
  return {
    readContract,
    writeContract,
    signTypedData,
    waitForTransactionReceipt,
    deps: {
      wallet: { writeContract, signTypedData } as unknown as WalletClient,
      publicClient: { readContract, waitForTransactionReceipt } as unknown as PublicClient,
      account: ACCOUNT,
    },
  };
}

describe("executeSwap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends no approval when the allowance already covers the input", async () => {
    const h = harness(maxUint256);
    await executeSwap(REQUEST, h.deps);
    expect(h.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: TOKEN_IN, functionName: "allowance", args: [ACCOUNT, PERMIT2_ADDRESS] }),
    );
    expect(h.writeContract).toHaveBeenCalledTimes(1);
    expect(h.writeContract.mock.calls[0][0].functionName).toBe("swapExactIn");
  });

  it("approves Permit2 for the maximum and waits for it before signing", async () => {
    const h = harness(0n);
    await executeSwap(REQUEST, h.deps);
    expect(h.writeContract).toHaveBeenCalledTimes(2);
    expect(h.writeContract.mock.calls[0][0]).toMatchObject({
      address: TOKEN_IN,
      functionName: "approve",
      args: [PERMIT2_ADDRESS, maxUint256],
      account: ACCOUNT,
    });
    expect(h.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: APPROVE_HASH });
    // The receipt came back before the wallet was asked to sign.
    expect(h.waitForTransactionReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      h.signTypedData.mock.invocationCallOrder[0],
    );
  });

  it("signs a Permit2 message naming the router, with a fresh nonce and a 20-minute deadline", async () => {
    const h = harness(maxUint256);
    await executeSwap(REQUEST, h.deps);
    const typed = h.signTypedData.mock.calls[0][0] as TypedDataDefinition & { account: Address };
    expect(typed.account).toBe(ACCOUNT);
    expect(typed.domain).toEqual({ name: "Permit2", chainId: 4663, verifyingContract: PERMIT2_ADDRESS });
    const message = typed.message as { permitted: { token: Address; amount: bigint }; spender: Address; nonce: bigint; deadline: bigint };
    expect(message.permitted).toEqual({ token: TOKEN_IN, amount: 100_000_000n });
    expect(message.spender).toBe(ROUTER);
    expect(message.deadline).toBe(BigInt(NOW_SEC + 1200));
    expect(message.nonce).toBeGreaterThan(0n);
    // The same nonce and deadline travel in the calldata, or Permit2 would hash a different message.
    const [params, permit, signature] = h.writeContract.mock.calls[0][0].args;
    expect(permit).toEqual({ permitted: { token: TOKEN_IN, amount: 100_000_000n }, nonce: message.nonce, deadline: message.deadline });
    expect(params.deadline).toBe(message.deadline);
    expect(signature).toBe(SIGNATURE);
  });

  it("sends the route's call block verbatim, recomputing nothing", async () => {
    const h = harness(maxUint256);
    const handle = await executeSwap(REQUEST, h.deps);
    expect(handle.hash).toBe(SWAP_HASH);
    const sent = h.writeContract.mock.calls[0][0];
    expect(sent).toMatchObject({ address: ROUTER, functionName: "swapExactIn", account: ACCOUNT });
    expect(sent.args[0]).toMatchObject({
      key: CALL.poolKey,
      zeroForOne: false,
      amountIn: 100_000_000n,
      amountOutMin: 197_010_000_000_000_000_000n,
      hookData: "0x",
    });
  });

  it("resolves the confirmation with the Trade event's own numbers", async () => {
    const h = harness(maxUint256);
    const handle = await executeSwap(REQUEST, h.deps);
    await expect(handle.confirmation).resolves.toEqual({
      amountOut: 198_500_000_000_000_000_000n,
      fee: 500_000n,
      holderRate: false,
    });
    expect(h.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: SWAP_HASH });
  });

  it("maps a dismissed wallet to SwapRejectedError", async () => {
    const h = harness(maxUint256);
    h.signTypedData.mockRejectedValue(
      new ContractFunctionExecutionError(new UserRejectedRequestError(new Error("User rejected the request.")), {
        abi: svRouterAbi,
        functionName: "swapExactIn",
        args: [],
      }),
    );
    await expect(executeSwap(REQUEST, h.deps)).rejects.toBeInstanceOf(SwapRejectedError);
    await expect(executeSwap(REQUEST, h.deps)).rejects.toThrow("Cancelled in wallet. Nothing was spent.");
  });

  it.each([
    ["InsufficientOutput" as const, "Price moved past 1% slippage; nothing was spent."],
    ["V4TooLittleReceived" as const, "Price moved past 1% slippage; nothing was spent."],
    ["Expired" as const, "The quote expired; try again. Nothing was spent."],
    ["unknown" as const, "Swap failed. Nothing was spent."],
  ])("maps a %s revert to its message", async (errorName, message) => {
    const h = harness(maxUint256);
    h.writeContract.mockRejectedValue(reverted(errorName));
    await expect(executeSwap(REQUEST, h.deps)).rejects.toBeInstanceOf(SwapFailedError);
    await expect(executeSwap(REQUEST, h.deps)).rejects.toThrow(message);
  });

  it("fails the confirmation when the transaction reverted or carried no Trade event", async () => {
    const h = harness(maxUint256);
    h.waitForTransactionReceipt.mockResolvedValueOnce({ status: "success", logs: [] });
    await expect((await executeSwap(REQUEST, h.deps)).confirmation).rejects.toThrow(
      "Swap failed. Nothing was spent.",
    );
    h.waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted", logs: [] });
    await expect((await executeSwap(REQUEST, h.deps)).confirmation).rejects.toBeInstanceOf(SwapFailedError);
  });
});
```

Run: `npx vitest run src/lib/swap.test.ts`
Expected: FAIL. The module exists, so the failure is `SwapRejectedError is not exported` / `Expected 1 arguments, but got 2` at the first `executeSwap(REQUEST, h.deps)` — the stub's surface, not a missing file.

- [ ] **Step 6: Rewrite the swap client**

Replace the whole of `src/lib/swap.ts`:

```ts
import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  decodeErrorResult,
  maxUint256,
  parseEventLogs,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { SwapCall } from "@/lib/quote/price";
import { PERMIT2_ADDRESS, SVROUTER_ADDRESS, robinhoodChain } from "./chain";
import { erc20Abi, svRouterAbi } from "./swap/abi";
import { permitTypedData, randomNonce } from "./swap/permit";
import type { Address, Side } from "./types";

/**
 * SVRouter execution. The request carries the quote route's `call` block verbatim: the browser
 * signs and sends the amounts the route computed and never recomputes one of them.
 *
 * Order on submit (spec section 4): allowance, then a Permit2 signature, then one `swapExactIn`,
 * then the receipt's `Trade` event for the amount actually received. Every failure message ends in
 * "Nothing was spent." because the router pulls funds only after its checks pass.
 */

/** How long the signature and the trade stay valid, in seconds. */
const DEADLINE_SEC = 1200;

export interface SwapRequest {
  ticker: string;
  side: Side;
  payAmount: number;
  payAsset: string;
  receiveAmount: number;
  receiveAsset: string;
  slippagePct: number;
  account: Address;
  isSuitHolder: boolean;
  /** The quote route's execution block. */
  call: SwapCall;
}

/** What the `Trade` event reported: the truth the confirmed toast shows, not the quote's guess. */
export type SwapReceipt = { amountOut: bigint; fee: bigint; holderRate: boolean };

export interface SwapHandle {
  /** Transaction hash, known once the wallet has signed and sent. */
  hash: Address;
  /** Resolves with the event's numbers, rejects with SwapFailedError on a revert. */
  confirmation: Promise<SwapReceipt>;
}

export type SwapDeps = { wallet: WalletClient; publicClient: PublicClient; account: Address };

export class SwapFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapFailedError";
  }
}

/** The user dismissed the wallet. Nothing was signed and nothing was sent. */
export class SwapRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapRejectedError";
  }
}

function tryDecode(data: Hex): { errorName: string; args?: readonly unknown[] } | undefined {
  try {
    return decodeErrorResult({ abi: svRouterAbi, data });
  } catch {
    return undefined;
  }
}

/**
 * The innermost named revert. The Universal Router wraps whatever the v4 swap threw in
 * `ExecutionFailed(commandIndex, message)`, so a slippage failure arrives one layer down.
 */
function revertName(err: BaseError): string | null {
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  const decoded: { errorName: string; args?: readonly unknown[] } | undefined =
    reverted.data ?? (reverted.raw ? tryDecode(reverted.raw) : undefined);
  if (!decoded) return null;
  if (decoded.errorName !== "ExecutionFailed") return decoded.errorName;
  const inner = decoded.args?.[1];
  const nested = typeof inner === "string" ? tryDecode(inner as Hex) : undefined;
  return nested?.errorName ?? decoded.errorName;
}

/** Spec section 4's table, and the only place a chain error becomes something a user reads. */
export function mapSwapError(err: unknown, slippagePct: number): Error {
  if (err instanceof SwapFailedError || err instanceof SwapRejectedError) return err;
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) {
      return new SwapRejectedError("Cancelled in wallet. Nothing was spent.");
    }
    const name = revertName(err);
    if (name === "InsufficientOutput" || name === "V4TooLittleReceived") {
      return new SwapFailedError(`Price moved past ${slippagePct}% slippage; nothing was spent.`);
    }
    if (name === "Expired" || name === "TransactionDeadlinePassed") {
      return new SwapFailedError("The quote expired; try again. Nothing was spent.");
    }
  }
  return new SwapFailedError("Swap failed. Nothing was spent.");
}

async function confirm(deps: SwapDeps, hash: Address, slippagePct: number): Promise<SwapReceipt> {
  let receipt;
  try {
    receipt = await deps.publicClient.waitForTransactionReceipt({ hash });
  } catch (err) {
    throw mapSwapError(err, slippagePct);
  }
  if (receipt.status === "reverted") throw new SwapFailedError("Swap failed. Nothing was spent.");
  const [trade] = parseEventLogs({ abi: svRouterAbi, eventName: "Trade", logs: receipt.logs });
  // Without the event there is no honest number to report, so this is a failure, not a zero.
  if (!trade) throw new SwapFailedError("Swap failed. Nothing was spent.");
  return { amountOut: trade.args.amountOut, fee: trade.args.fee, holderRate: trade.args.holderRate };
}

export async function executeSwap(req: SwapRequest, deps: SwapDeps): Promise<SwapHandle> {
  const router = SVROUTER_ADDRESS;
  if (!router) throw new SwapFailedError("Trading goes live when the router is deployed. Nothing was spent.");
  const { call } = req;
  const amountIn = BigInt(call.amountIn);
  const amountOutMin = BigInt(call.amountOutMin);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SEC);

  try {
    // 1. Permit2 is what pulls the token, so it is the spender of the ERC20 approval. LONG (Doppler)
    //    tokens report an unlimited allowance for every holder and skip this entirely.
    const allowance = await deps.publicClient.readContract({
      address: call.tokenIn,
      abi: erc20Abi,
      functionName: "allowance",
      args: [deps.account, PERMIT2_ADDRESS],
    });
    if (allowance < amountIn) {
      const approval = await deps.wallet.writeContract({
        address: call.tokenIn,
        abi: erc20Abi,
        functionName: "approve",
        args: [PERMIT2_ADDRESS, maxUint256],
        account: deps.account,
        chain: robinhoodChain,
      });
      await deps.publicClient.waitForTransactionReceipt({ hash: approval });
    }

    // 2. One signature, one nonce: Permit2 nonces are unordered bits, so a random one needs no read.
    const nonce = randomNonce();
    const signature = await deps.wallet.signTypedData({
      ...permitTypedData({ token: call.tokenIn, amount: amountIn, spender: router, nonce, deadline }),
      account: deps.account,
    });

    // 3. The trade. hookData is empty for every listed pool today.
    const hash = await deps.wallet.writeContract({
      address: router,
      abi: svRouterAbi,
      functionName: "swapExactIn",
      args: [
        {
          key: call.poolKey,
          zeroForOne: call.zeroForOne,
          amountIn,
          amountOutMin,
          hookData: "0x",
          deadline,
        },
        { permitted: { token: call.tokenIn, amount: amountIn }, nonce, deadline },
        signature,
      ],
      account: deps.account,
      chain: robinhoodChain,
    });

    // 4. The caller awaits this; it carries the event's numbers, not the quote's.
    return { hash, confirmation: confirm(deps, hash, req.slippagePct) };
  } catch (err) {
    throw mapSwapError(err, req.slippagePct);
  }
}
```

Run: `npx vitest run src/lib/swap.test.ts`
Expected: PASS (11 tests: 7 `it`s plus the 4-row revert table).

- [ ] **Step 7: Keep the call site compiling**

The signature change breaks `TradePanel`, and the gates must be green at this commit. This is the smallest edit that compiles and behaves; Task 5 owns the panel's real wiring and will build on it.

In `src/lib/types.ts`, add the import beside the existing ones and one optional field to `Quote`:

```ts
import type { SwapCall } from "./quote/price";
```

```ts
export interface Quote {
  payAmount: number;
  receiveAmount: number;
  priceImpactPct: number;
  routerFeePct: 0 | 0.5;
  poolFeePct: number;
  minReceived: number;
  /** The route's execution block; absent while the local approximation is answering. */
  call?: SwapCall;
}
```

(Both sides of the `types.ts` ↔ `quote/price.ts` pair import the other with `import type`, so nothing circular survives to runtime.)

In `src/components/TradePanel.tsx`, add the two wagmi clients to the imports and the component, and pass them plus the call block:

```ts
import { usePublicClient, useWalletClient } from "wagmi";
import { executeSwap, SwapFailedError, SwapRejectedError } from "@/lib/swap";
```

Beside the existing `useAppState()` line in the component body:

```ts
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
```

And in `submit`, replace the `executeSwap({ … })` call and widen the catch:

```ts
      if (!quote?.call || !walletClient || !publicClient) {
        throw new SwapFailedError("Trading goes live when the router is deployed. Nothing was spent.");
      }
      const handle = await executeSwap(
        {
          ticker: pair.ticker,
          side,
          payAmount,
          payAsset,
          receiveAmount,
          receiveAsset,
          slippagePct: slippage.value,
          account: address,
          isSuitHolder: isHolder,
          call: quote.call,
        },
        { wallet: walletClient, publicClient, account: address },
      );
```

```ts
    } catch (err) {
      updateToast(toastId, {
        kind: "failed",
        message:
          err instanceof SwapFailedError || err instanceof SwapRejectedError
            ? err.message
            : "Swap failed. Nothing was spent.",
      });
```

Run: `npx tsc --noEmit && npx eslint .`
Expected: clean. If wagmi's client types do not satisfy `SwapDeps`, widen `SwapDeps`' field types to wagmi's return types — never cast at the call site.

- [ ] **Step 8: Run the gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green. `grep -rn "rng\|hexBytes32" src/lib/swap.ts` matches nothing: the fake wallet round-trip is gone. With `NEXT_PUBLIC_SVROUTER_ADDRESS` unset, `npm run build` still succeeds and the panel keeps its disabled state.

- [ ] **Step 9: Commit**

```bash
git add src/lib/swap/abi.ts src/lib/swap/abi.test.ts src/lib/swap/permit.ts src/lib/swap/permit.test.ts src/lib/swap.ts src/lib/swap.test.ts src/lib/types.ts src/components/TradePanel.tsx
git commit -m "Execute swaps through SVRouter with a Permit2 signature" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```
### Task 5: Real balances and the Suits holder default

**Files:**
- Create: `src/test/dom.tsx`, `src/hooks/useTokenBalance.test.tsx`, `src/lib/suits.test.tsx`
- Modify: `src/hooks/useTokenBalance.ts`, `src/lib/suits.ts`, `vitest.config.mts`, `package.json` (`package-lock.json` follows), `.env.example`

**Interfaces:**
- Consumes: `useQuotes()` from `@/hooks/useMarketsData`; `robinhoodChain` from `@/lib/chain`; `Address`, `QuoteAsset`, `TokenPair` from `@/lib/types`; viem's `erc20Abi` and `formatUnits`; wagmi's `useAccount`, `useBlockNumber`, `useReadContract`, `useReadContracts`. Nothing from Tasks 1 to 4 — this task can run in parallel with them.
- Produces: `usePairBalances(pair: TokenPair): PairBalances` with real reads (same name and signature as the stub), `invalidatePairBalances(qc: QueryClient): Promise<void>` from `src/hooks/useTokenBalance.ts`; `useIsSuitHolder` with the mock default flipped in `src/lib/suits.ts`; the DOM test harness `src/test/dom.tsx` (`queryHarness()` plus every `@testing-library/react` export), which Task 6 reuses.

Decisions where the contract and the spec are silent (each one line):
- **Where the decimals come from.** The quote asset's decimals are `QuoteAsset.decimals` from `useQuotes()`, matched on `pair.quote` (the symbol) — already loaded for the whole app, no extra call. `TokenPair` carries no token decimals, so the pair token's come from an on-chain `decimals()` read, **not** from the quote route's `call.tokenOutDecimals`: the balance is needed before any priced answer exists (the 25/50/75/100 buttons and the insufficient-balance check run at amount 0, where the route is not called at all), and a `routable: false` answer carries no `call` and therefore no decimals. `decimals()` is immutable, so it is read once with `staleTime: Infinity, gcTime: Infinity` and is **not** part of the per-block batch.
- **"Refetch on block" samples the head every 10 s.** Robinhood Chain produces a block about every 0.1 s (the contracts repo's `.env.example` puts 50,000 blocks at roughly 80 minutes), so a subscription that invalidated on every block would refetch a hundred times a minute. `useBlockNumber({ watch: { poll: true, pollingInterval: 10_000 } })` plus an invalidation on change is the only sane reading of the spec's "refetches on block".
- **The batch's query key is held in a ref.** wagmi returns a fresh `queryKey` array each render; putting it in the effect's dependency list would make an invalidation re-run the effect, which re-invalidates — a loop. The ref keeps the dependency list to the block number that actually changed, with no `eslint-disable`.
- **Any unknown scale returns zeroes.** Disconnected, quotes not loaded, quote asset not in the list, decimals not read yet: all `{ quote: 0, token: 0 }`. A balance rendered at the wrong scale is worse than no balance.
- **There is no component or hook test in this repo today** — `find src -name '*.test.tsx'` is empty, `vitest.config.mts` includes only `src/**/*.test.ts`, there is no jsdom, no `@testing-library/*`, and no setup file. This task creates that harness because it is the first task that needs it; Task 6 only consumes it.
- **Vitest 4 removed both `environmentMatchGlobs` and the `@vitest-environment` docblock** (verified against the installed `vitest@4.1.11`: no `environmentMatchGlobs` and no docblock parser anywhere in `node_modules/vitest/dist`). Two environments in one run therefore need `test.projects`. The DOM project deliberately does **not** inherit the root config, because the root sets `ssr.resolve.conditions` to `["react-server", …]` and Vite's config merge concatenates arrays rather than replacing them — a merged DOM project would still carry `react-server`, under which `react` exports no client hooks.

- [ ] **Step 1: Add the DOM test harness and split the Vitest run into two projects**

```bash
npm install --save-dev jsdom@^30.1.0 @testing-library/react@^16.3.3 @testing-library/dom@^10.4.2
```

(`npm view jsdom version`, `npm view @testing-library/react version` and `npm view @testing-library/dom version` answered 30.1.0, 16.3.3 and 10.4.2 on 18 Sep 2026; use the current versions if they moved, keeping the caret. `@testing-library/dom` is a peer of `@testing-library/react` and must be installed explicitly. No `@vitejs/plugin-react`: Vite's own esbuild transform compiles `.tsx` with this repo's `tsconfig.json` `"jsx": "react-jsx"`, and tests need no Fast Refresh.)

Replace `vitest.config.mts` entirely:

```ts
import { fileURLToPath } from "node:url";
import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));
const alias = [{ find: /^@\//, replacement: `${src}/` }];

/**
 * Two projects, because the suite needs two environments and Vitest 4 dropped both
 * `environmentMatchGlobs` and the `@vitest-environment` docblock.
 *
 * `node` is every `*.test.ts`: server code, route handlers, PGlite. It inherits the root
 * config, whose `react-server` condition is what Next.js resolves server code under —
 * without it the `server-only` marker in the Envio and Db clients resolves to its throwing
 * client build. It is prepended to Vite's own server conditions rather than replacing them.
 *
 * `dom` is every `*.test.tsx`: hooks and components under jsdom. It does NOT extend the
 * root, on purpose. Vite merges config arrays by concatenation, so an extending project
 * could not drop `react-server` again, and under that condition `react` exports no client
 * hooks at all. It repeats the `@/` alias, which is the only root option it wants.
 */
export default defineConfig({
  resolve: { alias },
  ssr: { resolve: { conditions: ["react-server", ...defaultServerConditions] } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          environment: "node",
          // Ten PGlite instances booting at once exceeded the 10 s hook default twice on a
          // loaded laptop; the boot is real work.
          hookTimeout: 60_000,
        },
      },
      {
        resolve: { alias },
        test: { name: "dom", include: ["src/**/*.test.tsx"], environment: "jsdom" },
      },
    ],
  },
});
```

Run `npx vitest run` once now: expected PASS, the same test count as before, with every file reported under the `node` project and `dom` reporting nothing yet (`--passWithNoTests` is already in `npm test`).

- [ ] **Step 2: Write the DOM test harness**

`src/test/dom.tsx`:

```tsx
import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Testing Library's automatic unmount only runs when Vitest's globals are enabled; this
 * suite imports its API explicitly, so every file that imports this module registers the
 * unmount once, exactly as `@testing-library/react` does for itself under globals.
 */
afterEach(cleanup);

export * from "@testing-library/react";

/**
 * A QueryClientProvider wrapper plus the client behind it, so a test can spy on the client
 * a hook or a component reaches through `useQueryClient`. Retries off and `gcTime` zero:
 * a test must never wait on a retry, and nothing may leak into the next one.
 */
export function queryHarness(): {
  client: QueryClient;
  wrapper: (props: { children: ReactNode }) => ReactElement;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, wrapper: Wrapper };
}
```

- [ ] **Step 3: Write the failing balance test**

`src/hooks/useTokenBalance.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, QuoteAsset, TokenPair } from "@/lib/types";
import { queryHarness, renderHook } from "@/test/dom";
import { invalidatePairBalances, usePairBalances } from "./useTokenBalance";

const h = vi.hoisted(() => ({
  account: { address: undefined as `0x${string}` | undefined, isConnected: false },
  quotes: { data: undefined as unknown[] | undefined },
  decimals: { data: undefined as number | undefined },
  batch: {
    data: undefined as readonly bigint[] | undefined,
    queryKey: ["readContracts", { id: "balances" }] as unknown[],
  },
  block: { data: undefined as bigint | undefined },
  seenReadContract: vi.fn(),
  seenReadContracts: vi.fn(),
  seenBlockNumber: vi.fn(),
}));

vi.mock("wagmi", () => ({
  useAccount: () => h.account,
  useReadContract: (p: unknown) => {
    h.seenReadContract(p);
    return h.decimals;
  },
  useReadContracts: (p: unknown) => {
    h.seenReadContracts(p);
    return h.batch;
  },
  useBlockNumber: (p: unknown) => {
    h.seenBlockNumber(p);
    return h.block;
  },
}));
vi.mock("@/hooks/useMarketsData", () => ({ useQuotes: () => h.quotes }));

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x000000000000000000000000000000000000000a" as Address;
const QUOTE_ADDRESS = "0x000000000000000000000000000000000000000b" as Address;

const nvda: QuoteAsset = {
  symbol: "NVDA",
  name: "NVDA",
  address: QUOTE_ADDRESS,
  decimals: 6,
  usdPrice: 1,
  pairs: 3,
  vol24h: 0,
};

const pair = {
  id: TOKEN,
  ticker: "AI",
  name: "Artificial Inu",
  address: TOKEN,
  quote: "NVDA",
  origin: "LONG",
  tradeable: true,
} as TokenPair;

/** 1,250 NVDA at 6 dp and 125,000 AI at 18 dp, in base units. */
const QUOTE_BASE = BigInt("1250000000");
const TOKEN_BASE = BigInt("125000000000000000000000");

function connected(): void {
  h.account = { address: WALLET, isConnected: true };
  h.quotes.data = [nvda];
  h.decimals.data = 18;
  h.batch.data = [QUOTE_BASE, TOKEN_BASE];
}

function read() {
  const { client, wrapper } = queryHarness();
  const view = renderHook(() => usePairBalances(pair), { wrapper });
  return { client, ...view };
}

describe("usePairBalances", () => {
  beforeEach(() => {
    h.account = { address: undefined, isConnected: false };
    h.quotes.data = undefined;
    h.decimals.data = undefined;
    h.batch.data = undefined;
    h.block.data = undefined;
    h.seenReadContract.mockClear();
    h.seenReadContracts.mockClear();
    h.seenBlockNumber.mockClear();
  });

  it("returns zeroes and asks the chain for nothing while disconnected", () => {
    const { result } = read();
    expect(result.current).toEqual({ quote: 0, token: 0 });
    expect(h.seenReadContracts.mock.calls[0][0]).toMatchObject({ query: { enabled: false } });
    expect(h.seenReadContracts.mock.calls[0][0].contracts).toBeUndefined();
    expect(h.seenReadContract.mock.calls[0][0]).toMatchObject({ query: { enabled: false } });
  });

  it("scales each balance by its own asset's decimals", () => {
    connected();
    const { result } = read();
    expect(result.current).toEqual({ quote: 1250, token: 125_000 });
  });

  it("batches balanceOf for the quote address and the pair token, both on chain 4663", () => {
    connected();
    read();
    const params = h.seenReadContracts.mock.calls[0][0];
    expect(params.allowFailure).toBe(false);
    expect(params.query).toMatchObject({ enabled: true, refetchOnWindowFocus: true });
    expect(params.contracts).toHaveLength(2);
    expect(params.contracts[0]).toMatchObject({
      address: QUOTE_ADDRESS,
      functionName: "balanceOf",
      args: [WALLET],
      chainId: 4663,
    });
    expect(params.contracts[1]).toMatchObject({
      address: TOKEN,
      functionName: "balanceOf",
      args: [WALLET],
      chainId: 4663,
    });
  });

  it("reads the token's decimals once and keeps it, never in the per-block batch", () => {
    connected();
    read();
    expect(h.seenReadContract.mock.calls[0][0]).toMatchObject({
      address: TOKEN,
      functionName: "decimals",
      chainId: 4663,
      query: { enabled: true, staleTime: Infinity, gcTime: Infinity },
    });
  });

  it("returns zeroes rather than a wrong scale while the token's decimals are unknown", () => {
    connected();
    h.decimals.data = undefined;
    expect(read().result.current).toEqual({ quote: 0, token: 0 });
  });

  it("returns zeroes when the pair's quote symbol is not in the quotes list", () => {
    connected();
    h.quotes.data = [{ ...nvda, symbol: "USDC" }];
    const { result } = read();
    expect(result.current).toEqual({ quote: 0, token: 0 });
    expect(h.seenReadContracts.mock.calls[0][0]).toMatchObject({ query: { enabled: false } });
  });

  it("watches the head by polling rather than subscribing to every 0.1 s block", () => {
    connected();
    read();
    expect(h.seenBlockNumber.mock.calls[0][0]).toMatchObject({
      chainId: 4663,
      watch: { poll: true, pollingInterval: 10_000 },
      query: { enabled: true },
    });
  });

  it("invalidates the balance batch when a new block arrives, and not before", () => {
    connected();
    const { client, rerender } = read();
    const spy = vi.spyOn(client, "invalidateQueries");
    rerender();
    expect(spy).not.toHaveBeenCalled();
    h.block.data = BigInt(100);
    rerender();
    expect(spy).toHaveBeenCalledWith({ queryKey: h.batch.queryKey });
  });

  it("refreshes every read batch after a confirmed swap", async () => {
    const { client } = queryHarness();
    const spy = vi.spyOn(client, "invalidateQueries");
    await invalidatePairBalances(client);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["readContracts"] });
  });
});
```

- [ ] **Step 4: Run the balance test to verify it fails**

Run: `npx vitest run src/hooks/useTokenBalance.test.tsx`
Expected: FAIL. `invalidatePairBalances` does not exist yet, so the import fails with `No "invalidatePairBalances" export is defined on the "./useTokenBalance" mock` or `does not provide an export named 'invalidatePairBalances'`; every test in the file is reported as failing.

- [ ] **Step 5: Write the real balance reads**

Replace `src/hooks/useTokenBalance.ts` entirely:

```tsx
"use client";

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { erc20Abi, formatUnits, type ContractFunctionParameters } from "viem";
import { useAccount, useBlockNumber, useReadContract, useReadContracts } from "wagmi";
import { useQuotes } from "@/hooks/useMarketsData";
import { robinhoodChain } from "@/lib/chain";
import type { Address, TokenPair } from "@/lib/types";

export interface PairBalances {
  /** Quote-asset balance, in quote units. */
  quote: number;
  /** Pair-token balance. */
  token: number;
}

const ZERO: PairBalances = { quote: 0, token: 0 };

/**
 * Robinhood Chain produces a block about every 0.1 s, so "refetch on block" samples the
 * head every 10 s rather than subscribing to each one: a balance at most one sample old is
 * what the panel needs, and a per-block invalidation would refetch a hundred times a minute.
 */
const BLOCK_POLL_MS = 10_000;

/**
 * Both wallet balances the trade panel needs, in one `useReadContracts` batch:
 * `balanceOf(quoteAddress, user)` and `balanceOf(tokenAddress, user)`.
 *
 * Decimals come from two places, deliberately. The quote asset carries its own
 * (`QuoteAsset.decimals`, already loaded for the whole app by `useQuotes`), matched on
 * `TokenPair.quote`. The pair token has none in `TokenPair`, so its `decimals()` is read on
 * chain and kept for the session: the value is immutable, and the balance is needed before
 * any quote exists — the 25/50/75/100 buttons and the insufficient-balance check run at
 * amount 0, where the quote route is not called and no `call` block, and therefore no
 * decimals, has come back.
 *
 * Disconnected returns zeroes, and so does every state where a scale is still unknown: a
 * balance rendered at the wrong scale is worse than no balance.
 */
export function usePairBalances(pair: TokenPair): PairBalances {
  const { address, isConnected } = useAccount();
  const quotes = useQuotes();
  const qc = useQueryClient();

  const owner = address as Address | undefined;
  const quoteAsset = quotes.data?.find((q) => q.symbol === pair.quote);
  const ready = Boolean(isConnected && owner && quoteAsset);

  const decimals = useReadContract({
    address: pair.address,
    abi: erc20Abi,
    functionName: "decimals",
    chainId: robinhoodChain.id,
    // Immutable: read once per token, never re-read, and never part of the block batch.
    query: { enabled: Boolean(isConnected), staleTime: Infinity, gcTime: Infinity },
  });

  const contracts: readonly ContractFunctionParameters[] | undefined =
    owner && quoteAsset
      ? [
          {
            address: quoteAsset.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [owner],
            chainId: robinhoodChain.id,
          },
          {
            address: pair.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [owner],
            chainId: robinhoodChain.id,
          },
        ]
      : undefined;

  const batch = useReadContracts({
    allowFailure: false,
    contracts,
    query: { enabled: ready, refetchOnWindowFocus: true },
  });

  const { data: blockNumber } = useBlockNumber({
    chainId: robinhoodChain.id,
    watch: { poll: true, pollingInterval: BLOCK_POLL_MS },
    query: { enabled: ready },
  });

  // wagmi hands back a fresh key array every render. Holding it in a ref keeps the effect's
  // dependency list to the block that actually changed, so an invalidation can never feed
  // itself a new render and loop.
  const keyRef = useRef(batch.queryKey);
  keyRef.current = batch.queryKey;
  useEffect(() => {
    if (!ready || blockNumber === undefined) return;
    void qc.invalidateQueries({ queryKey: keyRef.current });
  }, [blockNumber, ready, qc]);

  const raw = batch.data as readonly bigint[] | undefined;
  if (!ready || !quoteAsset || !raw || raw.length < 2 || decimals.data === undefined) {
    return ZERO;
  }
  return {
    quote: Number(formatUnits(raw[0], quoteAsset.decimals)),
    token: Number(formatUnits(raw[1], decimals.data)),
  };
}

/**
 * Refresh every balance batch after a confirmed swap. wagmi keys each `useReadContracts`
 * query `["readContracts", …]`, so this prefix matches the batch above wherever it is
 * mounted. The 10 s block poll would catch up on its own; this only makes the panel honest
 * immediately.
 */
export function invalidatePairBalances(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: ["readContracts"] });
}
```

- [ ] **Step 6: Run the balance test to verify it passes**

Run: `npx vitest run src/hooks/useTokenBalance.test.tsx`
Expected: PASS, 9 tests, reported under the `dom` project.

- [ ] **Step 7: Write the failing Suits test**

`src/lib/suits.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address } from "@/lib/types";
import { renderHook } from "@/test/dom";

const h = vi.hoisted(() => ({
  read: { data: undefined as bigint | undefined },
  seen: vi.fn(),
}));

vi.mock("wagmi", () => ({
  useReadContract: (p: unknown) => {
    h.seen(p);
    return h.read;
  },
}));

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const NFT = "0x2222222222222222222222222222222222222222";

/**
 * `SUITS_NFT_ADDRESS` is read once at module load, so each case re-imports the module with
 * its own environment. The `wagmi` mock is registered per file and survives `resetModules`.
 */
async function load(env: { nft?: string; mock?: string }) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SUITS_NFT_ADDRESS", env.nft);
  vi.stubEnv("NEXT_PUBLIC_MOCK_SUIT_HOLDER", env.mock);
  return (await import("./suits")).useIsSuitHolder;
}

describe("useIsSuitHolder", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    h.seen.mockClear();
    h.read.data = undefined;
  });

  it("is false without an address, and leaves the read disabled", async () => {
    const useIsSuitHolder = await load({});
    const { result } = renderHook(() => useIsSuitHolder());
    expect(result.current).toBe(false);
    expect(h.seen.mock.calls[0][0]).toMatchObject({ query: { enabled: false } });
  });

  it("reports NOT a holder in an unconfigured build", async () => {
    const useIsSuitHolder = await load({});
    expect(renderHook(() => useIsSuitHolder(WALLET)).result.current).toBe(false);
  });

  it("reports NOT a holder when the mock flag is anything but \"true\"", async () => {
    const useIsSuitHolder = await load({ mock: "yes" });
    expect(renderHook(() => useIsSuitHolder(WALLET)).result.current).toBe(false);
  });

  it("still demos the 0% state when the mock flag is exactly \"true\"", async () => {
    const useIsSuitHolder = await load({ mock: "true" });
    expect(renderHook(() => useIsSuitHolder(WALLET)).result.current).toBe(true);
  });

  it("ignores the mock flag once the NFT address is configured", async () => {
    const useIsSuitHolder = await load({ nft: NFT, mock: "true" });
    h.read.data = BigInt(0);
    expect(renderHook(() => useIsSuitHolder(WALLET)).result.current).toBe(false);
  });

  it("is a holder when balanceOf is above zero", async () => {
    const useIsSuitHolder = await load({ nft: NFT });
    h.read.data = BigInt(2);
    const { result } = renderHook(() => useIsSuitHolder(WALLET));
    expect(result.current).toBe(true);
    expect(h.seen.mock.calls[0][0]).toMatchObject({
      address: NFT,
      functionName: "balanceOf",
      args: [WALLET],
      chainId: 4663,
      query: { enabled: true },
    });
  });
});
```

- [ ] **Step 8: Run the Suits test to verify it fails**

Run: `npx vitest run src/lib/suits.test.tsx`
Expected: FAIL, 2 of 6. "reports NOT a holder in an unconfigured build" and "reports NOT a holder when the mock flag is anything but \"true\"" both get `true`: today's `!== "false"` treats an unset flag, and anything but the literal `"false"`, as a holder.

- [ ] **Step 9: Flip the mock default**

`src/lib/suits.ts`: replace the doc comment and the mock branch.

```ts
/**
 * isSuitHolder = balanceOf(SuitsNFT, address) > 0. Until the contract address is
 * configured, NEXT_PUBLIC_MOCK_SUIT_HOLDER decides and defaults to "not a holder": an
 * unconfigured build must show the 0.5% router fee every user will actually pay, and the
 * quote route is told the same answer, so the displayed fee and the executed fee come from
 * one decision. Set the flag to exactly "true" to demo the 0% holder state.
 */
export function useIsSuitHolder(address?: Address): boolean {
  const { data } = useReadContract({
    address: SUITS_NFT_ADDRESS,
    abi: erc721BalanceAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: robinhoodChain.id,
    query: { enabled: Boolean(address && SUITS_NFT_ADDRESS) },
  });
  if (!address) return false;
  if (!SUITS_NFT_ADDRESS) {
    return process.env.NEXT_PUBLIC_MOCK_SUIT_HOLDER === "true";
  }
  return (data ?? BigInt(0)) > BigInt(0);
}
```

`.env.example`: replace the `NEXT_PUBLIC_MOCK_SUIT_HOLDER` block.

```
# Only read while NEXT_PUBLIC_SUITS_NFT_ADDRESS is unset. Anything but "true" means "not a
# holder" (0.5% router fee), which is what an unconfigured build must show: the fee every
# user will actually pay. Set it to "true" to demo the 0% holder state.
NEXT_PUBLIC_MOCK_SUIT_HOLDER=
```

- [ ] **Step 10: Run the Suits test to verify it passes**

Run: `npx vitest run src/lib/suits.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 11: Run the gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green, with the suite now reporting two projects (`node` and `dom`). `git diff package.json` shows only the three new devDependencies. Then `npm run dev` with a wallet connected on a token page: the balance line reads the wallet's real numbers, `Max` fills exactly the balance, and the Router fee row reads `0.5%` rather than `0% · Suit holder` in a build with neither `NEXT_PUBLIC_SUITS_NFT_ADDRESS` nor the mock flag set.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json vitest.config.mts .env.example src/test/dom.tsx src/hooks/useTokenBalance.ts src/hooks/useTokenBalance.test.tsx src/lib/suits.ts src/lib/suits.test.tsx
git commit -m "Read real wallet balances and default an unconfigured build to not a Suit holder" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

### Task 6: Wire the trade panel to the quote route and the real swap

**Files:**
- Create: `src/components/TradePanel.test.tsx`
- Modify: `src/lib/types.ts`, `src/lib/data/envio.ts`, `src/lib/data/mock.ts`, `src/components/TradePanel.tsx`

**Interfaces:**
- Consumes: `SwapCall` and `PriceResult` from `src/lib/quote/price.ts` (Task 3); `GET /api/tokens/[address]/quote` (Task 3); `hasRouter()` from `src/lib/chain.ts` (Task 1); `toHuman` from `src/lib/quote/math.ts` (Task 2); `executeSwap`, `SwapDeps`, `SwapReceipt`, `SwapFailedError`, `SwapRejectedError` from `src/lib/swap.ts` (Task 4); `usePairBalances`, `invalidatePairBalances` from `src/hooks/useTokenBalance.ts` and `src/test/dom.tsx` (Task 5); `useSwapQuote` from `src/hooks/useMarketsData.ts` (unchanged); `usePublicClient`, `useWalletClient` from wagmi.
- Produces: `Quote` widened with `routable?: boolean` and `call?: SwapCall`, and `SwapCall` re-exported from `src/lib/types.ts`; `EnvioDataSource.quoteSwap` answering from the route; a `TradePanel` that submits the route's `call` block and reports the `Trade` event's `amountOut`.

Decisions where the contract and the spec are silent (each one line):
- **`quoteSwap` carries the call block by widening `Quote`, not by returning a richer type.** Two optional fields — `routable?: boolean` and `call?: SwapCall` — leave `MarketsDataSource.quoteSwap`'s signature, `useSwapQuote`'s type, `localQuote`'s return and every existing read of `quote.payAmount` compiling untouched. A richer return type would have changed the interface method, both implementations, the hook's generic and `localQuote` all at once for nothing the panel needs.
- **`SwapCall` is defined once, in `src/lib/quote/price.ts` (the contract's home for it), and re-exported from `src/lib/types.ts` as a type.** `import type` is erased under `isolatedModules`, so `types.ts` gains no runtime dependency on server code and the type-level cycle (`price.ts` imports `Side`/`Denom` from `types.ts`) is harmless.
- **`routable` is a tri-state on purpose.** `false` means the route simulated the pool and could not route it; `true` means it priced it; `undefined` means nobody has asked yet. The panel shows the `UntradeableCard` only on an explicit `false`, so the card cannot flash before any input.
- **The route is not called at amount 0.** The panel queries at amount 0 so the rate and fee rows render before any input, but the route requires `amount > 0` and answers 400 below it. `EnvioDataSource.quoteSwap` therefore answers amount 0 from `localQuote`, with no `call`, so nothing can be submitted from it.
- **`MockDataSource.quoteSwap` keeps `localQuote` and never reaches the route.** The mock's tokens are seeded pseudo-random addresses that no backend knows: every call would 404 and the whole demo build's panel would break. It is modified only to document the contract it now has — it returns no `call`, so the mock build's submit button stays disabled, which is exactly the state a build with no `NEXT_PUBLIC_SVROUTER_ADDRESS` is in anyway. (I flag this as a place the task brief and the mock's purpose disagree.)
- **Error wording stays in `src/lib/swap.ts`.** Spec section 4 makes the swap client own the message mapping, so the panel renders `err.message` for both `SwapRejectedError` and `SwapFailedError` and falls back to "Swap failed. Nothing was spent." for anything else. Duplicating the strings in the panel would let the two drift.
- **The `UntradeableCard` decision moves into `TradeForm`**, after every hook call, because routability now comes from the quote rather than from the list's `tradeable` flag. `TradePanel`'s own `!pair.tradeable` guard stays: the list still answers for a token whose panel has not queried yet.

- [ ] **Step 1: Widen `Quote` and re-export `SwapCall`**

`src/lib/types.ts`: add the import at the very top of the file, above the doc comment's closing block is not needed — put it as the first line of the file.

```ts
import type { SwapCall } from "@/lib/quote/price";
```

then, immediately after the `export type VoteDir = "bull" | "bear";` line:

```ts
/**
 * The execution block the quote route returns. It lives in `src/lib/quote/price.ts` next to
 * the code that builds it; this is a type-only re-export, erased at build time, so nothing
 * client-side gains a runtime dependency on the route's internals.
 */
export type { SwapCall };
```

and replace the `Quote` interface:

```ts
export interface Quote {
  payAmount: number;
  receiveAmount: number;
  priceImpactPct: number;
  routerFeePct: 0 | 0.5;
  poolFeePct: number;
  minReceived: number;
  /**
   * `false` when the quote route simulated the pool and could not route it, `true` when it
   * priced it, `undefined` when nothing has been priced yet — amount 0, or the mock source's
   * local approximation. Only an explicit `false` shows the "Not routed" card.
   */
  routable?: boolean;
  /**
   * Execution, verbatim from the route. The browser never recomputes an amount in it; it
   * signs and sends it as it stands. Absent means "nothing can be submitted from this quote".
   */
  call?: SwapCall;
}
```

- [ ] **Step 2: Reach the quote route from the Envio data source**

`src/lib/data/envio.ts`: replace the import line and the `quoteSwap` method.

The imports at the top of the file become:

```ts
import type { Address, Candle, Denom, Holder, Interval, MarketsDataSource, Quote, QuoteAsset, Side, TokenPair, Trade, VoteDir } from "@/lib/types";
import type { PriceResult } from "@/lib/quote/price";
import { localQuote, poolFeePctFor } from "@/lib/quote";
import { LocalWatchStore } from "./localStore";
```

Add these two helpers just below `getJson`:

```ts
/** The panel's tolerance as the route's integer basis points, clamped to its 1..5000 range. */
function toSlippageBps(pct: number): number {
  return Math.min(5000, Math.max(1, Math.round(pct * 100)));
}

/**
 * The typed amount as a plain decimal string. `String(1e-7)` is "1e-7", which the route
 * rejects; "fullwide" never uses exponent notation and `useGrouping: false` never adds a
 * thousands separator.
 */
function toDecimalString(n: number): string {
  return n.toLocaleString("fullwide", { useGrouping: false, maximumFractionDigits: 20 });
}
```

and replace `quoteSwap` with:

```ts
  async quoteSwap(id: string, side: Side, amount: number, denom: Denom, isSuitHolder: boolean, slippagePct: number): Promise<Quote> {
    const fresh = this.pairsCache && Date.now() - this.pairsCache.at < 30_000 ? this.pairsCache.list : await this.pairs();
    const pair = fresh.find((p) => p.id === id.toLowerCase());
    if (!pair) throw new Error(`Unknown token ${id}`);

    // The panel asks at amount 0 so the rate and the fee rows render before any input; the
    // route requires amount > 0 and answers 400 below it. The local approximation answers
    // that one case, and carries no `call`, so nothing can be submitted from it.
    if (!(amount > 0)) return localQuote(pair, side, amount, denom, isSuitHolder, slippagePct);

    const key = id.toLowerCase();
    const query = new URLSearchParams({
      side,
      amount: toDecimalString(amount),
      denom,
      slippageBps: String(toSlippageBps(slippagePct)),
      holder: isSuitHolder ? "1" : "0",
    });
    const res = await fetch(`/api/tokens/${key}/quote?${query}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`/api/tokens/${key}/quote: ${res.status}`);
    const body = (await res.json()) as PriceResult;

    if (!body.routable) {
      // The panel replaces the whole form with the "Not routed" card, so none of these
      // numbers is ever rendered; zeroes are the honest placeholder for "no price exists".
      return {
        payAmount: 0,
        receiveAmount: 0,
        priceImpactPct: 0,
        routerFeePct: isSuitHolder ? 0 : 0.5,
        poolFeePct: poolFeePctFor(pair),
        minReceived: 0,
        routable: false,
      };
    }
    return {
      payAmount: Number(body.payAmount),
      receiveAmount: Number(body.receiveAmount),
      priceImpactPct: body.priceImpactPct,
      routerFeePct: body.routerFeePct,
      poolFeePct: body.poolFeePct,
      minReceived: Number(body.minReceived),
      routable: true,
      call: body.call,
    };
  }
```

- [ ] **Step 3: Say in the mock what its quote now is and is not**

`src/lib/data/mock.ts`: replace the `quoteSwap` method with the same body under a comment that states the contract.

```ts
  /**
   * The seeded approximation, deliberately not the quote route: every mock token is a
   * pseudo-random address no backend knows, so `/api/tokens/{id}/quote` would 404 for all
   * of them and the demo build's panel would break. The result therefore carries no `call`,
   * which the panel reads as "nothing can be submitted" — the state a build with no
   * NEXT_PUBLIC_SVROUTER_ADDRESS is already in.
   */
  async quoteSwap(
    id: string,
    side: Side,
    amount: number,
    denom: Denom,
    isSuitHolder: boolean,
    slippagePct: number,
  ): Promise<Quote> {
    return localQuote(
      this.pairOrThrow(id),
      side,
      amount,
      denom,
      isSuitHolder,
      slippagePct,
    );
  }
```

- [ ] **Step 4: Write the failing panel test**

`src/components/TradePanel.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Quote, SwapCall, TokenPair } from "@/lib/types";
import { fireEvent, queryHarness, render, screen, waitFor } from "@/test/dom";
import TradePanel from "./TradePanel";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x000000000000000000000000000000000000000a" as Address;
const QUOTE_ADDRESS = "0x000000000000000000000000000000000000000b" as Address;

const CALL: SwapCall = {
  poolKey: {
    currency0: TOKEN,
    currency1: QUOTE_ADDRESS,
    fee: 3000,
    tickSpacing: 60,
    hooks: "0x0000000000000000000000000000000000000000" as Address,
  },
  zeroForOne: false,
  amountIn: "100000000",
  amountOutMin: "980000000000000000000",
  tokenIn: QUOTE_ADDRESS,
  tokenOut: TOKEN,
  tokenInDecimals: 6,
  tokenOutDecimals: 18,
};

const PRICED: Quote = {
  payAmount: 100,
  receiveAmount: 1000,
  priceImpactPct: 0.004,
  routerFeePct: 0.5,
  poolFeePct: 0.3,
  minReceived: 990,
  routable: true,
  call: CALL,
};

const pair = {
  id: TOKEN,
  ticker: "AI",
  name: "Artificial Inu",
  address: TOKEN,
  quote: "NVDA",
  origin: "LONG",
  tradeable: true,
  priceUsd: 0.1943,
  priceQuote: 0.000866,
  change1h: 0,
  change24h: 0,
  vol24h: 0,
  mcap: 0,
  fdv: 0,
  liquidity: 1_000_000,
  holders: 0,
  createdAt: 0,
  bull: 0,
  bear: 0,
  poolId: "0x000000000000000000000000000000000000000c",
  hook: "",
  feeTier: "0.30%",
} as TokenPair;

const h = vi.hoisted(() => {
  // The panel's own error classes, defined here so the test never depends on how
  // src/lib/swap.ts builds them; `instanceof` inside the panel sees exactly these.
  class SwapFailedError extends Error {}
  class SwapRejectedError extends Error {}
  return {
    SwapFailedError,
    SwapRejectedError,
    state: {
      address: "0x1111111111111111111111111111111111111111",
      isConnected: true,
      isHolder: false,
      addToast: vi.fn(() => 1),
      updateToast: vi.fn(),
    },
    balances: { quote: 1250, token: 125_000 },
    quote: undefined as Quote | undefined,
    quoteError: false,
    router: true,
    wallet: { id: "wallet-client" } as unknown,
    publicClient: { id: "public-client" } as unknown,
    executeSwap: vi.fn(),
    invalidate: vi.fn(),
  };
});

vi.mock("@/context/AppState", () => ({ useAppState: () => h.state }));
vi.mock("@/hooks/useTokenBalance", () => ({
  usePairBalances: () => h.balances,
  invalidatePairBalances: h.invalidate,
}));
vi.mock("@/hooks/useMarketsData", () => ({
  useSwapQuote: () => ({ data: h.quote, isError: h.quoteError }),
}));
vi.mock("wagmi", () => ({
  usePublicClient: () => h.publicClient,
  useWalletClient: () => ({ data: h.wallet }),
}));
vi.mock("@/lib/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain")>()),
  hasRouter: () => h.router,
}));
vi.mock("@/lib/swap", () => ({
  executeSwap: h.executeSwap,
  SwapFailedError: h.SwapFailedError,
  SwapRejectedError: h.SwapRejectedError,
}));

function show() {
  const { wrapper } = queryHarness();
  return render(<TradePanel pair={pair} />, { wrapper });
}

function typeAmount(value: string): void {
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value } });
}

function buyButton(): HTMLElement {
  return screen.getByRole("button", { name: "Buy AI" });
}

describe("TradePanel", () => {
  beforeEach(() => {
    h.state.address = "0x1111111111111111111111111111111111111111";
    h.state.isConnected = true;
    h.state.isHolder = false;
    h.state.addToast.mockClear();
    h.state.addToast.mockReturnValue(1);
    h.state.updateToast.mockClear();
    h.balances = { quote: 1250, token: 125_000 };
    h.quote = PRICED;
    h.quoteError = false;
    h.router = true;
    h.wallet = { id: "wallet-client" };
    h.publicClient = { id: "public-client" };
    h.executeSwap.mockReset();
    h.invalidate.mockReset();
  });

  it("shows the not-routed card when the route could not simulate the pool", () => {
    h.quote = { ...PRICED, routable: false, call: undefined };
    show();
    expect(screen.getByText("Not routed")).toBeTruthy();
    expect(screen.queryByLabelText("Amount")).toBeNull();
  });

  it("disables trading with the deploy notice while the router address is unset", () => {
    h.router = false;
    show();
    expect(screen.getByText("Trading goes live when the router is deployed")).toBeTruthy();
    expect(buyButton().hasAttribute("disabled")).toBe(true);
  });

  it("asks for a wallet before anything else", () => {
    h.state.isConnected = false;
    show();
    expect(screen.getByText("Connect a wallet to trade.")).toBeTruthy();
    expect(buyButton().hasAttribute("disabled")).toBe(true);
  });

  it("asks for an amount once a wallet is connected", () => {
    show();
    expect(screen.getByText("Enter an amount.")).toBeTruthy();
  });

  it("refuses an amount the balance cannot cover", () => {
    h.quote = { ...PRICED, payAmount: 5000 };
    show();
    typeAmount("5000");
    expect(screen.getByText("Insufficient NVDA balance.")).toBeTruthy();
    expect(buyButton().hasAttribute("disabled")).toBe(true);
  });

  it("disables the button when the quote route failed", () => {
    h.quoteError = true;
    show();
    typeAmount("100");
    expect(screen.getByText("Quote unavailable. Try again.")).toBeTruthy();
  });

  it("disables the button while no call block has come back", () => {
    h.quote = { ...PRICED, call: undefined };
    show();
    typeAmount("100");
    expect(screen.getByText("Fetching a quote…")).toBeTruthy();
    expect(buyButton().hasAttribute("disabled")).toBe(true);
  });

  it("shows the 0% router fee for a Suit holder", () => {
    h.state.isHolder = true;
    h.quote = { ...PRICED, routerFeePct: 0 };
    show();
    expect(screen.getByText("0% · Suit holder")).toBeTruthy();
  });

  it("shows 0.5% for everyone else", () => {
    show();
    expect(screen.getByText("0.5%")).toBeTruthy();
  });

  it("sends the route's call block and the wallet clients verbatim", async () => {
    h.executeSwap.mockResolvedValue({
      hash: "0xdeadbeef",
      confirmation: Promise.resolve({
        amountOut: BigInt("987650000000000000000"),
        fee: BigInt("500000"),
        holderRate: false,
      }),
    });
    show();
    typeAmount("100");
    fireEvent.click(buyButton());
    await waitFor(() => expect(h.executeSwap).toHaveBeenCalledTimes(1));
    const [req, deps] = h.executeSwap.mock.calls[0];
    expect(req.call).toBe(CALL);
    expect(req).toMatchObject({ ticker: "AI", side: "buy", account: WALLET, isSuitHolder: false });
    expect(deps).toEqual({
      wallet: h.wallet,
      publicClient: h.publicClient,
      account: WALLET,
    });
  });

  it("reports the Trade event's amountOut in the confirmed toast, not the quote's", async () => {
    h.executeSwap.mockResolvedValue({
      hash: "0xdeadbeef",
      confirmation: Promise.resolve({
        amountOut: BigInt("987650000000000000000"),
        fee: BigInt("500000"),
        holderRate: false,
      }),
    });
    show();
    typeAmount("100");
    fireEvent.click(buyButton());
    await waitFor(() =>
      expect(h.state.updateToast).toHaveBeenCalledWith(1, {
        kind: "confirmed",
        message: "Bought 987.65 AI for 100 NVDA",
      }),
    );
    expect(h.state.addToast).toHaveBeenCalledWith({
      kind: "pending",
      message: "Buying 1,000 AI for 100 NVDA",
    });
    expect(h.state.updateToast).toHaveBeenCalledWith(1, { hash: "0xdeadbeef" });
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it("renders the swap client's own message when the wallet rejects", async () => {
    h.executeSwap.mockRejectedValue(
      new h.SwapRejectedError("Cancelled in wallet. Nothing was spent."),
    );
    show();
    typeAmount("100");
    fireEvent.click(buyButton());
    await waitFor(() =>
      expect(h.state.updateToast).toHaveBeenCalledWith(1, {
        kind: "failed",
        message: "Cancelled in wallet. Nothing was spent.",
      }),
    );
  });

  it("falls back to the generic failure for an error it does not know", async () => {
    h.executeSwap.mockRejectedValue(new Error("boom"));
    show();
    typeAmount("100");
    fireEvent.click(buyButton());
    await waitFor(() =>
      expect(h.state.updateToast).toHaveBeenCalledWith(1, {
        kind: "failed",
        message: "Swap failed. Nothing was spent.",
      }),
    );
  });
});
```

- [ ] **Step 5: Run the panel test to verify it fails**

Run: `npx vitest run src/components/TradePanel.test.tsx`
Expected: FAIL, 8 of 13. The not-routed, deploy-notice, call-block, `executeSwap` arguments, confirmed toast, rejection and generic-failure cases all fail; the wallet, amount, balance and fee-row cases already pass against the current panel.

- [ ] **Step 6: Wire the panel**

`src/components/TradePanel.tsx`, four replacements.

**(a)** Replace the import block at the top of the file (lines 1 to 11):

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePublicClient, useWalletClient } from "wagmi";
import { useAppState } from "@/context/AppState";
import { invalidatePairBalances, usePairBalances } from "@/hooks/useTokenBalance";
import { useSwapQuote } from "@/hooks/useMarketsData";
import { hasRouter, ORIGIN_URLS, robinhoodChain } from "@/lib/chain";
import { fmtAmt, fmtQuote, fmtTradeAmt, fmtUsd } from "@/lib/format";
import { toHuman } from "@/lib/quote/math";
import { executeSwap, SwapFailedError, SwapRejectedError } from "@/lib/swap";
import type { Denom, Side, TokenPair } from "@/lib/types";
import { GearIcon, Spinner } from "./ui";
```

**(b)** Replace everything from `function TradeForm({ pair }: { pair: TokenPair }) {` down to and including `const minReceived = quote?.minReceived ?? 0;`:

```tsx
function TradeForm({ pair }: { pair: TokenPair }) {
  const { isConnected, address, isHolder, addToast, updateToast } = useAppState();
  const balances = usePairBalances(pair);
  const publicClient = usePublicClient({ chainId: robinhoodChain.id });
  const { data: walletClient } = useWalletClient({ chainId: robinhoodChain.id });
  const qc = useQueryClient();
  const [side, setSide] = useState<Side>("buy");
  const [denom, setDenom] = useState<Denom>("quote");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState<Slippage>(DEFAULT_SLIPPAGE);
  const [slipOpen, setSlipOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const buy = side === "buy";
  const amountNum = parseFloat(amount) || 0;
  const payAsset = buy ? pair.quote : pair.ticker;
  const receiveAsset = buy ? pair.ticker : pair.quote;
  const payBalance = buy ? balances.quote : balances.token;
  const quoteUsd = pair.priceUsd / pair.priceQuote;

  const quoteQuery = useSwapQuote({
    id: pair.id,
    side,
    amount: amountNum,
    denom,
    isSuitHolder: isHolder,
    slippagePct: slippage.value,
  });
  const closeSlippage = useCallback(() => setSlipOpen(false), []);

  // Every hook above runs unconditionally. Routability is the route's verdict, not the
  // list's `tradeable` flag, so the "Not routed" card is decided here — and only on an
  // explicit false, so it can never flash before anything has been priced.
  const quote = quoteQuery.data;
  if (quote?.routable === false) return <UntradeableCard pair={pair} />;

  const call = quote?.call;
  const payAmount = amountNum ? (quote?.payAmount ?? 0) : 0;
  const receiveAmount = amountNum ? (quote?.receiveAmount ?? 0) : 0;
  const impact = quote?.priceImpactPct ?? 0;
  const routerFee = quote?.routerFeePct ?? (isHolder ? 0 : 0.5);
  const poolFee = quote?.poolFeePct;
  const minReceived = quote?.minReceived ?? 0;
```

**(c)** Replace the state machine (from `let state: "ready" | "disabled" | "pending" = "ready";` down to and including `if (pending) state = "pending";`):

```tsx
  let state: "ready" | "disabled" | "pending" = "ready";
  let reason = "";
  if (!hasRouter()) {
    // The quote route still answers, so every number on the panel is real; only execution
    // is off until NEXT_PUBLIC_SVROUTER_ADDRESS names a deployed router.
    state = "disabled";
    reason = "Trading goes live when the router is deployed";
  } else if (!isConnected) {
    state = "disabled";
    reason = "Connect a wallet to trade.";
  } else if (!amountNum) {
    state = "disabled";
    reason = "Enter an amount.";
  } else if (quoteQuery.isError) {
    state = "disabled";
    reason = "Quote unavailable. Try again.";
  } else if (payAmount > payBalance) {
    state = "disabled";
    reason = `Insufficient ${payAsset} balance.`;
  } else if (!walletClient || !publicClient) {
    state = "disabled";
    reason = "Connecting to your wallet…";
  } else if (!call) {
    // No execution block: the first priced answer is still in flight, or this build's data
    // source is the mock, which never asks the route.
    state = "disabled";
    reason = "Fetching a quote…";
  }
  if (pending) state = "pending";
```

**(d)** Delete the now-duplicated `const closeSlippage = useCallback(() => setSlipOpen(false), []);` line that sits just above `const submit`, and replace `submit` with:

```tsx
  const submit = async () => {
    if (state !== "ready" || !address || !call || !walletClient || !publicClient) return;
    const verb = buy ? "Buying" : "Selling";
    const done = buy ? "Bought" : "Sold";
    const paid = `${fmtTradeAmt(payAmount)} ${payAsset}`;
    setPending(true);
    setSlipOpen(false);
    const toastId = addToast({
      kind: "pending",
      message: `${verb} ${fmtTradeAmt(receiveAmount)} ${receiveAsset} for ${paid}`,
    });
    try {
      const handle = await executeSwap(
        {
          ticker: pair.ticker,
          side,
          payAmount,
          payAsset,
          receiveAmount,
          receiveAsset,
          slippagePct: slippage.value,
          account: address,
          isSuitHolder: isHolder,
          // Verbatim: the browser never recomputes an amount the route returned.
          call,
        },
        { wallet: walletClient, publicClient, account: address },
      );
      updateToast(toastId, { hash: handle.hash });
      const receipt = await handle.confirmation;
      // The Trade event's own number, never the quote's: a hook can take a cut on the way
      // out, and the user is told what actually landed in the wallet.
      const received = fmtTradeAmt(Number(toHuman(receipt.amountOut, call.tokenOutDecimals)));
      updateToast(toastId, { kind: "confirmed", message: `${done} ${received} ${receiveAsset} for ${paid}` });
      setAmount("");
      void invalidatePairBalances(qc);
    } catch (err) {
      updateToast(toastId, {
        kind: "failed",
        // src/lib/swap.ts owns the wording (spec section 4); duplicating it here would let
        // the two drift.
        message:
          err instanceof SwapRejectedError || err instanceof SwapFailedError
            ? err.message
            : "Swap failed. Nothing was spent.",
      });
    } finally {
      setPending(false);
    }
  };
```

- [ ] **Step 7: Run the panel test to verify it passes**

Run: `npx vitest run src/components/TradePanel.test.tsx`
Expected: PASS, 13 tests.

- [ ] **Step 8: Run the gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green. Then `NEXT_PUBLIC_DATA_SOURCE=envio npm run dev` on a token page: with `NEXT_PUBLIC_SVROUTER_ADDRESS` empty the numbers move with every typed amount (the route is answering) and the button reads the deploy notice; with it set to a deployed router the button arms and a submit opens the wallet.

- [ ] **Step 9: Commit**

```bash
git add src/lib/types.ts src/lib/data/envio.ts src/lib/data/mock.ts src/components/TradePanel.tsx src/components/TradePanel.test.tsx
git commit -m "Quote the trade panel from the route and execute it through SVRouter" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

### Task 7: The anvil fork harness and the docs

**Files:**
- Create: `scripts/fork/anvil.sh`, `scripts/fork/deploy-local.mts`, `scripts/fork/swap-e2e.mts`
- Modify: `package.json` (three scripts), `.gitignore`, `scripts/README.md`, `README.md`

**Interfaces:**
- Consumes: `PERMIT2_ADDRESS`, `UNIVERSAL_ROUTER_ADDRESS`, `SVROUTER_ADDRESS`, `robinhoodChain` from `src/lib/chain.ts` (Task 1); `getBackend()` and `poolKey()` from `src/lib/market/backend.ts` (Task 1); `PoolKeyRow` from `src/lib/market/poolKey.ts` (Task 1); `toHuman` from `src/lib/quote/math.ts` (Task 2); `createQuoter` from `src/lib/quote/quoter.ts` and `priceSwap` from `src/lib/quote/price.ts` (Task 3); `executeSwap` from `src/lib/swap.ts` (Task 4); the contracts repo's `script/Deploy.s.sol`.
- Produces: `npm run fork:anvil`, `npm run fork:deploy`, `npm run fork:e2e`; `.env.fork` (git-ignored, written by the deploy script).

Facts read out of the contracts repo (`/Users/kobs/Desktop/SuitVenturesMarket/SuitVenturesMarket-contracts`), each one line:
- `script/Deploy.s.sol`'s header says it is invoked as `forge script script/Deploy.s.sol --rpc-url <alias or url> --account <name> --broadcast …`; the deployer key is never an environment variable, which is why the fork script passes anvil's own published key with `--private-key` instead.
- It reads `OWNER`, `FEE_WALLET`, `UNIVERSAL_ROUTER`, `PERMIT2` (all required, `vm.envAddress`), `SUITS_NFT` (`vm.envOr`, default zero) and `ALLOW_OTHER_ADDRESSES` (`vm.envOr`, default false).
- It requires `block.chainid == 4663`, requires `UNIVERSAL_ROUTER` and `PERMIT2` to equal the spec's constants unless `ALLOW_OTHER_ADDRESSES=true`, and requires both to have code on the target chain — all true on a fork of Robinhood Chain, so the fork deploy passes the spec's constants and never sets the override.
- `ISVRouter.SwapParams` is `{ PoolKey key; bool zeroForOne; uint128 amountIn; uint128 amountOutMin; bytes hookData; uint256 deadline; }`, and `Trade(address indexed user, bytes32 indexed poolId, address indexed tokenIn, address tokenOut, uint256 amountIn, uint256 fee, uint256 amountOut, bool holderRate)` is emitted once per successful `swapExactIn`. `src/lib/swap.ts` already decodes that event into `SwapReceipt`, so the e2e asserts on `handle.confirmation`.

Decisions where the spec is silent (each one line):
- **Funding the test wallet is a storage write, not an impersonation.** anvil's accounts hold ETH but no NVDA and no AI, and the only large NVDA holder on the fork is the v4 PoolManager, whose balance backs the very pool being traded. The e2e instead finds each token's balance mapping slot by brute force (32 candidate slots, both the Solidity `keccak256(key ++ slot)` and the Vyper `keccak256(slot ++ key)` layouts, restoring every slot that did not work) and writes the balance with `anvil_setStorageAt`. This is `forge`'s own `deal` trick, done from viem.
- **Both scripts refuse to broadcast anywhere but localhost.** A wrong `NEXT_PUBLIC_RPC_URL` in `.env.local` would otherwise send a real deploy and a real swap to mainnet. The guard is a regex on the URL plus a `getChainId()` check, before any signing.
- **`.env.fork` is loaded last.** `npm run fork:e2e` passes `--env-file-if-exists=.env.local --env-file-if-exists=.env.fork` in that order, so the fork's `NEXT_PUBLIC_RPC_URL` and `NEXT_PUBLIC_SVROUTER_ADDRESS` win over anything `.env.local` sets. `.env.local` is still loaded because the e2e resolves pool keys through the market backend, which needs `DATABASE_URL`.
- **anvil's published test key is a constant in `deploy-local.mts`.** It is the mnemonic anvil prints on every start; it is worthless outside a local fork, and no real key appears in any of these three files or in `.env.fork`.

- [ ] **Step 1: Add the three package scripts and git-ignore `.env.fork`**

```bash
npm pkg set "scripts.fork:anvil=bash scripts/fork/anvil.sh"
npm pkg set "scripts.fork:deploy=node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/fork/deploy-local.mts"
npm pkg set "scripts.fork:e2e=node --env-file-if-exists=.env.local --env-file-if-exists=.env.fork --conditions=react-server --import tsx scripts/fork/swap-e2e.mts"
```

`.gitignore`, appended at the end of the file:

```
# Fork harness output: the local anvil RPC, the local router address and anvil's own
# published test key. The .env* rule above already covers it; named here so nobody
# re-adds it by hand, and so a reader knows the file exists.
.env.fork
```

- [ ] **Step 2: Write `scripts/fork/anvil.sh`**

```bash
#!/usr/bin/env bash
# Starts an anvil fork of Robinhood Chain for the M2 swap end-to-end run and prints the
# funded test accounts. Leave it running; the other two fork scripts talk to it.
#
#   FORK_RPC_URL   what to fork (default: the public Robinhood Chain endpoint)
#   FORK_PORT      anvil's port (default: 8545)
#   FORK_BLOCK     pin a block; unset means the chain head
#
# The public endpoint keeps only about the last 50,000 blocks of state (roughly 80 minutes
# at this chain's ~0.1 s blocks), so a pinned block older than that will not serve.
set -euo pipefail

RPC_URL="${FORK_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
PORT="${FORK_PORT:-8545}"

if ! command -v anvil >/dev/null 2>&1; then
  echo "anvil not found. Install Foundry: https://getfoundry.sh" >&2
  exit 1
fi

BLOCK_ARGS=()
if [ -n "${FORK_BLOCK:-}" ]; then
  BLOCK_ARGS=(--fork-block-number "$FORK_BLOCK")
fi

cat <<EOF
anvil fork of Robinhood Chain (chain id 4663) on port ${PORT}, forking ${RPC_URL}

Funded test accounts. These are anvil's own published keys: public knowledge, worthless
anywhere but this local fork, and the only keys this harness ever uses.

  #0  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
      0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  #1  0x70997970C51812dc3A010C7d01b50e0d17dc79C8
      0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  #2  0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
      0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

In another shell, from the repo root:
  npm run fork:deploy   # deploys SVRouter onto this fork and writes .env.fork
  npm run fork:e2e      # a real buy and a real sell through the app's own code

EOF

exec anvil --fork-url "$RPC_URL" --chain-id 4663 --port "$PORT" "${BLOCK_ARGS[@]}"
```

Then make it executable: `chmod +x scripts/fork/anvil.sh`.

- [ ] **Step 3: Write `scripts/fork/deploy-local.mts`**

```ts
/**
 * Deploys SVRouter onto the running anvil fork with the contracts repo's own deploy script,
 * prints the router address and writes .env.fork for the e2e run.
 *
 * Run: npm run fork:deploy   (with npm run fork:anvil running in another shell)
 *
 *   FORK_RPC_URL    the anvil endpoint (default http://127.0.0.1:8545)
 *   CONTRACTS_DIR   the contracts repo (default ../SuitVenturesMarket-contracts)
 *
 * script/Deploy.s.sol takes OWNER, FEE_WALLET, UNIVERSAL_ROUTER and PERMIT2 from the
 * environment, refuses any chain but 4663, and refuses any router or Permit2 but the spec's
 * constants unless ALLOW_OTHER_ADDRESSES is set — which this script never sets, because a
 * fork of Robinhood Chain has the real ones deployed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, isAddress, type Address } from "viem";
import { PERMIT2_ADDRESS, UNIVERSAL_ROUTER_ADDRESS } from "@/lib/chain";

/** anvil's published test account #0. Public knowledge, funded only on a local fork. */
const ANVIL_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;

const rpcUrl = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545";
const contractsDir = resolve(process.env.CONTRACTS_DIR ?? "../SuitVenturesMarket-contracts");

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!LOCAL_RPC.test(rpcUrl)) {
  die("FORK_RPC_URL must point at the local anvil fork; refusing to broadcast anywhere else.");
}
if (!existsSync(resolve(contractsDir, "script/Deploy.s.sol"))) {
  die(`No script/Deploy.s.sol under ${contractsDir}. Set CONTRACTS_DIR to the contracts repo.`);
}

const client = createPublicClient({ transport: http(rpcUrl) });
let chainId: number;
try {
  chainId = await client.getChainId();
} catch {
  die(`No node answering at ${rpcUrl}. Start it with: npm run fork:anvil`);
}
if (chainId !== 4663) {
  die(`The node at ${rpcUrl} reports chain id ${chainId}, not 4663. Start anvil with --chain-id 4663.`);
}

execFileSync(
  "forge",
  ["script", "script/Deploy.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--private-key", ANVIL_KEY],
  {
    cwd: contractsDir,
    stdio: "inherit",
    env: {
      ...process.env,
      OWNER: ANVIL_ACCOUNT,
      FEE_WALLET: ANVIL_ACCOUNT,
      UNIVERSAL_ROUTER: UNIVERSAL_ROUTER_ADDRESS,
      PERMIT2: PERMIT2_ADDRESS,
      SUITS_NFT: "0x0000000000000000000000000000000000000000",
    },
  },
);

// forge's broadcast log is the reliable source; the console.log line in the script is for a
// human reading the terminal.
type Broadcast = {
  transactions: { transactionType: string; contractName: string; contractAddress: string }[];
};
const runLatest = resolve(contractsDir, "broadcast/Deploy.s.sol/4663/run-latest.json");
if (!existsSync(runLatest)) die(`forge wrote no broadcast log at ${runLatest}.`);
const broadcast = JSON.parse(readFileSync(runLatest, "utf8")) as Broadcast;
const created = broadcast.transactions.find(
  (t) => t.transactionType === "CREATE" && t.contractName === "SVRouter",
);
if (!created || !isAddress(created.contractAddress)) {
  die("No SVRouter CREATE transaction in the broadcast log.");
}
const router = created.contractAddress as Address;

const body = [
  "# Written by scripts/fork/deploy-local.mts. Git-ignored, local fork only.",
  "# The key below is anvil's own published test account #0: public knowledge, funded only",
  "# on this fork, worthless anywhere else. Never put a real key in this file.",
  `NEXT_PUBLIC_RPC_URL=${rpcUrl}`,
  `NEXT_PUBLIC_SVROUTER_ADDRESS=${router}`,
  `FORK_PRIVATE_KEY=${ANVIL_KEY}`,
  "",
].join("\n");
writeFileSync(resolve(".env.fork"), body, { mode: 0o600 });

console.log(`\nSVRouter on the fork: ${router}`);
console.log(".env.fork written. Next: npm run fork:e2e");
```

- [ ] **Step 4: Write `scripts/fork/swap-e2e.mts`**

```ts
/**
 * End-to-end proof on the anvil fork: a real buy and a real sell on AI/NVDA and MARIO/NVDA,
 * priced by the quote route's own brain (`priceSwap` over the V4 Quoter) and executed by the
 * browser's own `executeSwap` — the same modules, the same `call` block, the same Permit2
 * signature. Asserts every Trade event's amountOut is at least the amountOutMin the quote
 * signed for, and exits non-zero on any failure.
 *
 * Run: npm run fork:e2e   (after npm run fork:anvil and npm run fork:deploy)
 *
 * It reads .env.local for DATABASE_URL (pool keys come from the market store) and .env.fork,
 * loaded second so its NEXT_PUBLIC_RPC_URL and NEXT_PUBLIC_SVROUTER_ADDRESS win.
 */
import assert from "node:assert/strict";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  http,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodChain, SVROUTER_ADDRESS } from "@/lib/chain";
import { getBackend } from "@/lib/market/backend";
import type { PoolKeyRow } from "@/lib/market/poolKey";
import { toHuman } from "@/lib/quote/math";
import { priceSwap } from "@/lib/quote/price";
import { createQuoter } from "@/lib/quote/quoter";
import { executeSwap } from "@/lib/swap";
import type { Denom, Side } from "@/lib/types";

const LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
const SLIPPAGE_BPS = 100; // 1 %
/** Pools to exercise, as ticker/quote symbol pairs (spec section 7). */
const POOLS: ReadonlyArray<{ ticker: string; quote: string }> = [
  { ticker: "AI", quote: "NVDA" },
  { ticker: "MARIO", quote: "NVDA" },
];

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "";
const privateKey = process.env.FORK_PRIVATE_KEY ?? "";
if (!LOCAL_RPC.test(rpcUrl)) {
  die("NEXT_PUBLIC_RPC_URL must point at the local anvil fork (see .env.fork); refusing to trade anywhere else.");
}
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  die("FORK_PRIVATE_KEY is missing or malformed. Run npm run fork:deploy first.");
}
if (!SVROUTER_ADDRESS) {
  die("NEXT_PUBLIC_SVROUTER_ADDRESS is empty. Run npm run fork:deploy first.");
}

const transport = http(rpcUrl);
const account = privateKeyToAccount(privateKey as Hex);
const publicClient = createPublicClient({ chain: robinhoodChain, transport });
const walletClient = createWalletClient({ account, chain: robinhoodChain, transport });
const testClient = createTestClient({ chain: robinhoodChain, mode: "anvil", transport });
const quoter = createQuoter({ client: publicClient });

const EMPTY_SLOT = pad("0x", { size: 32 });

/**
 * Give `holder` at least `amount` of `token` by writing the balance mapping directly, the
 * way forge's `deal` does. anvil's accounts hold ETH and nothing else, and the only large
 * NVDA holder on the fork is the v4 PoolManager, whose balance backs the pool under test.
 * Tries 32 candidate slots in both the Solidity (key ++ slot) and Vyper (slot ++ key)
 * layouts, and restores every slot that turned out not to be the balance.
 */
async function deal(token: Address, holder: Address, amount: bigint): Promise<void> {
  const held = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  });
  if (held >= amount) return;
  const value = pad(toHex(amount), { size: 32 });
  for (let slot = 0n; slot < 32n; slot++) {
    const candidates: Hex[] = [
      keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, slot])),
      keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [slot, holder])),
    ];
    for (const index of candidates) {
      const before = await publicClient.getStorageAt({ address: token, slot: index });
      await testClient.setStorageAt({ address: token, index, value });
      const now = await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [holder],
      });
      if (now === amount) return;
      await testClient.setStorageAt({ address: token, index, value: before ?? EMPTY_SLOT });
    }
  }
  throw new Error(`could not find the balance mapping slot of ${token}`);
}

async function one(
  label: string,
  pool: PoolKeyRow,
  side: Side,
  amount: string,
  denom: Denom,
): Promise<bigint> {
  const priced = await priceSwap(quoter, {
    side,
    amount,
    denom,
    slippageBps: SLIPPAGE_BPS,
    holder: false,
    pool,
  });
  assert.ok(priced.routable, `${label}: the quoter refused the pool (routable: false)`);

  const { call } = priced;
  // Twice the input so the fee, the swap and a second run all fit.
  await deal(call.tokenIn, account.address, BigInt(call.amountIn) * 2n);

  const handle = await executeSwap(
    {
      ticker: label,
      side,
      payAmount: Number(priced.payAmount),
      payAsset: side === "buy" ? "quote" : "token",
      receiveAmount: Number(priced.receiveAmount),
      receiveAsset: side === "buy" ? "token" : "quote",
      slippagePct: SLIPPAGE_BPS / 100,
      account: account.address,
      isSuitHolder: false,
      call,
    },
    { wallet: walletClient, publicClient, account: account.address },
  );
  const receipt = await handle.confirmation;
  const min = BigInt(call.amountOutMin);
  assert.ok(
    receipt.amountOut >= min,
    `${label}: Trade amountOut ${receipt.amountOut} is below amountOutMin ${min}`,
  );
  const outDecimals = call.tokenOutDecimals;
  console.log(
    `${label}: in ${toHuman(BigInt(call.amountIn), call.tokenInDecimals)} · ` +
      `quoted ${priced.receiveAmount} · event ${toHuman(receipt.amountOut, outDecimals)} · ` +
      `min ${toHuman(min, outDecimals)} · fee ${toHuman(receipt.fee, call.tokenInDecimals)} · ` +
      `holderRate ${receipt.holderRate} · tx ${handle.hash}`,
  );
  return receipt.amountOut;
}

async function roundTrip(ticker: string, quoteSymbol: string): Promise<void> {
  const backend = getBackend();
  const pairs = await backend.pairs("all");
  const pair = pairs.find((p) => p.ticker === ticker && p.quote === quoteSymbol);
  assert.ok(pair, `${ticker}/${quoteSymbol} is not in the market store`);
  const pool = await backend.poolKey(pair.id);
  assert.ok(pool, `${ticker}/${quoteSymbol} has no listed pool`);

  // Buy one unit of the quote asset's worth, then sell half of what landed.
  const bought = await one(`${ticker}/${quoteSymbol} buy`, pool, "buy", "1", "quote");
  await one(`${ticker}/${quoteSymbol} sell`, pool, "sell", toHuman(bought / 2n, pool.tokenDecimals), "token");
}

try {
  const chainId = await publicClient.getChainId();
  assert.equal(chainId, 4663, `the node at ${rpcUrl} reports chain id ${chainId}, not 4663`);
  for (const { ticker, quote } of POOLS) await roundTrip(ticker, quote);
  console.log("\nok — both pools bought and sold, every Trade event cleared its amountOutMin");
} catch (err) {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
```

- [ ] **Step 5: Start the fork**

Run, in its own shell: `npm run fork:anvil`
Expected: the three funded accounts printed, then anvil's own banner and `Listening on 127.0.0.1:8545`. Leave it running for steps 6 and 7.

- [ ] **Step 6: Deploy onto the fork**

Run, in a second shell from the repo root: `npm run fork:deploy`
Expected: forge's own output ending in `SVRouter deployed at: 0x…`, then `SVRouter on the fork: 0x…` and `.env.fork written`. `git status` must still show a clean tree: `.env.fork` is ignored. `cat .env.fork` shows exactly three variables and anvil's published key, nothing else.

- [ ] **Step 7: Run the end-to-end swap**

Run: `npm run fork:e2e`
Expected: four lines, one per leg, each with the quoted output, the event's output, the minimum and the fee, then `ok — both pools bought and sold, every Trade event cleared its amountOutMin`, and `echo $?` prints 0. A leg whose event fell below its minimum prints `FAILED: … is below amountOutMin …` and the command exits 1.

- [ ] **Step 8: Document the fork scripts in `scripts/README.md`**

Change the first line from `# Database scripts` to `# Scripts`, change "All four run" to "The four database scripts run", and append this section at the end of the file:

```markdown
## Fork scripts (M2 trading)

Three scripts prove the whole trading path on a local anvil fork of Robinhood Chain, without
touching mainnet and without waiting on the SVRouter deploy. They need Foundry
(https://getfoundry.sh) and the contracts repo checked out beside this one
(`../SuitVenturesMarket-contracts`, or set `CONTRACTS_DIR`).

| Command | What it does |
|---|---|
| `npm run fork:anvil` | Starts `anvil --fork-url <public RPC> --chain-id 4663` and prints the funded test accounts. Leave it running. `FORK_RPC_URL`, `FORK_PORT` and `FORK_BLOCK` override the defaults; the public endpoint keeps only about 80 minutes of state, so an old `FORK_BLOCK` will not serve. |
| `npm run fork:deploy` | Runs the contracts repo's `script/Deploy.s.sol` against that anvil with the spec's Universal Router and Permit2, reads the router address out of forge's broadcast log, and writes `.env.fork` with `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_SVROUTER_ADDRESS` and a funded key. |
| `npm run fork:e2e` | A real buy and a real sell on AI/NVDA and MARIO/NVDA through the app's own modules — `priceSwap` over the V4 Quoter for the numbers, `executeSwap` for the Permit2 signature and the `swapExactIn` call. Asserts every `Trade` event's `amountOut` is at least the `amountOutMin` the quote signed for, and exits non-zero otherwise. |

Run them in that order, `fork:anvil` in its own shell. `fork:e2e` reads `.env.local` as well,
because it resolves pool keys through the market backend and therefore needs `DATABASE_URL`;
`.env.fork` is loaded second so the fork's RPC and router win over anything `.env.local` sets.

`.env.fork` is git-ignored and never carries a real key: the only key in it is anvil's own
published test account #0, which is public knowledge and funded only on the local fork. Both
scripts refuse to broadcast to anything but a localhost RPC, and both check the node reports
chain id 4663 before they sign anything.

The e2e funds the test wallet by writing each token's balance mapping with
`anvil_setStorageAt` (forge's `deal` trick, done from viem), because anvil's accounts hold
ETH and nothing else and the only large NVDA holder on the fork is the v4 PoolManager, whose
balance backs the pool under test.
```

- [ ] **Step 9: Mark the M2 stubs done in `README.md`**

Replace the paragraph that reads

```
Preview deployments get no database variable and stay on the mock source.
Both sources share the swap math in `src/lib/quote.ts` — a constant-product
approximation until the v4 Quoter lands in M2.
```

with

```
Preview deployments get no database variable and stay on the mock source. The live source
prices a trade through `GET /api/tokens/[address]/quote`, which simulates the V4 Quoter and
returns both the display numbers and the execution `call` block; `src/lib/quote.ts` keeps its
constant-product approximation for the mock source and for the amount-0 case the route does
not answer.
```

and replace the whole `## Stubs still to wire (M2)` section with

```markdown
## Stubs still to wire

| Stub | Where | Status |
|---|---|---|
| Swap execution | `src/lib/swap.ts` | **Done (M2)** — Permit2 signature and `SVRouter.swapExactIn`, the receipt's `Trade` event parsed for the real output |
| Swap quote | `src/lib/quote.ts` `localQuote` | **Done (M2)** — the V4 Quoter behind `GET /api/tokens/[address]/quote`; the approximation stays for the mock source |
| Wallet balances | `src/hooks/useTokenBalance.ts` | **Done (M2)** — batched ERC-20 `balanceOf` reads for the quote asset and the pair token |
| Suit holder check | `src/lib/suits.ts` | **Done (M2)** — live `balanceOf` when `NEXT_PUBLIC_SUITS_NFT_ADDRESS` is set; the mock flag now defaults to "not a holder" |
| Watchlist / votes persistence | localStorage, in both sources | M3 — route handlers keyed by address, authorised by the session signature |
| Launchpad links for untradeable pools | `src/lib/chain.ts` | M3 — Bags dapp URL |

Execution is off until `NEXT_PUBLIC_SVROUTER_ADDRESS` names a deployed router; the quote route
still answers, so every number on the panel is real before the deploy. `scripts/fork/` proves
the whole path against a local anvil fork in the meantime — see `scripts/README.md`.
```

- [ ] **Step 10: Run the gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green. `git status` shows no `.env.fork` and no `.env.local`; `git diff package.json` shows only the three `fork:*` scripts.

- [ ] **Step 11: Commit**

```bash
git add package.json .gitignore scripts/fork/anvil.sh scripts/fork/deploy-local.mts scripts/fork/swap-e2e.mts scripts/README.md README.md
git commit -m "Prove the trading path on an anvil fork and mark the M2 stubs done" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```
