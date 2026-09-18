import { getDb, type Db } from "@/lib/db/client";
import { createQuoter, type Quoter } from "@/lib/quote/quoter";
import { createEnvioSource } from "./envioSource";
import { createLimiter, type RetryOpts } from "./limiter";
import type { EnvioSource } from "./source";
import type { SyncJob } from "./state";

/** `quoter` is only ever set for "nightly" (its probe phase, nightly.ts); the market job has no use for one. */
export type SyncDeps = { db: Db; source: EnvioSource; quoter?: Quoter };
type Factory = (job: SyncJob) => SyncDeps;
let override: Factory | null = null;

/**
 * Inside the sync a request may take at most 3 attempts: 3 × the 20 s request timeout plus 1 + 2 s of backoff is
 * 63 s, so a request that starts at the end of the market window (50 s) still ends inside the 120 s lease.
 */
export const SYNC_RETRY: RetryOpts = { attempts: 3 };

/**
 * Requests a minute per job. The market route issues at most 150 per invocation, so its limiter is a ceiling; the
 * nightly's about 366 requests take three minutes at 120, inside its 280 s window, and the market invocation yields
 * while the nightly holds its lease (spec 5.1), so the two never add up against the endpoint's 250.
 */
export const SOURCE_PER_MINUTE: Record<SyncJob, number> = { market: 200, nightly: 120 };

/** What a cron route runs against: the process Db (getDb throws DbUnavailableError without DATABASE_URL), the real source with the job's limiter, and — for "nightly" only — a real Quoter for its probe phase. */
export function syncDeps(job: SyncJob): SyncDeps {
  if (override) return override(job);
  const deps: SyncDeps = { db: getDb(), source: createEnvioSource({ limiter: createLimiter(SOURCE_PER_MINUTE[job]), retry: SYNC_RETRY }) };
  return job === "nightly" ? { ...deps, quoter: createQuoter() } : deps;
}
/** Tests only: substitute PGlite and a FakeSource (the factory may ignore the job); null restores the defaults. */
export function setSyncDeps(factory: Factory | null): void {
  override = factory;
}
