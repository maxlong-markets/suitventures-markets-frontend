import type { Db } from "@/lib/db/client";

export type SyncJob = "market" | "nightly" | "chain";
export type SyncState = {
  job: SyncJob; cursor: number; cursor2: number; cursorText: string; phase: string;
  lastRunAt: number | null; lastOkAt: number | null; lastError: string | null;
  rowsWritten: number; queriesUsed: number; leaseUntil: number; leaseOwner: string | null;
};

/** rows_written and queries_used are bigint: a string from the postgres driver, a number from PGlite; read through Number(). */
type Row = {
  job: SyncJob; cursor: number; cursor2: number; cursor_text: string; phase: string; last_run_at: number | null;
  last_ok_at: number | null; last_error: string | null; rows_written: number | string; queries_used: number | string; lease_until: number; lease_owner: string | null;
};

/** Every function starts here, so each works on a database that has never seen the job. */
const ensureRow = (db: Db, job: SyncJob) => db.query("insert into market.sync_state (job) values ($1) on conflict (job) do nothing", [job]);

export async function readState(db: Db, job: SyncJob): Promise<SyncState> {
  await ensureRow(db, job);
  const [r] = await db.query<Row>(
    "select job, cursor, cursor2, cursor_text, phase, last_run_at, last_ok_at, last_error, rows_written, queries_used, lease_until, lease_owner from market.sync_state where job = $1",
    [job],
  );
  return {
    job: r.job, cursor: r.cursor, cursor2: r.cursor2, cursorText: r.cursor_text, phase: r.phase, lastRunAt: r.last_run_at,
    lastOkAt: r.last_ok_at, lastError: r.last_error, rowsWritten: Number(r.rows_written), queriesUsed: Number(r.queries_used), leaseUntil: r.lease_until, leaseOwner: r.lease_owner,
  };
}

/** One conditional UPDATE: atomic, so two invocations racing for the row cannot both win. */
export async function acquireLease(db: Db, job: SyncJob, owner: string, now: number, ttlSec: number): Promise<boolean> {
  await ensureRow(db, job);
  const rows = await db.query(
    "update market.sync_state set lease_until = $3::int, lease_owner = $2::text where job = $1 and lease_until < $4::int returning job",
    [job, owner, now + ttlSec, now],
  );
  return rows.length === 1;
}

export async function releaseLease(db: Db, job: SyncJob, owner: string): Promise<void> {
  await db.query("update market.sync_state set lease_until = 0, lease_owner = null where job = $1 and lease_owner = $2::text", [job, owner]);
}

/**
 * Extends job's lease_until to now + ttlSec, but only while lease_owner still matches owner — this
 * never acquires or steals a lease the caller does not already hold, unlike acquireLease. Returns
 * whether it matched (one row updated); a false return means someone else holds the lease now (it
 * expired and was re-acquired, or was force-cleared), and the caller must stop writing rather than
 * assume it still owns the job.
 *
 * For a run that holds a lease across many cycles and outlives the lease's original ttlSec (Task 7's
 * catch-up script, chain-reader cutover, 21 Sep 2026): runChainSync/acquireLease takes the lease once
 * and never renews it, so a caller with its own long-running loop calls this periodically to keep the
 * lease alive past that original window instead of letting it expire mid-run.
 */
export async function renewLease(db: Db, job: SyncJob, owner: string, now: number, ttlSec: number): Promise<boolean> {
  const rows = await db.query(
    "update market.sync_state set lease_until = $3::int where job = $1 and lease_owner = $2::text returning job",
    [job, owner, now + ttlSec],
  );
  return rows.length === 1;
}

/**
 * `cursor` and `cursor2` only ever rise (`greatest` in SQL): a cycle that read them before another invocation moved
 * them on, and writes last, cannot pull them back. `cursorText` and `phase` are plain writes.
 */
export async function saveCursors(db: Db, job: SyncJob, patch: { cursor?: number; cursor2?: number; cursorText?: string; phase?: string }): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [job];
  const add = (column: string, cast: string, v: unknown, monotonic = false) => {
    params.push(v);
    const value = `$${params.length}::${cast}`;
    sets.push(`${column} = ${monotonic ? `greatest(${column}, ${value})` : value}`);
  };
  if (patch.cursor !== undefined) add("cursor", "int", patch.cursor, true);
  if (patch.cursor2 !== undefined) add("cursor2", "int", patch.cursor2, true);
  if (patch.cursorText !== undefined) add("cursor_text", "text", patch.cursorText);
  if (patch.phase !== undefined) add("phase", "text", patch.phase);
  if (sets.length === 0) return;
  await ensureRow(db, job);
  await db.query(`update market.sync_state set ${sets.join(", ")} where job = $1`, params);
}

/**
 * The head-block mark (spec 5.3a) lives on the market row and is shared by both jobs: the highest
 * latest_processed_block Envio has ever reported to an invocation. An indexer reporting less is replaying.
 */
export async function readHeadBlock(db: Db): Promise<number> {
  await ensureRow(db, "market");
  const [r] = await db.query<{ head_block: number }>("select head_block from market.sync_state where job = 'market'");
  return r.head_block;
}

/** Raises the mark to `block` where it is lower; never lowers it. */
export async function raiseHeadBlock(db: Db, block: number): Promise<void> {
  await ensureRow(db, "market");
  await db.query("update market.sync_state set head_block = greatest(head_block, $1::int) where job = 'market'", [block]);
}

export async function finishRun(db: Db, job: SyncJob, r: { now: number; ok: boolean; error?: string; rows: number; queries: number }): Promise<void> {
  await ensureRow(db, job);
  await db.query(
    `update market.sync_state set last_run_at = $2::int,
       last_ok_at = case when $3::boolean then $2::int else last_ok_at end,
       last_error = case when $3::boolean then null else $4::text end,
       rows_written = rows_written + $5::int, queries_used = queries_used + $6::int
     where job = $1`,
    [job, r.now, r.ok, r.error ?? null, r.rows, r.queries],
  );
}
