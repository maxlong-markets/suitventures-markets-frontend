import { describe, expect, it, vi } from "vitest";
import { createPublicClient } from "viem";
import { robinhoodChain } from "@/lib/chain";
import { createRateLimiter, pacedHttp } from "./pacing";

/** A manual clock: `now` advances only when the test says so, `sleep` records the requested waits and resolves when advanced past them. */
function manualClock(start = 0) {
  let now = start;
  const sleepers: { until: number; resolve: () => void }[] = [];
  const waits: number[] = [];
  return {
    clock: {
      now: () => now,
      sleep: (ms: number) =>
        new Promise<void>((resolve) => {
          waits.push(ms);
          sleepers.push({ until: now + ms, resolve });
        }),
    },
    waits,
    advance(ms: number) {
      now += ms;
      for (const s of sleepers.splice(0)) {
        if (s.until <= now) s.resolve();
        else sleepers.push(s);
      }
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createRateLimiter", () => {
  it("releases up to maxPerSecond calls at once and makes the next one wait for the oldest to age out", async () => {
    const { clock, waits, advance } = manualClock(10_000);
    const limiter = createRateLimiter(3, clock);
    const order: number[] = [];
    const takes = [0, 1, 2, 3].map((i) => limiter.take().then(() => order.push(i)));
    await flush();
    expect(order).toEqual([0, 1, 2]); // the fourth is queued
    expect(waits).toEqual([1000]); // until the first release ages out
    advance(999);
    await flush();
    expect(order).toEqual([0, 1, 2]);
    advance(1);
    await flush();
    await Promise.all(takes);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("sustains exactly maxPerSecond per rolling second: 40 released, 40 more one second later, none in between", async () => {
    const { clock, advance } = manualClock(0);
    const limiter = createRateLimiter(40, clock);
    let released = 0;
    const takes = Array.from({ length: 100 }, () => limiter.take().then(() => (released += 1)));
    await flush();
    expect(released).toBe(40);
    advance(500);
    await flush();
    expect(released).toBe(40);
    advance(500);
    await flush();
    expect(released).toBe(80);
    advance(1000);
    await flush();
    await Promise.all(takes);
    expect(released).toBe(100);
  });

  it("keeps takers in arrival order", async () => {
    const { clock, advance } = manualClock(0);
    const limiter = createRateLimiter(1, clock);
    const order: string[] = [];
    const a = limiter.take().then(() => order.push("a"));
    const b = limiter.take().then(() => order.push("b"));
    const c = limiter.take().then(() => order.push("c"));
    await flush();
    advance(1000);
    await flush();
    advance(1000);
    await flush();
    await Promise.all([a, b, c]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("refuses a non-positive or fractional budget", () => {
    expect(() => createRateLimiter(0)).toThrow(/positive integer/);
    expect(() => createRateLimiter(2.5)).toThrow(/positive integer/);
  });
});

describe("pacedHttp", () => {
  it("exposes url and callsPerSecond on the client's transport, and the client's retryCount, with its own type", () => {
    const client = createPublicClient({ chain: robinhoodChain, transport: pacedHttp("https://node.example", { callsPerSecond: 40, batchSize: 40 }) });
    expect(client.transport.type).toBe("pacedHttp");
    expect(client.transport.url).toBe("https://node.example");
    expect(client.transport.callsPerSecond).toBe(40);
    expect(client.transport.retryCount).toBe(3); // viem's default for the outer transport
  });

  it("takes from the limiter once per call before forwarding it", async () => {
    const take = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number }[] | { id: number };
      const items = Array.isArray(body) ? body : [body];
      return new Response(JSON.stringify(Array.isArray(body) ? items.map((b) => ({ jsonrpc: "2.0", id: b.id, result: "0x10" })) : { jsonrpc: "2.0", id: items[0]!.id, result: "0x10" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = createPublicClient({
        chain: robinhoodChain,
        transport: pacedHttp("https://node.example", { callsPerSecond: 40, batchSize: 40, limiter: { take } }),
      });
      const heights = await Promise.all([client.getBlockNumber(), client.getBlockNumber({ cacheTime: 0 }), client.getBlockNumber({ cacheTime: 0 })]);
      expect(heights.every((h) => h === 16n)).toBe(true);
      expect(take.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(take.mock.calls.length).toBe(fetchMock.mock.calls.reduce((n, [, init]) => { const b = JSON.parse(String(init?.body)); return n + (Array.isArray(b) ? b.length : 1); }, 0));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
