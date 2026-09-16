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
});
