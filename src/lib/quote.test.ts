import { describe, it, expect } from "vitest";
import { localQuote, poolFeePctFor } from "./quote";
import type { TokenPair } from "./types";

const pair = {
  id: "0xa", ticker: "AI", name: "AI", address: "0xa", quote: "NVDA", origin: "LONG", tradeable: true,
  priceUsd: 0.1943, priceQuote: 0.000866, change1h: 0, change24h: 0, vol24h: 0, mcap: 0, fdv: 0, liquidity: 5_141_337,
  holders: 0, createdAt: 0, bull: 0, bear: 0, poolId: "0x1", hook: "", hookAddress: "0x0", feeTier: "",
} as TokenPair;

describe("poolFeePctFor", () => {
  it("reads a fixed tier from the pool itself, so a token launched here shows its 1 % and not the estimate", () => {
    expect(poolFeePctFor({ ...pair, origin: "SV", feeTier: "1.00%" })).toBe(1);
    expect(poolFeePctFor({ ...pair, origin: "Uniswap", feeTier: "0.05%" })).toBe(0.05);
    expect(poolFeePctFor({ ...pair, origin: "Pons", feeTier: "0.30%" })).toBe(0.3);
  });
  it("falls back to the estimate by origin for a dynamic fee or an unknown tier", () => {
    expect(poolFeePctFor({ ...pair, origin: "Pons", feeTier: "Dynamic" })).toBe(1);
    expect(poolFeePctFor({ ...pair, origin: "LONG", feeTier: "Dynamic" })).toBe(0.3);
    expect(poolFeePctFor({ ...pair, origin: "LONG", feeTier: "" })).toBe(0.3);
  });
});

describe("localQuote", () => {
  it("buys tokens with quote and applies fees", () => {
    const q = localQuote(pair, "buy", 100, "quote", true, 0.5);
    expect(q.receiveAmount).toBeCloseTo(100 / 0.000866, 3);
    expect(q.routerFeePct).toBe(0);
    expect(q.poolFeePct).toBe(0.3);
    expect(q.minReceived).toBeCloseTo(q.receiveAmount * (1 - 0.005 - 0.003), 6);
    const quoteUsd = 0.1943 / 0.000866;
    expect(q.priceImpactPct).toBeCloseTo(((100 * quoteUsd) / (5_141_337 / 2)) * 100, 6);
  });
  it("treats null liquidity as zero impact", () => {
    expect(localQuote({ ...pair, liquidity: null }, "buy", 100, "quote", false, 0.5).priceImpactPct).toBe(0);
  });
  it("sells tokens for quote and prices the impact in the token's own USD", () => {
    const q = localQuote({ ...pair, origin: "Pons" }, "sell", 1000, "token", false, 0.5);
    expect(q.payAmount).toBe(1000);
    expect(q.receiveAmount).toBeCloseTo(1000 * 0.000866, 9);
    expect(q.routerFeePct).toBe(0.5);
    expect(q.poolFeePct).toBe(1.0);
    expect(q.priceImpactPct).toBeCloseTo(((1000 * 0.1943) / (5_141_337 / 2)) * 100, 6);
  });
});
