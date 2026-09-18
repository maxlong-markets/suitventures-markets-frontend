import type { Db } from "@/lib/db/client";

/**
 * How long a trade stays in market.swaps (Kobe, 18 Sep 2026: the chain produces ~1M trades a day, and keeping
 * every one forever grows the store ~15 GB a month). Candles keep every trade's aggregate for all time; only the
 * raw swap row is pruned, by nightly.ts's "prune" phase.
 */
export const SWAP_RETENTION_SEC = 10 * 86_400;

/** The oldest ts a swap may still hold at `now`; rows with ts below this are due for pruning. */
export function retentionCutoff(now: number): number {
  return now - SWAP_RETENTION_SEC;
}

const DEFAULT_BATCH = 50_000;

/**
 * One batch's delete. The inner select has no ORDER BY — pruning does not care which stale rows go first, only
 * that they go — so it stops as soon as it has found `$2` matching ctids rather than sorting the whole match
 * set; swaps_ts_brin (20260918200000_swaps_ts_brin.sql) keeps that scan cheap on a time-ordered table. `returning
 * tx_hash` is the only way to learn how many rows a DELETE touched through the Db interface (client.ts, pglite.ts
 * both hand back rows, never a driver-level row count, for a statement without RETURNING).
 */
const PRUNE_SQL = `
  delete from market.swaps
  where ctid = any(array(select ctid from market.swaps where ts < $1::int limit $2::int))
  returning tx_hash`;

/**
 * Deletes market.swaps rows with ts < retentionCutoff(opts.now), opts.batch (default 50000) at a time, looping
 * until a batch deletes 0 rows (every stale row is gone: done true) or Date.now() reaches opts.deadlineMs (done
 * false). Pruning carries no cursor of its own — unlike the id-range and keyset walks elsewhere in sync — because
 * `ts < cutoff` already identifies exactly what is left to delete, so a run the deadline stops simply resumes
 * deleting on the next invocation (nightly.ts's "prune" phase).
 */
export async function pruneSwaps(db: Db, opts: { now: number; deadlineMs: number; batch?: number }): Promise<{ deleted: number; done: boolean }> {
  const cutoff = retentionCutoff(opts.now);
  const batch = opts.batch ?? DEFAULT_BATCH;
  let deleted = 0;
  for (;;) {
    if (Date.now() >= opts.deadlineMs) return { deleted, done: false };
    const rows = await db.query<{ tx_hash: string }>(PRUNE_SQL, [cutoff, batch]);
    deleted += rows.length;
    if (rows.length === 0) return { deleted, done: true };
  }
}
