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

/**
 * Hard cap on distinct keys tracked by either map — wallets or client IPs. Both maps are reachable
 * before authentication now (the client one always was unauthenticated by design; the wallet one
 * is reachable through `allowWrite` only after a session exists, but the cap still bounds it against
 * a very large number of distinct wallets). Above the cap, inserting a new key first tries a sweep
 * and then, if that was not enough, drops the single oldest key.
 */
export const MAX_KEYS = 10_000;

type Store = { hits: Map<string, number[]>; sweptAt: number };
const wallets: Store = { hits: new Map(), sweptAt: -Infinity };
const clients: Store = { hits: new Map(), sweptAt: -Infinity };

/**
 * A full pass over every key in `store`, dropping any whose window has emptied. At most once per
 * `WINDOW_SEC` per store (tracked on the store itself): a flood of new keys must not make every
 * allowed request pay a full scan just because the map happens to be large.
 */
function sweep(store: Store, now: number): void {
  if (now - store.sweptAt < WINDOW_SEC) return;
  store.sweptAt = now;
  const since = now - WINDOW_SEC;
  for (const [key, times] of store.hits) {
    const kept = times.filter((t) => t > since);
    if (kept.length === 0) store.hits.delete(key);
    else store.hits.set(key, kept);
  }
}

/** true when this call fits the key's last rolling window, and counts it; false when it does not. */
function allow(store: Store, key: string, now: number, limit: number): boolean {
  const since = now - WINDOW_SEC;
  const existing = store.hits.get(key);
  const kept = (existing ?? []).filter((t) => t > since);
  if (kept.length >= limit) {
    store.hits.set(key, kept);
    return false;
  }
  if (existing === undefined && store.hits.size >= MAX_KEYS) {
    sweep(store, now);
    if (store.hits.size >= MAX_KEYS) {
      const oldest = store.hits.keys().next().value;
      if (oldest !== undefined) store.hits.delete(oldest);
    }
  }
  kept.push(now);
  // Recency: deleting before re-inserting moves this key to the newest position in Map iteration
  // order, which is what makes `keys().next().value` above the genuinely least-recently-used key.
  store.hits.delete(key);
  store.hits.set(key, kept);
  return true;
}

/** true when this write fits the wallet's last rolling minute, and counts it; false when it does not. */
export function allowWrite(wallet: string, now: number): boolean {
  return allow(wallets, wallet, now, WRITE_LIMIT);
}

/** true when this pre-auth request fits the client IP's last rolling minute, and counts it. */
export function allowClient(ip: string, now: number): boolean {
  return allow(clients, ip, now, CLIENT_LIMIT);
}

/** Drops every wallet with nothing left inside the window. Exported so a caller can sweep on demand; throttled the same as the automatic sweep. */
export function pruneRateLimit(now: number): void {
  sweep(wallets, now);
}

/** Tests only: forget every wallet and every client IP, and reset both stores' sweep timers. */
export function resetRateLimit(): void {
  wallets.hits.clear();
  wallets.sweptAt = -Infinity;
  clients.hits.clear();
  clients.sweptAt = -Infinity;
}

/** Tests only: how many wallets are currently tracked. */
export function rateLimitSize(): number {
  return wallets.hits.size;
}

/** Tests only: how many client IPs are currently tracked. */
export function clientLimitSize(): number {
  return clients.hits.size;
}
