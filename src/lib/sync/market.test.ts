import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { FakeSource, type FakeData } from "./fakeSource";
import { bucketStart, candleId, openBucketIds } from "./ids";
import { CANDLE_LOOKBACK_SEC, PAGE_LIMIT, runMarketCycle, type CycleOpts } from "./market";
import { readState, saveCursors } from "./state";
import { POOL_A, POOL_B, T0, TOKEN_A, TOKEN_B, candleRec, poolId, poolRec, priceRec, quoteRec, swapRec, tokenRec, txHash } from "./testRows";

const NOW = T0 + 1000;
let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
beforeEach(() => db.exec(
  "delete from market.quotes; delete from market.tokens; delete from market.pools; delete from market.swaps; delete from market.candles; delete from market.sync_state",
));

const count = async (table: string) => Number((await db.query<{ n: unknown }>(`select count(*) as n from market.${table}`))[0].n);
const counts = async () => [await count("pools"), await count("swaps"), await count("candles"), await count("tokens")];
const cycle = (source: FakeSource, over: Partial<CycleOpts> = {}) =>
  runMarketCycle(db, source, { now: NOW, queryBudget: 150, deadlineMs: Date.now() + 60_000, ...over });
/** The resume record the last cycle left in sync_state.cursor_text, or "" when there is none. */
const resumeRecord = async (): Promise<unknown> => {
  const { cursorText } = await readState(db, "market");
  return cursorText === "" ? "" : JSON.parse(cursorText);
};

/** One traded pool (A, last swap T0+500) with two swaps and two candles, and one pool (B) created at T0+700 that never traded. */
const base = (): FakeData => ({
  quotes: [quoteRec()],
  prices: [priceRec()],
  tokens: [tokenRec(), tokenRec({ id: TOKEN_B, address: TOKEN_B, primaryPool_id: POOL_B })],
  pools: [poolRec(), poolRec({ id: POOL_B, token_id: TOKEN_B, lastSwapAt: null, swapCount: 0, createdAt: T0 + 700 })],
  swaps: [swapRec(), swapRec({ txHash: txHash(2), timestamp: T0 + 450 })],
  candles: [candleRec(), candleRec({ interval: "h1" })],
});
/** `n` pools of token A with lastSwapAt T0 + i and nothing under them: a batch of 50 costs three requests (swaps, candles, tokens). */
const tradedPools = (n: number): FakeData =>
  ({ ...base(), pools: Array.from({ length: n }, (_, i) => poolRec({ id: poolId(0x100 + i), lastSwapAt: T0 + i })), swaps: [], candles: [] });
/** Pool A with 2001 swaps at T0 − 1000 + i, all inside [0, NOW]: three swap pages. */
const manySwaps = (): FakeData =>
  ({ ...base(), swaps: Array.from({ length: 2 * PAGE_LIMIT + 1 }, (_, i) => swapRec({ txHash: txHash(i + 1), timestamp: T0 - 1000 + i })) });
const m1 = bucketStart(T0, "m1");
/** Pool A with 1001 m1 candles from the bucket of T0 on: two candle pages. */
const manyCandles = (): FakeData => ({ ...base(), candles: Array.from({ length: PAGE_LIMIT + 1 }, (_, i) => candleRec({ t: m1 + 60 * i })) });

const full = { pages: 2, pools: 1, swaps: 2, candles: 2, tokens: 2, newPools: 1, queries: 7, cursor: T0 + 500, cursor2: T0 + 700, exhausted: false };
const nothing = { pages: 0, pools: 0, swaps: 0, candles: 0, tokens: 0, newPools: 0, queries: 0, cursor: 0, cursor2: 0, exhausted: true };

describe("runMarketCycle", () => {
  it("writes quotes, pools, swaps, candles, tokens and listed pools, and leaves both cursors at the maxima seen", async () => {
    const src = new FakeSource(base());
    expect(await cycle(src)).toEqual(full);
    expect(src.calls).toEqual(["quotes", "poolsSince", "swapsFor", "candlesFor", "tokensById", "poolsCreatedSince", "tokensById"]);
    expect(await db.query("select usd_price from market.quotes")).toEqual([{ usd_price: 182.5 }]);
    expect(await db.query("select id, listed_pool_id from market.tokens order by id")).toEqual([
      { id: TOKEN_A, listed_pool_id: POOL_A },
      { id: TOKEN_B, listed_pool_id: null },
    ]);
    expect([await count("pools"), await count("swaps"), await count("candles")]).toEqual([2, 2, 2]);
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 500, cursor2: T0 + 700, cursorText: "" });
  });

  it("re-processes the overlap without writing anything new, and never moves a cursor backwards", async () => {
    const src = new FakeSource(base());
    await cycle(src);
    expect(await cycle(src)).toEqual({ ...full, swaps: 0 });
    expect(await counts()).toEqual([2, 2, 2, 2]);
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 500, cursor2: T0 + 700 });
  });

  it("stops before the request that would exceed the budget; a batch that never started leaves no record", async () => {
    const src = new FakeSource(base());
    // quotes and one pool page fit; the page's first batch cannot issue its swap request, so nothing of it is committed.
    expect(await cycle(src, { queryBudget: 2 })).toEqual({ ...nothing, queries: 2 });
    expect(src.calls).toEqual(["quotes", "poolsSince"]);
    expect(await readState(db, "market")).toMatchObject({ cursor: 0, cursor2: 0, cursorText: "" });
  });

  it("advances the cursor after every 50-pool batch: 120 pools with a budget of 8 (quotes, page, two batches × 3) end at batch 2's maximum", async () => {
    const src = new FakeSource(tradedPools(120));
    expect(await cycle(src, { queryBudget: 8 })).toEqual({ ...nothing, pools: 100, tokens: 2, queries: 8, cursor: T0 + 99 });
    expect(src.calls).toEqual(["quotes", "poolsSince", "swapsFor", "candlesFor", "tokensById", "swapsFor", "candlesFor", "tokensById"]);
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 99, cursorText: "" });
    // The next cycle starts 120 s before that cursor, sees the page whole again and completes it.
    expect(await cycle(src)).toMatchObject({ pages: 1, pools: 120, cursor: T0 + 119, exhausted: false });
  });

  it("keeps the cursor of a completed page when the next page runs out of budget: 1000 pools = 20 batches × 3 + quotes + page = 62 requests; budget 63 admits only the next page request", async () => {
    const src = new FakeSource(tradedPools(1001));
    expect(await cycle(src, { queryBudget: 63 })).toMatchObject({ pages: 1, pools: 1000, queries: 63, cursor: T0 + 999, exhausted: true });
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 999, cursorText: "" });
  });

  it("returns at once past the deadline", async () => {
    const src = new FakeSource(base());
    expect(await cycle(src, { deadlineMs: Date.now() - 1 })).toEqual(nothing);
    expect(src.calls).toEqual([]);
  });

  it("asks for candles from since minus the lookback with the batch's open h1 and d1 bucket ids", async () => {
    await saveCursors(db, "market", { cursor: T0 + 400 });
    const src = new FakeSource(base());
    const spy = vi.spyOn(src, "candlesFor");
    await cycle(src);
    const since = T0 + 400 - 120;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith([POOL_A], since - CANDLE_LOOKBACK_SEC, openBucketIds([POOL_A], since, NOW), null, PAGE_LIMIT);
  });

  it("keyset-continues swaps and candles while pages come back full", async () => {
    const src = new FakeSource({
      ...base(),
      swaps: Array.from({ length: PAGE_LIMIT + 1 }, (_, i) => swapRec({ txHash: txHash(i + 1), timestamp: T0 + i })),
      candles: Array.from({ length: PAGE_LIMIT + 1 }, (_, i) => candleRec({ t: m1 + 60 * i })),
    });
    expect(await cycle(src)).toMatchObject({ swaps: PAGE_LIMIT + 1, candles: PAGE_LIMIT + 1, exhausted: false });
    expect(src.calls.filter((c) => c === "swapsFor")).toHaveLength(2);
    expect(src.calls.filter((c) => c === "candlesFor")).toHaveLength(2);
    expect([await count("swaps"), await count("candles")]).toEqual([PAGE_LIMIT + 1, PAGE_LIMIT + 1]);
  });

  it("throws on a source failure after persisting the batches completed before it", async () => {
    const src = new FakeSource(base());
    src.failOn = { method: "poolsCreatedSince", error: new Error("indexer responded 503") };
    await expect(cycle(src)).rejects.toThrow("indexer responded 503");
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 500, cursor2: 0 });
    expect(await count("swaps")).toBe(2);
  });

  it("resumes mid-swaps: a budget of 3 (quotes, page, one of three swap pages) saves the swap keyset, and the next cycle continues strictly after it", async () => {
    const src = new FakeSource(manySwaps());
    expect(await cycle(src, { queryBudget: 3 })).toEqual({ ...nothing, swaps: 1000, queries: 3 });
    const saved = { timestamp: T0 - 1, id: `${txHash(1000)}-0` };
    expect(await resumeRecord()).toEqual({ since: 0, poolIds: [POOL_A], swaps: saved, candles: null });
    expect(await readState(db, "market")).toMatchObject({ cursor: 0 });
    expect(await count("swaps")).toBe(1000);

    const spy = vi.spyOn(src, "swapsFor");
    expect(await cycle(src)).toMatchObject({ swaps: 1001, cursor: T0 + 500, cursor2: T0 + 700, exhausted: false });
    // Two pages finish the batch after the saved cursor; the third call is the same pool back in normal paging, from the new since.
    expect(spy.mock.calls).toEqual([
      [[POOL_A], 0, saved, PAGE_LIMIT],
      [[POOL_A], 0, { timestamp: T0 + 999, id: `${txHash(2000)}-0` }, PAGE_LIMIT],
      [[POOL_A], T0 + 500 - 120, null, PAGE_LIMIT],
    ]);
    expect(src.calls.slice(3)).toEqual([
      "quotes", "swapsFor", "swapsFor", "candlesFor", "tokensById",
      "poolsSince", "swapsFor", "candlesFor", "tokensById", "poolsCreatedSince", "tokensById",
    ]);
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 500, cursorText: "" });
  });

  it("resumes with swaps done and candles pending: a budget of 4 with 1001 candles saves the candle keyset, and the next cycle pages candles from it with no swap request for the batch", async () => {
    const src = new FakeSource(manyCandles());
    expect(await cycle(src, { queryBudget: 4 })).toEqual({ ...nothing, swaps: 2, candles: 1000, queries: 4 });
    const t = m1 + 60 * 999;
    const saved = { t, id: candleId(POOL_A, "m1", t) };
    expect(await resumeRecord()).toEqual({ since: 0, poolIds: [POOL_A], swaps: "done", candles: saved });

    const spy = vi.spyOn(src, "candlesFor");
    expect(await cycle(src)).toMatchObject({ cursor: T0 + 500, exhausted: false });
    expect(spy.mock.calls[0]).toEqual([[POOL_A], -CANDLE_LOOKBACK_SEC, openBucketIds([POOL_A], 0, NOW), saved, PAGE_LIMIT]);
    expect(src.calls.slice(4, 8)).toEqual(["quotes", "candlesFor", "tokensById", "poolsSince"]);
    expect(await count("candles")).toBe(PAGE_LIMIT + 1);
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 500, cursorText: "" });
  });

  it("resumes before the tokens: a budget of 4 (quotes, page, swaps, candles) saves both keysets done, and the next cycle only refreshes the batch's tokens before paging on", async () => {
    const src = new FakeSource(base());
    expect(await cycle(src, { queryBudget: 4 })).toEqual({ ...nothing, swaps: 2, candles: 2, queries: 4 });
    expect(await resumeRecord()).toEqual({ since: 0, poolIds: [POOL_A], swaps: "done", candles: "done" });
    expect(await cycle(src)).toEqual({ ...full, swaps: 0, pools: 2, tokens: 3, queries: 8 });
    expect(src.calls.slice(4)).toEqual(["quotes", "tokensById", "poolsSince", "swapsFor", "candlesFor", "tokensById", "poolsCreatedSince", "tokensById"]);
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 500, cursorText: "" });
  });

  it("re-processing a drained batch in normal paging changes no row counts", async () => {
    const src = new FakeSource(manySwaps());
    await cycle(src, { queryBudget: 3 });
    await cycle(src);
    expect(await counts()).toEqual([2, 2 * PAGE_LIMIT + 1, 2, 2]);
    expect(await cycle(src)).toMatchObject({ swaps: 0, cursor: T0 + 500, exhausted: false });
    expect(await counts()).toEqual([2, 2 * PAGE_LIMIT + 1, 2, 2]);
  });

  it("throws on a cursor_text that is not a resume record, before any request or write", async () => {
    const corrupt = [
      "{",
      '{"since":0}',
      '{"since":0,"poolIds":[],"swaps":null,"candles":null}',
      `{"since":0,"poolIds":["${POOL_A}"],"swaps":{"t":1,"id":"x"},"candles":null}`,
    ];
    for (const text of corrupt) {
      await saveCursors(db, "market", { cursorText: text });
      const src = new FakeSource(base());
      await expect(cycle(src)).rejects.toThrow('sync_state.cursor_text of job "market" is not a resume record');
      expect(src.calls).toEqual([]);
    }
    expect(await count("quotes")).toBe(0);
    expect(await counts()).toEqual([0, 0, 0, 0]);
  });
});
