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
