import { describe, it, expect, vi } from "vitest";
import { MAX_TTL_ENTRIES, ttlCache, clearTtlCache, ttlCacheSize } from "./cache";

describe("ttlCache", () => {
  it("memoizes within the ttl and dedupes concurrent loads", async () => {
    clearTtlCache();
    const load = vi.fn(async () => Math.random());
    const [a, b] = await Promise.all([ttlCache("k", 1000, load), ttlCache("k", 1000, load)]);
    expect(a).toBe(b);
    expect(await ttlCache("k", 1000, load)).toBe(a);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("serves the last good value when a reload fails", async () => {
    clearTtlCache();
    vi.useFakeTimers();
    const load = vi.fn<() => Promise<number>>().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("down"));
    expect(await ttlCache("k2", 10, load)).toBe(1);
    vi.advanceTimersByTime(20);
    expect(await ttlCache("k2", 10, load)).toBe(1);
    vi.useRealTimers();
  });

  // Amended 30 Sep 2026 (should fix 9, launch UX review); corrected fix round 1 finding 12,
  // which is what this note itself used to get wrong. A "not found" answer must not sit in the
  // memo the way a real one does, or a creator's own reload keeps hearing "not found" long after
  // the token actually landed. Only the first case below is the actual regression test: on the
  // old signature (no fourth argument) that option was silently dropped, `load` was called once
  // and its `null` cached for the full ttl exactly like any other value, so the very next call
  // answered from that stale cache instead of asking again, `load` called once rather than the
  // twice this case expects. The other two are guards, not regressions: the old code already
  // deduped two concurrent calls into one load (the plain in-flight sharing every key gets, with
  // or without this option), and already cached a found value normally, so both already passed.
  describe("skipCache", () => {
    it("still answers this call, but a later, separate call asks again rather than reusing it", async () => {
      clearTtlCache();
      const load = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
      const first = await ttlCache("skip:1", 30_000, load, { skipCache: (v) => v === null });
      expect(first).toBeNull();
      const second = await ttlCache("skip:1", 30_000, load, { skipCache: (v) => v === null });
      expect(second).toBeNull();
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("still dedupes two concurrent calls into one load, even when the answer will not be kept", async () => {
      clearTtlCache();
      const load = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
      const [a, b] = await Promise.all([
        ttlCache("skip:2", 30_000, load, { skipCache: (v) => v === null }),
        ttlCache("skip:2", 30_000, load, { skipCache: (v) => v === null }),
      ]);
      expect([a, b]).toEqual([null, null]);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("keeps caching a value the predicate does not match, exactly as with no predicate at all", async () => {
      clearTtlCache();
      const load = vi.fn<() => Promise<string | null>>().mockResolvedValue("found");
      await ttlCache("skip:3", 30_000, load, { skipCache: (v) => v === null });
      await ttlCache("skip:3", 30_000, load, { skipCache: (v) => v === null });
      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  // Security review, 27 Oct 2026: public routes key this memo by caller-chosen addresses.
  it("never holds more than MAX_TTL_ENTRIES keys, evicting expired entries first", async () => {
    clearTtlCache();
    vi.useFakeTimers();
    await ttlCache("short", 10, async () => "s");
    await ttlCache("long", 60_000, async () => "l");
    vi.advanceTimersByTime(20);
    for (let i = 0; ttlCacheSize() < MAX_TTL_ENTRIES; i++) await ttlCache(`fill:${i}`, 60_000, async () => i);
    await ttlCache("one-more", 60_000, async () => 1);
    expect(ttlCacheSize()).toBeLessThanOrEqual(MAX_TTL_ENTRIES);
    // The expired key went; the live one it did not need to touch stayed cached.
    const reload = vi.fn(async () => "fresh");
    expect(await ttlCache("long", 60_000, reload)).toBe("l");
    expect(reload).not.toHaveBeenCalled();
    for (let i = 0; i < 100; i++) await ttlCache(`more:${i}`, 60_000, async () => i);
    expect(ttlCacheSize()).toBe(MAX_TTL_ENTRIES);
    vi.useRealTimers();
    clearTtlCache();
  });

  it("evicts the least recently used key, so a key in steady use survives a flood of new ones", async () => {
    clearTtlCache();
    await ttlCache("hot", 60_000, async () => "h");
    const reload = vi.fn(async () => "fresh");
    for (let i = 0; i < MAX_TTL_ENTRIES + 500; i++) {
      await ttlCache(`flood:${i}`, 60_000, async () => i);
      if (i % 100 === 0) expect(await ttlCache("hot", 60_000, reload)).toBe("h");
    }
    expect(reload).not.toHaveBeenCalled();
    expect(ttlCacheSize()).toBe(MAX_TTL_ENTRIES);
    clearTtlCache();
  });

  it("answers without memoising when every key is mid-load, never growing past the cap", async () => {
    clearTtlCache();
    const pending: Array<() => void> = [];
    const hang = () => new Promise<number>((resolve) => pending.push(() => resolve(0)));
    const loads = Array.from({ length: MAX_TTL_ENTRIES }, (_, i) => ttlCache(`busy:${i}`, 60_000, hang));
    expect(ttlCacheSize()).toBe(MAX_TTL_ENTRIES);
    const extra = vi.fn(async () => "x");
    expect(await ttlCache("overflow", 60_000, extra)).toBe("x");
    expect(await ttlCache("overflow", 60_000, extra)).toBe("x");
    expect(extra).toHaveBeenCalledTimes(2);
    expect(ttlCacheSize()).toBe(MAX_TTL_ENTRIES);
    pending.forEach((release) => release());
    await Promise.all(loads);
    clearTtlCache();
  });
});
