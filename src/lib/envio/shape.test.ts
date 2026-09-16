import { describe, it, expect } from "vitest";
import { usdMap, windowStats, shapePairs, shapeQuotes, shapeCandles, shapeTrades, shapeHolders, hookLabel, feeTierLabel } from "./shape";
import { AI, NVDA, USDG, POOL, NOW, aiToken, prices, windowRows, quotes, candles, swaps, balances } from "./fixtures";

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
  });
  it("converts to USD", () => {
    expect(pair!.priceUsd).toBeCloseTo(0.000866 * 224.4, 9);
    expect(pair!.fdv).toBeCloseTo(0.000866 * 224.4 * 1e9, 3);
    expect(pair!.mcap).toBe(pair!.fdv);
    expect(pair!.vol24h).toBeCloseTo(18.6 * 224.4, 6);
    // liquidity = (10000 NVDA + 1,000,000 AI * 0.000866) * 224.4
    expect(pair!.liquidity).toBeCloseTo((10_000 + 1_000_000 * 0.000866) * 224.4, 3);
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
