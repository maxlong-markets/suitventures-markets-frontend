import { afterEach, describe, expect, it, vi } from "vitest";
import { DbUnavailableError } from "@/lib/db/client";
import { EnvioUnavailableError } from "@/lib/envio/client";
import { failure } from "./respond";

afterEach(() => vi.restoreAllMocks());

describe("failure", () => {
  it("answers 503 no-store with a retry hint for a database outage", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = failure(new DbUnavailableError("DATABASE_URL is not set"));
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("15");
    await expect(res.json()).resolves.toEqual({ error: "database unavailable" });
  });
  it("still answers 503 for the indexer and 500 for anything else", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(failure(new EnvioUnavailableError("indexer responded 429")).status).toBe(503);
    expect(failure(new Error("boom")).status).toBe(500);
  });
});
