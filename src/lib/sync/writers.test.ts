import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { POOL_A, QUOTE, T0, TOKEN_A, TOKEN_B, addr, balanceRec, candleRec, poolId, poolRec, priceRec, quoteRec, swapRec, tokenRec, txHash } from "./testRows";
import { dedupe, insertSwaps, markSynced, recomputeListedPools, replaceHolders, upsertCandles, upsertPools, upsertQuotes, upsertTokens } from "./writers";

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
beforeEach(() => db.exec(
  "delete from market.quotes; delete from market.tokens; delete from market.pools; delete from market.swaps; delete from market.candles; delete from market.token_balances; delete from market.holder_refresh",
));

const count = async (table: string) => Number((await db.query<{ n: unknown }>(`select count(*) as n from market.${table}`))[0].n);

describe("dedupe", () => {
  it("keeps the last occurrence per key and returns the rows in key order, so every multi-row statement locks its rows in one order", () => {
    const rows = [{ id: "b", v: 1 }, { id: "c", v: 1 }, { id: "a", v: 1 }, { id: "b", v: 2 }];
    expect(dedupe(rows, (r) => r.id)).toEqual([{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 1 }]);
    expect(dedupe([] as { id: string }[], (r) => r.id)).toEqual([]);
  });
});

describe("upsertQuotes", () => {
  it("writes quotes, leaves prices null without a price row and fills them when one exists", async () => {
    const gld = addr(0xa2);
    expect(await upsertQuotes(db, [quoteRec(), quoteRec({ id: gld, address: gld, symbol: "GLD" })], [priceRec()])).toBe(2);
    const rows = await db.query("select id, usd_price, usd_updated_at, aggregator, enabled from market.quotes order by id");
    expect(rows).toEqual([
      { id: QUOTE, usd_price: 182.5, usd_updated_at: T0, aggregator: addr(0xfeed), enabled: true },
      { id: gld, usd_price: null, usd_updated_at: null, aggregator: null, enabled: true },
    ]);
  });
  it("is idempotent", async () => {
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    expect(await upsertQuotes(db, [quoteRec()], [priceRec({ usdPrice: "183" })])).toBe(1);
    expect(await db.query("select usd_price from market.quotes")).toEqual([{ usd_price: 183 }]);
    expect(await count("quotes")).toBe(1);
  });
});

describe("upsertPools", () => {
  it("converts Envio's numeric strings: doubles for prices, numeric(78,0) read back as the same string", async () => {
    expect(await upsertPools(db, [poolRec()], T0 + 1000)).toBe(1);
    const rows = await db.query("select price_quote, tvl_token, last_swap_at, token_is_currency0, synced_at from market.pools where id = $1", [POOL_A]);
    expect(rows).toEqual([{ price_quote: 0.000866, tvl_token: "1000000000000000000000", last_swap_at: T0 + 500, token_is_currency0: true, synced_at: T0 + 1000 }]);
  });
  it("updates in place, including a value that became null", async () => {
    await upsertPools(db, [poolRec()], T0);
    await upsertPools(db, [poolRec({ swapCount: 9, lastSwapAt: T0 + 900, tvlToken: null })], T0 + 1);
    expect(await db.query("select swap_count, last_swap_at, tvl_token from market.pools")).toEqual([{ swap_count: 9, last_swap_at: T0 + 900, tvl_token: null }]);
    expect(await count("pools")).toBe(1);
  });
  it("defaults synced_to to 0 and never touches it afterwards", async () => {
    await upsertPools(db, [poolRec()], T0);
    expect(await db.query("select synced_to from market.pools")).toEqual([{ synced_to: 0 }]);
    await db.query("update market.pools set synced_to = $1", [T0 + 400]);
    await upsertPools(db, [poolRec({ swapCount: 9 })], T0 + 1);
    expect(await db.query("select synced_to, swap_count from market.pools")).toEqual([{ synced_to: T0 + 400, swap_count: 9 }]);
  });
});

describe("markSynced", () => {
  it("raises synced_to of the pools it names, never lowers it, and counts the rows it touched", async () => {
    await upsertPools(db, [poolRec(), poolRec({ id: poolId(0x12) })], T0);
    expect(await markSynced(db, [POOL_A], T0 + 500)).toBe(1);
    expect(await markSynced(db, [POOL_A, poolId(0x12)], T0 + 400)).toBe(2);
    expect(await db.query("select id, synced_to from market.pools order by id")).toEqual([
      { id: POOL_A, synced_to: T0 + 500 },
      { id: poolId(0x12), synced_to: T0 + 400 },
    ]);
    expect(await markSynced(db, [], T0 + 900)).toBe(0);
    expect(await markSynced(db, [poolId(0x99)], T0 + 900)).toBe(0);
  });
});

describe("upsertTokens", () => {
  it("stores total_supply exactly and never touches listed_pool_id", async () => {
    await upsertTokens(db, [tokenRec()], T0);
    await db.query("update market.tokens set listed_pool_id = $1", [POOL_A]);
    expect(await upsertTokens(db, [tokenRec({ holdersCount: 43 })], T0 + 1)).toBe(1);
    expect(await db.query("select total_supply, holders_count, listed_pool_id, metadata_loaded from market.tokens")).toEqual([
      { total_supply: "1000000000000000000000000000", holders_count: 43, listed_pool_id: POOL_A, metadata_loaded: true },
    ]);
    expect(await count("tokens")).toBe(1);
  });
});

describe("insertSwaps", () => {
  it("splits the id, ignores duplicates and reports only what was inserted", async () => {
    const b = swapRec({ txHash: txHash(2), id: `${txHash(2)}-7`, timestamp: T0 + 600 });
    expect(await insertSwaps(db, [swapRec(), b])).toBe(2);
    expect(await insertSwaps(db, [b, swapRec({ txHash: txHash(3) })])).toBe(1);
    expect(await db.query("select tx_hash, log_index, amount_token from market.swaps order by tx_hash, log_index")).toEqual([
      { tx_hash: txHash(1), log_index: 0, amount_token: 1000 },
      { tx_hash: txHash(2), log_index: 7, amount_token: 1000 },
      { tx_hash: txHash(3), log_index: 0, amount_token: 1000 },
    ]);
  });
  it("rejects a malformed id", async () => {
    await expect(insertSwaps(db, [swapRec({ id: "nope" })])).rejects.toThrow("bad swap id nope");
  });
});

describe("upsertCandles", () => {
  it("parses the interval from the id and upserts on (pool_id, interval, t), last duplicate winning", async () => {
    const m1 = candleRec();
    const h1 = candleRec({ interval: "h1" });
    expect(await upsertCandles(db, [m1, h1, { ...m1, close: "0.001", trades: 5 }])).toBe(2);
    expect(await db.query("select interval, t, close, trades from market.candles order by interval, t")).toEqual([
      { interval: "h1", t: h1.t, close: 0.000866, trades: 2 },
      { interval: "m1", t: m1.t, close: 0.001, trades: 5 },
    ]);
    expect(await upsertCandles(db, [m1, h1])).toBe(2);
    expect(await count("candles")).toBe(2);
  });
  it("throws on a malformed id", async () => {
    await expect(upsertCandles(db, [candleRec({ id: `${POOL_A}-h2-100` })])).rejects.toThrow(`bad candle id ${POOL_A}-h2-100`);
  });
});

describe("replaceHolders", () => {
  it("replaces one token's rows, drops zero balances and stamps holder_refresh", async () => {
    await replaceHolders(db, TOKEN_A, [balanceRec(), balanceRec({ holder: addr(0xc2), balance: "7" })], T0);
    await replaceHolders(db, TOKEN_B, [balanceRec({ token_id: TOKEN_B, holder: addr(0xc9) })], T0);
    expect(await replaceHolders(db, TOKEN_A, [balanceRec({ holder: addr(0xc3), balance: "9" }), balanceRec({ holder: addr(0xc4), balance: "0" })], T0 + 300)).toBe(1);
    expect(await db.query("select token_id, holder, balance from market.token_balances order by token_id, holder")).toEqual([
      { token_id: TOKEN_A, holder: addr(0xc3), balance: "9" },
      { token_id: TOKEN_B, holder: addr(0xc9), balance: "5000000000000000000" },
    ]);
    expect(await db.query("select refreshed_at from market.holder_refresh where token_id = $1", [TOKEN_A])).toEqual([{ refreshed_at: T0 + 300 }]);
  });
  it("keeps the old rows and stamp when the transaction fails after the delete", async () => {
    await replaceHolders(db, TOKEN_A, [balanceRec()], T0);
    // 80 digits overflow numeric(78,0) inside the transaction, after the delete has run.
    await expect(replaceHolders(db, TOKEN_A, [balanceRec({ balance: "1".repeat(80) })], T0 + 300)).rejects.toThrow();
    expect(await db.query("select holder from market.token_balances")).toEqual([{ holder: balanceRec().holder }]);
    expect(await db.query("select refreshed_at from market.holder_refresh")).toEqual([{ refreshed_at: T0 }]);
  });
});

describe("recomputeListedPools", () => {
  const seed = async () => {
    await upsertTokens(db, [tokenRec(), tokenRec({ id: TOKEN_B, address: TOKEN_B, primaryPool_id: poolId(0x12) })], T0);
    await upsertPools(db, [
      poolRec(),                                                                                   // A's primary: sane and traded
      poolRec({ id: poolId(0x12), token_id: TOKEN_B, priceQuote: "3.4e50", swapCount: 100 }),      // B's primary: parked at a tick boundary
      poolRec({ id: poolId(0x13), token_id: TOKEN_B, swapCount: 5 }),
      poolRec({ id: poolId(0x14), token_id: TOKEN_B, swapCount: 8 }),                              // the sane pool with the most swaps
    ], T0);
  };
  const listed = async () =>
    Object.fromEntries((await db.query<{ id: string; listed_pool_id: string | null }>("select id, listed_pool_id from market.tokens")).map((r) => [r.id, r.listed_pool_id]));

  it("takes the primary when it is sane and traded, else the sane traded pool with the most swaps", async () => {
    await seed();
    expect(await recomputeListedPools(db, [TOKEN_A, TOKEN_B])).toBe(2);
    expect(await listed()).toEqual({ [TOKEN_A]: POOL_A, [TOKEN_B]: poolId(0x14) });
  });
  it("sets null when no sane traded pool exists", async () => {
    await seed();
    await db.query("update market.pools set swap_count = 0 where token_id = $1", [TOKEN_B]);
    expect(await recomputeListedPools(db, [TOKEN_B])).toBe(1);
    expect((await listed())[TOKEN_B]).toBeNull();
  });
  it('"all" touches every token and an empty list touches none', async () => {
    await seed();
    expect(await recomputeListedPools(db, "all")).toBe(2);
    expect(await listed()).toEqual({ [TOKEN_A]: POOL_A, [TOKEN_B]: poolId(0x14) });
    expect(await recomputeListedPools(db, [])).toBe(0);
  });
});
