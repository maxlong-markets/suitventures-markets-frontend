import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { FakeSource, type FakeData } from "./fakeSource";
import { bucketStart, openBucketIds } from "./ids";
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
const cycle = (source: FakeSource, over: Partial<CycleOpts> = {}) =>
  runMarketCycle(db, source, { now: NOW, queryBudget: 150, deadlineMs: Date.now() + 60_000, ...over });

/** One traded pool (A, last swap T0+500) with two swaps and two candles, and one pool (B) created at T0+700 that never traded. */
const base = (): FakeData => ({
  quotes: [quoteRec()],
  prices: [priceRec()],
  tokens: [tokenRec(), tokenRec({ id: TOKEN_B, address: TOKEN_B, primaryPool_id: POOL_B })],
  pools: [poolRec(), poolRec({ id: POOL_B, token_id: TOKEN_B, lastSwapAt: null, swapCount: 0, createdAt: T0 + 700 })],
  swaps: [swapRec(), swapRec({ txHash: txHash(2), timestamp: T0 + 450 })],
  candles: [candleRec(), candleRec({ interval: "h1" })],
});
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
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 500, cursor2: T0 + 700 });
  });

  it("re-processes the overlap without writing anything new, and never moves a cursor backwards", async () => {
    const src = new FakeSource(base());
    await cycle(src);
    expect(await cycle(src)).toEqual({ ...full, swaps: 0 });
    expect([await count("pools"), await count("swaps"), await count("candles"), await count("tokens")]).toEqual([2, 2, 2, 2]);
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 500, cursor2: T0 + 700 });
  });

  it("stops before the request that would exceed the budget and leaves the cursor at the last completed page", async () => {
    const src = new FakeSource(base());
    // quotes and one pool page fit; the page's swaps do not, so nothing of that page is committed to the cursor.
    expect(await cycle(src, { queryBudget: 2 })).toEqual({ ...nothing, queries: 2 });
    expect(src.calls).toEqual(["quotes", "poolsSince"]);
    expect(await readState(db, "market")).toMatchObject({ cursor: 0, cursor2: 0 });
  });

  it("keeps the cursor of a completed page when the next page runs out of budget", async () => {
    // 1001 pools of one token: page one is 1000 pools = 20 pool batches × 2 requests + quotes + page + tokens = 43 requests.
    const pools = Array.from({ length: 1001 }, (_, i) => poolRec({ id: poolId(0x100 + i), lastSwapAt: T0 + i }));
    const src = new FakeSource({ ...base(), pools, swaps: [], candles: [] });
    const r = await cycle(src, { queryBudget: 44 });
    expect(r).toMatchObject({ pages: 1, pools: 1000, queries: 44, cursor: T0 + 999, exhausted: true });
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 999 });
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
    const m1 = bucketStart(T0, "m1");
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

  it("throws on a source failure after persisting the pages completed before it", async () => {
    const src = new FakeSource(base());
    src.failOn = { method: "poolsCreatedSince", error: new Error("indexer responded 503") };
    await expect(cycle(src)).rejects.toThrow("indexer responded 503");
    expect(await readState(db, "market")).toMatchObject({ cursor: T0 + 500, cursor2: 0 });
    expect(await count("swaps")).toBe(2);
  });
});
