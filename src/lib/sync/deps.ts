import { getDb, type Db } from "@/lib/db/client";
import { createEnvioSource } from "./envioSource";
import type { EnvioSource } from "./source";

export type SyncDeps = { db: Db; source: EnvioSource };
let override: (() => SyncDeps) | null = null;

/** What a cron route runs against: the process Db (getDb throws DbUnavailableError without DATABASE_URL) and the real source. */
export function syncDeps(): SyncDeps {
  return override ? override() : { db: getDb(), source: createEnvioSource() };
}
/** Tests only: substitute PGlite and a FakeSource; null restores the defaults. */
export function setSyncDeps(factory: (() => SyncDeps) | null): void {
  override = factory;
}
