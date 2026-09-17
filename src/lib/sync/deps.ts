import { getDb, type Db } from "@/lib/db/client";
import { createEnvioSource } from "./envioSource";
import type { RetryOpts } from "./limiter";
import type { EnvioSource } from "./source";

export type SyncDeps = { db: Db; source: EnvioSource };
let override: (() => SyncDeps) | null = null;

/**
 * Inside the sync a request may take at most 3 attempts: 3 × the 20 s request timeout plus 1 + 2 s of backoff is
 * 63 s, so a request that starts at the end of the market window (50 s) still ends inside the 120 s lease.
 */
export const SYNC_RETRY: RetryOpts = { attempts: 3 };

/** What a cron route runs against: the process Db (getDb throws DbUnavailableError without DATABASE_URL) and the real source. */
export function syncDeps(): SyncDeps {
  return override ? override() : { db: getDb(), source: createEnvioSource({ retry: SYNC_RETRY }) };
}
/** Tests only: substitute PGlite and a FakeSource; null restores the defaults. */
export function setSyncDeps(factory: (() => SyncDeps) | null): void {
  override = factory;
}
