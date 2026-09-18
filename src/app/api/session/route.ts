import { NextResponse } from "next/server";
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { robinhoodChain } from "@/lib/chain";
import { NONCE_COOKIE, NONCE_TTL_SEC, SESSION_COOKIE, SESSION_TTL_SEC, sessionSecret, signSession, verifyNonce } from "@/lib/session/cookie";
import { verifySiwe } from "@/lib/session/siwe";
import { allowClient } from "@/lib/social/rateLimit";
import { nowSec } from "@/lib/time";
import { badRequest, failure, noStore, tooManyRequests, unauthorized } from "../_lib/respond";
import { clearCookie, clientIp, cookieValue, notConfigured, requireSession, setCookie } from "../_lib/session";

export const dynamic = "force-dynamic";

/** Long enough for any EIP-4361 message with resources; short enough that nothing large is hashed on an unauthenticated path. */
const MAX_MESSAGE = 4096;

let client: PublicClient | null = null;
/**
 * Only a smart account (EIP-1271 / ERC-6492) makes this client talk to the chain; an EOA signature
 * recovers offline. Its own timeout and retry budget, rather than viem's `http()` defaults
 * (10 s timeout, 3 retries): a hung node should not be able to hold a sign-in open for ~30 s when
 * this route has no rate limit of its own to fall back on for that duration.
 */
function publicClient(): PublicClient {
  if (!client) {
    client = createPublicClient({
      chain: robinhoodChain,
      transport: http(process.env.ROBINHOOD_RPC_URL || undefined, { timeout: 5_000, retryCount: 1 }),
    });
  }
  return client;
}

/** The domain the browser signed against. Vercel rewrites `host` to the public hostname; `req.url` is the fallback for a direct Node request. */
const hostOf = (req: Request) => req.headers.get("host") ?? new URL(req.url).host;

/**
 * `SESSION_DOMAIN` when the deployment sets one, else the request's own `host` header. Unset is
 * correct on Vercel, which controls `host`; behind a proxy that forwards an arbitrary `Host` the
 * unset form is a no-op, which is exactly what pinning a real hostname here fixes.
 */
const expectedDomain = (req: Request) => process.env.SESSION_DOMAIN || hostOf(req);

/** Nonces already spent by a successful sign-in, keyed by the nonce, valued by when the entry can be forgotten. */
const usedNonces = new Map<string, number>();

/** Hard cap on tracked spent nonces; a nonce this old is long past its own ten minutes anyway. */
const MAX_USED_NONCES = 10_000;

/**
 * true for a nonce already spent by an earlier successful POST — even though the nonce cookie
 * itself, and the signature over it, would both still verify — so a captured request cannot be
 * replayed into a second session for as long as the browser holds the cookie.
 *
 * Per serverless instance, like both rate-limit stores (`rateLimit.ts`): a captured POST replayed
 * against a *different* instance inside the nonce's ten minutes would still be spent there. The
 * impact is low — whoever can capture the POST can read the `Set-Cookie` in its reply — and a
 * shared store is the M5 answer, but this is best-effort, not a guarantee (review M2).
 */
function nonceUsed(nonce: string, now: number): boolean {
  const exp = usedNonces.get(nonce);
  return exp !== undefined && exp > now;
}

/**
 * Records the nonce as spent and sweeps every expired entry while doing it. Called only on the
 * success path: a refused or thrown attempt leaves the nonce alone, so a client that mistypes a
 * signature can still retry with the same nonce before fetching a new one. A nonce is only ever
 * inserted once (repeats are turned back by `nonceUsed` before this runs), so Map insertion order
 * already is spend order — no delete-before-set dance is needed to keep the cap's eviction honest.
 */
function spendNonce(nonce: string, now: number): void {
  for (const [n, exp] of usedNonces) {
    if (exp <= now) usedNonces.delete(n);
  }
  if (usedNonces.size >= MAX_USED_NONCES) {
    const oldest = usedNonces.keys().next().value;
    if (oldest !== undefined) usedNonces.delete(oldest);
  }
  usedNonces.set(nonce, now + NONCE_TTL_SEC);
}

/** Tests only: forget every spent nonce. */
export function clearUsedNonces(): void {
  usedNonces.clear();
}

/** Tests only: how many spent nonces are currently tracked. */
export function usedNonceCount(): number {
  return usedNonces.size;
}

/**
 * Every terminal answer clears the nonce cookie, *except* the pre-auth 429 below: that attempt was
 * never judged (the budget ran out before the nonce was even read), so the nonce is still good and
 * the client should retry the same signed message after `Retry-After` rather than spend a fresh
 * nonce fetch it may have no budget left for.
 */
function terminal(res: NextResponse): NextResponse {
  clearCookie(res, NONCE_COOKIE);
  return res;
}

export async function POST(req: Request) {
  // Pre-auth: no wallet exists yet to key a budget on, so this shares the client-IP budget with
  // GET /api/session/nonce and bounds the cost — an unmetered eth_call — reachable before either
  // check below.
  if (!allowClient(clientIp(req), nowSec())) return tooManyRequests();
  const secret = sessionSecret();
  if (!secret) return terminal(notConfigured());
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return terminal(badRequest("bad body"));
  }
  const { message, signature } = (body ?? {}) as { message?: unknown; signature?: unknown };
  if (typeof message !== "string" || message.length === 0 || message.length > MAX_MESSAGE || typeof signature !== "string") {
    return terminal(badRequest("bad body"));
  }
  const cookie = cookieValue(req.headers.get("cookie"), NONCE_COOKIE);
  const now = nowSec();
  const nonce = cookie ? verifyNonce(cookie, secret, now) : null;
  if (!nonce) return terminal(unauthorized("no nonce"));
  if (nonceUsed(nonce, now)) return terminal(unauthorized("nonce already used"));
  try {
    const result = await verifySiwe(
      { message, signature: signature as Hex, expectedNonce: nonce, domain: expectedDomain(req), now },
      publicClient(),
    );
    if ("error" in result) return terminal(unauthorized(result.error));
    spendNonce(nonce, now);
    const iat = nowSec();
    const res = noStore({ address: result.address });
    setCookie(res, SESSION_COOKIE, signSession({ address: result.address, iat, exp: iat + SESSION_TTL_SEC }, secret), SESSION_TTL_SEC);
    return terminal(res);
  } catch {
    // Nothing from the error is logged or answered: viem's `BaseError` messages embed the request
    // `data` — which carries the address and the signature — and sometimes the RPC URL (Global
    // Constraint 4).
    return terminal(failure(new Error("sign-in verification failed")));
  }
}

export async function GET(req: Request) {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  return noStore({ address: session.address });
}

/**
 * Signing out needs no key, so this works even while SESSION_SECRET is unset. It clears this
 * browser's cookie and nothing else: sessions are stateless and there is no server-side
 * revocation list, so a token already copied elsewhere stays valid until its own 7-day `exp`.
 * Acceptable for M4; revocation is M5 (review M3).
 */
export async function DELETE() {
  const res = new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  clearCookie(res, SESSION_COOKIE);
  clearCookie(res, NONCE_COOKIE);
  return res;
}
