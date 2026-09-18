import { describe, expect, it } from "vitest";
import { poolKeyRow, type PoolKeyParts } from "./poolKey";

/**
 * The real AI/NVDA pool, in the indexer's own casing: ids lowercase, `Token.address` and
 * `Quote.address` checksummed. These are the fixtures' constants, and the only pool key that
 * hashes to this pool id — see the header's verified facts.
 */
const parts: PoolKeyParts = {
  poolId: "0xCBDFEA90430A30EE4469C9902E120A77E7C7E4711D5643671C1D1957F2F1CE27",
  hooks: "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544",
  fee: 8388608,
  tickSpacing: 8,
  tokenIsCurrency0: true,
  priceQuote: 0.000866,
  tokenAddress: "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18",
  tokenDecimals: 18,
  quoteAddress: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  quoteDecimals: 18,
};
const AI = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";

describe("poolKeyRow", () => {
  it("lowercases every address, so a row from the store equals a row from the indexer", () => {
    expect(poolKeyRow(parts)).toEqual({
      poolId: "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27",
      currency0: AI,
      currency1: NVDA,
      fee: 8388608,
      tickSpacing: 8,
      hooks: "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544",
      tokenIsCurrency0: true,
      priceQuote: 0.000866,
      tokenAddress: AI,
      tokenDecimals: 18,
      quoteAddress: NVDA,
      quoteDecimals: 18,
    });
  });

  it("orders the currencies by the flag the pool was created with, never by a string comparison", () => {
    expect(poolKeyRow({ ...parts, tokenIsCurrency0: false })).toMatchObject({
      currency0: NVDA,
      currency1: AI,
      tokenIsCurrency0: false,
      tokenAddress: AI,
      quoteAddress: NVDA,
    });
  });

  it("carries the fields the chain never sees: the stored price and both decimals", () => {
    const row = poolKeyRow({ ...parts, priceQuote: 0.5, tokenDecimals: 8, quoteDecimals: 6 });
    expect(row).toMatchObject({ priceQuote: 0.5, tokenDecimals: 8, quoteDecimals: 6 });
  });
});
