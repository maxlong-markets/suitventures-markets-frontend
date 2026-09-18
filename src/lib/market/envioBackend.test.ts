import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTtlCache } from "@/lib/envio/cache";
import { gql } from "@/lib/envio/client";
import { AI, NOW, NVDA, POOL, aiPoolKey, aiTokenBroken, prices, windowRows } from "@/lib/envio/fixtures";
import { POOL_KEY_QUERY, TOKEN_QUERY } from "@/lib/envio/queries";
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

  it("pins POOL_KEY_QUERY's fallback clause text — no swap-count floor, ordered by swap count then recency then id — but does not prove the indexer applies that order: Hasura decides that server-side, not this mock", () => {
    // TOKEN_QUERY's fallbackPool (what pairs/candles/trades list) filters on swapCount > 0 — the
    // store's listed_pool_id has the same rule (LISTED_POOL, spec section 6). Trading is a looser
    // bar: a fresh launch with liquidity and zero trades is still perfectly routable, so
    // POOL_KEY_QUERY's own fallback must never filter on swaps (Fix D; MarketBackend.poolKey).
    // The where/order_by/limit clause is asserted whole, not as two fragments: a mocked gql()
    // returns whatever a test hands it, so this can only pin the query text sent to the indexer —
    // it cannot exercise Hasura's own ordering (see the parity test in poolKey.test.ts for the part
    // of the rule this file *can* pin: the client-side choice between primary and fallback).
    const fallback = POOL_KEY_QUERY.slice(POOL_KEY_QUERY.indexOf("fallbackPool"));
    expect(fallback).toContain(
      'pools(where: { priceQuote: { _gt: "1e-24", _lt: "1e18" } }, order_by: [{ swapCount: desc }, { id: asc }], limit: 1)',
    );
  });

  it("poolKey() prefers a sane primary over the fallback slot even when the fallback is also sane: rule 1 beats rule 2", async () => {
    // POOL_KEY_FIELDS carries no swap count at all — the primary/fallback choice can never be
    // swayed by how well the fallback pool trades, only by whether the primary itself prices
    // sanely. A fallback stocked with a second, independently sane pool proves resolvePool never
    // even reaches it once the primary passes.
    const primary = aiPoolKey.fallbackPool![0]!; // the real AI/NVDA pool: sane
    const otherSanePool = { ...primary, id: `0x${"9".repeat(64)}` };
    gqlMock.mockImplementation(async (query) => {
      if (query === POOL_KEY_QUERY) return { Token: [{ ...aiPoolKey, primaryPool: primary, fallbackPool: [otherSanePool] }] } as never;
      throw new Error(`unexpected query ${query.slice(0, 30)}`);
    });
    expect(await backend.poolKey(AI)).toMatchObject({ poolId: POOL });
  });

  it("poolKey() resolves the same listed pool as pair() and lowercases every address", async () => {
    // Also how a never-swapped sane pool is found now: the fallback query above no longer excludes it.
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
    // AI's only sane pool is gone (fallbackPool: []) and the primary is the insane 3.4e50 one: the
    // widened fallback must not paper over a genuinely insane price (Fix D).
    gqlMock.mockResolvedValue({ Token: [{ ...aiPoolKey, fallbackPool: [] }] });
    expect(await backend.poolKey(AI)).toBeNull();
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
