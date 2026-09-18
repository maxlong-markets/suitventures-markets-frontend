import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "@/lib/db/client";
import type { Checkpoint } from "./seed";

const SEED_LOCK_FILE = "seed.lock";

async function swapCount(db: Db): Promise<number> {
  const [row] = await db.query<{ n: unknown }>("select count(*) as n from market.swaps");
  return Number(row?.n ?? 0);
}

/** Empties market.swaps. Returns the row count immediately before and after (the latter always 0). */
export async function truncateSwaps(db: Db): Promise<{ before: number; after: number }> {
  const before = await swapCount(db);
  await db.exec("truncate table market.swaps");
  return { before, after: await swapCount(db) };
}

/** True when `pid` names a process this OS still knows about. Signal 0 delivers nothing; it only probes. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuses to let a reset run under a live seed. `<dir>/seed.lock` holds the pid of the currently running
 * `seed.mts` (written at its start, removed on normal exit, a thrown error, or SIGTERM/SIGINT); when that pid is
 * still alive, this throws, naming the pid, so the operator stops the seed before truncating the table it is
 * writing into (a running seed's next checkpoint save would otherwise overwrite the rewind with its own in-memory
 * progress — see retention-review.md finding I1). A lock left behind by a process that is no longer running is
 * stale: removed here, and the check passes, same as when there is no lock file at all.
 */
export async function assertNoLiveSeed(dir: string): Promise<void> {
  const path = join(dir, SEED_LOCK_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "ENOENT") return;
    throw err;
  }
  const pid = Number(text.trim());
  if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
    throw new Error(`a seed is running (pid ${pid}, ${path}); stop it before resetting`);
  }
  await rm(path, { force: true });
}

/**
 * Rewinds the checkpoint at `path` so a re-run of the seed redoes the swaps phase: phase "swaps", ranges {}
 * (every range's cursor cleared), "swaps" dropped from done (nothing else in it changes), startedAt kept as it
 * was — the retention window a resumed swaps phase honours (seed.ts) still reads from the seed's original start,
 * not from this reset. A no-op, not an error, when there is no file at `path`: an operator may run this before a
 * checkpoint exists at all. Returns the rewritten checkpoint, or null when there was nothing to rewind.
 */
export async function resetSwapCheckpoint(path: string): Promise<Checkpoint | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "ENOENT") return null;
    throw err;
  }
  const cp = JSON.parse(text) as Checkpoint;
  const next: Checkpoint = { startedAt: cp.startedAt, phase: "swaps", ranges: {}, done: cp.done.filter((p) => p !== "swaps") };
  const tmp = `${path}.tmp`;
  // Written next to the file and renamed over it, so a kill mid-write can never leave a torn checkpoint (seed.mts's own convention).
  await writeFile(tmp, JSON.stringify(next, null, 2));
  await rename(tmp, path);
  return next;
}
