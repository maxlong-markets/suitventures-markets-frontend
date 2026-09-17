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
  it("logs only the name, code and message of an unexpected error, never the object (a driver error carries its query and parameters)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = Object.assign(new Error("boom"), { code: "XX000", query: "select secret", parameters: ["postgres://u:p@host/db"] });
    const res = failure(err);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "internal error" });
    expect(error.mock.calls).toEqual([["internal error: Error (XX000): boom"]]);
    error.mockClear();
    expect(failure(new TypeError("no code")).status).toBe(500);
    expect(failure("a thrown string").status).toBe(500);
    expect(error.mock.calls).toEqual([["internal error: TypeError: no code"], ["internal error: a thrown string"]]);
  });
});
