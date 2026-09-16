import { nowSec } from "@/app/api/_lib/respond";
import { ttlCache } from "./cache";
import { gql } from "./client";
import { PAIRS_LAUNCHPAD_QUERY, PAIRS_QUERY, windowQuery, type QuotePriceRow, type TokenRow, type WindowRow } from "./queries";
import { shapePairs, usdMap, windowStats } from "./shape";

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

/** Shared by the pairs and quotes routes, so a quotes request reuses the cached pair set. */
export async function loadPairs(scope: PairsScope = "all") {
  return ttlCache(`pairs:${scope}`, PAIRS_TTL * 1000, async () => {
    const now = nowSec();
    const tokens = await gql<{ Token: TokenRow[]; QuotePrice: QuotePriceRow[] }>(scope === "launchpad" ? PAIRS_LAUNCHPAD_QUERY : PAIRS_QUERY, { limit: LIMIT });
    const poolIds = tokens.Token.flatMap((t) => (t.primaryPool ? [t.primaryPool.id] : []));
    const rows = await loadWindowRows(poolIds, now);
    return shapePairs(tokens.Token, usdMap(tokens.QuotePrice, now), windowStats(rows, now));
  });
}
