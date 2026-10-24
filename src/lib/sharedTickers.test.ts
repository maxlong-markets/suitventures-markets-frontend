import { describe, expect, it } from "vitest";
import { isStockQuote, sharedTickers } from "./sharedTickers";
import type { QuoteAsset, TokenPair } from "./types";

const pair = (id: string, ticker: string) => ({ id, ticker }) as TokenPair;

describe("sharedTickers", () => {
  it("flags a ticker used by two different tokens, case-insensitively", () => {
    const s = sharedTickers([pair("0xa", "NVIDIA"), pair("0xb", "nvidia"), pair("0xc", "AI")]);
    expect([...s]).toEqual(["NVIDIA"]);
  });

  it("does not flag one token that appears twice", () => {
    expect(sharedTickers([pair("0xa", "AI"), pair("0xa", "AI")]).size).toBe(0);
  });

  it("ignores blank tickers", () => {
    expect(sharedTickers([pair("0xa", " "), pair("0xb", "")]).size).toBe(0);
  });
});

describe("isStockQuote", () => {
  it("matches Robinhood stock tokens only", () => {
    expect(isStockQuote({ symbol: "AAPL", name: "Apple • Robinhood Token" } as QuoteAsset)).toBe(true);
    expect(isStockQuote({ symbol: "NVDA", name: "NVIDIA" } as QuoteAsset)).toBe(true);
    expect(isStockQuote({ symbol: "WETH", name: "Wrapped Ether" } as QuoteAsset)).toBe(false);
    expect(isStockQuote({ symbol: "USDG", name: "Global Dollar" } as QuoteAsset)).toBe(false);
  });
});
