import type { Db } from "@/lib/db/client";
import { readChainCursor } from "./store";

/** market.sync_state job name for the chain reader; matches src/lib/chain/run.ts's and src/lib/chain/store.ts's own copy of the same constant. */
const CHAIN_JOB = "chain";

/**
 * Binary search over block numbers in `[1, head]` for the first block whose timestamp is at or
 * after `ts` (Task 7, `.superpowers/sdd/2026-09-21-chain-reader/task-7-brief.md`). `timestampOf`
 * is injected rather than called directly against a client: each call is one RPC in production
 * (`scripts/chain/catchup.mts` builds it from the chain client's `getBlock`), so a caller that
 * wraps it with a counter can report exactly how many probes the search made — this function
 * itself only ever returns the block number, per its brief-specified signature.
 *
 * A plain "leftmost block whose timestamp >= ts" search: every probe is a comparison against the
 * caller-supplied timestamp, never an interpolation from an assumed block time, so the result is
 * correct on a chain with irregular block spacing — the one precondition is that block timestamps
 * are non-decreasing (never assumed to be evenly spaced, only monotonic, which every real chain
 * guarantees). Returns `head` when even the head block's timestamp is before `ts` (every block is
 * older than `ts` — a caller cannot tell this apart from a legitimate answer of `head` by the return
 * value alone; `scripts/chain/catchup.mts` disambiguates by comparing `timestampOf(head)` to `ts`
 * itself). Returns `1` when `ts` is at or before the first block's timestamp (every block
 * qualifies). On a run of consecutive blocks sharing one timestamp, returns the first of that run,
 * matching "at or after" exactly.
 *
 * `head` must be at least 1 (`[1, head]` is the search range); this throws rather than silently
 * returning 0, which a caller could otherwise pass straight into `seedCursor` as `-1`.
 */
export async function findBlockAtOrAfter(
  head: number,
  timestampOf: (block: number) => Promise<number>,
  ts: number,
): Promise<number> {
  if (head < 1) {
    throw new Error(`findBlockAtOrAfter: head must be >= 1, got ${head}`);
  }
  let lo = 1;
  let hi = head;
  let result = head; // default: no block probed so far had a timestamp >= ts
  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const midTs = await timestampOf(mid);
    if (midTs >= ts) {
      result = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return result;
}

/**
 * Sets the `chain` job's stored cursor to `block` (Task 7 brief). Writes the `cursor` column of
 * `market.sync_state` directly with a plain `update`, never through `src/lib/sync/state.ts`'s
 * `saveCursors`: that helper wraps the column in `greatest(cursor, $value)`, so it can only ever
 * raise a stored cursor, and a rewind issued through it would silently do nothing.
 *
 * Resume rule: writes only when the stored cursor is 0 (the job has never run) or lower than
 * `block`, so re-running a catch-up after it was interrupted (Ctrl-C, a crash) resumes from
 * wherever the stored cursor actually got to rather than rewinding to `block` and redoing work.
 * Lowering the stored cursor happens only when `opts.forceRewind` is true
 * (`scripts/chain/catchup.mts`'s `--force-rewind`); given that, `block` is written unconditionally,
 * even if it happens to raise or leave the cursor unchanged.
 *
 * Returns the cursor as it stood before this call (`from`), what it holds after (`to` — equal to
 * `from` when the resume rule left it untouched), and whether this call actually lowered it
 * (`rewound`, i.e. `to < from`).
 *
 * `opts.dryRun` (fix round 1, task-7-report.md): computes and returns exactly the same `{ from, to,
 * rewound }` a real call would, but never issues the `update` — for `scripts/chain/catchup.mts`'s
 * `--dry-run`, which must report what it would do without changing anything.
 */
export async function seedCursor(
  db: Db,
  block: number,
  opts?: { forceRewind?: boolean; dryRun?: boolean },
): Promise<{ from: number; to: number; rewound: boolean }> {
  const forceRewind = opts?.forceRewind ?? false;
  const from = await readChainCursor(db);
  const to = forceRewind || from === 0 || from < block ? block : from;
  if (to !== from && !opts?.dryRun) {
    await db.query("update market.sync_state set cursor = $2::int where job = $1", [CHAIN_JOB, to]);
  }
  return { from, to, rewound: to < from };
}

/** Every candle interval divides this evenly (m1 60, m5 300, m15 900, h1 3_600, d1 86_400): flooring to it is a bucket boundary for all five at once (fix round 2, task-7-report.md). */
const DAY_SEC = 86_400;

/** Floors `ts` to the start of its UTC day (`scripts/chain/catchup.mts`'s `--from-ts` alignment). */
export function flooredToUtcMidnight(ts: number): number {
  return Math.floor(ts / DAY_SEC) * DAY_SEC;
}

/**
 * The earliest `--from-ts` `scripts/chain/catchup.mts` should ever be allowed to start from, floored
 * to its own UTC midnight — or `null` when no pool carries one, which the caller must treat as
 * "refuse to run," never as "no bound" (fix round 3, task-7-report.md).
 *
 * Filters to `baseline_at > 0` deliberately. `baseline_at` is `int not null default 0`
 * (`supabase/migrations/20260921010000_chain_reader.sql`), and the chain reader itself creates every
 * NEW pool with that default — `upsertPools`'s column set never mentions it
 * (`src/lib/chain/store.ts`, pinned by `store.test.ts`'s "never writes baseline_at ... defaults it to
 * 0 for a pool it creates"). Without this filter, the very first `Initialize` event the catch-up
 * replays drops a `baseline_at = 0` row into `market.pools`, and from that moment `min(baseline_at)`
 * over ALL pools is `0` forever: the bound silently decays from "not before 17 Sep" to "not negative"
 * after exactly one cycle of the very first run — worse than no bound at all, since it still reads as
 * protection. Filtering to real baselines only reads the one value that never moves: the snapshot
 * copy's own `synced_at`, backfilled once by the `chain_reader` migration and never written again by
 * anything in this build.
 */
export async function earliestRebuildableFromTs(db: Db): Promise<number | null> {
  const [row] = await db.query<{ min: number | null }>("select min(baseline_at) filter (where baseline_at > 0) as min from market.pools");
  return row?.min == null ? null : flooredToUtcMidnight(row.min);
}
