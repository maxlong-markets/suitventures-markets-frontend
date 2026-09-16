import { describe, it, expect } from "vitest";
import { windowQuery } from "./queries";
import { POOL, NOW } from "./fixtures";

describe("windowQuery", () => {
  it("refuses an empty pool list", () => {
    // `query Window {  }` is a parse error at the indexer, not an empty result.
    expect(() => windowQuery([], NOW)).toThrow("windowQuery needs at least one pool id");
  });
  it("refuses a pool id that is not 64 lowercase hex", () => {
    expect(() => windowQuery([POOL.toUpperCase()], NOW)).toThrow("bad pool id");
    expect(() => windowQuery(["0xcbdfea90"], NOW)).toThrow("bad pool id");
  });
  it("builds one aliased h1 selection per pool", () => {
    const q = windowQuery([POOL], NOW);
    expect(q).toContain("w0: Candle(");
    expect(q).toContain("-h1-%");
    expect(q).toContain("t: { _gte: 1757700000 }");
  });
});
