import { NextResponse } from "next/server";
import { NONCE_COOKIE, NONCE_TTL_SEC, newNonce, sessionSecret, signNonce } from "@/lib/session/cookie";
import { notConfigured, setCookie } from "../../_lib/session";

export const dynamic = "force-dynamic";

/** A fresh nonce and the HMAC of it, in a ten-minute cookie. The server keeps no nonce store: the cookie is the record. */
export async function GET() {
  const secret = sessionSecret();
  if (!secret) return notConfigured();
  const nonce = newNonce();
  const res = NextResponse.json({ nonce }, { headers: { "Cache-Control": "no-store" } });
  setCookie(res, NONCE_COOKIE, signNonce(nonce, secret), NONCE_TTL_SEC);
  return res;
}
