# M1 API Layer and Frontend Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route handlers in the frontend that read the Envio indexer's GraphQL API, convert to USD, and serve the existing `MarketsDataSource` models; an `EnvioDataSource` that consumes them; and the contract changes the frontend needs (address keys, `Origin`, nullable fields) so Markets and the token page run on live data.

**Architecture:** `src/lib/envio/` holds a thin GraphQL client, an in-memory TTL cache, and pure shaping functions (rows in, `TokenPair`/`QuoteAsset`/`Candle`/`Trade`/`Holder` out). `src/app/api/*` route handlers call those and set CDN cache headers. `EnvioDataSource` is a fetch client over the routes; watchlist and votes stay in a local store until the signed API exists (M2). Components change only where the data contract changes.

**Tech Stack:** Next.js 16 route handlers, TypeScript, Vitest (added), the existing React/Tailwind/wagmi app.

**Spec:** `docs/superpowers/specs/2026-09-12-m1-live-data-design.md` (sections 6 to 8). Depends on the indexer plan `docs/superpowers/plans/2026-09-12-m1-indexer.md` for the GraphQL schema (entity and field names are copied from it).

## Amendments, 16 September 2026

Measured against the full Envio Cloud deployment (commit 2fa2043, 859 M events, 234,945 pools, 130,226 tokens) after its sync finished. The plan had not been executed, so the changes below replace the original text in place.

- The endpoint requires an API key (`ENVIO_GRAPHQL_KEY`, server-only); the HyperSync token is not used by the frontend.
- No `Candle.interval` filter anywhere: it fails on the deployed schema. Candles are selected by pool id plus an id pattern; window stats are per-pool `h1` lookups in batches, not a global scan (`WINDOW_QUERY` removed, `windowQuery()` and `windowStats()` added).
- `Token_by_pk` replaced by a filtered `Token` query (composite key).
- Pairs: `LIMIT` 500, TTL 30 s, optional `?scope=launchpad` (Pons and LONG tokens only; 0.5 s against 4 s for all origins). Change figures use hourly buckets: price now against the open of the hour bucket 1 h and 24 h ago, falling back to the last close before that bucket.
- The indexer's Envio release branch is `envio`; pushes to `main` no longer deploy.
- Staleness must exempt pinned quotes, or 44% of the table loses its USD price (see Global Constraints).

## Global Constraints

- The frontend never calls Envio directly: only route handlers read `ENVIO_GRAPHQL_URL` and `ENVIO_GRAPHQL_KEY` (server-only, no `NEXT_PUBLIC_` prefix). `ENVIO_GRAPHQL_KEY` is the endpoint API key from Envio Cloud's Security tab (`envio-cloud indexer security api-key list suitventures-indexer kobesergio --show-tokens`), sent as `Authorization: Bearer`; it is not the HyperSync `ENVIO_API_TOKEN` the indexer uses.
- Never filter `Candle` on `interval`: on the deployed schema every such filter fails with `database query error` (the enum is named `Interval`, which collides with a Postgres type). Candles are selected by `pool_id` plus an id pattern `<pool>-<interval>-%` (ids are `<pool>-<interval>-<bucket>`), never by a global scan: window stats come from each pool's own `h1` candles, fetched in aliased batches of 50 pools.
- Composite primary keys: `Token_by_pk` needs `chainId` on this deployment, so single-token reads use `Token(where: { id: { _eq: $id } }, limit: 1)`.
- Measured on the full deployment (16 Sep 2026): pairs list 4 s for 200 rows over all origins, 0.5 s launchpad-only; candles by id pattern 0.3 to 1.2 s; h1 window rows for 50 pools 0.4 s; trades and holders 0.3 s. The endpoint allows 250 queries a minute; the pairs route stays under 25 a minute.
- USD conversion happens only in `src/lib/envio/shape.ts` using `QuotePrice` rows: `priceUsd = priceQuote * usdPrice`, `fdv = priceUsd * totalSupply / 10^decimals`, `mcap = fdv`, `liquidity = (tvlQuote/10^qDec + tvlToken/10^tDec * priceQuote) * usdPrice` (null when TVL is null), `vol24h = volumeQuote24h * usdPrice`.
- Tokens are keyed by **address** (`TokenPair.id`, lowercase). Routes are `/t/[address]`.
- `Origin` = `"LONG" | "Pons" | "Uniswap" | "Other" | "SUIT" | "SV"` replaces `Launchpad` everywhere. `tradeable` is `true` for every pool in M1 (the Quoter check is M2).
- `change1h`, `change24h` and `liquidity` are `number | null`; null renders as a dash, sorts last, and is excluded from the Gainers preset.
- A quote whose `QuotePrice.updatedAt` is older than 3 days (259,200 s) is stale: its `usdPrice` is reported as `null` and every USD figure derived from it is `null`. **A pinned row is never stale**: USDG carries `aggregator: "pinned"` and `usdPrice: 1` with the `updatedAt` of the block where it was first seen, 99 days old on the deployed indexer, so the age test must skip it. Without that exemption 18,064 of the 40,643 listed tokens (44%) lose their USD price, USDG being the largest quote asset.
- 29 of the 54 configured quote assets have no `QuotePrice` row at all, because they have no Chainlink feed on this chain (AMC, DJT, GLD, RDDT, HIMS and 24 more). That is 5,250 more listed tokens, 13%, which currently render as `$0.00`. Deciding what those rows show is an open item for MAXLONG, not a plan change; until it is decided the shaping keeps them at 0 and the table must not claim the figure is a price.
- Cache headers on every data route: `Cache-Control: public, s-maxage=<ttl>, stale-while-revalidate=60`; in-process TTL cache with the same ttl. Envio errors return HTTP 503 with `Retry-After: 15`.
- Keep the lint, type-check and build green after every task: `npx eslint .`, `npx tsc --noEmit`, `npm run build`.
- Commit after every task with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467
  ```

## File Structure

```
src/lib/types.ts                 Origin, TokenPair.id, nullable fields, MarketsDataSource keyed by id
src/lib/markets.ts               ORIGIN_OPTIONS, nullable-aware filter and sort
src/lib/format.ts                fmtPctOrDash, fmtUsdOrDash, toneClassOrFlat
src/lib/data/seed.ts, mock.ts    ids = addresses, origin, STONKBROKER as Other
src/lib/envio/client.ts          gql(): fetch to Envio with token, EnvioUnavailableError
src/lib/envio/cache.ts           ttlCache(): in-process memo with TTL
src/lib/envio/queries.ts         GraphQL documents and row types
src/lib/envio/shape.ts           rows → models, USD, window stats, staleness
src/lib/envio/fixtures.ts        one fixture response for tests
src/app/api/_lib/respond.ts      cached() / failure() helpers
src/app/api/pairs/route.ts
src/app/api/quotes/route.ts
src/app/api/tokens/[address]/candles/route.ts
src/app/api/tokens/[address]/trades/route.ts
src/app/api/tokens/[address]/holders/route.ts
src/app/api/health/route.ts
src/lib/quote.ts                 localQuote() shared by the mock and EnvioDataSource until the Quoter (M2)
src/lib/data/localStore.ts       browser-local watchlist and votes
src/lib/data/envio.ts            EnvioDataSource over the routes
src/app/t/[address]/page.tsx     renamed from t/[ticker]
components touched               PairsTable, TokenHeader, TradePanel, MarketsToolbar, TokenView, ActivityTabs
```

---

### Task 1: Data-contract changes: address keys, Origin, nullable fields

**Files:**
- Modify: `src/lib/types.ts`, `src/lib/markets.ts`, `src/lib/format.ts`, `src/lib/data/seed.ts`, `src/lib/data/mock.ts`, `src/lib/data/envio.ts`, `src/lib/chain.ts`, `src/hooks/useMarketsData.ts`, `src/context/AppState.tsx`, `src/components/PairsTable.tsx`, `src/components/TokenHeader.tsx`, `src/components/TradePanel.tsx`, `src/components/MarketsToolbar.tsx`, `src/components/TokenView.tsx`, `src/components/ActivityTabs.tsx`, `src/app/watchlist/page.tsx`, `src/app/page.tsx`, `package.json`
- Rename: `src/app/t/[ticker]/` → `src/app/t/[address]/`
- Test: `src/lib/markets.test.ts`

**Interfaces:**
- Produces: `Origin`; `TokenPair { id: string; origin: Origin; change1h: number | null; change24h: number | null; liquidity: number | null; ... }`; `MarketsDataSource` methods `candles(id, interval)`, `trades(id)`, `holders(id)`, `quoteSwap(id, ...)`, `setWatch(address, id, ...)`, `vote(address, id, ...)`, `watchlist()` returning ids; `ORIGIN_OPTIONS`; `OriginFilter`; `MarketFilters.origin`; `fmtPctOrDash(v: number | null)`, `fmtUsdOrDash(v: number | null)`, `toneClassOrFlat(v: number | null)`.

- [ ] **Step 1: Add Vitest and write the failing test**

```bash
npm install --save-dev vitest@^4.1.0
npm pkg set scripts.test="vitest run --passWithNoTests"
```

`src/lib/markets.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { DEFAULT_FILTERS, selectPairs } from "./markets";
import type { TokenPair } from "./types";

function pair(over: Partial<TokenPair>): TokenPair {
  return {
    id: "0xa", ticker: "A", name: "A", address: "0xa", quote: "NVDA", origin: "LONG", tradeable: true,
    priceUsd: 1, priceQuote: 0.01, change1h: 1, change24h: 5, vol24h: 100, mcap: 10, fdv: 10, liquidity: 20000,
    holders: 1, createdAt: 0, bull: 0, bear: 0, poolId: "0x1", hook: "None", feeTier: "0.30%", ...over,
  };
}

describe("selectPairs with null fields", () => {
  it("excludes null 24h change from Gainers", () => {
    const rows = selectPairs([pair({ id: "0xa", change24h: null }), pair({ id: "0xb", change24h: 3 })], { ...DEFAULT_FILTERS, preset: "gainers", sortKey: "h24", sortDir: "desc" }, 1_000);
    expect(rows.map((r) => r.id)).toEqual(["0xb"]);
  });
  it("sorts nulls last in both directions", () => {
    const list = [pair({ id: "0xa", liquidity: null }), pair({ id: "0xb", liquidity: 5 }), pair({ id: "0xc", liquidity: 9 })];
    expect(selectPairs(list, { ...DEFAULT_FILTERS, sortKey: "liq", sortDir: "desc" }, 1_000).map((r) => r.id)).toEqual(["0xc", "0xb", "0xa"]);
    expect(selectPairs(list, { ...DEFAULT_FILTERS, sortKey: "liq", sortDir: "asc" }, 1_000).map((r) => r.id)).toEqual(["0xb", "0xc", "0xa"]);
  });
  it("filters by origin", () => {
    const list = [pair({ id: "0xa", origin: "Pons" }), pair({ id: "0xb", origin: "Uniswap" })];
    expect(selectPairs(list, { ...DEFAULT_FILTERS, origin: "Uniswap" }, 1_000).map((r) => r.id)).toEqual(["0xb"]);
  });
});
```

Run: `npm test`
Expected: FAIL (`origin` filter and null handling don't exist yet; type errors on `origin`).

- [ ] **Step 2: Change the types**

In `src/lib/types.ts` replace the `Launchpad` line and the `TokenPair` fields:
```ts
export type Origin = "LONG" | "Pons" | "Uniswap" | "Other" | "SUIT" | "SV";

export interface TokenPair {
  /** Token contract address, lowercase. The canonical key: thousands of memecoins share tickers. */
  id: string;
  ticker: string;
  name: string;
  address: Address;
  logoUrl?: string;
  quote: string;
  origin: Origin;
  tradeable: boolean;
  priceUsd: number;
  priceQuote: number;
  /** percent; null when no candle exists before the window ("new") */
  change1h: number | null;
  change24h: number | null;
  vol24h: number;
  mcap: number;
  fdv: number;
  /** USD; null while liquidity accounting is unavailable */
  liquidity: number | null;
  holders: number;
  createdAt: number;
  bull: number;
  bear: number;
  poolId: Address;
  hook: string;
  feeTier: string;
}
```
Add `stale?: boolean` to `QuoteAsset`. In `MarketsDataSource` rename every `ticker: string` parameter to `id: string` (candles, trades, holders, quoteSwap, setWatch, vote); `watchlist()` returns ids; the doc comment says "token address". `grep -rn "Launchpad\|launchpad" src` must afterwards return only the toolbar label text.

- [ ] **Step 3: Update markets.ts, format.ts, seed and mock**

`src/lib/markets.ts`: rename `LaunchpadFilter` → `OriginFilter = "all" | Origin`, `LAUNCHPAD_OPTIONS` → `ORIGIN_OPTIONS` with rows `all/All, LONG/LONG, Pons/PONS, Uniswap/UNISWAP, Other/OTHER`, `MarketFilters.launchpad` → `origin`, `DEFAULT_FILTERS.origin = "all"`; in `filterPairs` use `p.origin` and change the Gainers rule to `p.change24h !== null && p.change24h > 0 && p.liquidity !== null && p.liquidity > GAINERS_MIN_LIQUIDITY`; make `sortValue` return `number | string | null` (passing `h1`/`h24`/`liq` through unchanged) and put nulls last in `sortPairs`:
```ts
    const av = sortValue(a, key, now);
    const bv = sortValue(b, key, now);
    if (av === null && bv === null) return b.vol24h - a.vol24h;
    if (av === null) return 1;
    if (bv === null) return -1;
```

`src/lib/format.ts`, append:
```ts
export function fmtPctOrDash(v: number | null): string {
  return v === null ? "—" : fmtPct(v);
}

export function fmtUsdOrDash(v: number | null): string {
  return v === null ? "—" : fmtUsd(v);
}

export function toneClassOrFlat(v: number | null): string {
  return v === null ? "text-ink-50" : toneClass(v);
}
```

`src/lib/data/seed.ts`: `SeedToken.pad: Origin`; STONKBROKER's `pad` becomes `"Other"`; `buildPairs` sets `id: address.toLowerCase()` and `origin: s.pad` (drop `launchpad`); `HOOK_BY_LAUNCHPAD`/`FEE_TIER_BY_LAUNCHPAD` become `HOOK_BY_ORIGIN`/`FEE_TIER_BY_ORIGIN: Record<Origin, string>` with `Uniswap: "None"/"0.30%"`, `SUIT: "None"/"0.30%"`, `Other: "Unknown hook"/"0.30%"`; delete `poolFeePct` and `poolFeeLabel` (Task 5 replaces them with `src/lib/quote.ts`, and `TradePanel` already builds its own label).

`src/lib/data/mock.ts`: `pair(id)` looks up `p.id === id.toLowerCase()`; every method takes `id`; the watchlist default becomes the ids of SUIT and AI (looked up from `buildPairs` by ticker in the constructor); `vote()` and `setWatch()` use ids; `quoteSwap` keeps its math until Task 5 moves it.

`src/lib/data/envio.ts`: rename the parameters to `_id` (the class is replaced in Task 5).

`src/lib/chain.ts`: `LAUNCHPAD_URLS` → `ORIGIN_URLS: Partial<Record<Origin, string>> = {}`.

- [ ] **Step 4: Update hooks, state, components and routes**

- `src/hooks/useMarketsData.ts`: `usePair(id)` matches `p.id === id.toLowerCase()`; `keys.candles(id, interval)`, `keys.trades(id)`, `keys.holders(id)`; `useSwapQuote` params use `id`.
- `src/context/AppState.tsx`: `toggleStar(id)`, `vote(id, dir)`; the pairs optimistic update matches `p.id === id`; `setLaunchpad` → `setOrigin(o: OriginFilter)`.
- `src/components/PairsTable.tsx`: `href = \`/t/${pair.id}\``; `pad = pair.origin.toUpperCase()`; `toneClassOrFlat`/`fmtPctOrDash` for 1h and 24h; `fmtUsdOrDash(pair.liquidity)` in the row and the expanded detail; `stars.has(p.id)`, `onToggleStar(pair.id)`.
- `src/components/TokenHeader.tsx`: badge `pair.origin.toUpperCase()`; star and vote calls pass `pair.id`; the change line uses `toneClassOrFlat`/`fmtPctOrDash`.
- `src/components/TradePanel.tsx`: `poolFeeText` suffix by `pair.origin` (`Pons` → MemeHook, `LONG` → Doppler); `UntradeableCard` copy becomes "This pool can't be routed through the SuitVentures swap yet." and renders the link only when `ORIGIN_URLS[pair.origin]` exists; `useSwapQuote({ id: pair.id, ... })`.
- `src/components/MarketsToolbar.tsx`: `ORIGIN_OPTIONS`, `filters.origin`, `setOrigin`; the label text stays "Launchpad".
- `src/components/ActivityTabs.tsx`: `useTrades(pair.id)`, `useHolders(pair.id)`; Info rows use `fmtUsdOrDash(pair.liquidity)`.
- `src/components/TokenView.tsx`: prop `address`, `usePair(address)`; the not-found copy says "No token at {short(address)}."
- `src/app/t/[address]/page.tsx` (moved): `params: Promise<{ address: string }>`, passes `address.toLowerCase()`; `generateMetadata` title `short(address)`.
- `src/app/page.tsx` and `src/app/watchlist/page.tsx`: the empty-state copy uses `filters.origin`.

- [ ] **Step 5: Verify**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green; `grep -rn "launchpad" src` returns only the "Launchpad" label in `MarketsToolbar.tsx`. Start `npm run dev`, open `/t/0x2e8c31162b855a2ffa90f6f8634643ad6f111e18` (AI) and `/`: mock data renders as before with UNISWAP/OTHER in the segment.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Key tokens by address, replace Launchpad with Origin, allow null change and liquidity" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

### Task 2: Envio GraphQL client and TTL cache

**Files:**
- Create: `src/lib/envio/client.ts`, `src/lib/envio/cache.ts`
- Test: `src/lib/envio/client.test.ts`, `src/lib/envio/cache.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `class EnvioUnavailableError extends Error`; `gql<T>(query: string, variables?: Record<string, unknown>): Promise<T>` (server-only; throws `EnvioUnavailableError` on network failure, non-2xx, or GraphQL `errors`); `ttlCache<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>` (memoizes per key for `ttlMs`, dedupes concurrent loads, serves the last good value if a reload throws and one exists); `clearTtlCache()`.

- [ ] **Step 1: Write the failing tests**

`src/lib/envio/client.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { gql, EnvioUnavailableError } from "./client";

describe("gql", () => {
  beforeEach(() => {
    process.env.ENVIO_GRAPHQL_URL = "https://indexer.test/v1/graphql";
    process.env.ENVIO_GRAPHQL_KEY = "tok";
  });
  it("posts the query with the bearer token and returns data", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { Pool: [{ id: "0x1" }] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const data = await gql<{ Pool: { id: string }[] }>("query { Pool { id } }");
    expect(data.Pool[0]?.id).toBe("0x1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://indexer.test/v1/graphql");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
  });
  it("throws EnvioUnavailableError on GraphQL errors and non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 200 })));
    await expect(gql("query { x }")).rejects.toBeInstanceOf(EnvioUnavailableError);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 502 })));
    await expect(gql("query { x }")).rejects.toBeInstanceOf(EnvioUnavailableError);
  });
});
```

`src/lib/envio/cache.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { ttlCache, clearTtlCache } from "./cache";

describe("ttlCache", () => {
  it("memoizes within the ttl and dedupes concurrent loads", async () => {
    clearTtlCache();
    const load = vi.fn(async () => Math.random());
    const [a, b] = await Promise.all([ttlCache("k", 1000, load), ttlCache("k", 1000, load)]);
    expect(a).toBe(b);
    expect(await ttlCache("k", 1000, load)).toBe(a);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("serves the last good value when a reload fails", async () => {
    clearTtlCache();
    vi.useFakeTimers();
    const load = vi.fn<() => Promise<number>>().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("down"));
    expect(await ttlCache("k2", 10, load)).toBe(1);
    vi.advanceTimersByTime(20);
    expect(await ttlCache("k2", 10, load)).toBe(1);
    vi.useRealTimers();
  });
});
```

Run: `npm test -- src/lib/envio`
Expected: FAIL, modules missing.

- [ ] **Step 2: Write the modules**

`src/lib/envio/client.ts`:
```ts
export class EnvioUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvioUnavailableError";
  }
}

/** The only place the app talks to the indexer. Server-only: reads ENVIO_* env vars. */
export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const url = process.env.ENVIO_GRAPHQL_URL;
  if (!url) throw new EnvioUnavailableError("ENVIO_GRAPHQL_URL is not set");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.ENVIO_GRAPHQL_KEY) headers.Authorization = `Bearer ${process.env.ENVIO_GRAPHQL_KEY}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ query, variables }), cache: "no-store" });
  } catch (err) {
    throw new EnvioUnavailableError(`indexer unreachable: ${String(err)}`);
  }
  if (!res.ok) throw new EnvioUnavailableError(`indexer responded ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length || !body.data) {
    throw new EnvioUnavailableError(`indexer query failed: ${body.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
  }
  return body.data;
}
```

`src/lib/envio/cache.ts`:
```ts
type Entry<T> = { value?: T; expires: number; inflight?: Promise<T> };

const store = new Map<string, Entry<unknown>>();

/** Per-process memo with a TTL. A failed reload keeps serving the last good value. */
export async function ttlCache<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const entry = (store.get(key) as Entry<T> | undefined) ?? { expires: 0 };
  if (entry.value !== undefined && entry.expires > now) return entry.value;
  if (entry.inflight) return entry.inflight;
  entry.inflight = load()
    .then((value) => {
      entry.value = value;
      entry.expires = Date.now() + ttlMs;
      return value;
    })
    .catch((err) => {
      if (entry.value !== undefined) return entry.value;
      throw err;
    })
    .finally(() => {
      entry.inflight = undefined;
    });
  store.set(key, entry as Entry<unknown>);
  return entry.inflight;
}

export function clearTtlCache(): void {
  store.clear();
}
```

Append to `.env.example`:
```
# Server-only. The indexer's GraphQL endpoint and its API key from Envio Cloud (Security tab), not the HyperSync token.
ENVIO_GRAPHQL_URL=
ENVIO_GRAPHQL_KEY=
```

- [ ] **Step 3: Run the tests, commit**

Run: `npm test -- src/lib/envio`
Expected: PASS.

```bash
git add -A
git commit -m "Add Envio GraphQL client and TTL cache" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

### Task 3: Queries and shaping

**Files:**
- Create: `src/lib/envio/queries.ts`, `src/lib/envio/shape.ts`, `src/lib/envio/fixtures.ts`
- Test: `src/lib/envio/shape.test.ts`

**Interfaces:**
- Consumes: `TokenPair`, `QuoteAsset`, `Candle`, `Trade`, `Holder`, `Origin` (Task 1).
- Produces:
  - `queries.ts`: `PAIRS_QUERY`, `PAIRS_LAUNCHPAD_QUERY`, `windowQuery(poolIds, sinceSec)`, `QUOTES_QUERY`, `CANDLES_QUERY`, `TOKEN_QUERY`, `TRADES_QUERY`, `HOLDERS_QUERY`, `HEALTH_QUERY` and row types `QuotePriceRow`, `QuoteRow`, `PoolRow`, `TokenRow`, `WindowRow`, `CandleRow`, `SwapRow`, `BalanceRow`.
  - `shape.ts`: `STALE_AFTER_SEC`; `isStale(row, nowSec)`; `usdMap(prices, nowSec): Map<string, number | null>`; `WindowStats`; `windowStats(rows, nowSec): Map<string, WindowStats>`; `shapePairs(tokens, usd, windows): TokenPair[]`; `shapeQuotes(quotes, pairs, usd, prices, nowSec): QuoteAsset[]`; `shapeCandles(rows, usdAtTime): Candle[]`; `shapeTrades(rows, usd, ticker): Trade[]`; `shapeHolders(rows, decimals, totalSupply): Holder[]`; `hookLabel(origin)`; `feeTierLabel(fee)`.

- [ ] **Step 1: Write the queries**

`src/lib/envio/queries.ts`:
```ts
export type QuotePriceRow = { id: string; usdPrice: number; updatedAt: number; aggregator: string };
export type QuoteRow = { id: string; symbol: string; name: string; decimals: number; address: string };
export type PoolRow = {
  id: string; quote_id: string; tokenIsCurrency0: boolean; hooks: string; fee: number; tickSpacing: number;
  origin: string; createdAt: number; priceQuote: number; tvlToken: string | null; tvlQuote: string | null;
  swapCount: number; lastSwapAt: number | null; quote: { symbol: string; decimals: number };
};
export type TokenRow = {
  id: string; address: string; symbol: string; name: string; decimals: number; totalSupply: string;
  holdersCount: number; origin: string; createdAt: number; primaryPool: PoolRow | null;
};
export type WindowRow = { pool_id: string; t: number; open: number; close: number; volumeQuote: number };
export type CandleRow = { t: number; open: number; high: number; low: number; close: number; volumeQuote: number };
export type SwapRow = { timestamp: number; side: "buy" | "sell"; amountToken: number; priceQuote: number; wallet: string; txHash: string };
export type BalanceRow = { holder: string; balance: string };

const POOL_FIELDS = "id quote_id tokenIsCurrency0 hooks fee tickSpacing origin createdAt priceQuote tvlToken tvlQuote swapCount lastSwapAt quote { symbol decimals }";
const TOKEN_FIELDS = `id address symbol name decimals totalSupply holdersCount origin createdAt primaryPool { ${POOL_FIELDS} }`;

export const PAIRS_QUERY = `
query Pairs($limit: Int!) {
  Token(where: { primaryPool: { swapCount: { _gt: 0 } } }, order_by: { primaryPool: { lastSwapAt: desc_nulls_last } }, limit: $limit) { ${TOKEN_FIELDS} }
  QuotePrice { id usdPrice updatedAt aggregator }
}`;

export const PAIRS_LAUNCHPAD_QUERY = `
query PairsLaunchpad($limit: Int!) {
  Token(where: { origin: { _in: [LONG, Pons] }, primaryPool: { swapCount: { _gt: 0 } } }, order_by: { primaryPool: { lastSwapAt: desc_nulls_last } }, limit: $limit) { ${TOKEN_FIELDS} }
  QuotePrice { id usdPrice updatedAt aggregator }
}`;

const POOL_ID = /^0x[0-9a-f]{64}$/;

/**
 * One aliased selection per pool: its h1 candles since `sinceSec`, oldest first.
 * Never filters on `interval` (broken on the deployed schema); the id pattern does that job.
 * Pool ids are validated before interpolation, so nothing user-supplied reaches the document.
 */
export function windowQuery(poolIds: string[], sinceSec: number): string {
  const parts = poolIds.map((id, i) => {
    if (!POOL_ID.test(id)) throw new Error(`bad pool id ${id}`);
    return `w${i}: Candle(where: { pool_id: { _eq: "${id}" }, id: { _like: "${id}-h1-%" }, t: { _gte: ${Math.floor(sinceSec)} } }, order_by: { t: asc }) { pool_id t open close volumeQuote }`;
  });
  return `query Window { ${parts.join(" ")} }`;
}

export const QUOTES_QUERY = `
query Quotes { Quote { id symbol name decimals address } QuotePrice { id usdPrice updatedAt aggregator } }`;

export const CANDLES_QUERY = `
query Candles($pool: String!, $like: String!, $limit: Int!) {
  Candle(where: { pool_id: { _eq: $pool }, id: { _like: $like } }, order_by: { t: desc }, limit: $limit) { t open high low close volumeQuote }
}`;

export const TOKEN_QUERY = `
query Token($id: String!) {
  Token(where: { id: { _eq: $id } }, limit: 1) { ${TOKEN_FIELDS} }
  QuotePrice { id usdPrice updatedAt aggregator }
}`;

export const TRADES_QUERY = `
query Trades($pool: String!) {
  Swap(where: { pool_id: { _eq: $pool } }, order_by: { timestamp: desc }, limit: 50) { timestamp side amountToken priceQuote wallet txHash }
}`;

export const HOLDERS_QUERY = `
query Holders($token: String!) {
  TokenBalance(where: { token_id: { _eq: $token }, balance: { _gt: "0" } }, order_by: { balance: desc }, limit: 10) { holder balance }
}`;

export const HEALTH_QUERY = `
query Health { chain_metadata { chain_id latest_processed_block block_height } QuotePrice { id updatedAt aggregator } }`;
```
Do not reintroduce an `interval` filter or `Token_by_pk`: both fail on the deployed schema (see Global Constraints). `windowQuery` builds the document itself because Hasura has no variable type for a list of aliased selections; the regex check is what keeps that safe.

- [ ] **Step 2: Write the fixture and the failing shaping tests**

`src/lib/envio/fixtures.ts`:
```ts
import type { TokenRow, QuotePriceRow, WindowRow, CandleRow, SwapRow, BalanceRow, QuoteRow } from "./queries";

export const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
export const AI = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
export const POOL = "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27";
export const NOW = 1_757_700_000;

export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
export const prices: QuotePriceRow[] = [
  { id: NVDA, usdPrice: 224.4, updatedAt: NOW - 600, aggregator: "0xc9d16e4f2569b9e3ea0468fd85844953713dc2a2" },
  // USDG is pinned at 1 and its updatedAt never moves: 99 days old on the deployed indexer.
  { id: USDG, usdPrice: 1, updatedAt: NOW - 8_500_000, aggregator: "pinned" },
  { id: "0xstale", usdPrice: 50, updatedAt: NOW - 400_000, aggregator: "0xdeadfeed" },
];

export const aiToken: TokenRow = {
  id: AI, address: "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18", symbol: "AI", name: "Artificial Inu", decimals: 18,
  totalSupply: "1000000000000000000000000000", holdersCount: 18423, origin: "LONG", createdAt: NOW - 5_000_000,
  primaryPool: {
    id: POOL, quote_id: NVDA, tokenIsCurrency0: true, hooks: "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544", fee: 8388608, tickSpacing: 8,
    origin: "LONG", createdAt: NOW - 5_000_000, priceQuote: 0.000866, tvlToken: "1000000000000000000000000", tvlQuote: "10000000000000000000000",
    swapCount: 5000, lastSwapAt: NOW - 30, quote: { symbol: "NVDA", decimals: 18 },
  },
};

// h1 candles for POOL. NOW sits on an hour boundary, so the 1h bucket is NOW - 3600 and the 24h bucket is NOW - 86400.
export const windowRows: WindowRow[] = [
  { pool_id: POOL, t: NOW - 86400, open: 0.001, close: 0.00095, volumeQuote: 0 },
  { pool_id: POOL, t: NOW - 7200, open: 0.0009, close: 0.00089, volumeQuote: 8.6 },
  { pool_id: POOL, t: NOW - 3600, open: 0.00088, close: 0.00087, volumeQuote: 10 },
];
export const quotes: QuoteRow[] = [{ id: NVDA, symbol: "NVDA", name: "NVIDIA Robinhood Token", decimals: 18, address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" }];
export const candles: CandleRow[] = [
  { t: NOW - 900, open: 0.0009, high: 0.00092, low: 0.00088, close: 0.0009, volumeQuote: 3 },
  { t: NOW - 1800, open: 0.00095, high: 0.00096, low: 0.0009, close: 0.0009, volumeQuote: 4 },
];
export const swaps: SwapRow[] = [{ timestamp: NOW - 30, side: "buy", amountToken: 15749, priceQuote: 0.000865, wallet: "0xce73000000000000000000000000000000006329", txHash: "0x" + "ab".repeat(32) }];
export const balances: BalanceRow[] = [
  { holder: "0x8366a39cc670b4001a1121b8f6a443a643e40951", balance: "84684155000000000000000000" },
  { holder: "0xb12e000000000000000000000000000000005020", balance: "84242846000000000000000000" },
];
```

`src/lib/envio/shape.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { usdMap, windowStats, shapePairs, shapeQuotes, shapeCandles, shapeTrades, shapeHolders, hookLabel, feeTierLabel } from "./shape";
import { AI, NVDA, USDG, POOL, NOW, aiToken, prices, windowRows, quotes, candles, swaps, balances } from "./fixtures";

describe("usdMap", () => {
  it("nulls stale quotes", () => {
    const m = usdMap(prices, NOW);
    expect(m.get(NVDA)).toBe(224.4);
    expect(m.get("0xstale")).toBeNull();
  });
  it("keeps a pinned quote whatever its age", () => {
    // USDG quotes 44% of the listed tokens; treating its frozen updatedAt as stale wipes their USD prices.
    expect(usdMap(prices, NOW).get(USDG)).toBe(1);
  });
});

describe("windowStats", () => {
  it("takes the open of the hour bucket an hour and a day ago and sums 24h volume", () => {
    const w = windowStats(windowRows, NOW).get(POOL)!;
    expect(w.ref1h).toBe(0.00088);
    expect(w.ref24h).toBe(0.001);
    expect(w.vol24h).toBeCloseTo(18.6, 9);
  });
  it("falls back to the last close before a missing bucket", () => {
    const rows = windowRows.filter((r) => r.t !== NOW - 3600);
    const w = windowStats(rows, NOW).get(POOL)!;
    expect(w.ref1h).toBe(0.00089); // close of the NOW - 7200 candle
    expect(w.ref24h).toBe(0.001);
  });
  it("has no entry for a pool without candles", () => {
    expect(windowStats([], NOW).has(POOL)).toBe(false);
  });
});

describe("shapePairs", () => {
  const [pair] = shapePairs([aiToken], usdMap(prices, NOW), windowStats(windowRows, NOW));
  it("keys by address and carries origin", () => {
    expect(pair!.id).toBe(AI);
    expect(pair!.origin).toBe("LONG");
    expect(pair!.poolId).toBe(POOL);
    expect(pair!.tradeable).toBe(true);
  });
  it("converts to USD", () => {
    expect(pair!.priceUsd).toBeCloseTo(0.000866 * 224.4, 9);
    expect(pair!.fdv).toBeCloseTo(0.000866 * 224.4 * 1e9, 3);
    expect(pair!.mcap).toBe(pair!.fdv);
    expect(pair!.vol24h).toBeCloseTo(18.6 * 224.4, 6);
    // liquidity = (10000 NVDA + 1,000,000 AI * 0.000866) * 224.4
    expect(pair!.liquidity).toBeCloseTo((10_000 + 1_000_000 * 0.000866) * 224.4, 3);
  });
  it("computes changes against the hour buckets an hour and a day ago", () => {
    expect(pair!.change1h).toBeCloseTo((0.000866 / 0.00088 - 1) * 100, 9);
    expect(pair!.change24h).toBeCloseTo((0.000866 / 0.001 - 1) * 100, 9);
  });
  it("marks a pool with no reference candle as new", () => {
    const [p] = shapePairs([aiToken], usdMap(prices, NOW), new Map());
    expect(p!.change1h).toBeNull();
    expect(p!.change24h).toBeNull();
    expect(p!.vol24h).toBe(0);
  });
  it("drops tokens without a primary pool and zeroes USD on a stale quote", () => {
    const stale = { ...aiToken, primaryPool: { ...aiToken.primaryPool!, quote_id: "0xstale" } };
    expect(shapePairs([{ ...aiToken, primaryPool: null }, stale], usdMap(prices, NOW), new Map())).toHaveLength(1);
    const [p] = shapePairs([stale], usdMap(prices, NOW), new Map());
    expect(p!.priceUsd).toBe(0);
    expect(p!.liquidity).toBeNull();
  });
  it("labels hooks and fee tiers", () => {
    expect(hookLabel("LONG")).toBe("Doppler shared v4 hook");
    expect(hookLabel("Pons")).toBe("Pons MemeHook · afterSwap");
    expect(feeTierLabel(8388608)).toBe("Dynamic");
    expect(feeTierLabel(3000)).toBe("0.30%");
    expect(pair!.hook).toBe("Doppler shared v4 hook");
    expect(pair!.feeTier).toBe("Dynamic");
  });
});

describe("shapeQuotes", () => {
  it("counts pairs and sums 24h USD volume per quote", () => {
    const pairs = shapePairs([aiToken], usdMap(prices, NOW), windowStats(windowRows, NOW));
    const [q] = shapeQuotes(quotes, pairs, usdMap(prices, NOW), prices, NOW);
    expect(q!.symbol).toBe("NVDA");
    expect(q!.pairs).toBe(1);
    expect(q!.usdPrice).toBe(224.4);
    expect(q!.stale).toBe(false);
    expect(q!.vol24h).toBeCloseTo(18.6 * 224.4, 6);
  });
});

describe("shapeCandles / shapeTrades / shapeHolders", () => {
  it("returns candles oldest first in USD with ms timestamps", () => {
    const out = shapeCandles(candles, () => 224.4);
    expect(out.map((c) => c.t)).toEqual([(NOW - 1800) * 1000, (NOW - 900) * 1000]);
    expect(out[1]!.c).toBeCloseTo(0.0009 * 224.4, 9);
    expect(out[1]!.v).toBeCloseTo(3 * 224.4, 9);
  });
  it("shapes trades with USD price and tx", () => {
    const [t] = shapeTrades(swaps, 224.4, "AI");
    expect(t!.priceUsd).toBeCloseTo(0.000865 * 224.4, 9);
    expect(t!.t).toBe((NOW - 30) * 1000);
    expect(t!.tx.length).toBe(66);
  });
  it("tags the PoolManager as Pool and computes shares", () => {
    const out = shapeHolders(balances, 18, 1_000_000_000n * 10n ** 18n);
    expect(out[0]!.tag).toBe("Pool");
    expect(out[0]!.share).toBeCloseTo(8.4684155, 6);
    expect(out[1]!.tag).toBeUndefined();
    expect(out[0]!.balance).toBeCloseTo(84_684_155, 3);
  });
});
```

Run: `npm test -- src/lib/envio/shape`
Expected: FAIL, module missing.

- [ ] **Step 3: Write shape.ts**

`src/lib/envio/shape.ts`:
```ts
import type { Candle, Holder, Origin, QuoteAsset, TokenPair, Trade } from "@/lib/types";
import type { BalanceRow, CandleRow, QuotePriceRow, QuoteRow, SwapRow, TokenRow, WindowRow } from "./queries";

export const STALE_AFTER_SEC = 259_200; // 3 days: distinguishes a dead aggregator from an off-hours hold
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const DYNAMIC_FEE_FLAG = 8388608;
const ORIGINS = new Set<Origin>(["LONG", "Pons", "Uniswap", "Other", "SUIT", "SV"]);

function toOrigin(s: string): Origin {
  return ORIGINS.has(s as Origin) ? (s as Origin) : "Other";
}

function units(raw: string | null, decimals: number): number | null {
  if (raw === null) return null;
  return Number(BigInt(raw)) / 10 ** decimals;
}

export function hookLabel(origin: Origin): string {
  switch (origin) {
    case "LONG":
      return "Doppler shared v4 hook";
    case "Pons":
      return "Pons MemeHook · afterSwap";
    case "Other":
      return "Unknown hook";
    default:
      return "None";
  }
}

export function feeTierLabel(fee: number): string {
  return fee === DYNAMIC_FEE_FLAG ? "Dynamic" : `${(fee / 10_000).toFixed(2)}%`;
}

/** A pinned row (USDG) has a frozen updatedAt and is never stale; a real feed goes stale after 3 days. */
export function isStale(p: { updatedAt: number; aggregator: string }, nowSec: number): boolean {
  return p.aggregator !== "pinned" && nowSec - p.updatedAt > STALE_AFTER_SEC;
}

/** quote id → USD price, null when the feed is stale. */
export function usdMap(prices: QuotePriceRow[], nowSec: number): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const p of prices) m.set(p.id, isStale(p, nowSec) ? null : p.usdPrice);
  return m;
}

export type WindowStats = { ref1h: number | null; ref24h: number | null; vol24h: number };

const HOUR = 3600;
const DAY = 86400;

/** Price at time t from h1 candles: the open of t's hour bucket, else the last close before that bucket, else null. */
function refAt(rows: WindowRow[], t: number): number | null {
  const bucket = Math.floor(t / HOUR) * HOUR;
  const exact = rows.find((r) => r.t === bucket);
  if (exact) return exact.open;
  let last: WindowRow | undefined;
  for (const r of rows) if (r.t < bucket && (!last || r.t > last.t)) last = r;
  return last ? last.close : null;
}

/** Per-pool 1h and 24h reference prices and 24h quote volume from that pool's h1 candles, in any order. */
export function windowStats(rows: WindowRow[], nowSec: number): Map<string, WindowStats> {
  const byPool = new Map<string, WindowRow[]>();
  for (const r of rows) {
    const list = byPool.get(r.pool_id) ?? [];
    list.push(r);
    byPool.set(r.pool_id, list);
  }
  const out = new Map<string, WindowStats>();
  for (const [poolId, list] of byPool) {
    let vol24h = 0;
    for (const r of list) if (r.t >= nowSec - DAY) vol24h += r.volumeQuote;
    out.set(poolId, { ref1h: refAt(list, nowSec - HOUR), ref24h: refAt(list, nowSec - DAY), vol24h });
  }
  return out;
}

export function shapePairs(
  tokens: TokenRow[],
  usd: Map<string, number | null>,
  windows: Map<string, WindowStats>,
): TokenPair[] {
  const out: TokenPair[] = [];
  for (const t of tokens) {
    const p = t.primaryPool;
    if (!p) continue;
    const q = usd.get(p.quote_id) ?? null;
    const usdPrice = q ?? 0; // stale or unknown quote: USD figures read 0, liquidity null
    const priceUsd = p.priceQuote * usdPrice;
    const supply = Number(BigInt(t.totalSupply)) / 10 ** t.decimals;
    const tvlQuote = units(p.tvlQuote, p.quote.decimals);
    const tvlToken = units(p.tvlToken, t.decimals);
    const liquidity = q === null || tvlQuote === null || tvlToken === null ? null : (tvlQuote + tvlToken * p.priceQuote) * q;
    const w = windows.get(p.id);
    const ref1 = w?.ref1h ?? undefined;
    const ref24 = w?.ref24h ?? undefined;
    const origin = toOrigin(p.origin);
    out.push({
      id: t.id,
      ticker: t.symbol,
      name: t.name,
      address: t.address as `0x${string}`,
      quote: p.quote.symbol,
      origin,
      tradeable: true, // Quoter simulation lands in M2
      priceUsd,
      priceQuote: p.priceQuote,
      change1h: ref1 !== undefined && ref1 > 0 ? (p.priceQuote / ref1 - 1) * 100 : null,
      change24h: ref24 !== undefined && ref24 > 0 ? (p.priceQuote / ref24 - 1) * 100 : null,
      vol24h: (w?.vol24h ?? 0) * usdPrice,
      mcap: priceUsd * supply,
      fdv: priceUsd * supply,
      liquidity,
      holders: t.holdersCount,
      createdAt: p.createdAt * 1000,
      bull: 0,
      bear: 0,
      poolId: p.id as `0x${string}`,
      hook: hookLabel(origin),
      feeTier: feeTierLabel(p.fee),
    });
  }
  return out;
}

export function shapeQuotes(
  quotes: QuoteRow[],
  pairs: TokenPair[],
  usd: Map<string, number | null>,
  prices: QuotePriceRow[],
  nowSec: number,
): QuoteAsset[] {
  const bySymbol = new Map<string, { pairs: number; vol: number }>();
  for (const p of pairs) {
    const cur = bySymbol.get(p.quote) ?? { pairs: 0, vol: 0 };
    bySymbol.set(p.quote, { pairs: cur.pairs + 1, vol: cur.vol + p.vol24h });
  }
  const byId = new Map(prices.map((p) => [p.id, p]));
  return quotes.map((q) => ({
    symbol: q.symbol,
    name: q.name,
    address: q.address as `0x${string}`,
    decimals: q.decimals,
    usdPrice: usd.get(q.id) ?? 0,
    stale: (() => { const p = byId.get(q.id); return p ? isStale(p, nowSec) : true; })(),
    pairs: bySymbol.get(q.symbol)?.pairs ?? 0,
    vol24h: bySymbol.get(q.symbol)?.vol ?? 0,
  }));
}

/** Candles come newest-first from the query; the chart wants oldest-first, USD, ms. */
export function shapeCandles(rows: CandleRow[], usdAtTime: (t: number) => number | null): Candle[] {
  return [...rows]
    .sort((a, b) => a.t - b.t)
    .map((c) => {
      const u = usdAtTime(c.t) ?? 0;
      return { t: c.t * 1000, o: c.open * u, h: c.high * u, l: c.low * u, c: c.close * u, v: c.volumeQuote * u };
    });
}

export function shapeTrades(rows: SwapRow[], usd: number | null, _ticker: string): Trade[] {
  const u = usd ?? 0;
  return rows.map((s) => ({
    t: s.timestamp * 1000,
    side: s.side,
    amount: s.amountToken,
    priceUsd: s.priceQuote * u,
    wallet: s.wallet as `0x${string}`,
    tx: s.txHash as `0x${string}`,
  }));
}

export function shapeHolders(rows: BalanceRow[], decimals: number, totalSupply: bigint): Holder[] {
  return rows.map((b) => {
    const bal = BigInt(b.balance);
    const share = totalSupply > 0n ? Number((bal * 1_000_000n) / totalSupply) / 10_000 : 0;
    return {
      wallet: b.holder as `0x${string}`,
      balance: Number(bal) / 10 ** decimals,
      share,
      tag: b.holder.toLowerCase() === POOL_MANAGER ? "Pool" : undefined,
    };
  });
}
```

- [ ] **Step 4: Run the tests, commit**

Run: `npm test -- src/lib/envio && npx tsc --noEmit`
Expected: PASS, clean.

```bash
git add -A
git commit -m "Add Envio queries and shaping into the market models" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

### Task 4: Route handlers

**Files:**
- Create: `src/app/api/_lib/respond.ts`, `src/app/api/pairs/route.ts`, `src/app/api/quotes/route.ts`, `src/app/api/tokens/[address]/candles/route.ts`, `src/app/api/tokens/[address]/trades/route.ts`, `src/app/api/tokens/[address]/holders/route.ts`, `src/app/api/health/route.ts`

**Interfaces:**
- Consumes: `gql`, `ttlCache` (Task 2); queries and shaping (Task 3).
- Produces: JSON routes returning `TokenPair[]`, `QuoteAsset[]`, `Candle[]`, `Trade[]`, `{ holders: Holder[]; count: number }`, and `{ ok, lag, quotes }`; `loadPairs()` exported for the quotes route.

- [ ] **Step 1: Write the shared responder**

`src/app/api/_lib/respond.ts`:
```ts
import { NextResponse } from "next/server";
import { EnvioUnavailableError } from "@/lib/envio/client";

export function cached<T>(data: T, ttlSec: number): NextResponse {
  return NextResponse.json(data, {
    headers: { "Cache-Control": `public, s-maxage=${ttlSec}, stale-while-revalidate=60` },
  });
}

export function failure(err: unknown): NextResponse {
  if (err instanceof EnvioUnavailableError) {
    return NextResponse.json({ error: "indexer unavailable" }, { status: 503, headers: { "Retry-After": "15" } });
  }
  console.error(err);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}

export const nowSec = () => Math.floor(Date.now() / 1000);
```

- [ ] **Step 2: Write the pairs and quotes routes**

`src/app/api/pairs/route.ts`:
```ts
import { gql } from "@/lib/envio/client";
import { ttlCache } from "@/lib/envio/cache";
import { PAIRS_QUERY, PAIRS_LAUNCHPAD_QUERY, windowQuery, type QuotePriceRow, type TokenRow, type WindowRow } from "@/lib/envio/queries";
import { shapePairs, usdMap, windowStats } from "@/lib/envio/shape";
import { cached, failure, nowSec } from "../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 30;
const LIMIT = 500;
const WINDOW_BATCH = 50; // pools per aliased window request; 0.4 s measured
const WINDOW_CONCURRENCY = 3;

export type PairsScope = "all" | "launchpad";

/** h1 candles for every pool, from a day before the 24h bucket so the day-ago reference has a fallback. */
async function loadWindowRows(poolIds: string[], now: number): Promise<WindowRow[]> {
  const since = Math.floor((now - 86400) / 3600) * 3600 - 86400;
  const batches: string[][] = [];
  for (let i = 0; i < poolIds.length; i += WINDOW_BATCH) batches.push(poolIds.slice(i, i + WINDOW_BATCH));
  const rows: WindowRow[] = [];
  for (let i = 0; i < batches.length; i += WINDOW_CONCURRENCY) {
    const results = await Promise.all(batches.slice(i, i + WINDOW_CONCURRENCY).map((b) => gql<Record<string, WindowRow[]>>(windowQuery(b, since))));
    for (const r of results) for (const list of Object.values(r)) rows.push(...list);
  }
  return rows;
}

export async function loadPairs(scope: PairsScope = "all") {
  return ttlCache(`pairs:${scope}`, TTL * 1000, async () => {
    const now = nowSec();
    const tokens = await gql<{ Token: TokenRow[]; QuotePrice: QuotePriceRow[] }>(scope === "launchpad" ? PAIRS_LAUNCHPAD_QUERY : PAIRS_QUERY, { limit: LIMIT });
    const poolIds = tokens.Token.flatMap((t) => (t.primaryPool ? [t.primaryPool.id] : []));
    const rows = await loadWindowRows(poolIds, now);
    return shapePairs(tokens.Token, usdMap(tokens.QuotePrice, now), windowStats(rows, now));
  });
}

export async function GET(req: Request) {
  const scope: PairsScope = new URL(req.url).searchParams.get("scope") === "launchpad" ? "launchpad" : "all";
  try {
    return cached(await loadPairs(scope), TTL);
  } catch (err) {
    return failure(err);
  }
}
```

`src/app/api/quotes/route.ts`:
```ts
import { gql } from "@/lib/envio/client";
import { ttlCache } from "@/lib/envio/cache";
import { QUOTES_QUERY, type QuotePriceRow, type QuoteRow } from "@/lib/envio/queries";
import { shapeQuotes, usdMap } from "@/lib/envio/shape";
import { loadPairs } from "../pairs/route";
import { cached, failure, nowSec } from "../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 30;

export async function GET() {
  try {
    const data = await ttlCache("quotes", TTL * 1000, async () => {
      const now = nowSec();
      const [q, pairs] = await Promise.all([gql<{ Quote: QuoteRow[]; QuotePrice: QuotePriceRow[] }>(QUOTES_QUERY), loadPairs()]);
      return shapeQuotes(q.Quote, pairs, usdMap(q.QuotePrice, now), q.QuotePrice, now);
    });
    return cached(data, TTL);
  } catch (err) {
    return failure(err);
  }
}
```

- [ ] **Step 3: Write the token routes and health**

`src/app/api/tokens/[address]/candles/route.ts`:
```ts
import { NextResponse } from "next/server";
import { gql } from "@/lib/envio/client";
import { ttlCache } from "@/lib/envio/cache";
import { CANDLES_QUERY, TOKEN_QUERY, type CandleRow, type QuotePriceRow, type TokenRow } from "@/lib/envio/queries";
import { shapeCandles, usdMap } from "@/lib/envio/shape";
import { cached, failure, nowSec } from "../../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 10;
const INTERVALS: Record<string, string> = { "1m": "m1", "5m": "m5", "15m": "m15", "1h": "h1", "1d": "d1" };

export async function GET(req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  const interval = INTERVALS[new URL(req.url).searchParams.get("interval") ?? "15m"];
  if (!interval) return NextResponse.json({ error: "bad interval" }, { status: 400 });
  try {
    const data = await ttlCache(`candles:${id}:${interval}`, TTL * 1000, async () => {
      const now = nowSec();
      const t = await gql<{ Token: TokenRow[]; QuotePrice: QuotePriceRow[] }>(TOKEN_QUERY, { id });
      const pool = t.Token[0]?.primaryPool;
      if (!pool) return [];
      const rows = await gql<{ Candle: CandleRow[] }>(CANDLES_QUERY, { pool: pool.id, like: `${pool.id}-${interval}-%`, limit: 300 });
      // One current USD price per quote in M1; per-candle history is an M6 refinement.
      const usd = usdMap(t.QuotePrice, now).get(pool.quote_id) ?? null;
      return shapeCandles(rows.Candle, () => usd);
    });
    return cached(data, TTL);
  } catch (err) {
    return failure(err);
  }
}
```

`src/app/api/tokens/[address]/trades/route.ts`:
```ts
import { gql } from "@/lib/envio/client";
import { ttlCache } from "@/lib/envio/cache";
import { TRADES_QUERY, TOKEN_QUERY, type QuotePriceRow, type SwapRow, type TokenRow } from "@/lib/envio/queries";
import { shapeTrades, usdMap } from "@/lib/envio/shape";
import { cached, failure, nowSec } from "../../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 10;

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  try {
    const data = await ttlCache(`trades:${id}`, TTL * 1000, async () => {
      const t = await gql<{ Token: TokenRow[]; QuotePrice: QuotePriceRow[] }>(TOKEN_QUERY, { id });
      const token = t.Token[0];
      if (!token?.primaryPool) return [];
      const rows = await gql<{ Swap: SwapRow[] }>(TRADES_QUERY, { pool: token.primaryPool.id });
      return shapeTrades(rows.Swap, usdMap(t.QuotePrice, nowSec()).get(token.primaryPool.quote_id) ?? null, token.symbol);
    });
    return cached(data, TTL);
  } catch (err) {
    return failure(err);
  }
}
```

`src/app/api/tokens/[address]/holders/route.ts`:
```ts
import { gql } from "@/lib/envio/client";
import { ttlCache } from "@/lib/envio/cache";
import { HOLDERS_QUERY, TOKEN_QUERY, type BalanceRow, type QuotePriceRow, type TokenRow } from "@/lib/envio/queries";
import { shapeHolders } from "@/lib/envio/shape";
import { cached, failure } from "../../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 60;

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  try {
    const data = await ttlCache(`holders:${id}`, TTL * 1000, async () => {
      const t = await gql<{ Token: TokenRow[]; QuotePrice: QuotePriceRow[] }>(TOKEN_QUERY, { id });
      const token = t.Token[0];
      if (!token) return { holders: [], count: 0 };
      const rows = await gql<{ TokenBalance: BalanceRow[] }>(HOLDERS_QUERY, { token: id });
      return { holders: shapeHolders(rows.TokenBalance, token.decimals, BigInt(token.totalSupply)), count: token.holdersCount };
    });
    return cached(data, TTL);
  } catch (err) {
    return failure(err);
  }
}
```

`src/app/api/health/route.ts`:
```ts
import { NextResponse } from "next/server";
import { gql } from "@/lib/envio/client";
import { HEALTH_QUERY } from "@/lib/envio/queries";
import { isStale } from "@/lib/envio/shape";
import { nowSec } from "../_lib/respond";

export const dynamic = "force-dynamic";

type HealthRows = {
  chain_metadata: { chain_id: number; latest_processed_block: number; block_height: number }[];
  QuotePrice: { id: string; updatedAt: number; aggregator: string }[];
};

export async function GET() {
  try {
    const h = await gql<HealthRows>(HEALTH_QUERY);
    const chain = h.chain_metadata.find((c) => c.chain_id === 4663);
    const now = nowSec();
    const quotes = h.QuotePrice.map((q) => ({ id: q.id, ageSec: now - q.updatedAt, stale: isStale(q, now) }));
    const lag = chain ? chain.block_height - chain.latest_processed_block : null;
    const ok = lag !== null && lag < 500 && quotes.every((q) => !q.stale);
    return NextResponse.json({ ok, lag, quotes }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
```

- [ ] **Step 4: Verify against the running indexer**

With `ENVIO_GRAPHQL_URL` and `ENVIO_GRAPHQL_KEY` in `.env.local` pointing at the cloud deployment (`https://indexer.hyperindex.xyz/37bf377/v1/graphql`; the key comes from `envio-cloud indexer security api-key list suitventures-indexer kobesergio --show-tokens`, a local `http://localhost:8080/v1/graphql` needs none), run `npm run dev` and:
```bash
curl -s localhost:3000/api/health
curl -s localhost:3000/api/pairs | head -c 600
curl -s 'localhost:3000/api/pairs?scope=launchpad' | head -c 600
curl -s localhost:3000/api/quotes | head -c 400
curl -s "localhost:3000/api/tokens/0x2e8c31162b855a2ffa90f6f8634643ad6f111e18/candles?interval=1h" | head -c 400
curl -s localhost:3000/api/tokens/0x2e8c31162b855a2ffa90f6f8634643ad6f111e18/trades | head -c 400
curl -s localhost:3000/api/tokens/0x2e8c31162b855a2ffa90f6f8634643ad6f111e18/holders | head -c 400
```
Expected: health `ok: true` with a small lag; pairs includes AI with `origin: "LONG"`, a USD price near DexScreener's, and non-null changes; candles oldest-first; trades and holders non-empty. The pairs route takes about 5 s cold for all origins and under 2 s for `scope=launchpad`; a `database query error` from Envio means a query filtered on `interval` or used `Token_by_pk`, which the Global Constraints forbid. Then confirm `npx tsc --noEmit && npx eslint . && npm run build` pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add route handlers over the Envio indexer with caching and health" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

### Task 5: EnvioDataSource, local watch store, env switch, smoke

**Files:**
- Create: `src/lib/quote.ts`, `src/lib/data/localStore.ts`
- Modify: `src/lib/data/envio.ts` (full implementation), `src/lib/data/mock.ts` (use `localQuote`), `README.md`
- Test: `src/lib/quote.test.ts`

**Interfaces:**
- Produces: `poolFeePctFor(pair): number`; `localQuote(pair: TokenPair, side, amount, denom, isSuitHolder, slippagePct): Quote`; `LocalWatchStore` with `watchlist(address)`, `setWatch(address, id, on)`, `votes(address)`, `vote(address, id, dir)`; `EnvioDataSource implements MarketsDataSource` with `kind = "envio"`.

- [ ] **Step 1: Extract the quote math and write its test**

`src/lib/quote.ts` (the mock's math, taking the pair instead of a ticker):
```ts
import type { Denom, Quote, Side, TokenPair } from "./types";

export function poolFeePctFor(pair: TokenPair): number {
  return pair.origin === "Pons" ? 1.0 : 0.3;
}

/** Local approximation until the V4 Quoter lands in M2: constant-product impact against half the pool. */
export function localQuote(pair: TokenPair, side: Side, amount: number, denom: Denom, isSuitHolder: boolean, slippagePct: number): Quote {
  const pn = pair.priceQuote;
  const quoteUsd = pair.priceQuote > 0 ? pair.priceUsd / pair.priceQuote : 0;
  const buy = side === "buy";
  let pay: number;
  let receive: number;
  if (buy) {
    if (denom === "quote") { pay = amount; receive = pn > 0 ? amount / pn : 0; } else { receive = amount; pay = amount * pn; }
  } else if (denom === "token") { pay = amount; receive = amount * pn; } else { receive = amount; pay = pn > 0 ? amount / pn : 0; }
  const payUsd = pay * (buy ? quoteUsd : pair.priceUsd);
  const liquidity = pair.liquidity ?? 0;
  const impact = liquidity > 0 ? (payUsd / (liquidity / 2)) * 100 : 0;
  const poolFee = poolFeePctFor(pair);
  return {
    payAmount: pay, receiveAmount: receive, priceImpactPct: impact,
    routerFeePct: isSuitHolder ? 0 : 0.5, poolFeePct: poolFee,
    minReceived: receive * (1 - slippagePct / 100 - poolFee / 100),
  };
}
```

`src/lib/quote.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { localQuote } from "./quote";
import type { TokenPair } from "./types";

const pair = {
  id: "0xa", ticker: "AI", name: "AI", address: "0xa", quote: "NVDA", origin: "LONG", tradeable: true,
  priceUsd: 0.1943, priceQuote: 0.000866, change1h: 0, change24h: 0, vol24h: 0, mcap: 0, fdv: 0, liquidity: 5_141_337,
  holders: 0, createdAt: 0, bull: 0, bear: 0, poolId: "0x1", hook: "", feeTier: "",
} as TokenPair;

describe("localQuote", () => {
  it("buys tokens with quote and applies fees", () => {
    const q = localQuote(pair, "buy", 100, "quote", true, 0.5);
    expect(q.receiveAmount).toBeCloseTo(100 / 0.000866, 3);
    expect(q.routerFeePct).toBe(0);
    expect(q.poolFeePct).toBe(0.3);
    expect(q.minReceived).toBeCloseTo(q.receiveAmount * (1 - 0.005 - 0.003), 6);
    const quoteUsd = 0.1943 / 0.000866;
    expect(q.priceImpactPct).toBeCloseTo(((100 * quoteUsd) / (5_141_337 / 2)) * 100, 6);
  });
  it("treats null liquidity as zero impact", () => {
    expect(localQuote({ ...pair, liquidity: null }, "buy", 100, "quote", false, 0.5).priceImpactPct).toBe(0);
  });
});
```

Make `MockDataSource.quoteSwap` return `localQuote(this.pair(id), side, amount, denom, isSuitHolder, slippagePct)` and delete its inline math and the `poolFeePct`/`quoteUsd` imports it no longer needs.

- [ ] **Step 2: Write the local store and EnvioDataSource**

`src/lib/data/localStore.ts`:
```ts
import type { Address, VoteDir } from "@/lib/types";

function key(kind: "watch" | "votes", address: Address): string {
  return `svm:${kind}:${address.toLowerCase()}`;
}
function read<T>(k: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(k: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(k, JSON.stringify(value));
  } catch {
    // private mode or quota: the session keeps working without persistence
  }
}

/** Browser-local watchlist and votes until the signed API exists (M2). */
export class LocalWatchStore {
  watchlist(address: Address): string[] {
    return read<string[]>(key("watch", address), []);
  }
  setWatch(address: Address, id: string, on: boolean): void {
    const list = this.watchlist(address).filter((x) => x !== id);
    write(key("watch", address), on ? [...list, id] : list);
  }
  votes(address: Address): Record<string, VoteDir> {
    return read<Record<string, VoteDir>>(key("votes", address), {});
  }
  vote(address: Address, id: string, dir: VoteDir): void {
    const book = this.votes(address);
    if (book[id] === dir) delete book[id];
    else book[id] = dir;
    write(key("votes", address), book);
  }
}
```

`src/lib/data/envio.ts`:
```ts
import type { Address, Candle, Denom, Holder, Interval, MarketsDataSource, Quote, QuoteAsset, Side, TokenPair, Trade, VoteDir } from "@/lib/types";
import { localQuote } from "@/lib/quote";
import { LocalWatchStore } from "./localStore";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** Live data through the app's own route handlers (the only Envio clients). */
export class EnvioDataSource implements MarketsDataSource {
  readonly kind = "envio" as const;
  private readonly store = new LocalWatchStore();
  private pairsCache: { at: number; list: TokenPair[] } | null = null;

  async pairs(): Promise<TokenPair[]> {
    const list = await getJson<TokenPair[]>("/api/pairs");
    this.pairsCache = { at: Date.now(), list };
    return list;
  }
  quotes(): Promise<QuoteAsset[]> {
    return getJson("/api/quotes");
  }
  candles(id: string, interval: Interval): Promise<Candle[]> {
    return getJson(`/api/tokens/${id}/candles?interval=${interval}`);
  }
  trades(id: string): Promise<Trade[]> {
    return getJson(`/api/tokens/${id}/trades`);
  }
  async holders(id: string): Promise<Holder[]> {
    return (await getJson<{ holders: Holder[] }>(`/api/tokens/${id}/holders`)).holders;
  }

  async quoteSwap(id: string, side: Side, amount: number, denom: Denom, isSuitHolder: boolean, slippagePct: number): Promise<Quote> {
    const fresh = this.pairsCache && Date.now() - this.pairsCache.at < 30_000 ? this.pairsCache.list : await this.pairs();
    const pair = fresh.find((p) => p.id === id.toLowerCase());
    if (!pair) throw new Error(`Unknown token ${id}`);
    return localQuote(pair, side, amount, denom, isSuitHolder, slippagePct);
  }

  async watchlist(address: Address): Promise<string[]> {
    return this.store.watchlist(address);
  }
  async setWatch(address: Address, id: string, on: boolean, signature: string): Promise<void> {
    if (!signature) throw new Error("A session signature is required.");
    this.store.setWatch(address, id, on);
  }
  async votes(address: Address): Promise<Record<string, VoteDir>> {
    return this.store.votes(address);
  }
  async vote(address: Address, id: string, dir: VoteDir, signature: string): Promise<void> {
    if (!signature) throw new Error("A session signature is required.");
    this.store.vote(address, id, dir);
  }
}
```

`src/lib/data/index.ts` is unchanged: `NEXT_PUBLIC_DATA_SOURCE=envio` selects the class.

- [ ] **Step 3: Run tests, typecheck, lint, build**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green.

- [ ] **Step 4: Browser smoke on live data**

With `NEXT_PUBLIC_DATA_SOURCE=envio` and the indexer env in `.env.local`, `npm run dev`, then at 390px and 1440px: `/` lists live pairs with LONG and PONS badges and non-zero volumes; a row opens `/t/<address>` with the chart drawing 1h and 1d candles, the trades tab listing real wallets, the holders tab showing the PoolManager tagged `Pool`; `/watchlist` still locks without a wallet. Save `.shots/live-markets-390.png` and `.shots/live-token-1440.png`. Vote counts show 0 and stars/votes persist only in the browser: expected in M1.

- [ ] **Step 5: Document and commit**

Add to the frontend `README.md` under Data layer: `NEXT_PUBLIC_DATA_SOURCE=envio` with `ENVIO_GRAPHQL_URL`/`ENVIO_GRAPHQL_KEY` runs the live routes; `/api/health` reports indexer lag and stale quotes; watchlist and votes are browser-local until M2.

```bash
git add -A
git commit -m "Add EnvioDataSource over the route handlers with local watchlist and votes" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

Then set `NEXT_PUBLIC_DATA_SOURCE=envio`, `ENVIO_GRAPHQL_URL` and `ENVIO_GRAPHQL_KEY` on Vercel and redeploy: that is the M1 flip.
