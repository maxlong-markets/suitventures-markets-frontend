import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import type { Address } from "@/lib/types";
import { testDb } from "@/test/db";
import { MAX_VOTE_IDS, setWatch, toggleVote, topTraders, voteCounts, votes, watchlist } from "./store";

const addr = (c: string) => `0x${c.repeat(40)}` as Address;
const T1 = addr("1"), T2 = addr("2"), T3 = addr("3"), T9 = addr("9");
const W1 = addr("a"), W2 = addr("b"), W3 = addr("c");
const USD = addr("d"), NOFEED = addr("e");
const POOL_1 = `0x${"1".repeat(64)}`, POOL_2 = `0x${"2".repeat(64)}`, POOL_3 = `0x${"3".repeat(64)}`;
const NOW = 1_789_000_000;
const DAY_AGO = NOW - 86_400;

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.exec("truncate market.votes, market.watchlist, market.swaps, market.pools, market.quotes");
});

const quote = (id: string, usdPrice: number | null) =>
  db.query("insert into market.quotes (id, address, symbol, name, decimals, enabled, usd_price) values ($1, $1, 'NVDA', 'NVIDIA', 18, true, $2)", [id, usdPrice]);
const pool = (id: string, tokenId: string, quoteId: string) =>
  db.query(
    `insert into market.pools (id, token_id, quote_id, token_is_currency0, hooks, fee, tick_spacing, origin, created_at, price_quote, swap_count, volume_quote_all_time, synced_at)
     values ($1, $2, $3, true, $4, 3000, 60, 'LONG', $5, 1, 0, 0, $5)`,
    [id, tokenId, quoteId, addr("0"), NOW - 200_000],
  );
const swap = (tx: string, poolId: string, tokenId: string, ts: number, wallet: string, amountQuote: number) =>
  db.query(
    `insert into market.swaps (tx_hash, log_index, pool_id, token_id, ts, side, amount_token, amount_quote, price_quote, wallet)
     values ($1, 0, $2, $3, $4, 'buy', 1, $5, 1, $6)`,
    [tx, poolId, tokenId, ts, amountQuote, wallet],
  );

/**
 * One quote priced at $100 and one with no feed at all.
 *   W1: 2 quote units on T1 and 3 on T2, both inside the day → $500 over 2 trades and 2 tokens,
 *       plus 99 units 25 hours ago that the window must not count.
 *   W2: two halves on T1 ($100) and 1000 units of the unpriced quote on T3 → $100 over 3 trades, 2 tokens.
 * So the two orderings disagree, which is the point of the `by` parameter.
 */
async function seedTrades() {
  await quote(USD, 100);
  await quote(NOFEED, null);
  await pool(POOL_1, T1, USD);
  await pool(POOL_2, T2, USD);
  await pool(POOL_3, T3, NOFEED);
  await swap("0xa1", POOL_1, T1, NOW - 100, W1, 2);
  await swap("0xa2", POOL_2, T2, NOW - 200, W1, 3);
  await swap("0xa3", POOL_1, T1, NOW - 90_000, W1, 99); // 25 hours ago: outside the window
  await swap("0xb1", POOL_1, T1, NOW - 300, W2, 0.5);
  await swap("0xb2", POOL_1, T1, NOW - 400, W2, 0.5);
  await swap("0xb3", POOL_3, T3, NOW - 500, W2, 1000); // no feed: no USD volume, still a trade
}

describe("watchlist", () => {
  it("adds, removes and is idempotent both ways", async () => {
    await setWatch(db, W1, T1, true, NOW);
    await setWatch(db, W1, T1, true, NOW + 5); // same row again: no duplicate, no error
    expect(await watchlist(db, W1)).toEqual([T1]);
    await setWatch(db, W1, T2, true, NOW + 10);
    expect(await watchlist(db, W1)).toEqual([T2, T1]); // newest first
    await setWatch(db, W1, T1, false, NOW + 20);
    await setWatch(db, W1, T1, false, NOW + 30); // removing what is gone is not an error
    expect(await watchlist(db, W1)).toEqual([T2]);
  });

  it("keeps the first created_at when the same token is starred twice", async () => {
    await setWatch(db, W1, T1, true, NOW);
    await setWatch(db, W1, T1, true, NOW + 500);
    expect(await db.query("select created_at from market.watchlist where wallet = $1", [W1])).toEqual([{ created_at: NOW }]);
  });

  it("keeps wallets apart", async () => {
    await setWatch(db, W1, T1, true, NOW);
    await setWatch(db, W2, T2, true, NOW);
    expect(await watchlist(db, W1)).toEqual([T1]);
    expect(await watchlist(db, W2)).toEqual([T2]);
    expect(await watchlist(db, W3)).toEqual([]);
  });
});

describe("votes", () => {
  it("casts, switches and clears", async () => {
    expect(await toggleVote(db, W1, T1, "bull", NOW)).toBe("bull");
    expect(await votes(db, W1)).toEqual({ [T1]: "bull" });
    expect(await toggleVote(db, W1, T1, "bear", NOW + 1)).toBe("bear"); // the other direction switches
    expect(await votes(db, W1)).toEqual({ [T1]: "bear" });
    expect(await toggleVote(db, W1, T1, "bear", NOW + 2)).toBeNull(); // the same direction clears
    expect(await votes(db, W1)).toEqual({});
    expect(await toggleVote(db, W1, T1, "bear", NOW + 3)).toBe("bear"); // and casts again
  });

  it("stamps updated_at on every write", async () => {
    await toggleVote(db, W1, T1, "bull", NOW);
    await toggleVote(db, W1, T1, "bear", NOW + 77);
    expect(await db.query("select dir, updated_at from market.votes where wallet = $1", [W1])).toEqual([{ dir: "bear", updated_at: NOW + 77 }]);
  });

  it("keeps one vote per wallet per token and answers the whole map", async () => {
    await toggleVote(db, W1, T1, "bull", NOW);
    await toggleVote(db, W1, T2, "bear", NOW);
    await toggleVote(db, W2, T1, "bear", NOW);
    expect(await votes(db, W1)).toEqual({ [T1]: "bull", [T2]: "bear" });
    expect(await votes(db, W2)).toEqual({ [T1]: "bear" });
    expect(await votes(db, W3)).toEqual({});
  });
});

describe("voteCounts", () => {
  it("counts both directions per token and answers zeros for the rest", async () => {
    await toggleVote(db, W1, T1, "bull", NOW);
    await toggleVote(db, W2, T1, "bull", NOW);
    await toggleVote(db, W3, T1, "bear", NOW);
    await toggleVote(db, W1, T2, "bear", NOW);
    expect(await voteCounts(db, [T1, T2, T9])).toEqual({
      [T1]: { bull: 2, bear: 1 },
      [T2]: { bull: 0, bear: 1 },
      [T9]: { bull: 0, bear: 0 },
    });
  });

  it("answers an empty map for no ids and never queries a token it was not asked about", async () => {
    await toggleVote(db, W1, T1, "bull", NOW);
    expect(await voteCounts(db, [])).toEqual({});
    expect(await voteCounts(db, [T2])).toEqual({ [T2]: { bull: 0, bear: 0 } });
  });

  it("serves the full page of ids and refuses more", async () => {
    const ids = Array.from({ length: MAX_VOTE_IDS }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    expect(Object.keys(await voteCounts(db, ids))).toHaveLength(MAX_VOTE_IDS);
    await expect(voteCounts(db, [...ids, T1])).rejects.toThrow(RangeError);
  });
});

describe("topTraders", () => {
  it("ranks by USD volume, converting through each pool's quote price", async () => {
    await seedTrades();
    expect(await topTraders(db, { sinceTs: DAY_AGO, by: "volume", limit: 50 })).toEqual([
      { wallet: W1, volumeUsd: 500, trades: 2, tokens: 2 },
      { wallet: W2, volumeUsd: 100, trades: 3, tokens: 2 },
    ]);
  });

  it("ranks by trade count, which puts the other wallet first", async () => {
    await seedTrades();
    expect((await topTraders(db, { sinceTs: DAY_AGO, by: "trades", limit: 50 })).map((r) => r.wallet)).toEqual([W2, W1]);
  });

  it("counts a trade in an unpriced quote asset without inventing volume for it", async () => {
    await seedTrades();
    const [, second] = await topTraders(db, { sinceTs: DAY_AGO, by: "volume", limit: 50 });
    expect(second).toEqual({ wallet: W2, volumeUsd: 100, trades: 3, tokens: 2 }); // the 1000-unit trade added a trade and a token, no dollars
  });

  it("obeys the window and the limit", async () => {
    await seedTrades();
    // NOW − 150 keeps only `0xa1` (NOW − 100). W1's second trade sits at NOW − 200 and W2's
    // earliest at NOW − 300, so both fall outside — which is the exclusion this case is for.
    // (NOW − 250 would still have caught `0xa2`: the window is `ts >= sinceTs`.)
    expect(await topTraders(db, { sinceTs: NOW - 150, by: "volume", limit: 50 })).toEqual([{ wallet: W1, volumeUsd: 200, trades: 1, tokens: 1 }]);
    // The boundary is inclusive: asking from exactly the second `0xa2` was written in keeps it.
    expect(await topTraders(db, { sinceTs: NOW - 200, by: "volume", limit: 50 })).toEqual([{ wallet: W1, volumeUsd: 500, trades: 2, tokens: 2 }]);
    expect(await topTraders(db, { sinceTs: DAY_AGO, by: "volume", limit: 1 })).toHaveLength(1);
    expect(await topTraders(db, { sinceTs: NOW + 1, by: "volume", limit: 50 })).toEqual([]);
  });

  it("breaks a tie by wallet, so the board never reshuffles between reads", async () => {
    await quote(USD, 100);
    await pool(POOL_1, T1, USD);
    await swap("0xc1", POOL_1, T1, NOW - 10, W3, 1);
    await swap("0xc2", POOL_1, T1, NOW - 10, W2, 1);
    await swap("0xc3", POOL_1, T1, NOW - 10, W1, 1);
    for (const by of ["volume", "trades"] as const) {
      expect((await topTraders(db, { sinceTs: DAY_AGO, by, limit: 50 })).map((r) => r.wallet)).toEqual([W1, W2, W3]);
    }
  });

  it("answers nothing at all when no one has traded", async () => {
    expect(await topTraders(db, { sinceTs: DAY_AGO, by: "volume", limit: 50 })).toEqual([]);
  });
});
