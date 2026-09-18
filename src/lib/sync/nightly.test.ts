import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { QuoterUnavailableError, type Quoter } from "@/lib/quote/quoter";
import { testDb } from "@/test/db";
import { FakeSource } from "./fakeSource";
import { runNightly } from "./nightly";
import { retentionCutoff } from "./retention";
import { readState, saveCursors } from "./state";
import { POOL_A, POOL_B, T0, TOKEN_A, TOKEN_B, poolRec, priceRec, quoteRec, swapRec, tokenRec, txHash } from "./testRows";
import { insertSwaps, upsertQuotes } from "./writers";

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
beforeEach(() => db.exec("delete from market.tokens; delete from market.pools; delete from market.quotes; delete from market.sync_state; delete from market.swaps"));
afterEach(() => vi.restoreAllMocks());

const source = () => new FakeSource({
  tokens: [tokenRec(), tokenRec({ id: TOKEN_B, address: TOKEN_B, primaryPool_id: POOL_B })],
  pools: [poolRec(), poolRec({ id: POOL_B, token_id: TOKEN_B })],
});
const nightly = (src: FakeSource, queryBudget = 240) => runNightly(db, src, { now: T0 + 1000, queryBudget, deadlineMs: Date.now() + 60_000 });
const listed = () => db.query("select id, listed_pool_id from market.tokens order by id");

describe("runNightly", () => {
  it("walks tokens, then pools, recomputes every listed pool and ends with an empty phase", async () => {
    const src = source();
    // No quoter supplied: the probe phase is a no-op and the run still finishes (nightly.ts's own doc comment).
    expect(await nightly(src)).toEqual({ done: true, phase: "", tokens: 2, pools: 2, listed: 2, probed: 0, routable: 0, unroutable: 0, skipped: 0, pruned: 0, queries: 2 });
    expect(src.calls).toEqual(["tokensPage", "poolsPage"]);
    expect(await listed()).toEqual([{ id: TOKEN_A, listed_pool_id: POOL_A }, { id: TOKEN_B, listed_pool_id: POOL_B }]);
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "" });
  });
  it("stops at the budget with done false and the next call continues from the stored phase", async () => {
    const src = source();
    expect(await nightly(src, 1)).toEqual({ done: false, phase: "pools", tokens: 2, pools: 0, listed: 0, probed: 0, routable: 0, unroutable: 0, skipped: 0, pruned: 0, queries: 1 });
    expect(await readState(db, "nightly")).toMatchObject({ phase: "pools", cursorText: "" });
    expect(await nightly(src, 1)).toEqual({ done: true, phase: "", tokens: 0, pools: 2, listed: 2, probed: 0, routable: 0, unroutable: 0, skipped: 0, pruned: 0, queries: 1 });
  });
  it("resumes a phase after the stored cursor id", async () => {
    await saveCursors(db, "nightly", { phase: "pools", cursorText: POOL_A });
    const src = source();
    expect(await nightly(src)).toMatchObject({ done: true, tokens: 0, pools: 1 });
    expect(src.calls).toEqual(["poolsPage"]);
    expect(await db.query("select id from market.pools")).toEqual([{ id: POOL_B }]);
  });
  it("runs the probe phase when a quoter is supplied, writing routable and landing on phase \"\" with probed counted", async () => {
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    const src = source();
    const quoter: Quoter = { exactIn: async () => 1n, exactOut: async () => { throw new Error("unused by probePools"); } };
    const result = await runNightly(db, src, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });
    // The probe phase makes no Envio request, so queries is unchanged from the no-quoter run above.
    expect(result).toEqual({ done: true, phase: "", tokens: 2, pools: 2, listed: 2, probed: 2, routable: 2, unroutable: 0, skipped: 0, pruned: 0, queries: 2 });
    expect(await db.query("select id, routable, probed_at from market.pools order by id")).toEqual([
      { id: POOL_A, routable: true, probed_at: T0 + 1000 },
      { id: POOL_B, routable: true, probed_at: T0 + 1000 },
    ]);
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "" });
  });
  it("counts every skipped candidate when the quoter cannot answer, and still finishes the phase (I2b, I4)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    const src = source();
    const quoter: Quoter = {
      exactIn: async () => { throw new QuoterUnavailableError(new Error("down")); },
      exactOut: async () => { throw new Error("unused by probePools"); },
    };
    const result = await runNightly(db, src, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });
    expect(result).toEqual({ done: true, phase: "", tokens: 2, pools: 2, listed: 2, probed: 2, routable: 0, unroutable: 0, skipped: 2, pruned: 0, queries: 2 });
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
    const src = source();
    const quoter: Quoter = { exactIn: async () => 1n, exactOut: async () => { throw new Error("unused by probePools"); } };
    const spy = vi.spyOn(db, "query");
    await runNightly(db, src, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });
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
  it("prunes swaps older than the retention window after the probe phase, reporting pruned", async () => {
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    const src = source();
    const cutoff = retentionCutoff(T0 + 1000);
    await insertSwaps(db, [
      swapRec({ txHash: txHash(0xe1), timestamp: cutoff - 10 }),
      swapRec({ txHash: txHash(0xe2), timestamp: cutoff + 10 }),
    ]);
    const quoter: Quoter = { exactIn: async () => 1n, exactOut: async () => { throw new Error("unused by probePools"); } };
    const result = await runNightly(db, src, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });
    expect(result).toEqual({ done: true, phase: "", tokens: 2, pools: 2, listed: 2, probed: 2, routable: 2, unroutable: 0, skipped: 0, pruned: 1, queries: 2 });
    expect(await db.query("select tx_hash from market.swaps")).toEqual([{ tx_hash: txHash(0xe2) }]);
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "" });
  });
  it("still prunes when no quoter is supplied, even though the probe phase is then a no-op", async () => {
    const src = source();
    const cutoff = retentionCutoff(T0 + 1000);
    await insertSwaps(db, [swapRec({ txHash: txHash(0xe3), timestamp: cutoff - 10 })]);
    expect(await nightly(src)).toEqual({ done: true, phase: "", tokens: 2, pools: 2, listed: 2, probed: 0, routable: 0, unroutable: 0, skipped: 0, pruned: 1, queries: 2 });
    expect(await db.query("select tx_hash from market.swaps")).toEqual([]);
  });
});
