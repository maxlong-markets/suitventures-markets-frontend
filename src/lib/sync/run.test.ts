import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { FakeSource } from "./fakeSource";
import { runSync, type RunOpts } from "./run";
import { acquireLease, raiseHeadBlock, readHeadBlock, readState } from "./state";
import { T0, poolRec, priceRec, quoteRec, tokenRec } from "./testRows";

const NOW_MS = (T0 + 1000) * 1000;
let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
beforeEach(() => db.exec("delete from market.quotes; delete from market.tokens; delete from market.pools; delete from market.sync_state"));

/** A clock that only moves when the runner sleeps, and a log of how long it slept. */
function opts(over: Partial<RunOpts> = {}): RunOpts & { slept: number[] } {
  let t = NOW_MS;
  const slept: number[] = [];
  return {
    job: "market", owner: "me", now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; },
    windowSec: 55, intervalSec: 30, queryBudget: 150, leaseSec: 120, slept, ...over,
  };
}
/** Quotes only: a market cycle costs three requests (quotes, an empty pool page, an empty new-pool page); the invocation's head-block probe is one more. */
const quotesOnly = () => ({ quotes: [quoteRec()], prices: [priceRec()] });
const source = (chain?: { latestProcessedBlock: number; blockHeight: number }) => new FakeSource({ ...quotesOnly(), chain });
const count = async (table: string) => Number((await db.query<{ n: unknown }>(`select count(*) as n from market.${table}`))[0]!.n);

describe("runSync", () => {
  it("skips when another owner holds the lease", async () => {
    await acquireLease(db, "market", "other", T0 + 1000, 120);
    const src = source();
    expect(await runSync(db, src, opts())).toEqual({ job: "market", skipped: "lease", cycles: 0, results: [], error: null });
    expect(src.calls).toEqual([]);
    expect((await readState(db, "market")).leaseOwner).toBe("other");
  });
  it("runs cycles 30 s apart inside a 55 s window and shares one budget across them, the head-block probe included", async () => {
    const o = opts({ queryBudget: 6 });
    const src = source();
    const report = await runSync(db, src, o);
    expect(report).toMatchObject({ job: "market", skipped: null, cycles: 2, error: null });
    expect(o.slept).toEqual([30_000]);
    expect(src.calls.slice(0, 2)).toEqual(["chainMeta", "quotes"]);
    expect(report.results[0]).toMatchObject({ queries: 3, exhausted: false });
    expect(report.results[1]).toMatchObject({ queries: 2, exhausted: true });
    expect(await readState(db, "market")).toMatchObject({ queriesUsed: 6, lastOkAt: T0 + 1030, lastError: null, leaseOwner: null, leaseUntil: 0 });
  });
  it("records an error through finishRun, ends the invocation and still releases the lease", async () => {
    const src = source();
    src.failOn = { method: "quotes", error: new Error("indexer responded 503") };
    const o = opts();
    expect(await runSync(db, src, o)).toEqual({ job: "market", skipped: null, cycles: 0, results: [], error: "indexer responded 503" });
    expect(o.slept).toEqual([]);
    expect(await readState(db, "market")).toMatchObject({ lastRunAt: T0 + 1000, lastOkAt: null, lastError: "indexer responded 503", leaseOwner: null });
  });
  it("runs the nightly job once", async () => {
    const src = new FakeSource({ tokens: [tokenRec()], pools: [poolRec()] });
    const o = opts({ job: "nightly", windowSec: 250, queryBudget: 400, leaseSec: 300 });
    const report = await runSync(db, src, o);
    expect(report).toMatchObject({ job: "nightly", cycles: 1, error: null });
    expect(report.results[0]).toMatchObject({ done: true, phase: "", tokens: 1, pools: 1, listed: 1 });
    expect(o.slept).toEqual([]);
    expect(await readState(db, "nightly")).toMatchObject({ rowsWritten: 3, queriesUsed: 3, leaseOwner: null });
  });
});

describe("runSync yields to the nightly (spec 5.1)", () => {
  it("skips with 'nightly' while the nightly's lease is held: its own lease released, the indexer not asked, nothing recorded", async () => {
    await acquireLease(db, "nightly", "night", T0 + 1000, 300);
    const src = source();
    const o = opts();
    expect(await runSync(db, src, o)).toEqual({ job: "market", skipped: "nightly", cycles: 0, results: [], error: null });
    expect(src.calls).toEqual([]);
    expect(o.slept).toEqual([]);
    expect(await readState(db, "market")).toMatchObject({ lastRunAt: null, lastError: null, leaseOwner: null, leaseUntil: 0 });
    expect(await readState(db, "nightly")).toMatchObject({ leaseOwner: "night", leaseUntil: T0 + 1300 });
  });
  it("runs once the nightly's lease has lapsed, and the nightly never yields to the market", async () => {
    await acquireLease(db, "nightly", "night", T0 + 500, 300); // until T0 + 800, before this invocation at T0 + 1000
    expect(await runSync(db, source(), opts({ windowSec: 1 }))).toMatchObject({ skipped: null, cycles: 1 });
    await acquireLease(db, "market", "other", T0 + 1000, 120);
    const src = new FakeSource({ tokens: [tokenRec()], pools: [poolRec()] });
    expect(await runSync(db, src, opts({ job: "nightly", windowSec: 280, queryBudget: 400, leaseSec: 300 }))).toMatchObject({ skipped: null, cycles: 1 });
  });
});

describe("runSync head-block guard (spec 5.3a)", () => {
  it("skips with 'indexer' when the indexer reports a block below the stored mark: last_error set, lease released, nothing written", async () => {
    await raiseHeadBlock(db, 1000);
    const src = source({ latestProcessedBlock: 999, blockHeight: 1200 });
    const o = opts();
    expect(await runSync(db, src, o)).toEqual({ job: "market", skipped: "indexer", cycles: 0, results: [], error: "indexer behind the store" });
    expect(src.calls).toEqual(["chainMeta"]);
    expect(o.slept).toEqual([]);
    expect(await readState(db, "market")).toMatchObject({
      lastRunAt: T0 + 1000, lastOkAt: null, lastError: "indexer behind the store", queriesUsed: 1, rowsWritten: 0, leaseOwner: null, leaseUntil: 0,
    });
    expect(await readHeadBlock(db)).toBe(1000);
    expect(await count("quotes")).toBe(0);
  });
  it("runs when the reported block equals the mark, raises the mark when it is above, and clears the error", async () => {
    await raiseHeadBlock(db, 1000);
    expect(await runSync(db, source({ latestProcessedBlock: 1000, blockHeight: 1000 }), opts({ windowSec: 1 }))).toMatchObject({ skipped: null, cycles: 1, error: null });
    expect(await readHeadBlock(db)).toBe(1000);
    expect(await runSync(db, source({ latestProcessedBlock: 1200, blockHeight: 1250 }), opts({ windowSec: 1 }))).toMatchObject({ skipped: null, cycles: 1, error: null });
    expect(await readHeadBlock(db)).toBe(1200);
    expect(await readState(db, "market")).toMatchObject({ lastError: null, queriesUsed: 8 });
    expect(await count("quotes")).toBe(1);
  });
  it("guards the nightly job with the same mark and records the skip on the nightly row", async () => {
    await raiseHeadBlock(db, 1000);
    const src = new FakeSource({ tokens: [tokenRec()], pools: [poolRec()], chain: { latestProcessedBlock: 500, blockHeight: 1000 } });
    const o = opts({ job: "nightly", windowSec: 250, queryBudget: 400, leaseSec: 300 });
    expect(await runSync(db, src, o)).toEqual({ job: "nightly", skipped: "indexer", cycles: 0, results: [], error: "indexer behind the store" });
    expect(src.calls).toEqual(["chainMeta"]);
    expect(await readState(db, "nightly")).toMatchObject({ lastError: "indexer behind the store", queriesUsed: 1, leaseOwner: null, leaseUntil: 0 });
    expect(await readState(db, "market")).toMatchObject({ lastRunAt: null, lastError: null });
    expect(await count("tokens")).toBe(0);
  });
  it("records a failed probe like a failed cycle and releases the lease", async () => {
    const src = source();
    src.failOn = { method: "chainMeta", error: new Error("indexer responded 503") };
    expect(await runSync(db, src, opts())).toEqual({ job: "market", skipped: null, cycles: 0, results: [], error: "indexer responded 503" });
    expect(src.calls).toEqual(["chainMeta"]);
    expect(await readState(db, "market")).toMatchObject({ lastError: "indexer responded 503", queriesUsed: 1, leaseOwner: null, leaseUntil: 0 });
    expect(await readHeadBlock(db)).toBe(0);
  });
});
