import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { FakeSource, type FakeData } from "./fakeSource";
import { bucketStart, candleId, openBucketIds } from "./ids";
import { CANDLE_LOOKBACK_SEC, PAGE_LIMIT, runMarketCycle, type CycleOpts } from "./market";
import { readState, saveCursors } from "./state";
import { POOL_A, POOL_B, T0, TOKEN_A, TOKEN_B, candleRec, poolId, poolRec, priceRec, quoteRec, swapRec, tokenRec, txHash } from "./testRows";
import { markSynced, upsertPools } from "./writers";

const NOW = T0 + 1000;
let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
beforeEach(() => db.exec(
  "delete from market.quotes; delete from market.tokens; delete from market.pools; delete from market.swaps; delete from market.candles; delete from market.sync_state",
));

const count = async (table: string) => Number((await db.query<{ n: unknown }>(`select count(*) as n from market.${table}`))[0].n);
const counts = async () => [await count("pools"), await count("swaps"), await count("candles"), await count("tokens")];
const syncedTo = async (id: string) => (await db.query<{ synced_to: number }>("select synced_to from market.pools where id = $1", [id]))[0].synced_to;
const cycle = (source: FakeSource, over: Partial<CycleOpts> = {}) =>
  runMarketCycle(db, source, { now: NOW, queryBudget: 150, deadlineMs: Date.now() + 60_000, ...over });
/** The resume record the last cycle left in sync_state.cursor_text, or "" when there is none. */
const resumeRecord = async (): Promise<unknown> => {
  const { cursorText } = await readState(db, "market");
  return cursorText === "" ? "" : JSON.parse(cursorText);
};
/** Pool A already stored with its history marked up to `watermark`, and the cursor at `cursor`: what a batch finds after earlier cycles. */
const storedPoolA = async (watermark: number, cursor: number) => {
  await upsertPools(db, [poolRec()], T0);
  await markSynced(db, [POOL_A], watermark);
  await saveCursors(db, "market", { cursor });
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
/** Pool A with 2001 swaps at T0 − 1000 + i, all inside [0, NOW]: three swap pages from 0. */
const manySwaps = (): FakeData =>
  ({ ...base(), swaps: Array.from({ length: 2 * PAGE_LIMIT + 1 }, (_, i) => swapRec({ txHash: txHash(i + 1), timestamp: T0 - 1000 + i })) });
const m1 = bucketStart(T0, "m1");
/** Pool A with 1001 m1 candles from the bucket of T0 on: two candle pages. */
const manyCandles = (): FakeData => ({ ...base(), candles: Array.from({ length: PAGE_LIMIT + 1 }, (_, i) => candleRec({ t: m1 + 60 * i })) });
const POOL_C = poolId(0x13);
/** base() plus pool C (token A) that traded at T0 + 950: a page that sets the cycle's head time while pool A, stored but never processed, sits behind the cursor. */
const withPoolC = (): FakeData => {
  const data = base();
  data.pools = [...(data.pools ?? []), poolRec({ id: POOL_C, lastSwapAt: T0 + 950 })];
  return data;
};

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

  it("re-processes the overlap without writing anything new, and never moves a cursor backwards, not even a cycle that read the cursors before another invocation raised them", async () => {
    const src = new FakeSource(base());
    await cycle(src);
    expect(await cycle(src)).toEqual({ ...full, swaps: 0 });
    expect(await counts()).toEqual([2, 2, 2, 2]);
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 500, cursor2: T0 + 700 });
    // The hung-request case: this cycle read cursor T0 + 500 and cursor2 T0 + 700; while its swap request is in
    // flight another invocation moves both to T0 + 900. Its own, older values are written last and must lose.
    const swapsFor = src.swapsFor.bind(src);
    vi.spyOn(src, "swapsFor").mockImplementationOnce(async (...args) => {
      await saveCursors(db, "market", { cursor: T0 + 900, cursor2: T0 + 900 });
      return swapsFor(...args);
    });
    expect(await cycle(src)).toMatchObject({ cursor: T0 + 500, cursor2: T0 + 700, exhausted: false });
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 900, cursor2: T0 + 900, cursorText: "" });
    expect(await counts()).toEqual([2, 2, 2, 2]);
  });

  it("stops before the request that would exceed the budget; a batch that never started leaves no record", async () => {
    const src = new FakeSource(base());
    // quotes and one pool page fit; the page's first batch cannot issue its swap request, so nothing of it is committed.
    expect(await cycle(src, { queryBudget: 2 })).toEqual({ ...nothing, queries: 2 });
    expect(src.calls).toEqual(["quotes", "poolsSince"]);
    expect(await readState(db, "market")).toMatchObject({ cursor: 0, cursor2: 0, cursorText: "" });
  });

  it("catches up honestly: 51 pools in two batches, budget 5 (quotes, page, batch one × 3) stops after batch one at its maximum; the next cycle still stores batch two's swaps older than that", async () => {
    const straggler = poolId(0x100 + 50); // alone in batch two; its swaps predate batch one's maximum lastSwapAt, T0 + 49
    const data = tradedPools(51);
    data.swaps = [T0 - 500, T0 + 20, T0 + 50].map((ts, i) => swapRec({ pool_id: straggler, txHash: txHash(i + 1), timestamp: ts }));
    const src = new FakeSource(data);
    expect(await cycle(src, { queryBudget: 5 })).toEqual({ ...nothing, pools: 50, tokens: 1, queries: 5, cursor: T0 + 49 });
    expect(src.calls).toEqual(["quotes", "poolsSince", "swapsFor", "candlesFor", "tokensById"]);
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 49, cursorText: "" });
    // Batch one is stored up to the page's head time (T0 + 50); the straggler is not stored at all yet.
    expect([await syncedTo(poolId(0x100)), await syncedTo(straggler)]).toEqual([T0 + 50, 0]);
    const spy = vi.spyOn(src, "swapsFor");
    expect(await cycle(src)).toMatchObject({ pages: 1, pools: 51, swaps: 3, cursor: T0 + 50, exhausted: false });
    expect(spy).toHaveBeenLastCalledWith([straggler], 0, null, PAGE_LIMIT);
    expect(await db.query("select ts from market.swaps order by ts")).toEqual([{ ts: T0 - 500 }, { ts: T0 + 20 }, { ts: T0 + 50 }]);
    expect(await syncedTo(straggler)).toBe(T0 + 50);
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

  it("asks for candles from the batch's since minus the lookback with its open h1 and d1 bucket ids", async () => {
    // Pool A's watermark T0 + 400 gives the batch since = T0 + 280, the same as the cursor's.
    await storedPoolA(T0 + 400, T0 + 400);
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
    // Two pages finish the batch after the saved cursor; the third call is the same pool back in normal paging, from its new watermark.
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

  it("fetches a batch's swaps from its oldest watermark minus the overlap, not from the cursor, and stamps the cycle's head time on it", async () => {
    await storedPoolA(T0 + 100, T0 + 400);
    const src = new FakeSource(base());
    const spy = vi.spyOn(src, "swapsFor");
    expect(await cycle(src)).toEqual(full);
    expect(spy).toHaveBeenCalledWith([POOL_A], T0 + 100 - 120, null, PAGE_LIMIT);
    // The head time is the largest lastSwapAt the pool pages showed, T0 + 500, below now; a new pool without activity is not stamped.
    expect([await syncedTo(POOL_A), await syncedTo(POOL_B)]).toEqual([T0 + 500, 0]);
  });

  it("never lowers synced_to: a later cycle whose head time is smaller (pool A's last swap now reported at T0 + 450) leaves the higher watermark", async () => {
    await cycle(new FakeSource(base()));
    expect(await syncedTo(POOL_A)).toBe(T0 + 500);
    expect(await cycle(new FakeSource({ ...base(), pools: [poolRec({ lastSwapAt: T0 + 450 })] }))).toMatchObject({ pools: 1, exhausted: false });
    expect(await syncedTo(POOL_A)).toBe(T0 + 500);
    expect(await db.query("select last_swap_at from market.pools where id = $1", [POOL_A])).toEqual([{ last_swap_at: T0 + 450 }]);
  });

  it("repairs a pool the cursor passed (synced_to 0 < last_swap_at T0 + 500 < cursor − 120): one repair batch after the pages, 10 requests in all", async () => {
    await storedPoolA(0, T0 + 900);
    const src = new FakeSource(withPoolC());
    const spy = vi.spyOn(src, "swapsFor");
    expect(await cycle(src)).toEqual({ pages: 2, pools: 2, swaps: 2, candles: 2, tokens: 3, newPools: 1, queries: 10, cursor: T0 + 950, cursor2: T0 + 700, exhausted: false });
    expect(src.calls).toEqual([
      "quotes", "poolsSince", "swapsFor", "candlesFor", "tokensById", "poolsCreatedSince", "tokensById",
      "swapsFor", "candlesFor", "tokensById",
    ]);
    expect(spy).toHaveBeenLastCalledWith([POOL_A], 0, null, PAGE_LIMIT);
    expect(await count("swaps")).toBe(2);
    expect([await syncedTo(POOL_A), await syncedTo(POOL_C)]).toEqual([T0 + 950, T0 + 950]);
  });

  it("skips the repair step when the budget is exhausted before it (7 requests for quotes, the page, its batch and the new pools), and repairs on the next cycle", async () => {
    await storedPoolA(0, T0 + 900);
    const src = new FakeSource(withPoolC());
    expect(await cycle(src, { queryBudget: 7 })).toMatchObject({ pools: 1, swaps: 0, queries: 7, exhausted: true });
    expect(src.calls).toHaveLength(7);
    expect([await count("swaps"), await syncedTo(POOL_A)]).toEqual([0, 0]);
    expect(await cycle(src)).toMatchObject({ swaps: 2, exhausted: false });
    expect(await syncedTo(POOL_A)).toBe(T0 + 950);
  });

  it("a resumed batch keeps the since it was started with (its watermark minus the overlap), even when the watermark moved meanwhile", async () => {
    await storedPoolA(T0 + 100, T0 + 400);
    // Swaps at T0 − 1000 + i: from T0 − 20 on that is i >= 980, 1021 swaps, two pages.
    const src = new FakeSource(manySwaps());
    expect(await cycle(src, { queryBudget: 3 })).toEqual({ ...nothing, swaps: 1000, queries: 3, cursor: T0 + 400 });
    const saved = { timestamp: T0 + 979, id: `${txHash(1980)}-0` };
    expect(await resumeRecord()).toEqual({ since: T0 - 20, poolIds: [POOL_A], swaps: saved, candles: null });
    await markSynced(db, [POOL_A], T0 + 900);
    const spy = vi.spyOn(src, "swapsFor");
    expect(await cycle(src)).toMatchObject({ swaps: 21, cursor: T0 + 500, exhausted: false });
    expect(spy.mock.calls[0]).toEqual([[POOL_A], T0 - 20, saved, PAGE_LIMIT]);
    expect(await count("swaps")).toBe(1021);
  });
});
