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
