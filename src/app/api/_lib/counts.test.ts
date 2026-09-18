import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { DbUnavailableError } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import type { VoteCount } from "@/lib/social/store";
import type { TokenPair } from "@/lib/types";
import { VOTES_TTL, voteCountsFor, withVoteCounts } from "./counts";

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
  clearTtlCache();
  voteCounts.mockReset();
  holder.db = {} as Db; // a database is configured; the store itself is mocked
});
afterEach(() => vi.restoreAllMocks());

describe("voteCountsFor", () => {
  it("caches for thirty seconds, keyed by the ids whatever order they arrive in", async () => {
    expect(VOTES_TTL).toBe(30);
    voteCounts.mockResolvedValue({ [T1]: { bull: 3, bear: 1 }, [T2]: { bull: 0, bear: 0 } });
    await expect(voteCountsFor([T1, T2])).resolves.toEqual({ [T1]: { bull: 3, bear: 1 }, [T2]: { bull: 0, bear: 0 } });
    voteCounts.mockResolvedValue({ [T1]: { bull: 99, bear: 99 }, [T2]: { bull: 99, bear: 99 } });
    await expect(voteCountsFor([T2, T1])).resolves.toEqual({ [T1]: { bull: 3, bear: 1 }, [T2]: { bull: 0, bear: 0 } });
    expect(voteCounts).toHaveBeenCalledTimes(1);
  });

  it("answers zeros without a database and never asks the store", async () => {
    holder.db = null;
    await expect(voteCountsFor([T1, T2])).resolves.toEqual({ [T1]: { bull: 0, bear: 0 }, [T2]: { bull: 0, bear: 0 } });
    expect(voteCounts).not.toHaveBeenCalled();
  });

  it("answers an empty map for no ids at all", async () => {
    await expect(voteCountsFor([])).resolves.toEqual({});
    expect(voteCounts).not.toHaveBeenCalled();
  });

  it("lets a store outage travel, so the route can answer 503", async () => {
    voteCounts.mockRejectedValue(new DbUnavailableError("database unavailable (ECONNREFUSED)"));
    await expect(voteCountsFor([T1])).rejects.toBeInstanceOf(DbUnavailableError);
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
});
