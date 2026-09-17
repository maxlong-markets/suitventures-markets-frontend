import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { FakeSource } from "./fakeSource";
import { runSync, type RunOpts } from "./run";
import { acquireLease, readState } from "./state";
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
/** Quotes only: a market cycle costs three requests (quotes, an empty pool page, an empty new-pool page). */
const source = () => new FakeSource({ quotes: [quoteRec()], prices: [priceRec()] });

describe("runSync", () => {
  it("skips when another owner holds the lease", async () => {
    await acquireLease(db, "market", "other", T0 + 1000, 120);
    const src = source();
    expect(await runSync(db, src, opts())).toEqual({ job: "market", skipped: "lease", cycles: 0, results: [], error: null });
    expect(src.calls).toEqual([]);
    expect((await readState(db, "market")).leaseOwner).toBe("other");
  });
  it("runs cycles 30 s apart inside a 55 s window and shares one budget across them", async () => {
    const o = opts({ queryBudget: 5 });
    const report = await runSync(db, source(), o);
    expect(report).toMatchObject({ job: "market", skipped: null, cycles: 2, error: null });
    expect(o.slept).toEqual([30_000]);
    expect(report.results[0]).toMatchObject({ queries: 3, exhausted: false });
    expect(report.results[1]).toMatchObject({ queries: 2, exhausted: true });
    expect(await readState(db, "market")).toMatchObject({ queriesUsed: 5, lastOkAt: T0 + 1030, lastError: null, leaseOwner: null, leaseUntil: 0 });
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
    expect(await readState(db, "nightly")).toMatchObject({ rowsWritten: 3, queriesUsed: 2, leaseOwner: null });
  });
});
