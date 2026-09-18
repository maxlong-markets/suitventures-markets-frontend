import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "@/lib/db/client";
import { syncDeps } from "./deps";

// The real factory: getDb() only needs DATABASE_URL to be some parseable string — postgres.js connects lazily, so
// this never opens a socket (the same reasoning createQuoter() and createEnvioSource() rely on: constructing a
// client is not calling it). No PGlite here on purpose — this test is about what the factory *wires*, not the
// database it wires it to.
const FAKE_URL = "postgres://user:pass@localhost:54329/deps-test";

afterEach(() => {
  resetDb();
  vi.unstubAllEnvs();
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
});
