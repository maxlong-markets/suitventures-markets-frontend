import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { acquireLease, finishRun, raiseHeadBlock, readHeadBlock, readState, releaseLease, renewLease, saveCursors } from "./state";

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
  it("renews only while the caller still owns the lease, and never acquires or steals one", async () => {
    // No lease held yet at all: renewLease must not act like acquireLease and take it anyway.
    expect(await renewLease(db, "market", "a", NOW, 120)).toBe(false);
    expect(await readState(db, "market")).toMatchObject({ leaseOwner: null, leaseUntil: 0 });

    await acquireLease(db, "market", "a", NOW, 120);
    expect(await renewLease(db, "market", "a", NOW + 60, 300)).toBe(true);
    expect(await readState(db, "market")).toMatchObject({ leaseOwner: "a", leaseUntil: NOW + 360 });

    // A different owner (never held it, or the lease moved on) cannot renew it either.
    expect(await renewLease(db, "market", "b", NOW + 61, 120)).toBe(false);
    expect(await readState(db, "market")).toMatchObject({ leaseOwner: "a", leaseUntil: NOW + 360 }); // untouched
  });

  it("saves a partial cursor patch", async () => {
    await saveCursors(db, "nightly", { cursor: 5, phase: "tokens" });
    await saveCursors(db, "nightly", { cursorText: "0xabc" });
    await saveCursors(db, "nightly", {});
    expect(await readState(db, "nightly")).toMatchObject({ cursor: 5, cursor2: 0, cursorText: "0xabc", phase: "tokens" });
  });
  it("never lowers cursor or cursor2 (a late writer loses), while cursor_text and phase are plain writes", async () => {
    await saveCursors(db, "market", { cursor: 100, cursor2: 200, cursorText: "a", phase: "x" });
    await saveCursors(db, "market", { cursor: 50, cursor2: 150, cursorText: "b", phase: "y" });
    expect(await readState(db, "market")).toMatchObject({ cursor: 100, cursor2: 200, cursorText: "b", phase: "y" });
    await saveCursors(db, "market", { cursor: 101, cursor2: 201 });
    expect(await readState(db, "market")).toMatchObject({ cursor: 101, cursor2: 201, cursorText: "b", phase: "y" });
  });
  it("accumulates rows_written and queries_used past the int4 range (they are bigint), read back as numbers", async () => {
    const types = await db.query<{ column_name: string; data_type: string }>(
      "select column_name, data_type from information_schema.columns where table_schema = 'market' and table_name = 'sync_state' and column_name in ('rows_written', 'queries_used') order by column_name",
    );
    expect(types).toEqual([{ column_name: "queries_used", data_type: "bigint" }, { column_name: "rows_written", data_type: "bigint" }]);
    await finishRun(db, "market", { now: NOW, ok: true, rows: 2_000_000_000, queries: 2_000_000_000 });
    await finishRun(db, "market", { now: NOW + 1, ok: true, rows: 2_000_000_000, queries: 2_000_000_000 });
    expect(await readState(db, "market")).toMatchObject({ rowsWritten: 4_000_000_000, queriesUsed: 4_000_000_000 });
  });
  it("keeps the highest head block ever reported on the market row, from a database that has never seen the job", async () => {
    expect(await readHeadBlock(db)).toBe(0);
    await raiseHeadBlock(db, 100);
    await raiseHeadBlock(db, 50);
    expect(await readHeadBlock(db)).toBe(100);
    await raiseHeadBlock(db, 120);
    expect(await readHeadBlock(db)).toBe(120);
    expect((await db.query<{ n: unknown }>("select count(*) as n from market.sync_state")).map((r) => Number(r.n))).toEqual([1]);
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
