import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import { clearCountsCache } from "@/lib/social/countsCache";
import { EnvioUnavailableError } from "@/lib/envio/client";
import type { PairsScope } from "@/lib/envio/pairs";
import type { VoteCount } from "@/lib/social/store";
import type { TokenPair } from "@/lib/types";
import { GET } from "./route";

const { holder, pairs, voteCounts } = vi.hoisted(() => ({
  holder: { db: null as Db | null },
  pairs: vi.fn<(scope: PairsScope) => Promise<TokenPair[]>>(),
  voteCounts: vi.fn<(db: unknown, ids: readonly string[]) => Promise<Record<string, VoteCount>>>(),
}));
vi.mock("@/lib/market/backend", () => ({ getBackend: () => ({ kind: "db", pairs }) }));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, hasDb: () => holder.db !== null, getDb: () => holder.db as Db };
});
vi.mock("@/lib/social/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/social/store")>()),
  voteCounts,
}));

const T1 = `0x${"1".repeat(40)}`;
const T2 = `0x${"2".repeat(40)}`;
const pair = (id: string) => ({ id, ticker: "AI", bull: 0, bear: 0 }) as TokenPair;
const call = (scope?: string) => GET(new Request(`http://localhost:3000/api/pairs${scope ? `?scope=${scope}` : ""}`));

beforeEach(() => {
  clearTtlCache();
  // The counts merge shares one per-id cache with `/api/votes` (review I1), and it outlives a
  // `ttlCache` clear: without this, a case that mocks a rejection is served the previous case's
  // numbers instead of reaching the store at all.
  clearCountsCache();
  pairs.mockReset();
  voteCounts.mockReset();
  pairs.mockResolvedValue([pair(T1), pair(T2)]);
  holder.db = null;
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/pairs", () => {
  it("answers the backend's pairs with the list's cache header, and reads the scope", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=30, stale-while-revalidate=60");
    expect(pairs).toHaveBeenCalledWith("all");
    await call("launchpad");
    expect(pairs).toHaveBeenLastCalledWith("launchpad");
    await call("nonsense");
    expect(pairs).toHaveBeenLastCalledWith("all");
  });

  it("carries real vote counts when a store is configured", async () => {
    holder.db = {} as Db;
    voteCounts.mockResolvedValue({ [T1]: { bull: 5, bear: 2 }, [T2]: { bull: 0, bear: 0 } });
    const body = (await (await call()).json()) as TokenPair[];
    expect(body.map((p) => [p.bull, p.bear])).toEqual([[5, 2], [0, 0]]);
    expect(voteCounts).toHaveBeenCalledWith(expect.anything(), [T1, T2]);
  });

  it("carries zeros, and asks nothing, without a store", async () => {
    const body = (await (await call()).json()) as TokenPair[];
    expect(body.map((p) => [p.bull, p.bear])).toEqual([[0, 0], [0, 0]]);
    expect(voteCounts).not.toHaveBeenCalled();
  });

  it("still answers the table when the counts cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    holder.db = {} as Db;
    voteCounts.mockRejectedValue(new Error("boom"));
    const res = await call();
    expect(res.status).toBe(200);
    expect(((await res.json()) as TokenPair[]).map((p) => p.bull)).toEqual([0, 0]);
  });

  it("answers 503 when the backend's source is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    pairs.mockRejectedValue(new EnvioUnavailableError("indexer responded 503"));
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("15");
  });
});
