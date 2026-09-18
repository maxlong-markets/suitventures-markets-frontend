import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, SESSION_TTL_SEC, signSession } from "@/lib/session/cookie";
import { nowSec } from "@/lib/time";
import type { Address } from "@/lib/types";
import { cookieValue, readSession, requireSession } from "./session";

const SECRET = "0123456789abcdef0123456789abcdef";
const ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as Address;
const token = (over: Partial<{ address: Address; iat: number; exp: number }> = {}) =>
  signSession({ address: ADDR, iat: nowSec(), exp: nowSec() + SESSION_TTL_SEC, ...over }, SECRET);
const req = (cookie?: string) => new Request("http://localhost:3000/api/me/watchlist", { headers: cookie ? { cookie } : {} });

beforeEach(() => vi.stubEnv("SESSION_SECRET", SECRET));
afterEach(() => vi.unstubAllEnvs());

describe("cookieValue", () => {
  it("reads one cookie out of a header, whitespace and neighbours and all", () => {
    expect(cookieValue("a=1; svm_session=xyz; b=2", SESSION_COOKIE)).toBe("xyz");
    expect(cookieValue("svm_session=xyz", SESSION_COOKIE)).toBe("xyz");
    expect(cookieValue("  svm_session = xyz ", SESSION_COOKIE)).toBe("xyz");
    expect(cookieValue("svm_session%20", SESSION_COOKIE)).toBeNull();
    expect(cookieValue("svm_session_other=xyz", SESSION_COOKIE)).toBeNull();
    expect(cookieValue("novalue", SESSION_COOKIE)).toBeNull();
    expect(cookieValue(null, SESSION_COOKIE)).toBeNull();
  });

  it("treats a cookie that is not valid percent-encoding as absent instead of throwing", () => {
    // `decodeURIComponent("%")` throws `URIError`. A cookie is attacker-supplied text and this
    // function is called outside every route's `try`, so an un-guarded decode is a 500 anyone
    // can trigger with one character.
    expect(cookieValue("svm_session=%", SESSION_COOKIE)).toBeNull();
    expect(cookieValue("a=1; svm_session=%ZZ; b=2", SESSION_COOKIE)).toBeNull();
    expect(cookieValue("svm_session=%E0%A4%A", SESSION_COOKIE)).toBeNull();
    // Valid escapes still decode.
    expect(cookieValue("svm_session=a%2Eb", SESSION_COOKIE)).toBe("a.b");
  });
});

describe("readSession", () => {
  it("answers the payload for a valid cookie", () => {
    expect(readSession(req(`${SESSION_COOKIE}=${token()}`))?.address).toBe(ADDR);
  });
  it("answers null without a cookie, with junk, with an expired token and with the wrong secret", () => {
    expect(readSession(req())).toBeNull();
    expect(readSession(req(`${SESSION_COOKIE}=junk`))).toBeNull();
    expect(readSession(req(`${SESSION_COOKIE}=${token({ exp: nowSec() - 1 })}`))).toBeNull();
    vi.stubEnv("SESSION_SECRET", "fedcba9876543210fedcba9876543210");
    expect(readSession(req(`${SESSION_COOKIE}=${token()}`))).toBeNull();
  });
  it("answers null while SESSION_SECRET is unset, without reading the cookie", () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    expect(readSession(req(`${SESSION_COOKIE}=${token()}`))).toBeNull();
  });
});

describe("requireSession", () => {
  it("hands back the payload when the cookie is good", () => {
    const result = requireSession(req(`${SESSION_COOKIE}=${token()}`));
    expect(result).not.toBeInstanceOf(Response);
    expect((result as { address: Address }).address).toBe(ADDR);
  });

  it("answers 401 without a session", async () => {
    const res = requireSession(req());
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
    expect((res as Response).headers.get("Cache-Control")).toBe("no-store");
    await expect((res as Response).json()).resolves.toEqual({ error: "not signed in" });
  });

  it("answers 503 while SESSION_SECRET is unset, so an unconfigured deploy reads as unconfigured and not as signed out", async () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    const res = requireSession(req(`${SESSION_COOKIE}=${token()}`)) as Response;
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("60");
    await expect(res.json()).resolves.toEqual({ error: "sessions not configured" });
  });

  it("answers 401, not 500, for a corrupt cookie", async () => {
    // The whole reason `cookieValue` guards its decode: this header reaches `requireSession`
    // before any route's `try`, so an exception here would be a 500 from every /api/me/* route.
    const res = requireSession(req(`${SESSION_COOKIE}=%`)) as Response;
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "not signed in" });
  });
});
