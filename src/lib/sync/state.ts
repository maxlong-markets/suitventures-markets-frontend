import type { Db } from "@/lib/db/client";

export type SyncJob = "market" | "nightly";
export type SyncState = {
  job: SyncJob; cursor: number; cursor2: number; cursorText: string; phase: string;
  lastRunAt: number | null; lastOkAt: number | null; lastError: string | null;
  rowsWritten: number; queriesUsed: number; leaseUntil: number; leaseOwner: string | null;
};

type Row = {
  job: SyncJob; cursor: number; cursor2: number; cursor_text: string; phase: string; last_run_at: number | null;
  last_ok_at: number | null; last_error: string | null; rows_written: number; queries_used: number; lease_until: number; lease_owner: string | null;
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
    lastOkAt: r.last_ok_at, lastError: r.last_error, rowsWritten: r.rows_written, queriesUsed: r.queries_used, leaseUntil: r.lease_until, leaseOwner: r.lease_owner,
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

export async function saveCursors(db: Db, job: SyncJob, patch: { cursor?: number; cursor2?: number; cursorText?: string; phase?: string }): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [job];
  const add = (column: string, cast: string, v: unknown) => { params.push(v); sets.push(`${column} = $${params.length}::${cast}`); };
  if (patch.cursor !== undefined) add("cursor", "int", patch.cursor);
  if (patch.cursor2 !== undefined) add("cursor2", "int", patch.cursor2);
  if (patch.cursorText !== undefined) add("cursor_text", "text", patch.cursorText);
  if (patch.phase !== undefined) add("phase", "text", patch.phase);
  if (sets.length === 0) return;
  await ensureRow(db, job);
  await db.query(`update market.sync_state set ${sets.join(", ")} where job = $1`, params);
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
