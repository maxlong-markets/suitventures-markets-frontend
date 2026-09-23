import { afterEach, describe, expect, it, vi } from "vitest";
import { QUOTES } from "@/lib/chain/math/quotes";
import { resetDb } from "@/lib/db/client";
import { chainDeps, holdersDeps, setChainDeps, setHoldersDeps, setSyncDeps, syncDeps } from "./deps";

// The real factory: getDb() only needs DATABASE_URL to be some parseable string — postgres.js connects lazily, so
// this never opens a socket (the same reasoning createQuoter() and createHyperSyncSource()/createChainClient() rely
// on: constructing a client is not calling it). No PGlite here on purpose — this test is about what the factory
// *wires*, not the database it wires it to.
const FAKE_URL = "postgres://user:pass@localhost:54329/deps-test";

afterEach(() => {
  resetDb();
  vi.unstubAllEnvs();
  setSyncDeps(null);
  setChainDeps(null);
  setHoldersDeps(null);
});

describe("syncDeps (I2a: a severed probe is silent unless the wiring itself is tested)", () => {
  it("gives the nightly job a real Quoter", () => {
    vi.stubEnv("DATABASE_URL", FAKE_URL);
    const deps = syncDeps("nightly");
    expect(deps.quoter).toBeDefined();
    expect(typeof deps.quoter?.exactIn).toBe("function");
    expect(typeof deps.quoter?.exactOut).toBe("function");
  });
  it("gives the market job no Quoter", () => {
    vi.stubEnv("DATABASE_URL", FAKE_URL);
    const deps = syncDeps("market");
    expect(deps.quoter).toBeUndefined();
  });

  it("gives every job a dead EnvioSource stub whose methods throw if actually called (Task 6: Envio is gone)", async () => {
    vi.stubEnv("DATABASE_URL", FAKE_URL);
    const nightly = syncDeps("nightly");
    const market = syncDeps("market");
    expect(nightly.source.queries).toBe(0);
    expect(market.source.queries).toBe(0);
    await expect(nightly.source.quotes()).rejects.toThrow(/Envio was decommissioned/);
    await expect(market.source.chainMeta()).rejects.toThrow(/Envio was decommissioned/);
  });

  it("still honours setSyncDeps for tests", () => {
    const fake = { db: {} as never, source: {} as never };
    setSyncDeps(() => fake);
    expect(syncDeps("market")).toBe(fake);
    expect(syncDeps("nightly")).toBe(fake); // the override may ignore the job entirely
  });
});

describe("chainDeps", () => {
  it("builds a real HyperSync source, a real chain client and the quote allowlist mapped for readQuotePrices", () => {
    vi.stubEnv("DATABASE_URL", FAKE_URL);
    const deps = chainDeps();
    expect(typeof deps.source.head).toBe("function");
    expect(typeof deps.source.fetch).toBe("function");
    expect(deps.source.requests).toBe(0);
    expect(typeof deps.client.readContract).toBe("function");
    // 54 rows, 24 with a Chainlink proxy (Task 6 brief, measurement 2).
    expect(deps.quotes).toHaveLength(54);
    expect(deps.quotes.filter((q) => q.chainlinkProxy !== null)).toHaveLength(24);
    expect(deps.quotes[0]).toEqual({
      address: QUOTES[0]!.address, chainlinkProxy: QUOTES[0]!.chainlinkProxy, chainlinkDecimals: QUOTES[0]!.chainlinkDecimals,
    });
  });

  it("honours setChainDeps for tests", () => {
    const fake = { db: {} as never, source: {} as never, client: {} as never, quotes: [] };
    setChainDeps(() => fake);
    expect(chainDeps()).toBe(fake);
  });
});

describe("holdersDeps", () => {
  it("builds a real HyperSync source for the top-holder builder", () => {
    vi.stubEnv("DATABASE_URL", FAKE_URL);
    const deps = holdersDeps();
    expect(typeof deps.source.head).toBe("function");
    expect(typeof deps.source.transfers).toBe("function");
    expect(deps.source.requests).toBe(0);
  });

  it("honours setHoldersDeps for tests", () => {
    const fake = { db: {} as never, source: {} as never };
    setHoldersDeps(() => fake);
    expect(holdersDeps()).toBe(fake);
  });
});
