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

/** Drops the single oldest entry by insertion time, making room for one more. */
function evictOldest(): void {
  let oldestId: string | undefined;
  let oldestAt = Infinity;
  for (const [id, entry] of cache) {
    if (entry.at < oldestAt) {
      oldestAt = entry.at;
      oldestId = id;
    }
  }
  if (oldestId !== undefined) cache.delete(oldestId);
}

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
    if (!cache.has(id) && cache.size >= MAX_ENTRIES) evictOldest();
    cache.set(id, { value, at: now });
  }
  return out;
}

/** Tests only: forget every cached id. */
export function clearCountsCache(): void {
  cache.clear();
}

/** Tests only: how many ids are currently cached. */
export function countsCacheSize(): number {
  return cache.size;
}
