import { describe, expect, it } from "vitest";
import { HOLDER_FEE_BPS, ROUTER_FEE_BPS, feeFor, grossUp, priceImpactPct, toBase, toHuman, withSlippage } from "./math";

const ONE = 10n ** 18n;

describe("feeFor", () => {
  it("takes 0.5 % from everyone and nothing from a Suits holder", () => {
    expect(ROUTER_FEE_BPS).toBe(50);
    expect(HOLDER_FEE_BPS).toBe(0);
    expect(feeFor(1_000_000n, ROUTER_FEE_BPS)).toEqual({ fee: 5_000n, net: 995_000n });
    expect(feeFor(1_000_000n, HOLDER_FEE_BPS)).toEqual({ fee: 0n, net: 1_000_000n });
  });

  it("floors the fee, exactly as the contract's integer division does", () => {
    expect(feeFor(199n, 50)).toEqual({ fee: 0n, net: 199n }); // 0.995 wei
    expect(feeFor(200n, 50)).toEqual({ fee: 1n, net: 199n });
    expect(feeFor(399n, 50)).toEqual({ fee: 1n, net: 398n }); // 1.995 wei
  });

  it("leaves one wei whole: the smallest trade pays nothing rather than everything", () => {
    expect(feeFor(1n, 50)).toEqual({ fee: 0n, net: 1n });
    expect(feeFor(0n, 50)).toEqual({ fee: 0n, net: 0n });
  });

  it("holds at 18 decimals with no float in sight", () => {
    expect(feeFor(ONE, 50)).toEqual({ fee: 5n * 10n ** 15n, net: 995n * 10n ** 15n });
    expect(feeFor(2n ** 200n, 50).fee + feeFor(2n ** 200n, 50).net).toBe(2n ** 200n);
  });

  it("refuses a negative amount and a fee that is not an integer in 0..9999", () => {
    expect(() => feeFor(-1n, 50)).toThrow(RangeError);
    expect(() => feeFor(100n, -1)).toThrow(RangeError);
    expect(() => feeFor(100n, 10_000)).toThrow(RangeError);
    expect(() => feeFor(100n, 0.5)).toThrow(RangeError);
    expect(() => feeFor(100n, Number.NaN)).toThrow(RangeError);
  });
});

describe("grossUp", () => {
  it("inverts feeFor exactly when the division is exact", () => {
    expect(grossUp(995_000n, 50)).toBe(1_000_000n);
    expect(feeFor(grossUp(995_000n, 50), 50).net).toBe(995_000n);
    expect(grossUp(995n, 50)).toBe(1_000n);
  });

  it("ceilings, so the pool is never a wei short of the net the quote promised", () => {
    expect(grossUp(1n, 50)).toBe(2n); // 1.005… wei
    expect(grossUp(996n, 50)).toBe(1_002n); // 1001.005… wei
    for (const net of [1n, 7n, 996n, 12_345n, ONE, ONE + 1n]) {
      expect(feeFor(grossUp(net, 50), 50).net).toBeGreaterThanOrEqual(net);
    }
  });

  it("is the identity for a holder, and zero grosses up to zero", () => {
    expect(grossUp(1_234n, HOLDER_FEE_BPS)).toBe(1_234n);
    expect(grossUp(0n, 50)).toBe(0n);
  });

  it("refuses a negative net and a 100 % fee, which has no gross", () => {
    expect(() => grossUp(-1n, 50)).toThrow(RangeError);
    expect(() => grossUp(1n, 10_000)).toThrow(RangeError);
  });
});

describe("withSlippage", () => {
  it("floors the minimum the user will accept", () => {
    expect(withSlippage(1_000_000n, 50)).toBe(995_000n);
    expect(withSlippage(1_000_000n, 100)).toBe(990_000n);
    expect(withSlippage(199n, 50)).toBe(198n); // 198.005
    expect(withSlippage(1n, 1)).toBe(0n); // one wei at any tolerance: zero is the honest floor
  });

  it("is the identity at zero and nothing at 100 %", () => {
    expect(withSlippage(1_234n, 0)).toBe(1_234n);
    expect(withSlippage(1_234n, 10_000)).toBe(0n);
  });

  it("refuses more than 100 %, a negative and a fraction", () => {
    expect(() => withSlippage(1_234n, 10_001)).toThrow(RangeError);
    expect(() => withSlippage(1_234n, -1)).toThrow(RangeError);
    expect(() => withSlippage(1_234n, 12.5)).toThrow(RangeError);
    expect(() => withSlippage(-1n, 50)).toThrow(RangeError);
  });
});

describe("toBase", () => {
  it("scales a decimal string by the token's decimals", () => {
    expect(toBase("1", 18)).toBe(ONE);
    expect(toBase("0.5", 18)).toBe(5n * 10n ** 17n);
    expect(toBase("1.5", 6)).toBe(1_500_000n);
    expect(toBase("0", 18)).toBe(0n);
    expect(toBase("123", 0)).toBe(123n);
  });

  it("accepts the shapes a keyboard produces", () => {
    expect(toBase(".5", 6)).toBe(500_000n);
    expect(toBase("1.", 6)).toBe(1_000_000n);
    expect(toBase("0001.500", 6)).toBe(1_500_000n);
  });

  it("truncates past the token's decimals, so 100 % of a balance can never exceed it", () => {
    expect(toBase("1.2345678", 6)).toBe(1_234_567n);
    expect(toBase("0.9999999", 6)).toBe(999_999n);
    expect(toBase("0.0000001", 6)).toBe(0n);
  });

  it("holds a uint256-sized number exactly", () => {
    expect(toBase("115792089237316195423570985008687907853269984665640564039457.584007913129639935", 18)).toBe(2n ** 256n - 1n);
  });

  it("throws RangeError on junk, including the shapes Number() would happily accept", () => {
    for (const bad of ["", " ", ".", "-1", "+1", "1e18", "1E18", "1.2.3", "abc", "0x1", "1 000", "1,000", "Infinity", "NaN", "1n"]) {
      expect(() => toBase(bad, 18)).toThrow(RangeError);
    }
  });

  it("throws RangeError on impossible decimals", () => {
    expect(() => toBase("1", -1)).toThrow(RangeError);
    expect(() => toBase("1", 1.5)).toThrow(RangeError);
    expect(() => toBase("1", 78)).toThrow(RangeError);
  });
});

describe("toHuman", () => {
  it("is the inverse of toBase", () => {
    for (const [base, decimals] of [[ONE, 18], [1n, 18], [1_500_000n, 6], [0n, 18], [123n, 0], [2n ** 256n - 1n, 18]] as const) {
      expect(toBase(toHuman(base, decimals), decimals)).toBe(base);
    }
  });

  it("never produces exponent notation, however small or large", () => {
    expect(toHuman(1n, 18)).toBe("0.000000000000000001");
    expect(toHuman(10n ** 30n, 18)).toBe("1000000000000");
    expect(toHuman(2n ** 256n - 1n, 18)).toBe("115792089237316195423570985008687907853269984665640564039457.584007913129639935");
    // What the route would have sent if a float had held the amount.
    expect(String(Number(toHuman(1n, 18)))).toContain("e");
    expect(toHuman(1n, 18)).not.toContain("e");
  });

  it("strips trailing zeros and the point with them", () => {
    expect(toHuman(0n, 18)).toBe("0");
    expect(toHuman(1_000_000n, 6)).toBe("1");
    expect(toHuman(1_500_000n, 6)).toBe("1.5");
    expect(toHuman(1_234_567n, 6)).toBe("1.234567");
    expect(toHuman(123n, 0)).toBe("123");
  });

  it("prints a sign, though toBase never accepts one", () => {
    expect(toHuman(-1_500_000n, 6)).toBe("-1.5");
  });

  it("refuses impossible decimals", () => {
    expect(() => toHuman(1n, -1)).toThrow(RangeError);
    expect(() => toHuman(1n, 1.5)).toThrow(RangeError);
  });
});

describe("priceImpactPct", () => {
  it("is zero when the realised rate equals the pool's stored price", () => {
    // Stored price 2 quote per token. Buy: 2 quote in, 1 token out.
    expect(priceImpactPct(2n * ONE, ONE, 18, 18, 2, true)).toBeCloseTo(0, 12);
    // Sell: 1 token in, 2 quote out.
    expect(priceImpactPct(ONE, 2n * ONE, 18, 18, 2, false)).toBeCloseTo(0, 12);
  });

  it("is positive when the swap is worse than the stored price, in both directions", () => {
    expect(priceImpactPct(21n * 10n ** 17n, ONE, 18, 18, 2, true)).toBeCloseTo(5, 12); // paid 2.1 for one token
    expect(priceImpactPct(ONE, 19n * 10n ** 17n, 18, 18, 2, false)).toBeCloseTo((2 / 1.9 - 1) * 100, 12);
  });

  it("is negative when a stale stored price reads worse than the pool", () => {
    expect(priceImpactPct(19n * 10n ** 17n, ONE, 18, 18, 2, true)).toBeCloseTo(-5, 12);
  });

  it("scales each side by its own decimals", () => {
    // 2.1 USDG (6 decimals) for one 18-decimal token, stored price 2.
    expect(priceImpactPct(2_100_000n, ONE, 6, 18, 2, true)).toBeCloseTo(5, 12);
  });

  it("returns 0 rather than Infinity or NaN on a degenerate input", () => {
    expect(priceImpactPct(0n, ONE, 18, 18, 2, true)).toBe(0);
    expect(priceImpactPct(ONE, 0n, 18, 18, 2, true)).toBe(0);
    expect(priceImpactPct(ONE, ONE, 18, 18, 0, true)).toBe(0);
    expect(priceImpactPct(ONE, ONE, 18, 18, Number.NaN, false)).toBe(0);
  });
});
