import { describe, expect, it } from "vitest";
import type { LaunchInfo, TokenPair } from "@/lib/types";
import { buildFactRows, feeTierNote } from "./tokenFacts";

const NOW = 1_800_000_000_000;
const PAIR = {
  id: "0xa", ticker: "AI", name: "Artificial Inu", address: "0x1234567890123456789012345678901234567890", quote: "NVDA", origin: "LONG",
  tradeable: true, priceUsd: 0.01234, priceQuote: 0.0000551, change1h: 1.23, change24h: -4.56, vol24h: 1_234_567, mcap: 9_876_543,
  fdv: 12_345_678, liquidity: 456_789, holders: 1_234, createdAt: NOW - 3 * 24 * 3_600_000, bull: 0, bear: 0, poolId: "0x1", hook: "",
  hookAddress: "0x0", feeTier: "0.30%",
} as unknown as TokenPair;

describe("buildFactRows", () => {
  it("puts the six figures the owner named first, in his order, and everything else after", () => {
    const rows = buildFactRows(PAIR, NOW);
    expect(rows.key.map((r) => r.label)).toEqual(["1h change", "24h change", "24h volume", "FDV", "Liquidity", "Holders"]);
    expect(rows.more.map((r) => r.label)).toEqual([
      "Ticker", "Name", "Token address", "Quote asset", "Origin", "Price (USD)", "Market cap", "Age", "Pool fee tier",
    ]);
  });

  it("colours the two changes and nothing else, and links only the token address", () => {
    const rows = buildFactRows(PAIR, NOW);
    expect(rows.key[0]!.toneClass).toContain("text-up");
    expect(rows.key[1]!.toneClass).toContain("text-down");
    expect([...rows.key.slice(2), ...rows.more].every((r) => r.toneClass === undefined)).toBe(true);
    expect([...rows.key, ...rows.more].filter((r) => r.href).map((r) => r.label)).toEqual(["Token address"]);
  });

  it("shows a dash, never a zero, for the USD figures of a stale pair", () => {
    const rows = buildFactRows({ ...PAIR, stale: true, vol24h: 0, fdv: 0, mcap: 0, priceUsd: 0 } as TokenPair, NOW);
    const value = (label: string) => [...rows.key, ...rows.more].find((r) => r.label === label)!.value;
    for (const label of ["24h volume", "FDV", "Market cap", "Price (USD)"]) expect(value(label)).toBe("—");
  });

  it("carries the pool fee sentence on the Pool fee tier row only", () => {
    const rows = buildFactRows(PAIR, NOW);
    expect(rows.more.at(-1)!.note).toBe("The pool charges 0.30% on every trade.");
    expect([...rows.key, ...rows.more.slice(0, -1)].every((r) => r.note === undefined)).toBe(true);
  });
});

describe("feeTierNote", () => {
  it("names the split only for a token launched here shown through its own launch pool", () => {
    const launch = { creatorShareBps: 7000 } as unknown as LaunchInfo;
    expect(feeTierNote({ ...PAIR, origin: "SV", feeTier: "1.00%", launch } as TokenPair)).toBe(
      "1.00% of every trade. The launch's locked liquidity earns this fee, and 70% of what it earns goes to the creator's payout address and 30% to MaxLong.",
    );
    expect(feeTierNote({ ...PAIR, origin: "Uniswap", feeTier: "0.30%", launch } as TokenPair)).toBe("The pool charges 0.30% on every trade.");
    expect(feeTierNote({ ...PAIR, feeTier: "Dynamic" } as TokenPair)).toBe(
      "The pool's hook sets the fee on each trade, so it can differ from one trade to the next.",
    );
  });
});
