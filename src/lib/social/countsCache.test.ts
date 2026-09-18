import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import type { VoteCount } from "@/lib/social/store";
import { clearCountsCache, countsCacheSize, countsFor } from "./countsCache";

const { voteCounts } = vi.hoisted(() => ({
  voteCounts: vi.fn<(db: unknown, ids: readonly string[]) => Promise<Record<string, VoteCount>>>(),
}));
vi.mock("@/lib/social/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/social/store")>()),
  voteCounts,
}));

const T1 = `0x${"1".repeat(40)}`;
const T2 = `0x${"2".repeat(40)}`;
const NOW = 1_789_000_000;
const db = {} as Db;

beforeEach(() => {
  clearCountsCache();
  voteCounts.mockReset();
});

describe("countsFor", () => {
  it("a hit skips the query entirely", async () => {
    voteCounts.mockResolvedValue({ [T1]: { bull: 3, bear: 1 } });
    await expect(countsFor(db, [T1], NOW)).resolves.toEqual({ [T1]: { bull: 3, bear: 1 } });
    voteCounts.mockResolvedValue({ [T1]: { bull: 99, bear: 99 } });
    await expect(countsFor(db, [T1], NOW + 10)).resolves.toEqual({ [T1]: { bull: 3, bear: 1 } }); // still cached
    expect(voteCounts).toHaveBeenCalledTimes(1);
  });

  it("a stale entry past thirty seconds is a miss again", async () => {
    voteCounts.mockResolvedValue({ [T1]: { bull: 3, bear: 1 } });
    await countsFor(db, [T1], NOW);
    voteCounts.mockResolvedValue({ [T1]: { bull: 4, bear: 1 } });
    await expect(countsFor(db, [T1], NOW + 31)).resolves.toEqual({ [T1]: { bull: 4, bear: 1 } });
    expect(voteCounts).toHaveBeenCalledTimes(2);
  });

  it("a miss batches only the ids that are missing or stale into one query", async () => {
    voteCounts.mockResolvedValue({ [T1]: { bull: 1, bear: 0 } });
    await countsFor(db, [T1], NOW); // T1 now cached
    voteCounts.mockResolvedValue({ [T2]: { bull: 0, bear: 2 } });
    await expect(countsFor(db, [T1, T2], NOW + 1)).resolves.toEqual({
      [T1]: { bull: 1, bear: 0 },
      [T2]: { bull: 0, bear: 2 },
    });
    expect(voteCounts).toHaveBeenCalledTimes(2);
    expect(voteCounts.mock.calls[1][1]).toEqual([T2]); // only the miss, not T1 again
  });

  it("zeroes an id the store's answer does not mention", async () => {
    voteCounts.mockResolvedValue({});
    await expect(countsFor(db, [T1], NOW)).resolves.toEqual({ [T1]: { bull: 0, bear: 0 } });
  });

  it("answers an empty map, and asks the store nothing, for no ids at all", async () => {
    await expect(countsFor(db, [], NOW)).resolves.toEqual({});
    expect(voteCounts).not.toHaveBeenCalled();
  });

  it("two different id sets of equal size get their own counts, never each other's", async () => {
    voteCounts.mockImplementation(async (_db, ids) =>
      Object.fromEntries((ids as string[]).map((id) => [id, { bull: id === T1 ? 5 : 9, bear: 0 }])),
    );
    await expect(countsFor(db, [T1], NOW)).resolves.toEqual({ [T1]: { bull: 5, bear: 0 } });
    await expect(countsFor(db, [T2], NOW)).resolves.toEqual({ [T2]: { bull: 9, bear: 0 } });
    // Re-asking for T1 must still be the cached 5, not T2's 9: a caller-set-length key would risk this.
    await expect(countsFor(db, [T1], NOW + 1)).resolves.toEqual({ [T1]: { bull: 5, bear: 0 } });
    expect(voteCounts).toHaveBeenCalledTimes(2);
  });

  it("caps the cache at five thousand entries, evicting the oldest to make room", async () => {
    const ids = Array.from({ length: 5_001 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    voteCounts.mockImplementation(async (_db, batch) =>
      Object.fromEntries((batch as string[]).map((id) => [id, { bull: 0, bear: 0 }])),
    );
    for (const id of ids) await countsFor(db, [id], NOW);
    expect(countsCacheSize()).toBe(5_000);
    // The very first id was evicted to make room for the 5,001st; asking again is a fresh miss.
    voteCounts.mockClear();
    await countsFor(db, [ids[0]], NOW + 1);
    expect(voteCounts).toHaveBeenCalledTimes(1);
  });
});
