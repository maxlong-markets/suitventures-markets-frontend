import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTtlCache } from "@/lib/envio/cache";
import { gql } from "@/lib/envio/client";
import { GET } from "./route";

// EnvioUnavailableError is re-exported because _lib/respond imports it from the same module.
vi.mock("@/lib/envio/client", () => ({
  gql: vi.fn(),
  EnvioUnavailableError: class EnvioUnavailableError extends Error {},
}));

const gqlMock = vi.mocked(gql);
const NOW_SEC = 1_789_547_000;

/** One healthy indexer response: chain caught up, one fresh feed. */
const healthy = {
  chain_metadata: [{ chain_id: 4663, latest_processed_block: 1_000, block_height: 1_000 }],
  QuotePrice: [{ id: "0xquote", updatedAt: NOW_SEC - 60, aggregator: "0xfeed" }],
};

describe("GET /api/health", () => {
  beforeEach(() => {
    clearTtlCache();
    gqlMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports 503 and ok:false when the indexer is unreachable", async () => {
    gqlMock.mockRejectedValue(new Error("indexer unreachable: fetch failed"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ ok: false, error: "indexer unavailable" });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("caches the failure for the window instead of re-querying on every request", async () => {
    gqlMock.mockRejectedValue(new Error("boom"));
    const first = await GET();
    const second = await GET();
    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    await expect(second.json()).resolves.toEqual({ ok: false, error: "indexer unavailable" });
    // The point of Ruling 23: an outage must not cost one indexer call per request.
    expect(gqlMock).toHaveBeenCalledTimes(1);
  });

  it("answers 200 with the lag and quote ages while the indexer is healthy", async () => {
    gqlMock.mockResolvedValue(healthy);
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      lag: 0,
      quotes: [{ id: "0xquote", ageSec: 60, stale: false }],
    });
  });

  it("does not re-query inside the window, and reports the outage once it expires", async () => {
    gqlMock.mockResolvedValue(healthy);
    expect((await GET()).status).toBe(200);

    // Phase 2: the indexer dies, but the window has not expired, so nothing is asked.
    gqlMock.mockRejectedValue(new Error("gone"));
    const cachedHit = await GET();
    expect(cachedHit.status).toBe(200);
    expect(gqlMock).toHaveBeenCalledTimes(1);

    // Phase 3: past the 5s window the loader runs again and fails. The cache still holds the old
    // healthy value, so this is exactly the stale-success case the finding was about.
    vi.advanceTimersByTime(6_000);
    const afterExpiry = await GET();
    expect(gqlMock).toHaveBeenCalledTimes(2);
    expect(afterExpiry.status).toBe(503);
    await expect(afterExpiry.json()).resolves.toEqual({ ok: false, error: "indexer unavailable" });
  });

  it("answers 503 when the chain is lagging even though the query succeeded", async () => {
    gqlMock.mockResolvedValue({
      ...healthy,
      chain_metadata: [{ chain_id: 4663, latest_processed_block: 1_000, block_height: 2_000 }],
    });
    const res = await GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ ok: false, lag: 1_000 });
  });
});
