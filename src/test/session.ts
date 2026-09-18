import { SESSION_COOKIE, SESSION_TTL_SEC, signSession } from "@/lib/session/cookie";
import { nowSec } from "@/lib/time";
import type { Address } from "@/lib/types";

/** 32 characters, the minimum `sessionSecret()` accepts. It exists only in the suite and protects nothing. */
export const TEST_SESSION_SECRET = "0123456789abcdef0123456789abcdef";

/** A `Cookie` header carrying a valid session for `wallet`. */
export function sessionHeader(wallet: Address, over: Partial<{ iat: number; exp: number }> = {}): string {
  const iat = over.iat ?? nowSec();
  return `${SESSION_COOKIE}=${signSession({ address: wallet, iat, exp: over.exp ?? iat + SESSION_TTL_SEC }, TEST_SESSION_SECRET)}`;
}
