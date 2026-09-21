import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { candleCutoff, pruneCandles, pruneSwaps, retentionCutoff, SWAP_RETENTION_SEC } from "./retention";
import { candleRec, swapRec, txHash } from "./testRows";
import { insertSwaps, upsertCandles } from "./writers";

const NOW = 1_789_900_000;
const CUTOFF = retentionCutoff(NOW);
const FAR_FUTURE = () => Date.now() + 60_000;

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
beforeEach(() => db.exec("delete from market.swaps; delete from market.candles"));

const txHashes = async () => (await db.query<{ tx_hash: string }>("select tx_hash from market.swaps order by tx_hash")).map((r) => r.tx_hash);

describe("retentionCutoff", () => {
  it("is now minus SWAP_RETENTION_SEC (5 days)", () => {
    expect(SWAP_RETENTION_SEC).toBe(5 * 86_400);
    expect(retentionCutoff(NOW)).toBe(NOW - SWAP_RETENTION_SEC);
  });
});

describe("pruneSwaps", () => {
  it("deletes rows older than the cutoff and keeps rows at or after it", async () => {
    const old = txHash(1), atCutoff = txHash(2), recent = txHash(3);
    await insertSwaps(db, [
      swapRec({ txHash: old, timestamp: CUTOFF - 1 }),
      swapRec({ txHash: atCutoff, timestamp: CUTOFF }),
      swapRec({ txHash: recent, timestamp: CUTOFF + 1 }),
    ]);
    expect(await pruneSwaps(db, { now: NOW, deadlineMs: FAR_FUTURE() })).toEqual({ deleted: 1, done: true });
    expect(await txHashes()).toEqual([atCutoff, recent]);
  });

  it("loops across batches until a batch deletes nothing", async () => {
    const hashes = [1, 2, 3, 4, 5].map(txHash);
    await insertSwaps(db, hashes.map((tx) => swapRec({ txHash: tx, timestamp: CUTOFF - 100 })));
    const spy = vi.spyOn(db, "query");
    expect(await pruneSwaps(db, { now: NOW, deadlineMs: FAR_FUTURE(), batch: 2 })).toEqual({ deleted: 5, done: true });
    expect(await txHashes()).toEqual([]);
    // 5 rows at 2 a batch: two full batches, one of the last row, one empty batch that finds done.
    const deletes = spy.mock.calls.filter(([text]) => typeof text === "string" && text.includes("delete from market.swaps"));
    expect(deletes).toHaveLength(4);
  });

  it("stops at the deadline with done false, leaving the rest for the next run", async () => {
    await insertSwaps(db, [swapRec({ txHash: txHash(9), timestamp: CUTOFF - 1 })]);
    expect(await pruneSwaps(db, { now: NOW, deadlineMs: Date.now() - 1 })).toEqual({ deleted: 0, done: false });
    expect(await txHashes()).toEqual([txHash(9)]);
  });
});

describe("pruneCandles", () => {
  const m1Cutoff = candleCutoff("m1", NOW);
  const d1Cutoff = candleCutoff("d1", NOW);
  const candleKeys = async () =>
    (await db.query<{ interval: string; t: number }>("select interval, t from market.candles order by interval, t")).map((r) => `${r.interval}:${r.t}`);

  it("deletes candles below each interval's own cutoff and keeps the rest, with different windows exercised across intervals", async () => {
    await upsertCandles(db, [
      candleRec({ interval: "m1", t: m1Cutoff - 1 }), // stale under m1's 1-day window: deleted
      candleRec({ interval: "m1", t: m1Cutoff }), // at the cutoff: kept
      candleRec({ interval: "d1", t: m1Cutoff - 1 }), // same t as the first row, but well inside d1's 300-day window: kept
      candleRec({ interval: "d1", t: d1Cutoff - 1 }), // stale under d1's own, much longer, window: deleted
    ]);
    expect(await pruneCandles(db, { now: NOW, deadlineMs: FAR_FUTURE() })).toEqual({ deleted: 2, done: true });
    expect(await candleKeys()).toEqual([`d1:${m1Cutoff - 1}`, `m1:${m1Cutoff}`]);
  });

  it("stops at the deadline with done false, and a second call finishes the job", async () => {
    const t = candleCutoff("h1", NOW) - 5;
    await upsertCandles(db, [candleRec({ interval: "h1", t })]);
    expect(await pruneCandles(db, { now: NOW, deadlineMs: Date.now() - 1 })).toEqual({ deleted: 0, done: false });
    expect(await candleKeys()).toEqual([`h1:${t}`]);
    expect(await pruneCandles(db, { now: NOW, deadlineMs: FAR_FUTURE() })).toEqual({ deleted: 1, done: true });
    expect(await candleKeys()).toEqual([]);
  });

  it("an empty table is { deleted: 0, done: true }", async () => {
    expect(await pruneCandles(db, { now: NOW, deadlineMs: FAR_FUTURE() })).toEqual({ deleted: 0, done: true });
  });
});
