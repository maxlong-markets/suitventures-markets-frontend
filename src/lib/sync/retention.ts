import type { Db } from "@/lib/db/client";
import { INTERVALS } from "./ids";

/**
 * How long a trade stays in market.swaps (Kobe, 21 Sep 2026: nothing on the site reads a trade older than 24
 * hours except the newest-fifty list on a token page, and five days keeps that list full even on a quiet
 * token). Candles keep their own, much longer, per-interval window (CANDLE_RETENTION_SEC below); only the raw
 * swap row is pruned here, by nightly.ts's "prune" phase.
 */
export const SWAP_RETENTION_SEC = 5 * 86_400;

/** The oldest ts a swap may still hold at `now`; rows with ts below this are due for pruning. */
export function retentionCutoff(now: number): number {
  return now - SWAP_RETENTION_SEC;
}

/**
 * How long each candle interval is kept. The read path never returns more than CANDLES_LIMIT (300,
 * src/lib/market/dbBackend.ts) candles for one pool and interval, so 300 buckets is the most the screen can
 * ever show: 5 h of m1, 25 h of m5, 75 h of m15, 12.5 d of h1, 300 d of d1. Each window below covers that with
 * margin. `pruneCandles` below deletes rows past these windows; nightly.ts's "prune" phase runs it right
 * after `pruneSwaps`.
 */
export const CANDLE_RETENTION_SEC = { m1: 86_400, m5: 2 * 86_400, m15: 4 * 86_400, h1: 14 * 86_400, d1: 300 * 86_400 } as const;

/** The oldest bucket start (`t`) a candle of this interval may still hold at `now`. */
export function candleCutoff(interval: keyof typeof CANDLE_RETENTION_SEC, now: number): number {
  return now - CANDLE_RETENTION_SEC[interval];
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

/**
 * One interval's one batch of pruneCandles's delete, the same ctid-batch shape as PRUNE_SQL above and for the
 * same reason: no ORDER BY, and `returning pool_id` is the only way to learn the row count through the Db
 * interface (pool_id need not be unique across the returned rows; only the count is used). `$1` is the
 * interval, `$2` its candleCutoff, `$3` the batch size.
 */
const PRUNE_CANDLES_SQL = `
  delete from market.candles
  where ctid = any(array(select ctid from market.candles where interval = $1 and t < $2::int limit $3::int))
  returning pool_id`;

/**
 * Deletes market.candles rows past each interval's own CANDLE_RETENTION_SEC window (candleCutoff), opts.batch
 * (default 50000) at a time, one interval fully drained (INTERVALS order, ids.ts) before the next starts.
 * Stops early (done false) at opts.deadlineMs, same as pruneSwaps; carries no cursor of its own either — an
 * interval only partly drained, or not yet reached, is simply found again by the next nightly's own
 * `t < candleCutoff(interval, now)` scan. Called from nightly.ts's "prune" phase, right after pruneSwaps.
 */
export async function pruneCandles(db: Db, opts: { now: number; deadlineMs: number; batch?: number }): Promise<{ deleted: number; done: boolean }> {
  const batch = opts.batch ?? DEFAULT_BATCH;
  let deleted = 0;
  for (const interval of INTERVALS) {
    const cutoff = candleCutoff(interval, opts.now);
    for (;;) {
      if (Date.now() >= opts.deadlineMs) return { deleted, done: false };
      const rows = await db.query<{ pool_id: string }>(PRUNE_CANDLES_SQL, [interval, cutoff, batch]);
      deleted += rows.length;
      if (rows.length === 0) break;
    }
  }
  return { deleted, done: true };
}
