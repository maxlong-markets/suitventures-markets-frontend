import { describe, expect, it } from "vitest";
import { FakeSource } from "./fakeSource";
import type { BalanceRec, CandleRec, PoolRec, SwapRec, TokenRec } from "./source";

const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const P1 = id(1), P2 = id(2), P3 = id(3), P4 = id(4), P5 = id(5), P6 = id(6);
const pool = (o: Partial<PoolRec> & { id: string }): PoolRec => ({ token_id: "0xt", quote_id: "0xq", tokenIsCurrency0: true, hooks: "0x0", fee: 3000, tickSpacing: 60, origin: "LONG", createdAt: 0, priceQuote: "1", tvlToken: null, tvlQuote: null, swapCount: 1, lastSwapAt: 0, volumeQuoteAllTime: "0", ...o });
const swap = (o: Partial<SwapRec> & { id: string }): SwapRec => ({ pool_id: P1, token_id: "0xt", timestamp: 0, side: "buy", amountToken: "1", amountQuote: "1", priceQuote: "1", wallet: "0xw", txHash: "0xh", ...o });
const candle = (o: Partial<CandleRec> & { id: string }): CandleRec => ({ pool_id: P1, t: 0, open: "1", high: "1", low: "1", close: "1", volumeQuote: "0", volumeToken: "0", trades: 0, ...o });
const token = (o: Partial<TokenRec> & { id: string }): TokenRec => ({ address: o.id, symbol: "T", name: "T", decimals: 18, totalSupply: "0", holdersCount: 0, poolCount: 0, origin: "LONG", createdAt: 0, primaryPool_id: null, metadataLoaded: true, ...o });
const balance = (o: Partial<BalanceRec> & { id: string }): BalanceRec => ({ token_id: "0xt", holder: o.id, balance: "1", updatedAt: 0, ...o });
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

const S1 = `${id(11)}-0`, S2 = `${id(13)}-0`, S3 = `${id(12)}-0`, S4 = `${id(14)}-0`, S5 = `${id(10)}-0`;
const C1 = `${P1}-m1-100`, C2 = `${P1}-m1-200`, C3 = `${P2}-m1-200`, C4 = `${P1}-m1-50`, H1 = `${P1}-h1-0`;

function source() {
  return new FakeSource({
    pools: [
      pool({ id: P3, lastSwapAt: 200, createdAt: 30 }), pool({ id: P1, lastSwapAt: 100, createdAt: 10 }), pool({ id: P2, lastSwapAt: 200, createdAt: 20 }),
      pool({ id: P4, lastSwapAt: null, createdAt: 40 }), pool({ id: P5, lastSwapAt: null, createdAt: 5 }), pool({ id: P6, lastSwapAt: 50, createdAt: 1 }),
    ],
    swaps: [swap({ id: S1, timestamp: 10 }), swap({ id: S2, pool_id: P2, timestamp: 20 }), swap({ id: S3, timestamp: 20 }), swap({ id: S4, pool_id: P3, timestamp: 30 }), swap({ id: S5, timestamp: 5 })],
    candles: [candle({ id: C1, t: 100 }), candle({ id: C2, t: 200 }), candle({ id: C3, pool_id: P2, t: 200 }), candle({ id: C4, t: 50 }), candle({ id: H1, t: 0 })],
    tokens: [token({ id: "0xb" }), token({ id: "0xa" }), token({ id: "0xc" })],
    balances: [balance({ id: "0xh1", balance: "9" }), balance({ id: "0xh2", balance: "10" }), balance({ id: "0xh3", balance: "0" }), balance({ id: "0xh4", balance: "10" }), balance({ id: "0xh5", token_id: "0xother", balance: "99" })],
    chain: { latestProcessedBlock: 10, blockHeight: 12 },
  });
}

describe("FakeSource", () => {
  it("pages traded pools by (lastSwapAt, id) with a strict keyset", async () => {
    const s = source();
    expect(ids(await s.poolsSince(100, null, 10))).toEqual([P1, P2, P3]);
    expect(ids(await s.poolsSince(100, null, 2))).toEqual([P1, P2]);
    expect(ids(await s.poolsSince(100, { lastSwapAt: 200, id: P2 }, 10))).toEqual([P3]);
    expect(ids(await s.poolsSince(100, { lastSwapAt: 200, id: P3 }, 10))).toEqual([]);
  });
  it("pages never-traded pools by (createdAt, id)", async () => {
    const s = source();
    expect(ids(await s.poolsCreatedSince(5, null, 10))).toEqual([P5, P4]);
    expect(ids(await s.poolsCreatedSince(5, { createdAt: 5, id: P5 }, 10))).toEqual([P4]);
  });
  it("pages the swaps of the given pools by (timestamp, id)", async () => {
    const s = source();
    expect(ids(await s.swapsFor([P1, P2], 10, null, 10))).toEqual([S1, S3, S2]);
    expect(ids(await s.swapsFor([P1, P2], 10, { timestamp: 20, id: S3 }, 10))).toEqual([S2]);
    expect(ids(await s.swapsFor([P1, P2], 10, null, 1))).toEqual([S1]);
    expect(ids(await s.swapsFor([P3], 0, null, 10))).toEqual([S4]);
  });
  it("pages recent candles and returns the open buckets on the first page only", async () => {
    const s = source();
    const first = await s.candlesFor([P1], 100, [H1, `${P1}-d1-0`], null, 10);
    expect(ids(first.recent)).toEqual([C1, C2]);
    expect(ids(first.open)).toEqual([H1]);
    const next = await s.candlesFor([P1], 100, [H1], { t: 100, id: C1 }, 10);
    expect(ids(next.recent)).toEqual([C2]);
    expect(next.open).toEqual([]);
    expect(ids((await s.candlesFor([P1, P2], 200, [], null, 1)).recent)).toEqual([C2]);
  });
  it("looks up tokens, ranks holders as BigInt largest first, and reads chain metadata", async () => {
    const s = source();
    expect(ids(await s.tokensById(["0xa", "0xc", "0xz"]))).toEqual(["0xa", "0xc"]);
    expect(ids(await s.topHolders("0xt", 10))).toEqual(["0xh2", "0xh4", "0xh1"]);
    expect(ids(await s.topHolders("0xt", 2))).toEqual(["0xh2", "0xh4"]);
    expect(await s.chainMeta()).toEqual({ latestProcessedBlock: 10, blockHeight: 12 });
  });
  it("walks id ranges ascending, bounded by beforeId, balances only when non-zero", async () => {
    const s = source();
    expect(ids(await s.tokensPage("", 10))).toEqual(["0xa", "0xb", "0xc"]);
    expect(ids(await s.tokensPage("0xa", 1))).toEqual(["0xb"]);
    expect(ids(await s.poolsPage(P2, 10))).toEqual([P3, P4, P5, P6]);
    expect(ids(await s.swapsPage(S5, S4, 10))).toEqual([S1, S3, S2]);
    expect(ids(await s.swapsPage(S5, null, 10))).toEqual([S1, S3, S2, S4]);
    expect(ids(await s.candlesPage("", null, 2))).toEqual([H1, C1]); // "-h1-" sorts before "-m1-"
    expect(ids(await s.balancesPage("", null, 10))).toEqual(["0xh1", "0xh2", "0xh4", "0xh5"]);
    expect(ids(await s.balancesPage("0xh1", "0xh4", 10))).toEqual(["0xh2"]);
  });
  it("records calls, counts queries and throws an armed failure once", async () => {
    const s = source();
    await s.quotes();
    await s.tokensPage("", 1);
    s.failOn = { method: "quotes", error: new Error("boom") };
    await expect(s.quotes()).rejects.toThrow("boom");
    expect((await s.quotes()).quotes).toEqual([]);
    expect(s.calls).toEqual(["quotes", "tokensPage", "quotes", "quotes"]);
    expect(s.queries).toBe(4);
    expect(s.failOn).toBeNull();
  });
});
