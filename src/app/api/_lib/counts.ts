import { getDb, hasDb } from "@/lib/db/client";
import { ttlCache } from "@/lib/envio/cache";
import { MAX_VOTE_IDS, voteCounts, type VoteCount } from "@/lib/social/store";
import type { TokenPair } from "@/lib/types";

/** Counts move fast and matter little; the client updates its own vote optimistically and the next fetch reconciles. */
export const VOTES_TTL = 30;

export const zeros = (ids: readonly string[]): Record<string, VoteCount> =>
  Object.fromEntries(ids.map((id) => [id, { bull: 0, bear: 0 }]));

/**
 * Grouped counts for these token ids, memoised for `VOTES_TTL` per id set so the public counts route
 * and the two market reads share one entry. Zeros without a database, which is what the spec promises
 * on the Envio-only path. A store failure travels: the counts route turns it into a 503.
 */
export async function voteCountsFor(ids: readonly string[]): Promise<Record<string, VoteCount>> {
  if (ids.length === 0) return {};
  if (!hasDb()) return zeros(ids);
  // Sorted, so the same set asked for in any order is one cache entry.
  return ttlCache(`votes:${[...ids].sort().join(",")}`, VOTES_TTL * 1000, () => voteCounts(getDb(), ids));
}

/**
 * The same pairs with real `bull` / `bear` when a store is configured. Called after the backend's own
 * memo has answered, so the pairs cache stays backend-agnostic; each merged pair is a fresh object,
 * because `ttlCache` hands every caller the same one and writing into it would poison the memo.
 * This can never fail a market read: without counts the table still renders, with the zeros both
 * backends already shape.
 */
export async function withVoteCounts(pairs: readonly TokenPair[]): Promise<TokenPair[]> {
  if (pairs.length === 0 || !hasDb()) return [...pairs];
  try {
    // PAIRS_LIMIT and MAX_VOTE_IDS are both 500, so the slice never drops a pair; it is the guard that keeps that true.
    const counts = await voteCountsFor(pairs.slice(0, MAX_VOTE_IDS).map((p) => p.id));
    return pairs.map((p) => {
      const count = counts[p.id];
      return count ? { ...p, bull: count.bull, bear: count.bear } : p;
    });
  } catch (err) {
    // Name only: a driver error carries its query and the connection string.
    console.warn(`vote counts unavailable: ${err instanceof Error ? err.name : "unknown"}`);
    return [...pairs];
  }
}
