type Entry<T> = { value?: T; expires: number; inflight?: Promise<T> };

const store = new Map<string, Entry<unknown>>();

/** Per-process memo with a TTL. A failed reload keeps serving the last good value. */
export async function ttlCache<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const entry = (store.get(key) as Entry<T> | undefined) ?? { expires: 0 };
  if (entry.value !== undefined && entry.expires > now) return entry.value;
  if (entry.inflight) return entry.inflight;
  entry.inflight = load()
    .then((value) => {
      entry.value = value;
      entry.expires = Date.now() + ttlMs;
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
