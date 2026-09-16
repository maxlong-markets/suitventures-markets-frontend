import { nowSec } from "@/app/api/_lib/respond";
import { ttlCache } from "./cache";
import { gql } from "./client";
import {
  PAIRS_LAUNCHPAD_QUERY, PAIRS_QUERY, PAIRS_RECOVERY_LAUNCHPAD_QUERY, PAIRS_RECOVERY_QUERY, windowQuery,
  type PoolRow, type QuotePriceRow, type TokenRow, type WindowRow,
} from "./queries";
import { resolvePool, shapePairs, usdMap, windowStats } from "./shape";

/** Seconds; also the pairs route's `s-maxage`. */
export const PAIRS_TTL = 30;
const LIMIT = 500;
const WINDOW_BATCH = 50; // pools per aliased window request; 0.4 s measured
const WINDOW_CONCURRENCY = 3;

export type PairsScope = "all" | "launchpad";

/** h1 candles for every pool, from a day before the 24h bucket so the day-ago reference has a fallback. */
async function loadWindowRows(poolIds: string[], now: number): Promise<WindowRow[]> {
  // windowQuery rejects an empty selection set, so a scope with no pools never reaches it.
  if (poolIds.length === 0) return [];
  const since = Math.floor((now - 86400) / 3600) * 3600 - 86400;
  const batches: string[][] = [];
  for (let i = 0; i < poolIds.length; i += WINDOW_BATCH) batches.push(poolIds.slice(i, i + WINDOW_BATCH));
  const rows: WindowRow[] = [];
  for (let i = 0; i < batches.length; i += WINDOW_CONCURRENCY) {
    const results = await Promise.all(batches.slice(i, i + WINDOW_CONCURRENCY).map((b) => gql<Record<string, WindowRow[]>>(windowQuery(b, since))));
    for (const r of results) for (const list of Object.values(r)) rows.push(...list);
  }
  return rows;
}

type PairsRows = { Token: TokenRow[]; QuotePrice: QuotePriceRow[] };

const RECOVERY_WINDOW_SEC = 7 * 86400;

/**
 * Shared by the pairs and quotes routes, so a quotes request reuses the cached pair set.
 *
 * Two queries in parallel: the main list, plus the tokens the main list cannot see because
 * the indexer's `primaryPool` points at a dead pool. Merging them and re-sorting on the
 * *resolved* pool is what puts AI and its ~1000 siblings back on the table.
 */
export async function loadPairs(scope: PairsScope = "all") {
  return ttlCache(`pairs:${scope}`, PAIRS_TTL * 1000, async () => {
    const now = nowSec();
    const launchpad = scope === "launchpad";
    const [main, recovery] = await Promise.all([
      gql<PairsRows>(launchpad ? PAIRS_LAUNCHPAD_QUERY : PAIRS_QUERY, { limit: LIMIT }),
      gql<PairsRows>(launchpad ? PAIRS_RECOVERY_LAUNCHPAD_QUERY : PAIRS_RECOVERY_QUERY, { since: now - RECOVERY_WINDOW_SEC, limit: LIMIT }),
    ]);

    // Same token can appear in both; the main row wins because its pool is already sane.
    const byId = new Map<string, TokenRow>();
    for (const t of recovery.Token) byId.set(t.id, t);
    for (const t of main.Token) byId.set(t.id, t);

    const resolved: { token: TokenRow; pool: PoolRow }[] = [];
    for (const token of byId.values()) {
      const pool = resolvePool(token);
      if (pool) resolved.push({ token, pool });
    }
    // The main query's own order_by ranks on the primary pool, which is the wrong pool for
    // every recovered row, so the merged list is ranked here on the resolved pool instead.
    resolved.sort((a, b) => (b.pool.lastSwapAt ?? -1) - (a.pool.lastSwapAt ?? -1));
    const top = resolved.slice(0, LIMIT);

    const rows = await loadWindowRows(top.map((r) => r.pool.id), now);
    const prices = new Map<string, QuotePriceRow>();
    for (const p of [...main.QuotePrice, ...recovery.QuotePrice]) prices.set(p.id, p);
    return shapePairs(top.map((r) => r.token), usdMap([...prices.values()], now), windowStats(rows, now));
  });
}
