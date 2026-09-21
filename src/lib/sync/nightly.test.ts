import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { QuoterUnavailableError, type Quoter } from "@/lib/quote/quoter";
import { testDb } from "@/test/db";
import { runNightly } from "./nightly";
import { candleCutoff, retentionCutoff } from "./retention";
import { readState, saveCursors } from "./state";
import { candleRec, POOL_A, POOL_B, T0, TOKEN_A, TOKEN_B, poolRec, priceRec, quoteRec, swapRec, tokenRec, txHash } from "./testRows";
import { insertSwaps, upsertCandles, upsertPools, upsertQuotes, upsertTokens } from "./writers";

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
beforeEach(() => db.exec("delete from market.tokens; delete from market.pools; delete from market.quotes; delete from market.sync_state; delete from market.swaps; delete from market.candles"));
afterEach(() => vi.restoreAllMocks());

/**
 * Seeds market.tokens/market.pools directly, the way the chain reader (src/lib/chain/run.ts) now writes them:
 * Task 6 dropped the "tokens"/"pools" phases that used to walk this data in from Envio through a FakeSource,
 * so this job's own tests no longer build one either.
 */
async function seedTokensAndPools(): Promise<void> {
  await upsertTokens(db, [tokenRec(), tokenRec({ id: TOKEN_B, address: TOKEN_B, primaryPool_id: POOL_B })], T0);
  await upsertPools(db, [poolRec(), poolRec({ id: POOL_B, token_id: TOKEN_B })], T0);
}

const nightly = (queryBudget = 240) => runNightly(db, { now: T0 + 1000, queryBudget, deadlineMs: Date.now() + 60_000 });
const listed = () => db.query("select id, listed_pool_id from market.tokens order by id");

describe("runNightly", () => {
  it("recomputes every listed pool, probes nothing without a quoter, prunes, and ends with an empty phase", async () => {
    await seedTokensAndPools();
    // No quoter supplied: the probe phase is a no-op and the run still finishes (nightly.ts's own doc comment).
    expect(await nightly()).toEqual({ done: true, phase: "", listed: 2, probed: 0, routable: 0, unroutable: 0, skipped: 0, pruned: 0, prunedCandles: 0, queries: 0 });
    expect(await listed()).toEqual([{ id: TOKEN_A, listed_pool_id: POOL_A }, { id: TOKEN_B, listed_pool_id: POOL_B }]);
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "" });
  });

  it('a stored phase of "tokens" or "pools" from before Task 6 resumes at "listed" instead of crashing', async () => {
    await seedTokensAndPools();
    await saveCursors(db, "nightly", { phase: "pools", cursorText: POOL_A });
    expect(await nightly()).toMatchObject({ done: true, phase: "", listed: 2 });
    await seedTokensAndPools();
    await saveCursors(db, "nightly", { phase: "tokens", cursorText: "" });
    expect(await nightly()).toMatchObject({ done: true, phase: "", listed: 2 });
  });

  it('resumes a stored "probe" phase after its cursor, skipping "listed" again', async () => {
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    await seedTokensAndPools();
    await db.query("update market.tokens set listed_pool_id = null"); // proves "listed" really did not re-run below
    await saveCursors(db, "nightly", { phase: "probe", cursorText: POOL_A });
    const quoter: Quoter = { exactIn: async () => 1n, exactOut: async () => { throw new Error("unused by probePools"); } };
    const result = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });
    expect(result).toMatchObject({ done: true, phase: "", listed: 0, probed: 1, routable: 1 }); // only POOL_B, strictly after POOL_A
    expect(await listed()).toEqual([{ id: TOKEN_A, listed_pool_id: null }, { id: TOKEN_B, listed_pool_id: null }]);
  });

  it("stops at the deadline with done false, and the next call resumes the stored phase", async () => {
    await seedTokensAndPools();
    const quoter: Quoter = { exactIn: async () => 1n, exactOut: async () => { throw new Error("unused by probePools"); } };
    // Already past: probePools's own deadline check stops it before it probes anything. "listed" still ran
    // (it has no deadline check of its own — one statement over the whole table).
    const result = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() - 1, quoter });
    expect(result).toMatchObject({ done: false, phase: "probe", listed: 2, probed: 0 });
    expect(await readState(db, "nightly")).toMatchObject({ phase: "probe" });
  });

  it('runs the probe phase when a quoter is supplied, writing routable and landing on phase "" with probed counted', async () => {
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    await seedTokensAndPools();
    const quoter: Quoter = { exactIn: async () => 1n, exactOut: async () => { throw new Error("unused by probePools"); } };
    const result = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });
    expect(result).toEqual({ done: true, phase: "", listed: 2, probed: 2, routable: 2, unroutable: 0, skipped: 0, pruned: 0, prunedCandles: 0, queries: 0 });
    expect(await db.query("select id, routable, probed_at from market.pools order by id")).toEqual([
      { id: POOL_A, routable: true, probed_at: T0 + 1000 },
      { id: POOL_B, routable: true, probed_at: T0 + 1000 },
    ]);
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "" });
  });

  it("counts every skipped candidate when the quoter cannot answer, and still finishes the phase (I2b, I4)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    await seedTokensAndPools();
    const quoter: Quoter = {
      exactIn: async () => { throw new QuoterUnavailableError(new Error("down")); },
      exactOut: async () => { throw new Error("unused by probePools"); },
    };
    const result = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });
    expect(result).toEqual({ done: true, phase: "", listed: 2, probed: 2, routable: 0, unroutable: 0, skipped: 2, pruned: 0, prunedCandles: 0, queries: 0 });
    // The partial-outage band is observable in the log too (I4): counts only, no address, no URL.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/2 of 2 candidates skipped/);
    expect(String(warn.mock.calls[0]?.[0])).not.toMatch(/0x[0-9a-f]{40}|https?:/i);
    warn.mockRestore();
    expect(await db.query("select routable, probed_at from market.pools order by id")).toEqual([
      { routable: null, probed_at: null },
      { routable: null, probed_at: null },
    ]);
    // runNightly's own job — finishing the phase and persisting the cursor — is unaffected by every candidate
    // being skipped; it is run.ts's finishRun that must separately turn this into a recorded error (run.test.ts).
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "" });
  });

  it("persists the probe cursor through saveCursors as it walks, not only once at the end (I3 wiring)", async () => {
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    await seedTokensAndPools();
    const quoter: Quoter = { exactIn: async () => 1n, exactOut: async () => { throw new Error("unused by probePools"); } };
    const spy = vi.spyOn(db, "query");
    await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });
    const probeCursorCalls = spy.mock.calls
      .map(([, params]) => params)
      .filter((params): params is unknown[] => Array.isArray(params) && params[0] === "nightly" && params.includes("probe"));
    // The first is the "listed" -> "probe" phase transition (cursorText: ""); POOL_A and POOL_B then land in the
    // same (only) page and the same PROBE_CONCURRENCY batch, so onPage fires once more — wired to
    // saveCursors(db, "nightly", { phase: "probe", cursorText: lastId }) exactly as nightly.ts promises — with
    // the real last id, proving the callback nightly.ts hands to probePools actually ran (I3).
    expect(probeCursorCalls).toEqual([
      ["nightly", "", "probe"],
      ["nightly", POOL_B, "probe"],
    ]);
  });

  it("prunes swaps and candles past their retention windows after the probe phase, reporting both counts", async () => {
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    await seedTokensAndPools();
    const cutoff = retentionCutoff(T0 + 1000);
    const candleStale = candleCutoff("m1", T0 + 1000);
    await insertSwaps(db, [
      swapRec({ txHash: txHash(0xe1), timestamp: cutoff - 10 }),
      swapRec({ txHash: txHash(0xe2), timestamp: cutoff + 10 }),
    ]);
    await upsertCandles(db, [
      candleRec({ interval: "m1", t: candleStale - 10 }),
      candleRec({ interval: "m1", t: candleStale + 10 }),
    ]);
    const quoter: Quoter = { exactIn: async () => 1n, exactOut: async () => { throw new Error("unused by probePools"); } };
    const result = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });
    expect(result).toEqual({ done: true, phase: "", listed: 2, probed: 2, routable: 2, unroutable: 0, skipped: 0, pruned: 1, prunedCandles: 1, queries: 0 });
    expect(await db.query("select tx_hash from market.swaps")).toEqual([{ tx_hash: txHash(0xe2) }]);
    expect(await db.query("select t from market.candles")).toEqual([{ t: candleStale + 10 }]);
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "" });
  });

  it("still prunes when no quoter is supplied, even though the probe phase is then a no-op", async () => {
    await seedTokensAndPools();
    const cutoff = retentionCutoff(T0 + 1000);
    await insertSwaps(db, [swapRec({ txHash: txHash(0xe3), timestamp: cutoff - 10 })]);
    expect(await nightly()).toEqual({ done: true, phase: "", listed: 2, probed: 0, routable: 0, unroutable: 0, skipped: 0, pruned: 1, prunedCandles: 0, queries: 0 });
    expect(await db.query("select tx_hash from market.swaps")).toEqual([]);
  });

  it("reports the phase not done when the swap prune runs out of time, leaving the candle prune with none either", async () => {
    await seedTokensAndPools();
    const cutoff = retentionCutoff(T0 + 1000);
    const candleStale = candleCutoff("m1", T0 + 1000);
    await insertSwaps(db, [swapRec({ txHash: txHash(0xe4), timestamp: cutoff - 10 })]);
    await upsertCandles(db, [candleRec({ interval: "m1", t: candleStale - 10 })]);
    // Already past by the time the prune phase is reached: pruneSwaps's own first deadline check bails
    // immediately (deleted 0, done false), and pruneCandles — called right after, sharing the same deadline —
    // bails the same way on its own first check. Neither row is touched; the phase itself must not read done.
    const result = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() - 1 });
    expect(result).toMatchObject({ done: false, phase: "prune", pruned: 0, prunedCandles: 0 });
    expect(await db.query("select tx_hash from market.swaps")).toEqual([{ tx_hash: txHash(0xe4) }]);
    expect(await db.query("select t from market.candles")).toEqual([{ t: candleStale - 10 }]);
    expect(await readState(db, "nightly")).toMatchObject({ phase: "prune" });
  });
});
