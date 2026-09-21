import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { QuoterUnavailableError, type Quoter } from "@/lib/quote/quoter";
import { testDb } from "@/test/db";
import { FakeSource } from "./fakeSource";
import { PROBE_UNREACHABLE, runSync, type RunOpts } from "./run";
import { acquireLease, raiseHeadBlock, readHeadBlock, readState } from "./state";
import { POOL_A, T0, poolRec, priceRec, quoteRec, tokenRec } from "./testRows";
import { upsertPools, upsertQuotes, upsertTokens } from "./writers";

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
    // Task 6: nightly no longer walks tokens/pools from a source — seed them directly, the way the chain
    // reader would already have written them. The FakeSource here stands only for deps.ts's dead stub; its
    // seeded rows (if any) would never be read now.
    await upsertTokens(db, [tokenRec()], T0);
    await upsertPools(db, [poolRec()], T0);
    const src = new FakeSource({});
    const o = opts({ job: "nightly", windowSec: 250, queryBudget: 400, leaseSec: 300 });
    const report = await runSync(db, src, o);
    expect(report).toMatchObject({ job: "nightly", cycles: 1, error: null });
    expect(report.results[0]).toMatchObject({ done: true, phase: "", listed: 1 });
    expect(o.slept).toEqual([]);
    expect(await readState(db, "nightly")).toMatchObject({ rowsWritten: 1, queriesUsed: 0, leaseOwner: null });
  });
  it("forwards opts.quoter through to the nightly's probe phase (I2a wiring)", async () => {
    await upsertTokens(db, [tokenRec()], T0);
    await upsertPools(db, [poolRec()], T0);
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    const src = new FakeSource({});
    const calls: string[] = [];
    const quoter: Quoter = {
      exactIn: async (call) => { calls.push(call.poolKey.poolId); return 1n; },
      exactOut: async () => { throw new Error("unused by probePools"); },
    };
    const o = opts({ job: "nightly", windowSec: 250, queryBudget: 400, leaseSec: 300, quoter });
    const report = await runSync(db, src, o);
    expect(calls).toEqual([POOL_A]);
    expect(report.results[0]).toMatchObject({ routable: 1, unroutable: 0, skipped: 0 });
  });
  it("records PROBE_UNREACHABLE through finishRun when every probe candidate is skipped (I2b), keeping the cursor and finishing the phase", async () => {
    await upsertTokens(db, [tokenRec()], T0);
    await upsertPools(db, [poolRec()], T0);
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    const src = new FakeSource({});
    const quoter: Quoter = {
      exactIn: async () => { throw new QuoterUnavailableError(new Error("down")); },
      exactOut: async () => { throw new Error("unused by probePools"); },
    };
    const o = opts({ job: "nightly", windowSec: 250, queryBudget: 400, leaseSec: 300, quoter });
    const report = await runSync(db, src, o);
    expect(report.error).toBe(PROBE_UNREACHABLE);
    expect(report.results[0]).toMatchObject({ done: true, phase: "", routable: 0, unroutable: 0, skipped: 1 });
    // Not a thrown-error abort: "listed" already wrote a real row, and the probe phase's own cursor and phase
    // are already persisted (I3) by the time finishRun records the error — a dead RPC must not erase either,
    // only stop the run from reading as healthy.
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "", lastError: PROBE_UNREACHABLE, rowsWritten: 1, leaseOwner: null });
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
    const src = new FakeSource({}); // nightly no longer reads a source at all (Task 6)
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
  it("no longer guards the nightly job with the head-block mark (Task 6): runs even when the source's chain head is behind the stored mark, and never asks chainMeta or writes its seeded tokens/pools", async () => {
    await raiseHeadBlock(db, 1000);
    const src = new FakeSource({ tokens: [tokenRec()], pools: [poolRec()], chain: { latestProcessedBlock: 500, blockHeight: 1000 } });
    const o = opts({ job: "nightly", windowSec: 250, queryBudget: 400, leaseSec: 300 });
    const report = await runSync(db, src, o);
    expect(report).toMatchObject({ job: "nightly", skipped: null, cycles: 1, error: null });
    // chainMeta never asked: the guard is market-only now, and nightly no longer reads a source at all.
    expect(src.calls).toEqual([]);
    expect(await readState(db, "market")).toMatchObject({ lastRunAt: null, lastError: null });
    // The chain reader owns market.tokens/market.pools now (Task 6): nightly's dropped "tokens"/"pools"
    // phases would have written this FakeSource's seeded rows into them; they must not exist.
    expect(await count("tokens")).toBe(0);
    expect(await count("pools")).toBe(0);
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
