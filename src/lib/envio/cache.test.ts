import { describe, it, expect, vi } from "vitest";
import { ttlCache, clearTtlCache } from "./cache";

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

  // Amended 30 Sep 2026 (should fix 9, launch UX review): a "not found" answer must not sit in
  // the memo the way a real one does, or a creator's own reload keeps hearing "not found" long
  // after the token actually landed. On the old signature (no fourth argument) this option was
  // silently dropped, `load` was called once and its `null` cached for the full ttl exactly like
  // any other value, so the very next call answered from that stale cache instead of asking
  // again: these three cases would have failed with `load` called once, not twice.
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
});
