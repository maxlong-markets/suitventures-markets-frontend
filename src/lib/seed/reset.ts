import { readFile, rename, writeFile } from "node:fs/promises";
import type { Db } from "@/lib/db/client";
import type { Checkpoint } from "./seed";

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
