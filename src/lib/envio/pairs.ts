import { nowSec } from "@/lib/time";
import { ttlCache } from "./cache";
import { gql } from "./client";
import {
  PAIRS_LAUNCHPAD_QUERY, PAIRS_QUERY, PAIRS_RECOVERY_LAUNCHPAD_QUERY, PAIRS_RECOVERY_QUERY, windowQuery,
  type PoolRow, type QuotePriceRow, type TokenRow, type WindowRow,
} from "./queries";
import { resolvePool, shapePairs, usdMap, windowStats } from "./shape";

/** Seconds; also the pairs route's `s-maxage`. */
export const PAIRS_TTL = 30;
/** Rows the merged list is capped at. Exported for the merge tests, which must build exactly this many. */
export const PAIRS_LIMIT = 500;
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
/** Candidates to consider; the ordered recovery query makes the cut deterministic, not the limit. */
const RECOVERY_LIMIT = 1000;

/**
 * The cutoff the recovery query has to beat: the oldest swap the main list still shows. A token
 * quieter than that would not have made the list on its own merits, so it is not worth recovering.
 * A short main list has no meaningful cutoff, so fall back to a fixed window.
 */
function recoverySince(main: TokenRow[], now: number): number {
  const last = main.length >= PAIRS_LIMIT ? main[main.length - 1] : undefined;
  return last?.primaryPool?.lastSwapAt ?? now - RECOVERY_WINDOW_SEC;
}

/**
 * Shared by the pairs and quotes routes, so a quotes request reuses the cached pair set.
 *
 * Two queries: the main list, then the tokens the main list cannot see because the indexer's
 * `primaryPool` points at a dead pool. They run in sequence because the second one's cutoff comes
 * from the first one's tail. Merging them and re-sorting on the *resolved* pool is what puts AI
 * and its ~1000 siblings back on the table.
 */
export async function loadPairs(scope: PairsScope = "all") {
  return ttlCache(`pairs:${scope}`, PAIRS_TTL * 1000, async () => {
    const now = nowSec();
    const launchpad = scope === "launchpad";
    const main = await gql<PairsRows>(launchpad ? PAIRS_LAUNCHPAD_QUERY : PAIRS_QUERY, { limit: PAIRS_LIMIT });
    const recovery = await gql<PairsRows>(launchpad ? PAIRS_RECOVERY_LAUNCHPAD_QUERY : PAIRS_RECOVERY_QUERY, {
      since: recoverySince(main.Token, now),
      limit: RECOVERY_LIMIT,
    });

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
    const top = resolved.slice(0, PAIRS_LIMIT);

    const rows = await loadWindowRows(top.map((r) => r.pool.id), now);
    const prices = new Map<string, QuotePriceRow>();
    for (const p of [...main.QuotePrice, ...recovery.QuotePrice]) prices.set(p.id, p);
    return shapePairs(top.map((r) => r.token), usdMap([...prices.values()], now), windowStats(rows, now));
  });
}
