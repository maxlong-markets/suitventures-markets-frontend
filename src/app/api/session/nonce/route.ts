import { NextResponse } from "next/server";
import { NONCE_COOKIE, NONCE_TTL_SEC, newNonce, sessionSecret, signNonce } from "@/lib/session/cookie";
import { allowClient } from "@/lib/social/rateLimit";
import { nowSec } from "@/lib/time";
import { tooManyRequests } from "../../_lib/respond";
import { clientIp, notConfigured, setCookie } from "../../_lib/session";

export const dynamic = "force-dynamic";

/**
 * A fresh nonce and the HMAC of it, in a ten-minute cookie. The server keeps no nonce store: the
 * cookie is the record. Rate limited per client IP before anything else: this and `POST
 * /api/session` share one pre-auth budget, since neither has a wallet to key on yet.
 */
export async function GET(req: Request) {
  if (!allowClient(clientIp(req), nowSec())) return tooManyRequests();
  const secret = sessionSecret();
  if (!secret) return notConfigured();
  const nonce = newNonce();
  const res = NextResponse.json({ nonce }, { headers: { "Cache-Control": "no-store" } });
  setCookie(res, NONCE_COOKIE, signNonce(nonce, secret), NONCE_TTL_SEC);
  return res;
}
