import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { bucketStart } from "@/lib/sync/ids";
import { testDb } from "@/test/db";
import { applyFold, loadFoldState, readChainCursor } from "./store";
import type { CandleInterval, CandleState, FoldResult, PoolState, SwapEvent, TokenState, TradeRow } from "./types";

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(() =>
  db.exec(
    "delete from market.quotes; delete from market.tokens; delete from market.pools; delete from market.swaps; delete from market.candles; delete from market.sync_state",
  ),
);

const count = async (table: string) => Number((await db.query<{ n: unknown }>(`select count(*) as n from market.${table}`))[0].n);

// Rows in the shape the fold produces. Ids are lowercase like the indexer's, following src/lib/sync/testRows.ts's conventions.
const hex = (n: number, digits: number) => "0x" + n.toString(16).padStart(digits, "0");
const addr = (n: number) => hex(n, 40);
const poolId = (n: number) => hex(n, 64);
const txHash = (n: number) => hex(n, 64);

const T0 = 1_789_000_000;
const QUOTE = addr(0xa1);
const TOKEN_A = addr(0xb1);
const TOKEN_B = addr(0xb2);
const POOL_A = poolId(0x11);
const POOL_B = poolId(0x12);
const WALLET = addr(0xc1);

function pool(o: Partial<PoolState> = {}): PoolState {
  return {
    id: POOL_A, tokenId: TOKEN_A, quoteId: QUOTE, tokenIsCurrency0: true, hooks: addr(0), fee: 3000, tickSpacing: 60,
    origin: "LONG", createdAt: T0, priceQuote: 0.000866, sqrtPriceX96: 123456789012345678901234567890n,
    tvlToken: 1_000_000_000_000_000_000_000n, tvlQuote: 500_000_000_000_000_000n, swapCount: 3, lastSwapAt: T0 + 500,
    volumeQuoteAllTime: 12.5, baselineAt: 0, ...o,
  };
}
function token(o: Partial<TokenState> = {}): TokenState {
  return {
    id: TOKEN_A, address: TOKEN_A, symbol: "AI", name: "Artificial Inu", decimals: 18, poolCount: 1, origin: "LONG",
    primaryPoolId: POOL_A, createdAt: T0, metadataLoaded: true, ...o,
  };
}
function candle(o: Partial<CandleState> = {}): CandleState {
  const interval = o.interval ?? "m1";
  return {
    poolId: POOL_A, interval, t: bucketStart(T0 + 500, interval), open: 0.0008, high: 0.0009, low: 0.0007,
    close: 0.000866, volumeQuote: 1.2, volumeToken: 1500, trades: 2, ...o,
  };
}
function trade(o: Partial<TradeRow> = {}): TradeRow {
  const tx = o.txHash ?? txHash(1);
  const logIndex = o.logIndex ?? 0;
  return {
    id: `${tx}-${logIndex}`, poolId: POOL_A, tokenId: TOKEN_A, timestamp: T0 + 500, side: "buy", amountToken: 1000,
    amountQuote: 0.866, priceQuote: 0.000866, wallet: WALLET, txHash: tx, logIndex, ...o,
  };
}
function swapEvent(o: Partial<SwapEvent> = {}): SwapEvent {
  return {
    kind: "swap", block: 100, logIndex: 0, timestamp: T0 + 500, txHash: txHash(1), txFrom: WALLET,
    poolId: POOL_A, amount0: -1000n, amount1: 866n, sqrtPriceX96: 123n, liquidity: 1n, tick: 0, fee: 3000, ...o,
  };
}
function result(o: Partial<FoldResult> = {}): FoldResult {
  return { pools: [pool()], tokens: [token()], candles: [candle()], trades: [trade()], newTokens: [], ignoredPools: 0, ...o };
}
async function insertQuote(o: { id?: string; usdPrice?: number | null } = {}) {
  const id = o.id ?? QUOTE;
  await db.query(
    `insert into market.quotes (id, address, symbol, name, decimals, enabled, usd_price, usd_updated_at, aggregator)
     values ($1, $1, 'NVDA', 'NVIDIA', 18, true, $2, $3, $4)`,
    [id, o.usdPrice === undefined ? 182.5 : o.usdPrice, T0, addr(0xfeed)],
  );
}

/** Wraps a real Db, counting only `.query` calls (what loadFoldState issues); exact copy of everything else. */
function countingDb(inner: Db): { db: Db; total: () => number; matching: (needle: string) => number } {
  const calls: string[] = [];
  const db: Db = {
    query: async (text, params) => {
      calls.push(text);
      return inner.query(text, params);
    },
    exec: (text) => inner.exec(text),
    copy: (table, columns, rows) => inner.copy(table, columns, rows),
    tx: (fn) => inner.tx(fn),
    end: () => inner.end(),
  };
  return { db, total: () => calls.length, matching: (needle) => calls.filter((c) => c.includes(needle)).length };
}

describe("readChainCursor", () => {
  it("is 0 when the chain job has never run", async () => {
    expect(await readChainCursor(db)).toBe(0);
  });
});

describe("loadFoldState", () => {
  it("loads the pools events name, their tokens, every quote, and leaves untouched maps empty", async () => {
    await applyFold(db, result(), 100, T0);
    await insertQuote();
    const state = await loadFoldState(db, [swapEvent()]);
    expect(state.pools.get(POOL_A)).toEqual(pool());
    expect(state.tokens.get(TOKEN_A)).toEqual(token());
    expect(state.quotes.get(QUOTE)).toEqual({ id: QUOTE, decimals: 18, usdPrice: 182.5 });
    expect(state.poolsByToken.get(TOKEN_A)).toEqual([POOL_A]);
    expect(state.candles.get(`${POOL_A}-m1-${bucketStart(T0 + 500, "m1")}`)).toEqual(candle());
  });

  it("returns empty maps for an empty event batch, but still loads every quote", async () => {
    await insertQuote();
    const state = await loadFoldState(db, []);
    expect(state.pools.size).toBe(0);
    expect(state.tokens.size).toBe(0);
    expect(state.poolsByToken.size).toBe(0);
    expect(state.candles.size).toBe(0);
    expect(state.quotes.get(QUOTE)?.usdPrice).toBe(182.5);
  });

  it("loads sibling pools of a multi-pool token even when only one is named by an event", async () => {
    const poolC = poolId(0x13);
    await applyFold(
      db,
      result({
        pools: [pool({ id: POOL_B, tokenId: TOKEN_B }), pool({ id: poolC, tokenId: TOKEN_B })],
        tokens: [token({ id: TOKEN_B, address: TOKEN_B, poolCount: 2, primaryPoolId: POOL_B })],
        candles: [],
        trades: [],
      }),
      100,
      T0,
    );
    const state = await loadFoldState(db, [swapEvent({ poolId: poolC })]);
    expect(new Set(state.poolsByToken.get(TOKEN_B))).toEqual(new Set([POOL_B, poolC]));
    // The sibling POOL_B was never named by an event: proves it is loaded fully, not just listed by id.
    expect(state.pools.get(POOL_B)).toEqual(pool({ id: POOL_B, tokenId: TOKEN_B }));
    expect(state.pools.get(poolC)).toEqual(pool({ id: poolC, tokenId: TOKEN_B }));
  });

  it("fetches candle keys with one query regardless of how many pools or intervals are touched", async () => {
    const poolC = poolId(0x13);
    await applyFold(
      db,
      result({
        pools: [pool(), pool({ id: POOL_B, tokenId: TOKEN_B }), pool({ id: poolC, tokenId: TOKEN_B })],
        tokens: [token(), token({ id: TOKEN_B, address: TOKEN_B, poolCount: 2, primaryPoolId: POOL_B })],
        candles: [candle(), candle({ poolId: POOL_B, interval: "h1" }), candle({ poolId: poolC, interval: "d1" })],
        trades: [],
      }),
      100,
      T0,
    );
    const events = [POOL_A, POOL_B, poolC].flatMap((p, i) => [
      swapEvent({ poolId: p, logIndex: i * 2, txHash: txHash(10 + i) }),
      swapEvent({ poolId: p, logIndex: i * 2 + 1, timestamp: T0 + 1000, txHash: txHash(20 + i) }),
    ]);
    const wrapped = countingDb(db);
    const state = await loadFoldState(wrapped.db, events);
    // 3 pools x up to 5 intervals x 2 distinct timestamps = up to 30 keys, fetched in one join.
    expect(wrapped.matching("market.candles")).toBe(1);
    // Bounded, not proportional to event/key count: pool-id lookup, tokens, sibling pools, quotes, candles.
    expect(wrapped.total()).toBeLessThanOrEqual(5);
    expect(state.candles.get(`${POOL_A}-m1-${bucketStart(T0 + 500, "m1")}`)).toBeDefined();
    expect(state.candles.get(`${POOL_B}-h1-${bucketStart(T0 + 500, "h1")}`)).toBeDefined();
    expect(state.candles.get(`${poolC}-d1-${bucketStart(T0 + 500, "d1")}`)).toBeDefined();
  });
});

describe("applyFold", () => {
  it("round-trips through loadFoldState: create, then update in a second fold", async () => {
    await insertQuote();
    await applyFold(db, result(), 100, T0);
    expect(await readChainCursor(db)).toBe(100);

    let state = await loadFoldState(db, [swapEvent()]);
    expect(state.pools.get(POOL_A)?.swapCount).toBe(3);

    const updated = result({
      pools: [pool({ swapCount: 9, priceQuote: 0.0009, lastSwapAt: T0 + 900 })],
      tokens: [token({ poolCount: 2, symbol: "AI2" })],
      candles: [candle({ close: 0.0009, trades: 5 })],
      trades: [trade({ txHash: txHash(2), amountToken: 500 })],
    });
    await applyFold(db, updated, 150, T0 + 900);
    expect(await readChainCursor(db)).toBe(150);

    state = await loadFoldState(db, [swapEvent()]);
    expect(state.pools.get(POOL_A)).toEqual(pool({ swapCount: 9, priceQuote: 0.0009, lastSwapAt: T0 + 900 }));
    expect(state.tokens.get(TOKEN_A)).toEqual(token({ poolCount: 2, symbol: "AI2" }));
    expect(state.candles.get(`${POOL_A}-m1-${bucketStart(T0 + 500, "m1")}`)).toEqual(candle({ close: 0.0009, trades: 5 }));
    expect(await count("swaps")).toBe(2);
  });

  it("is idempotent: applying the same result twice changes nothing", async () => {
    const r = result();
    await applyFold(db, r, 100, T0);
    const snapshot = async () => ({
      pools: await db.query("select * from market.pools order by id"),
      tokens: await db.query("select * from market.tokens order by id"),
      swaps: await db.query("select * from market.swaps order by tx_hash, log_index"),
      candles: await db.query("select * from market.candles order by pool_id, interval, t"),
      cursor: await readChainCursor(db),
    });
    const before = await snapshot();
    await applyFold(db, r, 100, T0);
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(await count("pools")).toBe(1);
    expect(await count("tokens")).toBe(1);
    expect(await count("swaps")).toBe(1);
    expect(await count("candles")).toBe(1);
  });

  it("leaves pools, tokens, trades, candles and the cursor untouched when one statement in the transaction throws", async () => {
    // A pool from an earlier, successful fold: proves the failed batch does not touch prior state either.
    await applyFold(db, result({ candles: [] }), 50, T0 - 100);
    const before = {
      pools: await db.query("select * from market.pools order by id"),
      tokens: await db.query("select * from market.tokens order by id"),
      swaps: await db.query("select * from market.swaps order by tx_hash, log_index"),
      candles: await db.query("select * from market.candles order by pool_id, interval, t"),
      cursor: await readChainCursor(db),
    };

    const bad = result({
      pools: [pool({ id: POOL_B, tokenId: TOKEN_B, sqrtPriceX96: null, tvlToken: null, tvlQuote: null })],
      tokens: [token({ id: TOKEN_B, address: TOKEN_B, primaryPoolId: POOL_B })],
      trades: [trade({ txHash: txHash(9), poolId: POOL_B, tokenId: TOKEN_B })],
      candles: [candle({ poolId: POOL_B, interval: "bogus" as CandleInterval })],
    });
    await expect(applyFold(db, bad, 999, T0 + 5000)).rejects.toThrow();

    const after = {
      pools: await db.query("select * from market.pools order by id"),
      tokens: await db.query("select * from market.tokens order by id"),
      swaps: await db.query("select * from market.swaps order by tx_hash, log_index"),
      candles: await db.query("select * from market.candles order by pool_id, interval, t"),
      cursor: await readChainCursor(db),
    };
    expect(after).toEqual(before);
    // Specifically: the bad batch's own new pool/token/trade never landed either.
    expect(await db.query("select id from market.pools where id = $1", [POOL_B])).toEqual([]);
    expect(await db.query("select id from market.tokens where id = $1", [TOKEN_B])).toEqual([]);
    expect(after.cursor).toBe(50);
  });

  it("round-trips a uint160 and TVL values far beyond 2^63 exactly", async () => {
    const huge = 1461446703485210103287273052203988822378723970341n; // 2^160 - 1
    const hugeTvl = 123456789012345678901234567890123456789012345678n;
    await applyFold(db, result({ pools: [pool({ sqrtPriceX96: huge, tvlToken: hugeTvl, tvlQuote: hugeTvl + 1n })] }), 100, T0);
    const state = await loadFoldState(db, [swapEvent()]);
    const p = state.pools.get(POOL_A);
    expect(p?.sqrtPriceX96).toBe(huge);
    expect(p?.tvlToken).toBe(hugeTvl);
    expect(p?.tvlQuote).toBe(hugeTvl + 1n);
    expect(typeof p?.sqrtPriceX96).toBe("bigint");
  });

  describe("protected columns", () => {
    it("never writes baseline_at, defaults it to 0 for a pool it creates, and leaves an existing value alone", async () => {
      await applyFold(db, result(), 100, T0);
      expect((await db.query<{ baseline_at: number }>("select baseline_at from market.pools where id = $1", [POOL_A]))[0].baseline_at).toBe(0);

      // Simulate the migration's backfill: a pool copied from the old indexer with a real baseline.
      await db.query("update market.pools set baseline_at = $1 where id = $2", [T0 - 5000, POOL_A]);
      await applyFold(db, result({ pools: [pool({ swapCount: 20, priceQuote: 0.001 })] }), 200, T0 + 1000);

      const row = (await db.query<{ baseline_at: number; swap_count: number }>("select baseline_at, swap_count from market.pools where id = $1", [POOL_A]))[0];
      expect(row.baseline_at).toBe(T0 - 5000); // untouched
      expect(row.swap_count).toBe(20); // other columns still update
    });

    it("never writes holders_count or total_supply: 0 for a token it creates, and an externally set value survives further folds", async () => {
      await applyFold(db, result(), 100, T0);
      let row = (await db.query<{ holders_count: number; total_supply: string }>(
        "select holders_count, total_supply from market.tokens where id = $1",
        [TOKEN_A],
      ))[0];
      expect(row.holders_count).toBe(0);
      expect(row.total_supply).toBe("0");

      // Simulate the holder-refresh job (out of scope here) setting real values.
      await db.query("update market.tokens set holders_count = $1, total_supply = $2 where id = $3", [777, "999999999999999999999999999999", TOKEN_A]);
      await applyFold(db, result({ tokens: [token({ poolCount: 3, symbol: "NEW" })] }), 200, T0 + 1000);

      row = (await db.query<{ holders_count: number; total_supply: string }>(
        "select holders_count, total_supply from market.tokens where id = $1",
        [TOKEN_A],
      ))[0];
      expect(row.holders_count).toBe(777); // untouched
      expect(row.total_supply).toBe("999999999999999999999999999999"); // untouched
      const updated = (await db.query<{ pool_count: number; symbol: string }>("select pool_count, symbol from market.tokens where id = $1", [TOKEN_A]))[0];
      expect(updated).toEqual({ pool_count: 3, symbol: "NEW" }); // other columns still update
    });
  });
});
