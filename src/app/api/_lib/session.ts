import { isIP } from "node:net";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionSecret, verifySession, type SessionPayload } from "@/lib/session/cookie";
import { nowSec } from "@/lib/time";
import { unauthorized } from "./respond";

/**
 * One cookie's value out of a raw `Cookie` header. Route handlers are tested by calling them with a
 * plain `Request`, where `next/headers` has no request scope to read, so nothing here uses it.
 */
export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // `decodeURIComponent("%")` throws `URIError`, and this runs before every route's own
      // `try`: an un-guarded decode would turn one corrupt character into a 500 from every
      // /api/me/* route and from both session routes. A cookie that is not valid
      // percent-encoding is no cookie, which is the answer that makes them all say 401.
      return null;
    }
  }
  return null;
}

/**
 * The pre-auth rate-limit key: the first `x-forwarded-for` hop when it is an IP literal carrying no
 * zone id, else `x-real-ip` when it is, else `"unknown"`. On Vercel the platform's own proxy
 * overwrites `x-forwarded-for` with the client IP it actually saw and never forwards a
 * caller-supplied value, so on that deployment this key is not attacker-chosen. Behind no reverse
 * proxy at all (`next start` run directly, and every test here) neither header can be trusted, so
 * every caller shares the `"unknown"` bucket — that caps sign-in at roughly ten completions a
 * minute for the *entire process* (one nonce GET plus one session POST per sign-in, both spending
 * the same 20/min budget), not per caller. A real NAT egress collapses the same way: one office's
 * shared IP gets one budget for everyone behind it. A `%` anywhere in the candidate is rejected
 * outright rather than validated: `node:net`'s `isIP` accepts an IPv6 zone id (`::1%eth0`) and does
 * not check what follows the `%`, so validating it would let a caller mint an unlimited number of
 * distinct "valid" keys, each with its own fresh budget — the same amplification this key exists
 * to close, just moved from "any string" to "any string after a `%`".
 */
export function clientIp(req: Request): string {
  const candidate = (value: string | null): string | null => {
    const trimmed = value?.trim();
    return trimmed && !trimmed.includes("%") && isIP(trimmed) !== 0 ? trimmed.toLowerCase() : null;
  };
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0] ?? null;
  return candidate(forwarded) ?? candidate(req.headers.get("x-real-ip")) ?? "unknown";
}

/** The signed-in wallet, or null: no cookie, a bad signature, an expired token, or no key configured. */
export function readSession(req: Request): SessionPayload | null {
  const secret = sessionSecret();
  if (!secret) return null;
  const token = cookieValue(req.headers.get("cookie"), SESSION_COOKIE);
  return token ? verifySession(token, secret, nowSec()) : null;
}

/** 503 while SESSION_SECRET is unset: sign-in is not broken, it is not deployed, and the client stays read-only. */
export function notConfigured(): NextResponse {
  return NextResponse.json(
    { error: "sessions not configured" },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" } },
  );
}

/** The payload, or the answer to return as-is. `NextResponse extends Response`, so callers test with `instanceof Response`. */
export function requireSession(req: Request): SessionPayload | Response {
  if (!sessionSecret()) return notConfigured();
  return readSession(req) ?? unauthorized("not signed in");
}

/** Secure only in production: a local http:// dev server would silently drop a Secure cookie. */
const isProd = () => process.env.NODE_ENV === "production";

export function setCookie(res: NextResponse, name: string, value: string, maxAge: number): void {
  res.cookies.set({ name, value, httpOnly: true, sameSite: "lax", path: "/", secure: isProd(), maxAge });
}

export function clearCookie(res: NextResponse, name: string): void {
  res.cookies.set({ name, value: "", httpOnly: true, sameSite: "lax", path: "/", secure: isProd(), maxAge: 0 });
}
