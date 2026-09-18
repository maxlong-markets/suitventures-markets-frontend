import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as votesGET } from "@/app/api/votes/route";
import type { Db } from "@/lib/db/client";
import { DbUnavailableError } from "@/lib/db/client";
import { clearCountsCache } from "@/lib/social/countsCache";
import type { VoteCount } from "@/lib/social/store";
import type { TokenPair } from "@/lib/types";
import { VOTES_TTL, zeros, withVoteCounts } from "./counts";

const { holder, voteCounts } = vi.hoisted(() => ({
  holder: { db: null as Db | null },
  voteCounts: vi.fn<(db: unknown, ids: readonly string[]) => Promise<Record<string, VoteCount>>>(),
}));
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

beforeEach(() => {
  clearCountsCache();
  voteCounts.mockReset();
  holder.db = {} as Db; // a database is configured; the store itself is mocked
});
afterEach(() => vi.restoreAllMocks());

describe("zeros", () => {
  it("shapes an answer for every id without asking the store anything", () => {
    expect(VOTES_TTL).toBe(30);
    expect(zeros([T1, T2])).toEqual({ [T1]: { bull: 0, bear: 0 }, [T2]: { bull: 0, bear: 0 } });
    expect(zeros([])).toEqual({});
    expect(voteCounts).not.toHaveBeenCalled();
  });
});

describe("withVoteCounts", () => {
  it("fills the real counts in without touching the cached pair objects", async () => {
    voteCounts.mockResolvedValue({ [T1]: { bull: 7, bear: 2 }, [T2]: { bull: 0, bear: 0 } });
    const cached = [pair(T1), pair(T2)];
    const merged = await withVoteCounts(cached);
    expect(merged.map((p) => [p.bull, p.bear])).toEqual([[7, 2], [0, 0]]);
    expect(cached.map((p) => [p.bull, p.bear])).toEqual([[0, 0], [0, 0]]); // the memo's objects are untouched
    expect(merged[0]).not.toBe(cached[0]);
  });

  it("leaves the backend's zeros alone without a database and asks the store nothing", async () => {
    holder.db = null;
    const cached = [pair(T1)];
    await expect(withVoteCounts(cached)).resolves.toEqual(cached);
    expect(voteCounts).not.toHaveBeenCalled();
  });

  it("keeps a pair the counts do not mention exactly as it was", async () => {
    voteCounts.mockResolvedValue({});
    const cached = [pair(T1)];
    await expect(withVoteCounts(cached)).resolves.toEqual(cached);
  });

  it("never fails a market read: a store outage logs an error name and keeps the zeros", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    voteCounts.mockRejectedValue(Object.assign(new DbUnavailableError("database unavailable (ECONNREFUSED)"), { query: "select 1" }));
    const cached = [pair(T1)];
    await expect(withVoteCounts(cached)).resolves.toEqual(cached);
    expect(warn).toHaveBeenCalledWith("vote counts unavailable: DbUnavailableError");
  });

  it("does nothing at all for an empty list", async () => {
    await expect(withVoteCounts([])).resolves.toEqual([]);
    expect(voteCounts).not.toHaveBeenCalled();
  });

  /**
   * Review I1: the merge used to keep its own `votes:{sorted ids}` memo in the uncapped `ttlCache`,
   * so the pairs table and `/api/votes` each held a separate thirty seconds of the same numbers and
   * could disagree about one token. One cache, keyed per id, means the second reader is a hit.
   */
  it("serves ids the public counts route already cached, without a second store query", async () => {
    voteCounts.mockResolvedValue({ [T1]: { bull: 3, bear: 1 }, [T2]: { bull: 0, bear: 0 } });
    const res = await votesGET(new Request(`http://localhost:3000/api/votes?ids=${T1},${T2}`));
    expect(res.status).toBe(200);
    expect(voteCounts).toHaveBeenCalledTimes(1);

    voteCounts.mockResolvedValue({ [T1]: { bull: 99, bear: 99 }, [T2]: { bull: 99, bear: 99 } });
    const merged = await withVoteCounts([pair(T1), pair(T2)]);
    expect(merged.map((p) => [p.bull, p.bear])).toEqual([[3, 1], [0, 0]]); // the route's numbers, not a fresh read
    expect(voteCounts).toHaveBeenCalledTimes(1);
  });

  it("asks once for a set of ids, in id order, whatever order the pairs arrive in", async () => {
    voteCounts.mockResolvedValue({ [T1]: { bull: 1, bear: 0 }, [T2]: { bull: 0, bear: 2 } });
    await withVoteCounts([pair(T2), pair(T1)]);
    expect(voteCounts.mock.calls[0][1]).toEqual([T2, T1]);
    await withVoteCounts([pair(T1), pair(T2)]);
    expect(voteCounts).toHaveBeenCalledTimes(1); // both already cached, in either order
  });
});
