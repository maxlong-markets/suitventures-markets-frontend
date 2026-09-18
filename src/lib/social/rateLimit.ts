/**
 * A per-wallet write budget, counted in this process only: another serverless instance keeps its own
 * map, so the real ceiling is the cap times the number of live instances. That is deliberate for M4
 * (spec section 3) — it bounds a single client's runaway loop, and M5 verifies rate limiting under
 * load properly. Nothing here is a security control.
 */
export const WRITE_LIMIT = 60;
export const WINDOW_SEC = 60;

/**
 * The pre-auth budget for `GET /api/session/nonce` and `POST /api/session`, keyed by client IP
 * rather than by wallet: neither route has a session yet, so there is no wallet to key on, and
 * this is what bounds the cost (an unmetered `eth_call` on POST) reachable before authentication.
 * One shared budget for both routes, not one each — an IP that spends it on nonces has none left
 * for sign-in attempts, and vice versa.
 */
export const CLIENT_LIMIT = 20;

/** Above this many tracked keys, one sweep drops every key whose window has emptied. */
const SWEEP_AT = 5_000;

const hits = new Map<string, number[]>();
const clientHits = new Map<string, number[]>();

/** true when this call fits the key's last rolling window, and counts it; false when it does not. */
function allow(store: Map<string, number[]>, key: string, now: number, limit: number): boolean {
  const since = now - WINDOW_SEC;
  const kept = (store.get(key) ?? []).filter((t) => t > since);
  if (kept.length >= limit) {
    store.set(key, kept);
    return false;
  }
  kept.push(now);
  store.set(key, kept);
  if (store.size > SWEEP_AT) pruneMap(store, now);
  return true;
}

/** true when this write fits the wallet's last rolling minute, and counts it; false when it does not. */
export function allowWrite(wallet: string, now: number): boolean {
  return allow(hits, wallet, now, WRITE_LIMIT);
}

/** true when this pre-auth request fits the client IP's last rolling minute, and counts it. */
export function allowClient(ip: string, now: number): boolean {
  return allow(clientHits, ip, now, CLIENT_LIMIT);
}

function pruneMap(store: Map<string, number[]>, now: number): void {
  const since = now - WINDOW_SEC;
  for (const [key, times] of store) {
    const kept = times.filter((t) => t > since);
    if (kept.length === 0) store.delete(key);
    else store.set(key, kept);
  }
}

/** Drops every wallet with nothing left inside the window. Called automatically when the map grows; exported so a caller can sweep on demand. */
export function pruneRateLimit(now: number): void {
  pruneMap(hits, now);
}

/** Tests only: forget every wallet and every client IP. */
export function resetRateLimit(): void {
  hits.clear();
  clientHits.clear();
}

/** Tests only: how many wallets are currently tracked. */
export function rateLimitSize(): number {
  return hits.size;
}
