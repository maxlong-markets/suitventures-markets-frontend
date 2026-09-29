import { describe, expect, it } from "vitest";
import { USDG } from "@/lib/chain/math/constants";
import { QUOTES } from "@/lib/chain/math/quotes";
import { CREATION_FEE, MAX_USD, MIN_USD, REFERENCE_PRICE_DECIMALS, currencyConfig } from "./currencyConfig";

const ZERO = "0x0000000000000000000000000000000000000000";

describe("currencyConfig (spec 8.3, the contracts script's canonical schema)", () => {
  const file = currencyConfig(QUOTES);

  it("carries the DEFAULT bounds and a zero creation fee, as a string, at the top level, and nothing else", () => {
    expect([MIN_USD, MAX_USD, CREATION_FEE, REFERENCE_PRICE_DECIMALS]).toEqual([5_000, 10_000_000, "0", 8]);
    expect(Object.keys(file)).toEqual(["minUsd", "maxUsd", "creationFee", "currencies"]);
    expect(file).toMatchObject({ minUsd: 5_000, maxUsd: 10_000_000, creationFee: "0" });
  });

  it("lists all 54 quotes.json rows, sorted by symbol, lowercase: 24 on a feed, USDG alone pinned, 29 waiting for a reference price", () => {
    expect(file.currencies).toHaveLength(54);
    expect(file.currencies.map((c) => c.symbol)).toEqual([...file.currencies.map((c) => c.symbol)].sort());
    const by = (source: string) => file.currencies.filter((c) => c.priceSource === source);
    expect(by("chainlink")).toHaveLength(24);
    const pinned = by("pinned");
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatchObject({ address: USDG, symbol: "USDG", decimals: 6, priceSource: "pinned", chainlinkProxy: ZERO, chainlinkDecimals: 0, referenceUsdPrice: "0" });
    expect(by("reference")).toHaveLength(29);
    for (const c of by("reference")) expect([c.chainlinkProxy, c.chainlinkDecimals, c.referenceUsdPrice]).toEqual([ZERO, 0, "0"]);
    for (const c of file.currencies) {
      expect(Object.keys(c)).toEqual(["address", "symbol", "decimals", "priceSource", "chainlinkProxy", "chainlinkDecimals", "referenceUsdPrice"]);
      expect(c.address).toBe(c.address.toLowerCase());
      expect(c.chainlinkProxy).toBe(c.chainlinkProxy.toLowerCase());
    }
    expect(file.currencies.find((c) => c.symbol === "AAPL")).toMatchObject({
      address: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9", symbol: "AAPL", decimals: 18, priceSource: "chainlink",
      chainlinkProxy: "0x6b22a786baa607d76728168703a39ea9c99f2cd0", chainlinkDecimals: 8, referenceUsdPrice: "0",
    });
  });
});
