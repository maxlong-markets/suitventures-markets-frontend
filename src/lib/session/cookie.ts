import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { nowSec } from "@/lib/time";
import type { Address } from "@/lib/types";

export const SESSION_COOKIE = "svm_session";
export const NONCE_COOKIE = "svm_nonce";
export const SESSION_TTL_SEC = 7 * 86_400;
export const NONCE_TTL_SEC = 600;

/** The address is always lowercase: it is the only identity the user routes trust, and the primary key of every row the user owns. */
export type SessionPayload = { address: Address; iat: number; exp: number };

const LOWER_ADDRESS = /^0x[0-9a-f]{40}$/;

const mac = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("base64url");

/** `base64url(json).base64url(hmac-sha256)`. The MAC covers the encoded body, so nothing depends on key order surviving a round trip. */
function seal(value: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${body}.${mac(body, secret)}`;
}

/** The parsed body of a token whose signature matches, else null. */
function open(token: string, secret: string): unknown {
  const dot = token.indexOf(".");
  if (dot <= 0 || token.indexOf(".", dot + 1) !== -1) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "utf8");
  const want = Buffer.from(mac(body, secret), "utf8");
  // timingSafeEqual throws on a length mismatch, and the length of an HMAC is not a secret.
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function signSession(p: SessionPayload, secret: string): string {
  return seal({ address: p.address.toLowerCase(), iat: p.iat, exp: p.exp }, secret);
}

export function verifySession(token: string, secret: string, now: number): SessionPayload | null {
  const v = open(token, secret) as Partial<SessionPayload> | null;
  if (!v || typeof v.address !== "string" || typeof v.iat !== "number" || typeof v.exp !== "number") return null;
  if (!LOWER_ADDRESS.test(v.address)) return null;
  if (v.exp <= now) return null;
  return { address: v.address as Address, iat: v.iat, exp: v.exp };
}

/**
 * 16 CSPRNG bytes as hex: 32 alphanumeric characters, which is what EIP-4361 (and viem's own
 * `createSiweMessage`) requires. viem's `generateSiweNonce()` is deliberately not used: it is
 * `Math.random()` over a shared buffer whose index advances one character per call, so two
 * successive nonces overlap in 95 of their 96 characters.
 */
export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

/** The value of the `svm_nonce` cookie. The window travels inside the sealed body as well as in Max-Age, so a kept cookie still cannot outlive it. */
export function signNonce(nonce: string, secret: string): string {
  return seal({ n: nonce, exp: nowSec() + NONCE_TTL_SEC }, secret);
}

export function verifyNonce(token: string, secret: string, now: number): string | null {
  const v = open(token, secret) as { n?: unknown; exp?: unknown } | null;
  if (!v || typeof v.n !== "string" || typeof v.exp !== "number") return null;
  if (v.exp <= now) return null;
  return v.n;
}

/** `process.env.SESSION_SECRET`, null when unset or shorter than 32 characters (256 bits written as hex is 64). */
export function sessionSecret(): string | null {
  const secret = process.env.SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}
