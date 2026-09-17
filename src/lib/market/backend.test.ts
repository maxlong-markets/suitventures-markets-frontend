import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "@/lib/db/client";
import { getBackend, resetBackend } from "./backend";

describe("getBackend", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetBackend();
    resetDb();
  });

  it("uses Envio when DATABASE_URL is unset", () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("MARKET_DATA_BACKEND", "");
    expect(getBackend().kind).toBe("envio");
  });

  it("uses the store when DATABASE_URL is set, and memoises", () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/market"); // never connected: the driver is lazy
    vi.stubEnv("MARKET_DATA_BACKEND", "");
    const b = getBackend();
    expect(b.kind).toBe("db");
    expect(getBackend()).toBe(b);
  });

  it("rolls back to Envio when MARKET_DATA_BACKEND is envio", () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/market");
    vi.stubEnv("MARKET_DATA_BACKEND", "envio");
    expect(getBackend().kind).toBe("envio");
  });
});
