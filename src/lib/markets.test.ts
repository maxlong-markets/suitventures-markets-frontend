import { describe, it, expect } from "vitest";
import { DEFAULT_FILTERS, ORIGIN_OPTIONS, originLabel, selectPairs } from "./markets";
import type { TokenPair } from "./types";

function pair(over: Partial<TokenPair>): TokenPair {
  return {
    id: "0xa", ticker: "A", name: "A", address: "0xa", quote: "NVDA", origin: "LONG", tradeable: true,
    priceUsd: 1, priceQuote: 0.01, change1h: 1, change24h: 5, vol24h: 100, mcap: 10, fdv: 10, liquidity: 20000,
    holders: 1, createdAt: 0, bull: 0, bear: 0, poolId: "0x1", hook: "None", hookAddress: "0x0", feeTier: "0.30%", ...over,
  };
}

describe("selectPairs with null fields", () => {
  it("excludes null 24h change from Gainers", () => {
    const rows = selectPairs([pair({ id: "0xa", change24h: null }), pair({ id: "0xb", change24h: 3 })], { ...DEFAULT_FILTERS, preset: "gainers", sortKey: "h24", sortDir: "desc" }, 1_000);
    expect(rows.map((r) => r.id)).toEqual(["0xb"]);
  });
  it("sorts nulls last in both directions", () => {
    const list = [pair({ id: "0xa", liquidity: null }), pair({ id: "0xb", liquidity: 5 }), pair({ id: "0xc", liquidity: 9 })];
    expect(selectPairs(list, { ...DEFAULT_FILTERS, sortKey: "liq", sortDir: "desc" }, 1_000).map((r) => r.id)).toEqual(["0xc", "0xb", "0xa"]);
    expect(selectPairs(list, { ...DEFAULT_FILTERS, sortKey: "liq", sortDir: "asc" }, 1_000).map((r) => r.id)).toEqual(["0xb", "0xc", "0xa"]);
  });
  it("filters by origin", () => {
    const list = [pair({ id: "0xa", origin: "Pons" }), pair({ id: "0xb", origin: "Uniswap" })];
    expect(selectPairs(list, { ...DEFAULT_FILTERS, origin: "Uniswap" }, 1_000).map((r) => r.id)).toEqual(["0xb"]);
  });
  it("offers SV in the origin filter and keeps only launches when it is picked (instant launchpad design, 7.4)", () => {
    expect(ORIGIN_OPTIONS.map((o) => o.key)).toContain("SV");
    const list = [pair({ id: "0xa", origin: "SV" }), pair({ id: "0xb", origin: "LONG" })];
    expect(selectPairs(list, { ...DEFAULT_FILTERS, origin: "SV" }, 1_000).map((r) => r.id)).toEqual(["0xa"]);
  });
});

describe("origin labels (amended 30 Sep 2026)", () => {
  it("puts the SUITS chip second, right after All, and prints every other origin in capitals", () => {
    expect(ORIGIN_OPTIONS.map((o) => [o.key, o.label])).toEqual([
      ["all", "All"],
      ["SV", "SUITS"],
      ["LONG", "LONG"],
      ["Pons", "PONS"],
      ["Uniswap", "UNISWAP"],
      ["Other", "OTHER"],
    ]);
  });

  it("names a token launched here SUITS, and every other origin by its own name in capitals", () => {
    expect(originLabel("SV")).toBe("SUITS");
    expect(originLabel("LONG")).toBe("LONG");
    expect(originLabel("Pons")).toBe("PONS");
    expect(originLabel("Uniswap")).toBe("UNISWAP");
    expect(originLabel("Other")).toBe("OTHER");
    expect(originLabel("SUIT")).toBe("SUIT");
  });

  it("gives every chip the same word the row badge prints", () => {
    for (const o of ORIGIN_OPTIONS) if (o.key !== "all") expect(o.label).toBe(originLabel(o.key));
  });
});
