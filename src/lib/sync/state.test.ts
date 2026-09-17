import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { acquireLease, finishRun, readState, releaseLease, saveCursors } from "./state";

const NOW = 1_789_000_000;
let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
beforeEach(() => db.exec("delete from market.sync_state"));

describe("sync_state", () => {
  it("returns the default row on first read", async () => {
    expect(await readState(db, "market")).toEqual({
      job: "market", cursor: 0, cursor2: 0, cursorText: "", phase: "", lastRunAt: null, lastOkAt: null, lastError: null,
      rowsWritten: 0, queriesUsed: 0, leaseUntil: 0, leaseOwner: null,
    });
  });
  it("gives the lease to one owner at a time and frees it once lease_until has passed", async () => {
    expect(await acquireLease(db, "market", "a", NOW, 120)).toBe(true);
    expect(await acquireLease(db, "market", "b", NOW + 60, 120)).toBe(false);
    expect(await readState(db, "market")).toMatchObject({ leaseOwner: "a", leaseUntil: NOW + 120 });
    expect(await acquireLease(db, "market", "b", NOW + 121, 120)).toBe(true);
    expect(await readState(db, "market")).toMatchObject({ leaseOwner: "b", leaseUntil: NOW + 241 });
  });
  it("is released only by its owner", async () => {
    await acquireLease(db, "market", "a", NOW, 120);
    await releaseLease(db, "market", "b");
    expect((await readState(db, "market")).leaseOwner).toBe("a");
    await releaseLease(db, "market", "a");
    expect(await readState(db, "market")).toMatchObject({ leaseOwner: null, leaseUntil: 0 });
    expect(await acquireLease(db, "market", "b", NOW, 120)).toBe(true);
  });
  it("saves a partial cursor patch", async () => {
    await saveCursors(db, "nightly", { cursor: 5, phase: "tokens" });
    await saveCursors(db, "nightly", { cursorText: "0xabc" });
    await saveCursors(db, "nightly", {});
    expect(await readState(db, "nightly")).toMatchObject({ cursor: 5, cursor2: 0, cursorText: "0xabc", phase: "tokens" });
  });
  it("records ok and failed runs and accumulates the counters", async () => {
    await finishRun(db, "market", { now: NOW, ok: true, rows: 10, queries: 3 });
    expect(await readState(db, "market")).toMatchObject({ lastRunAt: NOW, lastOkAt: NOW, lastError: null, rowsWritten: 10, queriesUsed: 3 });
    await finishRun(db, "market", { now: NOW + 30, ok: false, error: "indexer responded 429", rows: 2, queries: 1 });
    expect(await readState(db, "market")).toMatchObject({ lastRunAt: NOW + 30, lastOkAt: NOW, lastError: "indexer responded 429", rowsWritten: 12, queriesUsed: 4 });
    await finishRun(db, "market", { now: NOW + 60, ok: true, rows: 0, queries: 0 });
    expect(await readState(db, "market")).toMatchObject({ lastOkAt: NOW + 60, lastError: null });
  });
});
