import { describe, expect, it } from "vitest";
import { buildBrief } from "./brief";
import type { QuoteAsset, TokenPair } from "./types";

const pair = (id: string, over: Partial<TokenPair>) =>
  ({ id, ticker: id, vol24h: 0, change24h: null, createdAt: 0, stale: false, ...over }) as TokenPair;
const quote = (symbol: string, pairs: number) => ({ symbol, name: symbol, pairs, vol24h: 0 }) as QuoteAsset;

describe("buildBrief", () => {
  it("picks the gainer, the volume leader, the newest pair and the busiest stock", () => {
    const b = buildBrief(
      [
        pair("a", { vol24h: 100, change24h: 50, createdAt: 1 }),
        pair("b", { vol24h: 900, change24h: 5, createdAt: 2 }),
        pair("c", { vol24h: 0, change24h: 900, createdAt: 3 }),
      ],
      [quote("NVDA", 10), quote("TSLA", 40), quote("WETH", 900)],
    );
    expect(b.map((i) => i.pair?.id ?? i.quote?.symbol)).toEqual(["a", "b", "c", "TSLA"]);
  });

  it("leaves out volume cards when nothing traded, instead of showing zeros", () => {
    const b = buildBrief([pair("a", { createdAt: 5 })], []);
    expect(b.map((i) => i.key)).toEqual(["newest"]);
  });

  it("ignores stale pairs for the gainer and volume cards", () => {
    const b = buildBrief([pair("a", { vol24h: 10, change24h: 10, stale: true })], []);
    expect(b.map((i) => i.key)).toEqual(["newest"]);
  });
});
