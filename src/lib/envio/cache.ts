type Entry<T> = { value?: T; expires: number; inflight?: Promise<T> };

const store = new Map<string, Entry<unknown>>();

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
  const entry = (store.get(key) as Entry<T> | undefined) ?? { expires: 0 };
  if (entry.value !== undefined && entry.expires > now) return entry.value;
  if (entry.inflight) return entry.inflight;
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
