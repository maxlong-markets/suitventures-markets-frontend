import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { saveCursors } from "@/lib/sync/state";
import { testDb } from "@/test/db";
import { findBlockAtOrAfter, seedCursor } from "./catchup";
import { readChainCursor } from "./store";

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(() => db.exec("delete from market.sync_state"));

describe("findBlockAtOrAfter", () => {
  const T0 = 1_700_000_000;
  // Deliberately irregular block spacing (the gap cycles 6..11 s: 10 + (block % 5), never a fixed
  // block time), so a search that assumed one would land on the wrong boundary against this fixture.
  const tsAt = (block: number) => T0 + block * 10 + (block % 5);

  /** Wraps tsAt so a test can assert how many probes (RPC calls in production) the search made. */
  function counted(): { timestampOf: (block: number) => Promise<number>; probes: () => number } {
    let probes = 0;
    return {
      timestampOf: async (block: number) => {
        probes += 1;
        return tsAt(block);
      },
      probes: () => probes,
    };
  }

  it("finds the exact boundary block on an irregular sequence", async () => {
    const head = 2000;
    const boundary = 777;
    const { timestampOf } = counted();
    expect(await findBlockAtOrAfter(head, timestampOf, tsAt(boundary))).toBe(boundary);
  });

  it("finds the boundary block when ts falls strictly between two blocks' timestamps", async () => {
    const head = 2000;
    const boundary = 512;
    const { timestampOf } = counted();
    // One second past the previous block's timestamp, still short of the boundary block's own: the
    // boundary block is still the first one at or after it.
    expect(await findBlockAtOrAfter(head, timestampOf, tsAt(boundary - 1) + 1)).toBe(boundary);
  });

  it("returns block 1 when ts is before the first block", async () => {
    const head = 2000;
    const { timestampOf } = counted();
    expect(await findBlockAtOrAfter(head, timestampOf, tsAt(1) - 1_000)).toBe(1);
  });

  it("returns head when every block is older than ts", async () => {
    const head = 2000;
    const { timestampOf } = counted();
    expect(await findBlockAtOrAfter(head, timestampOf, tsAt(head) + 1_000)).toBe(head);
  });

  it("makes a logarithmic number of probes, not a linear scan", async () => {
    const head = 1_000_000;
    const boundary = 654_321;
    const { timestampOf, probes } = counted();
    expect(await findBlockAtOrAfter(head, timestampOf, tsAt(boundary))).toBe(boundary);
    // log2(1_000_000) ~= 20; comfortable headroom above that without being anywhere near head's scale.
    expect(probes()).toBeGreaterThan(0);
    expect(probes()).toBeLessThanOrEqual(25);
  });
});

describe("seedCursor", () => {
  it("sets a cursor of 0 (the job has never run)", async () => {
    expect(await seedCursor(db, 12_345)).toEqual({ from: 0, to: 12_345, rewound: false });
    expect(await readChainCursor(db)).toBe(12_345);
  });

  it("raises a stored cursor that is lower than the target block", async () => {
    await saveCursors(db, "chain", { cursor: 2_000 });
    expect(await seedCursor(db, 9_000)).toEqual({ from: 2_000, to: 9_000, rewound: false });
    expect(await readChainCursor(db)).toBe(9_000);
  });

  it("leaves a higher stored cursor alone without forceRewind", async () => {
    await saveCursors(db, "chain", { cursor: 5_000 });
    expect(await seedCursor(db, 3_000)).toEqual({ from: 5_000, to: 5_000, rewound: false });
    expect(await readChainCursor(db)).toBe(5_000);
  });

  it("rewinds a higher stored cursor only under forceRewind", async () => {
    await saveCursors(db, "chain", { cursor: 5_000 });
    // Proves this writes the column directly: routed through saveCursors' greatest(), this could
    // never lower the stored value at all.
    expect(await seedCursor(db, 3_000, { forceRewind: true })).toEqual({ from: 5_000, to: 3_000, rewound: true });
    expect(await readChainCursor(db)).toBe(3_000);
  });

  it("forceRewind still just raises when the target is higher, and does not report a rewind", async () => {
    await saveCursors(db, "chain", { cursor: 1_000 });
    expect(await seedCursor(db, 8_000, { forceRewind: true })).toEqual({ from: 1_000, to: 8_000, rewound: false });
    expect(await readChainCursor(db)).toBe(8_000);
  });

  // Fix round 1 (task-7-report.md): --dry-run must change nothing, so seedCursor needs a mode that
  // reports what it would do without writing.
  describe("dryRun", () => {
    it("reports what a raise would become, but writes nothing", async () => {
      await saveCursors(db, "chain", { cursor: 2_000 });
      expect(await seedCursor(db, 9_000, { dryRun: true })).toEqual({ from: 2_000, to: 9_000, rewound: false });
      expect(await readChainCursor(db)).toBe(2_000); // unchanged
    });

    it("reports what a forced rewind would become, but writes nothing", async () => {
      await saveCursors(db, "chain", { cursor: 5_000 });
      expect(await seedCursor(db, 3_000, { forceRewind: true, dryRun: true })).toEqual({ from: 5_000, to: 3_000, rewound: true });
      expect(await readChainCursor(db)).toBe(5_000); // unchanged
    });

    it("reports a higher stored cursor would be left alone, and writes nothing (redundant either way, but proves dryRun does not change the resume rule itself)", async () => {
      await saveCursors(db, "chain", { cursor: 5_000 });
      expect(await seedCursor(db, 3_000, { dryRun: true })).toEqual({ from: 5_000, to: 5_000, rewound: false });
      expect(await readChainCursor(db)).toBe(5_000);
    });
  });
});
