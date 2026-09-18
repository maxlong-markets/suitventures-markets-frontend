/**
 * A per-wallet write budget, counted in this process only: another serverless instance keeps its own
 * map, so the real ceiling is the cap times the number of live instances. That is deliberate for M4
 * (spec section 3) — it bounds a single client's runaway loop, and M5 verifies rate limiting under
 * load properly. Nothing here is a security control.
 */
export const WRITE_LIMIT = 60;
export const WINDOW_SEC = 60;

/** Above this many tracked wallets, one sweep drops every wallet whose window has emptied. */
const SWEEP_AT = 5_000;

const hits = new Map<string, number[]>();

/** true when this write fits the wallet's last rolling minute, and counts it; false when it does not. */
export function allowWrite(wallet: string, now: number): boolean {
  const since = now - WINDOW_SEC;
  const kept = (hits.get(wallet) ?? []).filter((t) => t > since);
  if (kept.length >= WRITE_LIMIT) {
    hits.set(wallet, kept);
    return false;
  }
  kept.push(now);
  hits.set(wallet, kept);
  if (hits.size > SWEEP_AT) pruneRateLimit(now);
  return true;
}

/** Drops every wallet with nothing left inside the window. Called automatically when the map grows; exported so a caller can sweep on demand. */
export function pruneRateLimit(now: number): void {
  const since = now - WINDOW_SEC;
  for (const [wallet, times] of hits) {
    const kept = times.filter((t) => t > since);
    if (kept.length === 0) hits.delete(wallet);
    else hits.set(wallet, kept);
  }
}

/** Tests only: forget every wallet. */
export function resetRateLimit(): void {
  hits.clear();
}

/** Tests only: how many wallets are currently tracked. */
export function rateLimitSize(): number {
  return hits.size;
}
