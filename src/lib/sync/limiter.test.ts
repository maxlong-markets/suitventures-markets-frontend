import { beforeEach, describe, expect, it } from "vitest";
import { EnvioUnavailableError } from "@/lib/envio/client";
import { createLimiter, withRetry } from "./limiter";

/** A clock that only moves when the limiter sleeps or the test advances it. */
function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createLimiter", () => {
  it("hands out perMinute tokens at once, then waits for the refill", async () => {
    const c = clock();
    const limiter = createLimiter(60, c);
    for (let i = 0; i < 60; i++) await limiter.take();
    expect(c.sleeps).toEqual([]);
    await limiter.take();
    expect(c.sleeps).toEqual([1000]);
  });
  it("refills continuously and never above the bucket size", async () => {
    const c = clock();
    const limiter = createLimiter(60, c);
    for (let i = 0; i < 60; i++) await limiter.take();
    c.advance(500);
    await limiter.take();
    expect(c.sleeps).toEqual([500]);
    c.advance(600_000);
    for (let i = 0; i < 60; i++) await limiter.take();
    expect(c.sleeps).toEqual([500]);
    await limiter.take();
    expect(c.sleeps).toEqual([500, 1000]);
  });
  it("rejects a non-positive rate", () => {
    expect(() => createLimiter(0)).toThrow("perMinute");
  });
});

describe("withRetry", () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  beforeEach(() => {
    sleeps.length = 0;
  });

  it("retries 429, 5xx and unreachable with exponential backoff", async () => {
    const errors = [
      new EnvioUnavailableError("indexer responded 429"),
      new EnvioUnavailableError("indexer responded 503"),
      new EnvioUnavailableError("indexer unreachable: fetch failed"),
    ];
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (errors.length) throw errors.shift();
      return "ok";
    }, { baseMs: 10, sleep });
    expect(result).toBe("ok");
    expect(calls).toBe(4);
    expect(sleeps).toEqual([10, 20, 40]);
  });
  it("gives up after `attempts` and throws the last error", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw new EnvioUnavailableError(`indexer responded 502 (${calls})`);
    }, { attempts: 3, baseMs: 10, sleep })).rejects.toThrow("responded 502 (3)");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });
  it("rethrows a bad document, a 4xx other than 429 and any other error at once", async () => {
    let calls = 0;
    const once = (err: Error) => withRetry(async () => {
      calls++;
      throw err;
    }, { sleep });
    await expect(once(new EnvioUnavailableError("indexer query failed: unknown field"))).rejects.toThrow("query failed");
    await expect(once(new EnvioUnavailableError("indexer responded 404"))).rejects.toThrow("404");
    await expect(once(new Error("responded 503, but not from the client"))).rejects.toThrow("not from the client");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([]);
  });
});
