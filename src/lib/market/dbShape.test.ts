import { describe, expect, it } from "vitest";
import { pairFromRow, type PairRow } from "./dbShape";

const NOW = 1_800_000_000;

/** A minimal, fully-formed row; each test overrides only the field it cares about. */
const row: PairRow = {
  id: "0xa", symbol: "AAA", name: "AAA token", address: "0xa", decimals: 18,
  total_supply: "1000000000000000000000000000", holders_count: 10,
  pool_id: "0xpool", quote_id: "0xquote", pool_origin: "LONG",
  hooks: "0x4E3468951D49F2EEA976ED0D6E75FFCB44A9A544", fee: 3000, pool_created_at: NOW - 1000,
  price_quote: 0.5, tvl_token: "1000000000000000000000", tvl_quote: "1000000000000000000000",
  routable: null,
  quote_symbol: "NVDA", quote_decimals: 18, usd_price: 100, usd_updated_at: NOW - 60, aggregator: "0xfeed",
};

describe("pairFromRow tradeable", () => {
  it("routable: true reads tradeable: true", () => {
    expect(pairFromRow({ ...row, routable: true }, undefined, NOW).tradeable).toBe(true);
  });

  it("routable: false reads tradeable: false", () => {
    expect(pairFromRow({ ...row, routable: false }, undefined, NOW).tradeable).toBe(false);
  });

  it("routable: null (never probed) reads tradeable: true — optimistic, not hidden for lack of a probe", () => {
    expect(pairFromRow({ ...row, routable: null }, undefined, NOW).tradeable).toBe(true);
  });
});

describe("pairFromRow hookAddress", () => {
  it("lowercases the listed pool's hooks field", () => {
    expect(pairFromRow(row, undefined, NOW).hookAddress).toBe("0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544");
  });

  it("is the zero address for a pool with no hook", () => {
    const zero = "0x0000000000000000000000000000000000000000";
    expect(pairFromRow({ ...row, hooks: zero }, undefined, NOW).hookAddress).toBe(zero);
  });
});
