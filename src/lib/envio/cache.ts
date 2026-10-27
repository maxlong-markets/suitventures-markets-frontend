type Entry<T> = { value?: T; expires: number; inflight?: Promise<T> };

const store = new Map<string, Entry<unknown>>();

/**
 * Hard cap on keys (security review, 27 Oct 2026). Several public routes key this memo by a caller-chosen address
 * (`candles:${id}:${interval}`, `trades:${id}`, `holders:${id}`, `poolKey:…`), and an entry was never removed after it
 * expired, so a client walking random valid addresses grew the process's memory without bound. Same cap as the logo
 * memo and the vote-counts cache.
 */
export const MAX_TTL_ENTRIES = 5_000;

/** Before a new key goes in at the cap: drop every expired, idle entry, then, if still full, the least recently used idle one. */
function makeRoom(now: number): void {
  for (const [key, entry] of store) {
    if (!entry.inflight && entry.expires <= now) store.delete(key);
  }
  if (store.size < MAX_TTL_ENTRIES) return;
  for (const [key, entry] of store) {
    if (!entry.inflight) {
      store.delete(key);
      return;
    }
  }
}

/**
 * `skipCache`: a resolved value this returns true for still answers the caller (and still joins
 * an in-flight load already under way, so two callers this same tick never cost two loads), but
 * is not written into the memo for anyone after it. A single-token lookup passes this for a
 * `null` ("not found") answer, amended 30 Sep 2026: caching that for the full TTL is what let a
 * creator's own reload keep saying "not found" for up to about a minute after the token had
 * actually landed (should fix 9, launch UX review).
 */
export interface TtlCacheOpts<T> {
  skipCache?: (value: T) => boolean;
}

/** Per-process memo with a TTL. A failed reload keeps serving the last good value. */
export async function ttlCache<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  opts?: TtlCacheOpts<T>,
): Promise<T> {
  const now = Date.now();
  const existing = store.get(key) as Entry<T> | undefined;
  // Least recently used order: every use moves the key to the back, so the eviction below takes the coldest key, and
  // a flood of caller-chosen ids cannot push out a key every visitor keeps asking for (pairs, quotes).
  if (existing) {
    store.delete(key);
    store.set(key, existing as Entry<unknown>);
  }
  const entry = existing ?? { expires: 0 };
  if (entry.value !== undefined && entry.expires > now) return entry.value;
  if (entry.inflight) return entry.inflight;
  if (!existing && store.size >= MAX_TTL_ENTRIES) {
    makeRoom(now);
    // Every key is mid-load: answer this call without memoising it rather than grow past the cap.
    if (store.size >= MAX_TTL_ENTRIES) return load();
  }
  entry.inflight = load()
    .then((value) => {
      if (opts?.skipCache?.(value)) {
        // Answered this call; the next one (even seconds later) must ask again rather than
        // inherit this one's miss, so nothing of this load stays in the memo.
        store.delete(key);
      } else {
        entry.value = value;
        entry.expires = Date.now() + ttlMs;
      }
      return value;
    })
    .catch((err) => {
      if (entry.value !== undefined) return entry.value;
      throw err;
    })
    .finally(() => {
      entry.inflight = undefined;
    });
  store.set(key, entry as Entry<unknown>);
  return entry.inflight;
}

export function clearTtlCache(): void {
  store.clear();
}

/** Tests only: how many keys the memo holds. */
export function ttlCacheSize(): number {
  return store.size;
}
