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
