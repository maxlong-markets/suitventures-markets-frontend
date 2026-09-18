import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address } from "@/lib/types";
import {
  NONCE_COOKIE,
  NONCE_TTL_SEC,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  newNonce,
  sessionSecret,
  signNonce,
  signSession,
  verifyNonce,
  verifySession,
} from "./cookie";

const SECRET = "0123456789abcdef0123456789abcdef"; // exactly 32 characters, the minimum
const OTHER = "fedcba9876543210fedcba9876543210";
const ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as Address;
const MIXED = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const NOW = 1_789_000_000;

/** The wire format, written out once here so the test pins it rather than trusting the module. */
const forge = (json: string, secret = SECRET) => {
  const body = Buffer.from(json, "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("session cookie", () => {
  it("names the two cookies and their lifetimes", () => {
    expect(SESSION_COOKIE).toBe("svm_session");
    expect(NONCE_COOKIE).toBe("svm_nonce");
    expect(SESSION_TTL_SEC).toBe(604_800);
    expect(NONCE_TTL_SEC).toBe(600);
  });

  it("round-trips a payload, lowercases the address and uses base64url(payload).base64url(hmac)", () => {
    const token = signSession({ address: MIXED, iat: NOW, exp: NOW + SESSION_TTL_SEC }, SECRET);
    expect(token).toBe(forge(JSON.stringify({ address: ADDR, iat: NOW, exp: NOW + SESSION_TTL_SEC })));
    expect(token.split(".")).toHaveLength(2);
    expect(verifySession(token, SECRET, NOW)).toEqual({ address: ADDR, iat: NOW, exp: NOW + SESSION_TTL_SEC });
  });

  it("refuses a tampered body, a tampered signature, the wrong secret and anything that is not a token", () => {
    const token = signSession({ address: ADDR, iat: NOW, exp: NOW + 60 }, SECRET);
    const [body, sig] = token.split(".");
    const other = signSession({ address: `0x${"22".repeat(20)}` as Address, iat: NOW, exp: NOW + 60 }, SECRET);
    const [otherBody, otherSig] = other.split(".");
    expect(verifySession(`${otherBody}.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifySession(`${body}.${otherSig}`, SECRET, NOW)).toBeNull();
    expect(verifySession(token, OTHER, NOW)).toBeNull();
    expect(verifySession(`${body}.${sig}x`, SECRET, NOW)).toBeNull(); // different length: no throw from timingSafeEqual
    expect(verifySession(body, SECRET, NOW)).toBeNull();
    expect(verifySession(`${body}.${sig}.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifySession("", SECRET, NOW)).toBeNull();
    expect(verifySession(".", SECRET, NOW)).toBeNull();
  });

  it("refuses a correctly signed token whose payload is not a session", () => {
    for (const junk of [
      "null",
      '"hello"',
      "{}",
      '{"address":"nope","iat":1,"exp":9999999999}',
      `{"address":"${MIXED}","iat":1,"exp":9999999999}`, // checksummed: the identity must be lowercase
      `{"address":"${ADDR}","iat":"1","exp":9999999999}`,
      "not json at all",
    ]) {
      expect(verifySession(forge(junk), SECRET, NOW)).toBeNull();
    }
  });

  it("refuses a token at and after its expiry", () => {
    const token = signSession({ address: ADDR, iat: NOW, exp: NOW + 60 }, SECRET);
    expect(verifySession(token, SECRET, NOW + 59)).not.toBeNull();
    expect(verifySession(token, SECRET, NOW + 60)).toBeNull();
    expect(verifySession(token, SECRET, NOW + 61)).toBeNull();
  });

  it("mints an EIP-4361-shaped nonce that never repeats or overlaps", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => newNonce()));
    expect(nonces.size).toBe(50);
    for (const n of nonces) expect(n).toMatch(/^[0-9a-f]{32}$/);
  });

  it("round-trips a nonce and expires it after ten minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const nonce = newNonce();
    const token = signNonce(nonce, SECRET);
    expect(verifyNonce(token, SECRET, NOW)).toBe(nonce);
    expect(verifyNonce(token, SECRET, NOW + NONCE_TTL_SEC - 1)).toBe(nonce);
    expect(verifyNonce(token, SECRET, NOW + NONCE_TTL_SEC)).toBeNull();
    expect(verifyNonce(token, OTHER, NOW)).toBeNull();
    expect(verifyNonce(forge('{"n":"abc"}'), SECRET, NOW)).toBeNull();
  });

  it("reads SESSION_SECRET only when it is long enough to be a key", () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    expect(sessionSecret()).toBeNull();
    vi.stubEnv("SESSION_SECRET", "");
    expect(sessionSecret()).toBeNull();
    vi.stubEnv("SESSION_SECRET", "x".repeat(31));
    expect(sessionSecret()).toBeNull();
    vi.stubEnv("SESSION_SECRET", "x".repeat(32));
    expect(sessionSecret()).toBe("x".repeat(32));
  });
});
