import { getDb, hasDb } from "@/lib/db/client";
import { countsFor } from "@/lib/social/countsCache";
import { MAX_VOTE_IDS, type VoteCount } from "@/lib/social/store";
import { nowSec } from "@/lib/time";
import type { TokenPair } from "@/lib/types";

/** Counts move fast and matter little; the client updates its own vote optimistically and the next fetch reconciles. */
export const VOTES_TTL = 30;

export const zeros = (ids: readonly string[]): Record<string, VoteCount> =>
  Object.fromEntries(ids.map((id) => [id, { bull: 0, bear: 0 }]));

/**
 * The same pairs with real `bull` / `bear` when a store is configured. Called after the backend's own
 * memo has answered, so the pairs cache stays backend-agnostic; each merged pair is a fresh object,
 * because `ttlCache` hands every caller the same one and writing into it would poison the memo.
 * This can never fail a market read: without counts the table still renders, with the zeros both
 * backends already shape.
 *
 * The counts come from `countsFor` — the one per-id cache `/api/votes` reads too (review I1). A
 * second memo here, keyed by the caller's whole id set, was both unbounded and a separate thirty
 * seconds of the same data, so `/api/votes` and the token page could disagree about one token.
 */
export async function withVoteCounts(pairs: readonly TokenPair[]): Promise<TokenPair[]> {
  if (pairs.length === 0 || !hasDb()) return [...pairs];
  try {
    // PAIRS_LIMIT and MAX_VOTE_IDS are both 500, so the slice never drops a pair; it is the guard that keeps that true.
    const counts = await countsFor(getDb(), pairs.slice(0, MAX_VOTE_IDS).map((p) => p.id), nowSec());
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
