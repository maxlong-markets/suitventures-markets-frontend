import type { Db } from "@/lib/db/client";
import { voteCounts, type VoteCount } from "@/lib/social/store";

/** Each cached count is good for thirty seconds — counts move fast and matter little (see `_lib/counts.ts`). */
const TTL_SEC = 30;

/** However many distinct ids get asked about, the cache never holds more entries than this. */
const MAX_ENTRIES = 5_000;

type Entry = { value: VoteCount; at: number };

/**
 * Keyed by token id, never by a caller-chosen set: `/api/votes`' `?ids=` is public and unbounded in
 * shape, so a memo keyed by the whole set (the `votes:{sorted ids}` string `ttlCache` used) lets
 * every distinct set the caller can phrase pin its own permanent entry (Task 3 review I1). Keying
 * per id bounds the cache by the number of distinct ids ever asked about instead.
 */
const cache = new Map<string, Entry>();

/**
 * Bull/bear counts for `ids`, each served from its own thirty-second cache entry when fresh, and
 * batched into exactly one `voteCounts` query for whichever ids are missing or stale. `now` is a
 * parameter rather than read here, so a caller can test the TTL without fake timers.
 */
export async function countsFor(db: Db, ids: readonly string[], now: number): Promise<Record<string, VoteCount>> {
  const out: Record<string, VoteCount> = {};
  const misses: string[] = [];
  for (const id of ids) {
    const entry = cache.get(id);
    if (entry && entry.at + TTL_SEC > now) out[id] = entry.value;
    else misses.push(id);
  }
  if (misses.length === 0) return out;
  const fresh = await voteCounts(db, misses);
  for (const id of misses) {
    const value = fresh[id] ?? { bull: 0, bear: 0 };
    out[id] = value;
    rememberCounts(id, value, now);
  }
  return out;
}

/**
 * One id's counts, as of `now`, replacing whatever was cached for it. The write path calls this
 * with the counts its own transaction read (`toggleVote`), so the thirty seconds an entry lives
 * can no longer outlive the vote that changed it: before this, a wallet's vote committed and every
 * reader — the pairs list, `/api/votes`, the token page — kept answering the pre-vote number, so
 * the client's own refetch painted the count back to where it had been (the 23 Sep report).
 *
 * It is the write path's half of `countsFor`, and deliberately shares its insert: a fresh entry
 * still evicts the oldest at the cap, and replacing one that is already there still evicts
 * nothing.
 */
export function rememberCounts(id: string, value: VoteCount, now: number): void {
  if (!cache.has(id) && cache.size >= MAX_ENTRIES) {
    // Only a genuinely new id can grow the cache past its cap; refreshing one already present
    // (stale or not) must evict nothing. `keys().next().value` is the oldest entry precisely
    // because every set here is a delete-then-set, which keeps Map order equal to recency.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(id);
  cache.set(id, { value, at: now });
}

/** Tests only: forget every cached id. */
export function clearCountsCache(): void {
  cache.clear();
}

/** Tests only: how many ids are currently cached. */
export function countsCacheSize(): number {
  return cache.size;
}
