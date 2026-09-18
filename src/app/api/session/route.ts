import { NextResponse } from "next/server";
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { robinhoodChain } from "@/lib/chain";
import { NONCE_COOKIE, SESSION_COOKIE, SESSION_TTL_SEC, sessionSecret, signSession, verifyNonce } from "@/lib/session/cookie";
import { verifySiwe } from "@/lib/session/siwe";
import { nowSec } from "@/lib/time";
import { badRequest, failure, noStore, unauthorized } from "../_lib/respond";
import { clearCookie, cookieValue, notConfigured, requireSession, setCookie } from "../_lib/session";

export const dynamic = "force-dynamic";

/** Long enough for any EIP-4361 message with resources; short enough that nothing large is hashed on an unauthenticated path. */
const MAX_MESSAGE = 4096;

let client: PublicClient | null = null;
/** Only a smart account (EIP-1271 / ERC-6492) makes this client talk to the chain; an EOA signature recovers offline. */
function publicClient(): PublicClient {
  if (!client) client = createPublicClient({ chain: robinhoodChain, transport: http(process.env.ROBINHOOD_RPC_URL || undefined) });
  return client;
}

/** The domain the browser signed against. Vercel rewrites `host` to the public hostname; `req.url` is the fallback for a direct Node request. */
const hostOf = (req: Request) => req.headers.get("host") ?? new URL(req.url).host;

export async function POST(req: Request) {
  const secret = sessionSecret();
  if (!secret) return notConfigured();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("bad body");
  }
  const { message, signature } = (body ?? {}) as { message?: unknown; signature?: unknown };
  if (typeof message !== "string" || message.length === 0 || message.length > MAX_MESSAGE || typeof signature !== "string") {
    return badRequest("bad body");
  }
  const cookie = cookieValue(req.headers.get("cookie"), NONCE_COOKIE);
  const nonce = cookie ? verifyNonce(cookie, secret, nowSec()) : null;
  if (!nonce) return unauthorized("no nonce");
  try {
    const result = await verifySiwe(
      { message, signature: signature as Hex, expectedNonce: nonce, domain: hostOf(req), now: nowSec() },
      publicClient(),
    );
    // Single use either way: a nonce that has been spoken for is spent, so a wrong guess cannot be retried against it.
    if ("error" in result) {
      const res = unauthorized(result.error);
      clearCookie(res, NONCE_COOKIE);
      return res;
    }
    const iat = nowSec();
    const res = noStore({ address: result.address });
    setCookie(res, SESSION_COOKIE, signSession({ address: result.address, iat, exp: iat + SESSION_TTL_SEC }, secret), SESSION_TTL_SEC);
    clearCookie(res, NONCE_COOKIE);
    return res;
  } catch {
    // Nothing from the error is logged or answered: viem's `BaseError` messages embed the request
    // `data` — which carries the address and the signature — and sometimes the RPC URL (Global
    // Constraint 4). The nonce is spent here too, so a verification that threw cannot be retried
    // against it.
    const res = failure(new Error("sign-in verification failed"));
    clearCookie(res, NONCE_COOKIE);
    return res;
  }
}

export async function GET(req: Request) {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  return noStore({ address: session.address });
}

/** Signing out needs no key, so this works even while SESSION_SECRET is unset. */
export async function DELETE() {
  const res = new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  clearCookie(res, SESSION_COOKIE);
  clearCookie(res, NONCE_COOKIE);
  return res;
}
