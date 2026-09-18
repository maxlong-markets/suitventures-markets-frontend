import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DbUnavailableError } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import type { Address, TraderRow } from "@/lib/types";
import { GET, maxDuration } from "./route";

const h = vi.hoisted(() => ({
  hasDb: vi.fn<() => boolean>(),
  topTraders: vi.fn<(db: unknown, opts: { sinceTs: number; by: string; limit: number }) => Promise<TraderRow[]>>(),
}));

// importOriginal, so `DbUnavailableError` stays the very class `failure()` tests against.
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  hasDb: h.hasDb,
  getDb: () => ({ kind: "fake-db" }),
}));
vi.mock("@/lib/social/store", () => ({ topTraders: h.topTraders }));

const ROW: TraderRow = {
  wallet: "0x1111111111111111111111111111111111111111" as Address,
  volumeUsd: 1_250_000,
  trades: 412,
  tokens: 9,
};

const call = (query = "") => GET(new Request(`http://localhost:3000/api/traders${query}`));

describe("GET /api/traders", () => {
  beforeEach(() => {
    clearTtlCache();
    h.hasDb.mockReset().mockReturnValue(true);
    h.topTraders.mockReset().mockResolvedValue([ROW]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  // Review I3: the board's is the heaviest query in the app — a day of `market.swaps` joined and
  // hash-aggregated — and it was the only store route inheriting the platform's default duration.
  it("pins a duration budget, like every other route that touches the store", () => {
    expect(maxDuration).toBe(30);
  });

  it("answers 503 with a sentence the page can print and a machine-readable code when there is no store", async () => {
    h.hasDb.mockReturnValue(false);
    const res = await call();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "traders board needs the market store", code: "no-store" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(h.topTraders).not.toHaveBeenCalled();
  });

  it.each(["?by=hype", "?by=", "?by=VOLUME"])("rejects %s before touching the store", async (query) => {
    const res = await call(query);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad by" });
    expect(h.topTraders).not.toHaveBeenCalled();
  });

  it("ranks by volume over the last 24 hours by default, top 50, cached a minute, with a window that moves with the clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_789_000_000_000);
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([ROW]);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=60, stale-while-revalidate=60");
    const first = h.topTraders.mock.calls[0][1];
    expect(first.by).toBe("volume");
    expect(first.limit).toBe(50);
    expect(first.sinceTs).toBe(1_789_000_000 - 86_400);

    // Past the memo's 60 s TTL: a `sinceTs` hoisted to module scope would stay put here, but the
    // loader recomputes it against the clock every time the memo refills (review M3/M4).
    vi.setSystemTime(1_789_000_000_000 + 61_000);
    await call();
    const second = h.topTraders.mock.calls[1][1];
    expect(second.sinceTs).toBe(first.sinceTs + 61);
    vi.useRealTimers();
  });

  it("takes the trades ordering when asked for it", async () => {
    await call("?by=trades");
    expect(h.topTraders.mock.calls[0][1].by).toBe("trades");
  });

  it("memoises each ordering on its own for 60 s", async () => {
    await call("?by=volume");
    await call("?by=volume");
    expect(h.topTraders).toHaveBeenCalledTimes(1);
    await call("?by=trades");
    expect(h.topTraders).toHaveBeenCalledTimes(2);
  });

  it("answers 503 with no code when the database itself is unreachable — a different condition than a missing store", async () => {
    h.topTraders.mockRejectedValue(new DbUnavailableError("database unavailable (ECONNREFUSED)"));
    const res = await call();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; code?: string };
    // toEqual already fails if an extra `code` key snuck in; the explicit check makes the intent
    // impossible to miss on a future read.
    expect(body).toEqual({ error: "database unavailable" });
    expect(body.code).toBeUndefined();
  });
});
