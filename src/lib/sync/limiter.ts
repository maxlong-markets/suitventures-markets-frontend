import { EnvioUnavailableError } from "@/lib/envio/client";

export type Limiter = { take(): Promise<void> };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Token bucket: `perMinute` tokens, refilled continuously; take() resolves when one is available. `now` and `sleep` are injectable for tests. */
export function createLimiter(perMinute: number, deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Limiter {
  if (!(perMinute > 0)) throw new Error(`createLimiter: perMinute must be positive, got ${perMinute}`);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  // The bucket is kept in milliseconds of refill time: a full minute holds perMinute tokens.
  const msPerToken = 60_000 / perMinute;
  let creditMs = 60_000;
  let last = now();
  return {
    async take() {
      for (;;) {
        const t = now();
        creditMs = Math.min(60_000, creditMs + (t - last));
        last = t;
        if (creditMs >= msPerToken) {
          creditMs -= msPerToken;
          return;
        }
        await sleep(Math.ceil(msPerToken - creditMs));
      }
    },
  };
}

export type RetryOpts = { attempts?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> };

const RETRYABLE = /responded 429|responded 5|unreachable/;
/** A rejected document is never retried, whatever the indexer's own error text goes on to say. */
const NEVER = /query failed/;

/** Retries fn on an EnvioUnavailableError whose message contains "responded 429", "responded 5", or "unreachable" and not "query failed"; attempts default 4, backoff baseMs·2^n (baseMs default 1000). Any other error is rethrown at once. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;
  for (let n = 0; ; n++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof EnvioUnavailableError && RETRYABLE.test(err.message) && !NEVER.test(err.message);
      if (!retryable || n + 1 >= attempts) throw err;
      await sleep(baseMs * 2 ** n);
    }
  }
}
