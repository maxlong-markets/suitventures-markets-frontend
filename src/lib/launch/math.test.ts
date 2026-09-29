import { describe, expect, it } from "vitest";
import {
  PRESET_MULTIPLIERS, RULE_OF_THUMB, SUPPLY, capTokens, estimateFirstBuyTokens, firstBuyCapGross, maxFirstBuy, minFirstBuyTokens,
  presetValuations, pricePerToken, randomSalt, rawToNumber, routerFeeOf, shareOfSupplyPct, usdToRaw,
} from "./math";

const USDG = (n: number) => BigInt(Math.round(n * 1_000_000)); // 6 decimals
const V = 4_995_430_000n; // $4,995.43, spec 3.2's first row

describe("presets (spec 7.2, DEFAULT: the minimum times 1, 2, 5 and 20, clamped to the maximum)", () => {
  it("multiplies the minimum and clamps to the maximum", () => {
    expect(PRESET_MULTIPLIERS).toEqual([1n, 2n, 5n, 20n]);
    expect(presetValuations(USDG(5_000), USDG(10_000_000))).toEqual([USDG(5_000), USDG(10_000), USDG(25_000), USDG(100_000)]);
    expect(presetValuations(USDG(5_000), USDG(20_000))).toEqual([USDG(5_000), USDG(10_000), USDG(20_000), USDG(20_000)]);
  });
});

describe("the first buy (spec 3.4 and 7.2)", () => {
  it("takes the router fee out of the gross, floored, exactly as SVRouter does", () => {
    expect(routerFeeOf(USDG(100), 50)).toBe(USDG(0.5));
    expect(routerFeeOf(199n, 50)).toBe(0n);
  });

  it("estimates S × y / (V' + y), y = 0.99 × (gross − router fee)", () => {
    const gross = USDG(100);
    const y = ((gross - routerFeeOf(gross, 50)) * 99n) / 100n;
    expect(estimateFirstBuyTokens(gross, V, 50)).toBe((SUPPLY * y) / (V + y));
    expect(estimateFirstBuyTokens(0n, V, 50)).toBe(0n);
    expect(estimateFirstBuyTokens(gross, 0n, 50)).toBe(0n);
  });

  it("sends the estimate less 0.5 % as the floor", () => {
    expect(minFirstBuyTokens(1_000_000n)).toBe(995_000n);
  });

  it("caps the gross near 25.4 % of V' at a 20 % cap and 50 bps, and a buy of that size stays under the cap", () => {
    const cap = firstBuyCapGross(V, 2000, 50)!;
    expect(Number(cap) / Number(V)).toBeCloseTo(0.2536, 3);
    expect(estimateFirstBuyTokens(cap, V, 50)).toBeLessThan(capTokens(2000));
    expect(capTokens(2000)).toBe(SUPPLY / 5n);
    expect(firstBuyCapGross(V, 0, 50)).toBe(0n); // 0 blocks any first buy
    expect(firstBuyCapGross(V, 10_000, 50)).toBeNull(); // no cap to stay under
  });

  it("offers the smaller of the balance less the creation fee and the cap as Max", () => {
    expect(maxFirstBuy(USDG(100), USDG(1), USDG(500))).toBe(USDG(99));
    expect(maxFirstBuy(USDG(10_000), 0n, USDG(500))).toBe(USDG(500));
    expect(maxFirstBuy(USDG(1), USDG(5), USDG(500))).toBe(0n);
    expect(maxFirstBuy(undefined, 0n, USDG(500))).toBe(USDG(500));
    expect(maxFirstBuy(USDG(7), 0n, null)).toBe(USDG(7));
    expect(maxFirstBuy(undefined, 0n, null)).toBeNull();
  });

  it("reports a share of supply in percent", () => {
    expect(shareOfSupplyPct(SUPPLY / 5n)).toBe(20);
    expect(shareOfSupplyPct(0n)).toBe(0);
  });
});

describe("display conversions", () => {
  it("turns a typed USD amount into raw quote units at the current price, rounded to the last decimal, and refuses nonsense", () => {
    expect(usdToRaw("5000", 1, 6)).toBe(USDG(5_000));
    expect(usdToRaw("1000", 250, 18)).toBe(4n * 10n ** 18n);
    expect(usdToRaw("", 1, 6)).toBeNull();
    expect(usdToRaw("0", 1, 6)).toBeNull();
    expect(usdToRaw("12", 0, 6)).toBeNull();
    expect(usdToRaw("abc", 1, 6)).toBeNull();
    expect(usdToRaw("0.0000001", 1, 6)).toBeNull(); // positive, but rounds to no raw units at all
  });

  it("prices one whole token at V' over one billion", () => {
    expect(pricePerToken(V, 6)).toBeCloseTo(4.99543e-6, 12);
    expect(rawToNumber(V, 6)).toBeCloseTo(4995.43, 6);
  });

  it("draws a fresh 32-byte salt each time", () => {
    const a = randomSalt();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(randomSalt()).not.toBe(a);
  });

  it("states the one rule of thumb spec 3.4 allows", () => {
    expect(RULE_OF_THUMB).toBe("Buys worth about 41 % of the opening valuation double the price, plus the 1 % pool fee.");
  });
});
