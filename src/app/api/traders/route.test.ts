import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DbUnavailableError } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import type { Address, TraderRow } from "@/lib/types";
import { GET } from "./route";

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

  it("answers 503 with a sentence the page can print when there is no store", async () => {
    h.hasDb.mockReturnValue(false);
    const res = await call();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "traders board needs the market store" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(h.topTraders).not.toHaveBeenCalled();
  });

  it.each(["?by=hype", "?by=", "?by=VOLUME"])("rejects %s before touching the store", async (query) => {
    const res = await call(query);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad by" });
    expect(h.topTraders).not.toHaveBeenCalled();
  });

  it("ranks by volume over the last 24 hours by default, top 50, cached a minute", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([ROW]);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=60, stale-while-revalidate=60");
    const opts = h.topTraders.mock.calls[0][1];
    expect(opts.by).toBe("volume");
    expect(opts.limit).toBe(50);
    expect(Math.floor(Date.now() / 1000) - opts.sinceTs).toBe(86_400);
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

  it("answers 503 when the database itself is unreachable", async () => {
    h.topTraders.mockRejectedValue(new DbUnavailableError("database unavailable (ECONNREFUSED)"));
    const res = await call();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "database unavailable" });
  });
});
