import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { swapRec, txHash } from "@/lib/sync/testRows";
import { insertSwaps } from "@/lib/sync/writers";
import { testDb } from "@/test/db";
import { resetSwapCheckpoint, truncateSwaps } from "./reset";
import type { Checkpoint } from "./seed";

describe("truncateSwaps", () => {
  let db: Db;
  beforeAll(async () => { db = await testDb(); });
  afterAll(() => db.end());

  it("empties market.swaps and reports the row count before and after", async () => {
    await insertSwaps(db, [swapRec({ txHash: txHash(1) }), swapRec({ txHash: txHash(2) })]);
    expect(await truncateSwaps(db)).toEqual({ before: 2, after: 0 });
    expect(await db.query("select tx_hash from market.swaps")).toEqual([]);
    // Idempotent: truncating an already-empty table is not an error.
    expect(await truncateSwaps(db)).toEqual({ before: 0, after: 0 });
  });
});

describe("resetSwapCheckpoint", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "reset-swaps-")); });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("rewinds an existing checkpoint to the swaps phase, dropping only swaps from done and keeping startedAt", async () => {
    const path = join(dir, "checkpoint.json");
    const before: Checkpoint = { startedAt: 1_789_000_000, phase: "candles", ranges: { r0: "done", r1: "0xabc-3" }, done: ["quotes", "tokens", "pools", "swaps"] };
    await writeFile(path, JSON.stringify(before, null, 2));
    const next = await resetSwapCheckpoint(path);
    const want: Checkpoint = { startedAt: 1_789_000_000, phase: "swaps", ranges: {}, done: ["quotes", "tokens", "pools"] };
    expect(next).toEqual(want);
    // Persisted, not just returned: a fresh read of the file matches too.
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(want);
  });

  it("returns null and creates nothing when the checkpoint file does not exist", async () => {
    const path = join(dir, "missing", "checkpoint.json");
    expect(await resetSwapCheckpoint(path)).toBeNull();
    await expect(access(path)).rejects.toThrow();
  });
});
