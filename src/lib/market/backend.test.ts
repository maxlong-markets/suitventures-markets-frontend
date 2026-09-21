import { afterEach, describe, expect, it, vi } from "vitest";
import { DbUnavailableError, resetDb } from "@/lib/db/client";
import { chainHeadFrom, getBackend, resetBackend } from "./backend";

describe("getBackend", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetBackend();
    resetDb();
  });

  it("uses the store when DATABASE_URL is set, and memoises", () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/market"); // never connected: the driver is lazy
    const b = getBackend();
    expect(b.kind).toBe("db");
    expect(getBackend()).toBe(b);
  });

  it("throws when DATABASE_URL is unset (Task 6: Envio is gone, so there is no fallback left to roll back to)", () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(() => getBackend()).toThrow(DbUnavailableError);
  });

  it("no longer reads MARKET_DATA_BACKEND: setting it to \"envio\" changes nothing", () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/market");
    vi.stubEnv("MARKET_DATA_BACKEND", "envio");
    expect(getBackend().kind).toBe("db");
  });
});

describe("chainHeadFrom (Task 6 review, MAJOR-1: health's lag must be the node's own head, not null)", () => {
  it("converts the chain client's own block number (a bigint) to the plain number chainHead wants", async () => {
    const client = { getBlockNumber: async () => 12_345n };
    await expect(chainHeadFrom(client)()).resolves.toBe(12_345);
  });

  it("lets a client failure propagate, so createDbBackend's own catch is what degrades it to lag: null", async () => {
    const client = { getBlockNumber: async () => { throw new Error("rpc unreachable"); } };
    await expect(chainHeadFrom(client)()).rejects.toThrow("rpc unreachable");
  });
});
