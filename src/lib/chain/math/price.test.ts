import { describe, it, expect } from "vitest";
import { priceFromSqrtPriceX96, sqrtPriceX96FromPrice, toUnits, absBig } from "./price";

const Q96 = 2n ** 96n;

describe("priceFromSqrtPriceX96", () => {
  it("is 1 at sqrtP = 2^96 with equal decimals", () => {
    expect(priceFromSqrtPriceX96(Q96, 18, 18, true)).toBeCloseTo(1, 12);
    expect(priceFromSqrtPriceX96(Q96, 18, 18, false)).toBeCloseTo(1, 12);
  });
  it("adjusts for decimals (18-dec token vs 6-dec USDG)", () => {
    // raw ratio 1 wei/wei: 1e18 wei of token = 1e18 wei of USDG = 1e12 USDG
    expect(priceFromSqrtPriceX96(Q96, 18, 6, true)).toBeCloseTo(1e12, 0);
  });
  it("inverts when the token is currency1", () => {
    const sqrtP = 2n * Q96; // price1per0 = 4
    expect(priceFromSqrtPriceX96(sqrtP, 18, 18, true)).toBeCloseTo(4, 9);
    expect(priceFromSqrtPriceX96(sqrtP, 18, 18, false)).toBeCloseTo(0.25, 9);
  });
  it("matches the AI/NVDA pool within 0.1%", () => {
    // AI is currency0, NVDA currency1, both 18 decimals; DexScreener priceNative 0.0008658
    const sqrtP = 2331300000000000000000000000n;
    const p = priceFromSqrtPriceX96(sqrtP, 18, 18, true);
    expect(Math.abs(p - 0.0008658) / 0.0008658).toBeLessThan(0.001);
  });
});

describe("toUnits / absBig", () => {
  it("formats raw amounts", () => {
    expect(toUnits(1500000n, 6)).toBe(1.5);
    expect(toUnits(2n * 10n ** 18n, 18)).toBe(2);
  });
  it("abs on bigint", () => {
    expect(absBig(-5n)).toBe(5n);
    expect(absBig(5n)).toBe(5n);
  });
});

describe("sqrtPriceX96FromPrice", () => {
  // The inverse of priceFromSqrtPriceX96: a spread of prices, decimal pairings (including
  // unequal decimals in both directions) and both token orientations, round-tripped through
  // both functions and checked back against the original price within 1e-9 relative — the
  // precision the port promises (see the function's doc comment), not the ~1e-16 double gives
  // priceFromSqrtPriceX96 alone.
  const cases: { price: number; decimals0: number; decimals1: number }[] = [
    { price: 1, decimals0: 18, decimals1: 18 },
    { price: 4, decimals0: 18, decimals1: 18 },
    { price: 0.25, decimals0: 18, decimals1: 18 },
    { price: 1e12, decimals0: 18, decimals1: 6 },
    { price: 0.0008658, decimals0: 18, decimals1: 18 }, // the AI/NVDA pool price above
    { price: 224.4, decimals0: 18, decimals1: 18 },
    { price: 3000, decimals0: 6, decimals1: 18 },
    { price: 1e-6, decimals0: 6, decimals1: 18 },
    { price: 5.5e7, decimals0: 18, decimals1: 8 },
    { price: 1e-15, decimals0: 18, decimals1: 18 },
    { price: 1e18, decimals0: 0, decimals1: 18 },
  ];

  it("round-trips through priceFromSqrtPriceX96 within 1e-9 relative", () => {
    for (const { price, decimals0, decimals1 } of cases) {
      for (const tokenIsCurrency0 of [true, false]) {
        const sqrtPriceX96 = sqrtPriceX96FromPrice(price, decimals0, decimals1, tokenIsCurrency0);
        const roundTripped = priceFromSqrtPriceX96(sqrtPriceX96, decimals0, decimals1, tokenIsCurrency0);
        const rel = Math.abs(roundTripped - price) / price;
        expect(
          rel,
          `price=${price} decimals0=${decimals0} decimals1=${decimals1} tokenIsCurrency0=${tokenIsCurrency0}`,
        ).toBeLessThan(1e-9);
      }
    }
  });

  it("throws for zero, negative, NaN and infinite prices", () => {
    expect(() => sqrtPriceX96FromPrice(0, 18, 18, true)).toThrow();
    expect(() => sqrtPriceX96FromPrice(-1, 18, 18, true)).toThrow();
    expect(() => sqrtPriceX96FromPrice(-0.0008658, 18, 18, false)).toThrow();
    expect(() => sqrtPriceX96FromPrice(NaN, 18, 18, true)).toThrow();
    expect(() => sqrtPriceX96FromPrice(Infinity, 18, 18, true)).toThrow();
    expect(() => sqrtPriceX96FromPrice(-Infinity, 18, 18, false)).toThrow();
  });
});
