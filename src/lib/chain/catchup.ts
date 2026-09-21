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
 * correct on a chain with irregular block spacing. Returns `head` when even the head block's
 * timestamp is before `ts` (every block is older than `ts`); returns `1` when `ts` is at or
 * before the first block's timestamp (every block qualifies).
 */
export async function findBlockAtOrAfter(
  head: number,
  timestampOf: (block: number) => Promise<number>,
  ts: number,
): Promise<number> {
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
