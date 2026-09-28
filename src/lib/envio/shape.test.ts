import { describe, it, expect } from "vitest";
import { usdMap, windowStats, shapePairs, shapeQuotes, shapeCandles, shapeTrades, shapeHolders, hookLabel, feeTierLabel, isSanePool, resolvePool } from "./shape";
import {
  AI, NVDA, USDG, POOL, BROKEN_POOL, NOW, aiToken, prices, windowRows, quotes, candles, swaps, balances,
  aiTokenAsStrings, aiTokenBroken, brokenPool, candlesAsStrings, pricesAsStrings, swapsAsStrings, windowRowsAsStrings,
} from "./fixtures";

describe("usdMap", () => {
  it("nulls stale quotes", () => {
    const m = usdMap(prices, NOW);
    expect(m.get(NVDA)).toBe(224.4);
    expect(m.get("0xstale")).toBeNull();
  });
  it("keeps a pinned quote whatever its age", () => {
    // USDG quotes 44% of the listed tokens; treating its frozen updatedAt as stale wipes their USD prices.
    expect(usdMap(prices, NOW).get(USDG)).toBe(1);
  });
});

describe("windowStats", () => {
  it("takes the open of the hour bucket an hour and a day ago and sums 24h volume", () => {
    const w = windowStats(windowRows, NOW).get(POOL)!;
    expect(w.ref1h).toBe(0.00088);
    expect(w.ref24h).toBe(0.001);
    expect(w.vol24h).toBeCloseTo(18.6, 9);
  });
  it("falls back to the last close before a missing bucket", () => {
    const rows = windowRows.filter((r) => r.t !== NOW - 3600);
    const w = windowStats(rows, NOW).get(POOL)!;
    expect(w.ref1h).toBe(0.00089); // close of the NOW - 7200 candle
    expect(w.ref24h).toBe(0.001);
  });
  it("has no entry for a pool without candles", () => {
    expect(windowStats([], NOW).has(POOL)).toBe(false);
  });
});

describe("shapePairs", () => {
  const [pair] = shapePairs([aiToken], usdMap(prices, NOW), windowStats(windowRows, NOW));
  it("keys by address and carries origin", () => {
    expect(pair!.id).toBe(AI);
    expect(pair!.address).toBe(aiToken.address); // checksummed, never the lowercase id re-cased
    expect(pair!.origin).toBe("LONG");
    expect(pair!.poolId).toBe(POOL);
    expect(pair!.tradeable).toBe(true);
    expect(pair!.stale).toBe(false);
    // Every row points at the proxy; the route decides whether a logo exists.
    expect(pair!.logoUrl).toBe(`/api/tokens/${AI}/logo`);
  });
  it("converts to USD", () => {
    expect(pair!.priceUsd).toBeCloseTo(0.000866 * 224.4, 9);
    expect(pair!.fdv).toBeCloseTo(0.000866 * 224.4 * 1e9, 3);
    expect(pair!.mcap).toBe(pair!.fdv);
    expect(pair!.vol24h).toBeCloseTo(18.6 * 224.4, 6);
    // liquidity = the quote side only (D43): 10,000 NVDA * 224.4. The 1,000,000 AI on the token
    // side is deliberately not counted.
    expect(pair!.liquidity).toBeCloseTo(10_000 * 224.4, 3);
  });
  it("computes changes against the hour buckets an hour and a day ago", () => {
    expect(pair!.change1h).toBeCloseTo((0.000866 / 0.00088 - 1) * 100, 9);
    expect(pair!.change24h).toBeCloseTo((0.000866 / 0.001 - 1) * 100, 9);
  });
  it("marks a pool with no reference candle as new", () => {
    const [p] = shapePairs([aiToken], usdMap(prices, NOW), new Map());
    expect(p!.change1h).toBeNull();
    expect(p!.change24h).toBeNull();
    expect(p!.vol24h).toBe(0);
  });
  it("drops tokens without a primary pool and zeroes USD on a stale quote", () => {
    const stale = { ...aiToken, primaryPool: { ...aiToken.primaryPool!, quote_id: "0xstale" } };
    expect(shapePairs([{ ...aiToken, primaryPool: null }, stale], usdMap(prices, NOW), new Map())).toHaveLength(1);
    const [p] = shapePairs([stale], usdMap(prices, NOW), new Map());
    expect(p!.stale).toBe(true);
    expect(p!.priceUsd).toBe(0);
    expect(p!.mcap).toBe(0);
    expect(p!.vol24h).toBe(0);
    expect(p!.liquidity).toBeNull();
  });
  it("labels hooks and fee tiers", () => {
    expect(hookLabel("LONG")).toBe("Doppler shared v4 hook");
    expect(hookLabel("Pons")).toBe("Pons MemeHook · afterSwap");
    expect(feeTierLabel(8388608)).toBe("Dynamic");
    expect(feeTierLabel(3000)).toBe("0.30%");
    expect(pair!.hook).toBe("Doppler shared v4 hook");
    expect(pair!.feeTier).toBe("Dynamic");
  });
});

describe("shapeQuotes", () => {
  it("counts pairs and sums 24h USD volume per quote", () => {
    const pairs = shapePairs([aiToken], usdMap(prices, NOW), windowStats(windowRows, NOW));
    const [q] = shapeQuotes(quotes, pairs, usdMap(prices, NOW), prices, NOW);
    expect(q!.symbol).toBe("NVDA");
    expect(q!.pairs).toBe(1);
    expect(q!.usdPrice).toBe(224.4);
    expect(q!.stale).toBe(false);
    expect(q!.vol24h).toBeCloseTo(18.6 * 224.4, 6);
  });
});

describe("shapeCandles / shapeTrades / shapeHolders", () => {
  it("returns candles oldest first in USD with ms timestamps", () => {
    const out = shapeCandles(candles, () => 224.4);
    expect(out.map((c) => c.t)).toEqual([(NOW - 1800) * 1000, (NOW - 900) * 1000]);
    expect(out[1]!.c).toBeCloseTo(0.0009 * 224.4, 9);
    expect(out[1]!.v).toBeCloseTo(3 * 224.4, 9);
  });
  it("drops candles with no USD price instead of drawing them at zero", () => {
    const out = shapeCandles(candles, (t) => (t === NOW - 1800 ? null : 224.4));
    expect(out).toHaveLength(1);
    expect(out[0]!.t).toBe((NOW - 900) * 1000);
    expect(out[0]!.c).toBeCloseTo(0.0009 * 224.4, 9);
  });
  it("shapes trades with USD price and tx", () => {
    const [t] = shapeTrades(swaps, 224.4, "AI");
    expect(t!.priceUsd).toBeCloseTo(0.000865 * 224.4, 9);
    expect(t!.t).toBe((NOW - 30) * 1000);
    expect(t!.tx.length).toBe(66);
  });
  it("tags the PoolManager as Pool and computes shares", () => {
    const out = shapeHolders(balances, 18, 1_000_000_000n * 10n ** 18n);
    expect(out[0]!.tag).toBe("Pool");
    expect(out[0]!.share).toBeCloseTo(8.4684155, 6);
    expect(out[1]!.tag).toBeUndefined();
    expect(out[0]!.balance).toBeCloseTo(84_684_155, 3);
  });
});

// Hasura sends every numeric column as a string. Before coercion `vol24h += r.volumeQuote`
// concatenated ("0" + "10" + "8.6") and landed on NaN, and priceQuote/usdPrice/amount reached
// the API as strings. Each case pairs the wire shape against the numeric fixture.
describe("numeric strings from the indexer", () => {
  it("usdMap coerces a string price", () => {
    expect(usdMap(pricesAsStrings, NOW).get(NVDA)).toBe(224.4);
    expect(usdMap(pricesAsStrings, NOW).get(USDG)).toBe(1);
    expect(usdMap(pricesAsStrings, NOW).get("0xstale")).toBeNull();
  });
  it("windowStats sums string volumes instead of concatenating them", () => {
    const w = windowStats(windowRowsAsStrings, NOW).get(POOL)!;
    expect(w.vol24h).toBeCloseTo(18.6, 9);
    expect(w).toEqual(windowStats(windowRows, NOW).get(POOL));
  });
  it("shapePairs produces the same pair from string rows", () => {
    const [fromStrings] = shapePairs([aiTokenAsStrings], usdMap(pricesAsStrings, NOW), windowStats(windowRowsAsStrings, NOW));
    const [fromNumbers] = shapePairs([aiToken], usdMap(prices, NOW), windowStats(windowRows, NOW));
    expect(fromStrings).toEqual(fromNumbers);
    expect(fromStrings!.priceQuote).toBe(0.000866);
    expect(Number.isFinite(fromStrings!.vol24h)).toBe(true);
  });
  it("shapeQuotes sums a numeric 24h volume from string rows", () => {
    const pairs = shapePairs([aiTokenAsStrings], usdMap(pricesAsStrings, NOW), windowStats(windowRowsAsStrings, NOW));
    const [q] = shapeQuotes(quotes, pairs, usdMap(pricesAsStrings, NOW), pricesAsStrings, NOW);
    expect(q!.usdPrice).toBe(224.4);
    expect(q!.vol24h).toBeCloseTo(18.6 * 224.4, 6);
  });
  it("shapeCandles and shapeTrades coerce their string rows", () => {
    expect(shapeCandles(candlesAsStrings, () => 224.4)).toEqual(shapeCandles(candles, () => 224.4));
    const [t] = shapeTrades(swapsAsStrings, 224.4, "AI");
    expect(t!.amount).toBe(15749);
    expect(t!.priceUsd).toBeCloseTo(0.000865 * 224.4, 9);
  });
});

describe("resolvePool", () => {
  it("rejects prices at the tick boundaries", () => {
    expect(isSanePool(aiToken.primaryPool!)).toBe(true);
    expect(isSanePool(brokenPool)).toBe(false);
    expect(isSanePool({ ...brokenPool, priceQuote: 0 })).toBe(false);
    expect(isSanePool({ ...brokenPool, priceQuote: 1e-24 })).toBe(false); // exclusive
    expect(isSanePool({ ...brokenPool, priceQuote: 1e18 })).toBe(false); // exclusive
    expect(isSanePool({ ...brokenPool, priceQuote: "1e-23" })).toBe(true);
    expect(isSanePool({ ...brokenPool, priceQuote: "1e17" })).toBe(true);
  });
  it("keeps a sane primary pool and ignores the fallback", () => {
    const t = { ...aiToken, fallbackPool: [brokenPool] };
    expect(resolvePool(t)!.id).toBe(POOL);
  });
  it("falls back when the primary is parked at a boundary", () => {
    expect(resolvePool(aiTokenBroken)!.id).toBe(POOL);
  });
  it("returns null when the primary is broken and nothing sane is offered", () => {
    expect(resolvePool({ ...aiTokenBroken, fallbackPool: undefined })).toBeNull();
    expect(resolvePool({ ...aiTokenBroken, fallbackPool: [] })).toBeNull();
    expect(resolvePool({ ...aiTokenBroken, fallbackPool: [brokenPool] })).toBeNull();
    expect(resolvePool({ ...aiToken, primaryPool: null })).toBeNull();
  });
  it("shapePairs prices a recovered token off the fallback pool", () => {
    // Without recovery AI reads as a USDG pair at 3.4e50; with it, the real LONG/NVDA pool.
    const [p] = shapePairs([aiTokenBroken], usdMap(prices, NOW), windowStats(windowRows, NOW));
    expect(p!.poolId).toBe(POOL);
    expect(p!.poolId).not.toBe(BROKEN_POOL);
    expect(p!.origin).toBe("LONG");
    expect(p!.quote).toBe("NVDA");
    expect(p!.priceQuote).toBe(0.000866);
    expect(p!.priceUsd).toBeCloseTo(0.000866 * 224.4, 9);
    expect(shapePairs([{ ...aiTokenBroken, fallbackPool: [] }], usdMap(prices, NOW), new Map())).toHaveLength(0);
  });
});
