import { createTransport, http, type EIP1193RequestFn, type Transport } from "viem";

/**
 * Pacing for the public Robinhood Chain node (measured 23 Sep 2026, from one address, with batched
 * `eth_call`s of `balanceOf` at a recent historical block):
 *
 *   - one JSON-RPC batch of 40 calls per second, sustained for 20 s: 800 of 800 answered;
 *   - two batches of 40 in the same second: the first answered, the second and everything after it
 *     for that second refused with HTTP 429 "Too Many Requests" — 40 of 1,600 answered;
 *   - the penalty clears within a second: a single call right after a refused second is answered.
 *
 * So the node meters CALLS (not HTTP requests) per address per rolling second, at 40, with no burst
 * allowance beyond that — and Vercel's functions all leave from a small shared pool of addresses, so
 * the reader is one such address. Its holder-count reads used to fire both sides of every pair at
 * once (two chunks of 40 in the same 16 ms batching window became one 80-call batch), which refused
 * every read of every busy cycle and froze `holders_count` at its 17 Sep baseline.
 *
 * `createRateLimiter` is that budget as code: at most `maxPerSecond` releases in any rolling 1,000 ms,
 * callers queued in arrival order. `pacedHttp` puts it in front of viem's `http` transport so EVERY
 * server-side call — token metadata, quote feeds, the health check's head, balance reads — shares one
 * meter per process, instead of each caller having to remember the limit. The transport-level batch
 * stays at the same 40 so a burst released together is exactly one HTTP request.
 */

export type RateLimiter = { take(): Promise<void> };

export function createRateLimiter(
  maxPerSecond: number,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): RateLimiter {
  if (!Number.isInteger(maxPerSecond) || maxPerSecond < 1) throw new Error(`maxPerSecond must be a positive integer, got ${maxPerSecond}`);
  const released: number[] = []; // release times of the last `maxPerSecond` calls, ascending
  let queue: Promise<void> = Promise.resolve(); // takers resolve strictly in arrival order
  return {
    take() {
      const turn = queue.then(async () => {
        for (;;) {
          const now = clock.now();
          while (released.length > 0 && released[0]! <= now - 1000) released.shift();
          if (released.length < maxPerSecond) {
            released.push(now);
            return;
          }
          await clock.sleep(released[0]! + 1000 - now);
        }
      });
      queue = turn.catch(() => undefined);
      return turn;
    },
  };
}

export type PacedHttpOptions = {
  /** Calls released per rolling second. */
  callsPerSecond: number;
  /** Calls per JSON-RPC batch (HTTP request); at most `callsPerSecond` makes sense. */
  batchSize: number;
  /** Tests only: a limiter to share or observe. Default: a fresh one per transport. */
  limiter?: RateLimiter;
};

/**
 * viem's `http` transport behind a `createRateLimiter`. Retries (429s, timeouts, 5xx) are the
 * outer transport's, so a retried call is metered again rather than slipping past the limiter; the
 * inner `http` never retries on its own. Exposes `url` and `callsPerSecond` on `client.transport`
 * the way `http` exposes `url`, for tests and for anyone reading a client's configuration.
 */
export function pacedHttp(url: string, opts: PacedHttpOptions): Transport {
  const inner = http(url, { batch: { batchSize: opts.batchSize, wait: 16 }, retryCount: 0 });
  const limiter = opts.limiter ?? createRateLimiter(opts.callsPerSecond);
  return ({ chain, retryCount, timeout, pollingInterval }) => {
    const transport = inner({ chain, retryCount: 0, timeout, pollingInterval });
    return createTransport(
      {
        key: "pacedHttp",
        name: `Paced HTTP (${opts.callsPerSecond}/s)`,
        type: "pacedHttp",
        retryCount,
        timeout,
        request: (async (args) => {
          await limiter.take();
          return transport.request(args);
        }) as EIP1193RequestFn,
      },
      { url, callsPerSecond: opts.callsPerSecond },
    );
  };
}
