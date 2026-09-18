import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTtlCache } from "@/lib/envio/cache";
import { clearCountsCache } from "@/lib/social/countsCache";
import { EnvioUnavailableError } from "@/lib/envio/client";
import type { TokenPair } from "@/lib/types";
import { GET } from "./route";

const { pair } = vi.hoisted(() => ({ pair: vi.fn<(id: string) => Promise<TokenPair | null>>() }));
vi.mock("@/lib/market/backend", () => ({ getBackend: () => ({ kind: "db", pair }) }));

const { holder, voteCounts } = vi.hoisted(() => ({
  holder: { db: null as import("@/lib/db/client").Db | null },
  voteCounts: vi.fn<(db: unknown, ids: readonly string[]) => Promise<Record<string, { bull: number; bear: number }>>>(),
}));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, hasDb: () => holder.db !== null, getDb: () => holder.db as import("@/lib/db/client").Db };
});
vi.mock("@/lib/social/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/social/store")>()),
  voteCounts,
}));

const ADDR = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const CACHE = "public, s-maxage=30, stale-while-revalidate=60";
const call = (address: string) => GET(new Request(`http://localhost:3000/api/tokens/${address}`), { params: Promise.resolve({ address }) });
const found = { id: ADDR, ticker: "AI", name: "Artificial Inu" } as TokenPair;

describe("GET /api/tokens/[address]", () => {
  beforeEach(() => {
    clearTtlCache();
    clearCountsCache();
    pair.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("rejects a malformed address before touching the backend", async () => {
    const res = await call("not-an-address");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad address" });
    expect(pair).not.toHaveBeenCalled();
  });

  it("answers 404 with the list's cache header for an unknown token, and memoises that answer", async () => {
    pair.mockResolvedValue(null);
    const res = await call(ADDR);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "unknown token" });
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
    expect((await call(ADDR)).status).toBe(404);
    expect(pair).toHaveBeenCalledTimes(1); // ttlCache stores null as a value
  });

  it("answers the pair, lowercasing the path segment", async () => {
    pair.mockResolvedValue(found);
    const res = await call(ADDR.toUpperCase().replace("0X", "0x"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
    await expect(res.json()).resolves.toEqual(found);
    expect(pair).toHaveBeenCalledWith(ADDR);
  });

  it("answers 503 when the backend's source is unavailable", async () => {
    pair.mockRejectedValue(new EnvioUnavailableError("indexer responded 503"));
    const res = await call(ADDR);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("15");
  });
});

describe("GET /api/tokens/[address] vote counts", () => {
  beforeEach(() => {
    // This `describe` sits outside the first one, so none of its hooks run here. Without the
    // clear, the 30 s `pair:<addr>` memo the earlier cases filled is still live and the 404 case
    // below would be served a 200 out of it.
    clearTtlCache();
    // The counts merge shares one per-id cache with `/api/votes` (review I1); it survives a
    // `ttlCache` clear, so each case below must start from an empty one to reach the store.
    clearCountsCache();
    pair.mockReset();
    holder.db = null;
    voteCounts.mockReset();
  });

  it("carries real counts when a store is configured, without poisoning the pair memo", async () => {
    holder.db = {} as import("@/lib/db/client").Db;
    pair.mockResolvedValue({ ...found, bull: 0, bear: 0 });
    voteCounts.mockResolvedValue({ [ADDR]: { bull: 4, bear: 1 } });
    await expect((await call(ADDR)).json()).resolves.toMatchObject({ bull: 4, bear: 1 });
    expect(pair).toHaveBeenCalledTimes(1);

    // No `clearTtlCache()` here: clearing the memo is exactly what would hide the bug. Taking the
    // store away instead means nothing is merged on the second read, so it answers whatever the
    // memo actually holds — the backend's zeros, unless the first merge wrote into that object.
    holder.db = null;
    await expect((await call(ADDR)).json()).resolves.toMatchObject({ bull: 0, bear: 0 });
    expect(pair).toHaveBeenCalledTimes(1); // served from the memo, not re-fetched
  });

  it("carries zeros, and asks nothing, without a store", async () => {
    pair.mockResolvedValue({ ...found, bull: 0, bear: 0 });
    await expect((await call(ADDR)).json()).resolves.toMatchObject({ bull: 0, bear: 0 });
    expect(voteCounts).not.toHaveBeenCalled();
  });

  it("merges nothing onto a 404", async () => {
    holder.db = {} as import("@/lib/db/client").Db;
    pair.mockResolvedValue(null);
    expect((await call(ADDR)).status).toBe(404);
    expect(voteCounts).not.toHaveBeenCalled();
  });
});
