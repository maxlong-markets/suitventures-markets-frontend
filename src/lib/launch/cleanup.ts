import "server-only";

import { createChainClient } from "@/lib/chain/onchain";
import type { Db } from "@/lib/db/client";
import { readState } from "@/lib/sync/state";
import { deleteObject, filebaseConfig, headObject } from "./filebase";
import { cleanableUploads, markUploadDeleted, objectNeeded } from "./uploads";

/**
 * The nightly `"uploads"` phase (instant launchpad design, section 6, orphans). An upload whose launch never landed keeps
 * two pinned objects for nothing; this removes them. The cut-off follows the reader's cursor, not the wall clock: an
 * upload whose launch the reader has not folded yet is still `pending`, and deleting it would blank a live token.
 */
export const CLEANUP_BATCH = 200;
export const UPLOAD_GRACE_SEC = 86_400;
/** The form's permit and launch deadline: the longest a signed launch can wait before it lands. */
export const LAUNCH_DEADLINE_SEC = 1_200;
export const READER_STALE_SEC = 3_600;

export type UploadCleaner = {
  /** Unix seconds of a block: one RPC call per night. */
  blockTimestamp(block: number): Promise<number>;
  /** S3 HeadObject: the object's Last-Modified in unix seconds, or null when it is already gone. */
  objectModifiedAt(key: string): Promise<number | null>;
  /** S3 DeleteObject, which unpins the CID. */
  deleteObject(key: string): Promise<void>;
};
/**
 * `skipped`: "reader-stale" (the chain job has not succeeded for an hour) or "rpc" (the cut-off or the rows could not be
 * read). `kept`: rows left as they are because an object was re-pinned after the cut-off. `raced`: objects deleted that a
 * row needed by the time the delete finished, each also logged as an error. `done` is false only when the deadline
 * stopped the walk: a night of failures still ends the phase, so the probe behind it always runs.
 */
export type CleanupResult = {
  skipped: "reader-stale" | "rpc" | null; deleted: number; failed: number; kept: number; raced: number; done: boolean;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Removal = "gone" | "kept";

/**
 * One object of one row. Kept when another row needs it, or when its Last-Modified is at or after the cut-off: a recent
 * re-upload of the same content re-pinned the same key after the rows were judged. After a delete the rule is asked
 * again; a row that needs the object now lost it to a race, which is logged loudly and counted.
 */
async function removeObject(
  db: Db, cleaner: UploadCleaner, kind: "image" | "metadata", cid: string, key: string, rowId: number, cutoff: number, r: CleanupResult,
): Promise<Removal> {
  if (await objectNeeded(db, kind, cid, rowId, cutoff)) return "gone";
  const modified = await cleaner.objectModifiedAt(key);
  if (modified === null) return "gone";
  if (modified >= cutoff) return "kept";
  await cleaner.deleteObject(key);
  if (await objectNeeded(db, kind, cid, rowId, cutoff)) {
    r.raced += 1;
    console.error(`nightly uploads: RACE: deleted ${key} while another upload row needed it; re-upload that ${kind} to re-pin it`);
  }
  return "gone";
}

export async function cleanUploads(db: Db, cleaner: UploadCleaner, now: number, deadlineMs: number): Promise<CleanupResult> {
  const r: CleanupResult = { skipped: null, deleted: 0, failed: 0, kept: 0, raced: 0, done: true };
  const chain = await readState(db, "chain");
  // A stalled reader's cursor says nothing about recent launches, so nothing is safe to judge.
  if (chain.lastOkAt === null || now - chain.lastOkAt > READER_STALE_SEC) return { ...r, skipped: "reader-stale" };
  let cutoff: number;
  try {
    cutoff = (await cleaner.blockTimestamp(chain.cursor)) - UPLOAD_GRACE_SEC - LAUNCH_DEADLINE_SEC;
  } catch (err) {
    console.warn(`nightly uploads: skipped, no cut-off: ${message(err)}`);
    return { ...r, skipped: "rpc" };
  }
  let after: { createdAt: number; id: number } | undefined;
  for (;;) {
    let rows: Awaited<ReturnType<typeof cleanableUploads>>;
    try {
      rows = await cleanableUploads(db, cutoff, CLEANUP_BATCH, after);
    } catch (err) {
      console.warn(`nightly uploads: skipped, rows unreadable: ${message(err)}`);
      return { ...r, skipped: "rpc" };
    }
    for (const row of rows) {
      if (Date.now() >= deadlineMs) return { ...r, done: false };
      // The cursor walks past this row whatever happens to it, so a row left in place is not read again tonight.
      after = { createdAt: row.createdAt, id: row.id };
      try {
        if ((await removeObject(db, cleaner, "metadata", row.metadataCid, row.metadataKey, row.id, cutoff, r)) === "kept"
          || (await removeObject(db, cleaner, "image", row.imageCid, row.imageKey, row.id, cutoff, r)) === "kept") {
          r.kept += 1;
          continue;
        }
        await markUploadDeleted(db, row.id);
        r.deleted += 1;
      } catch (err) {
        // The row stays as it was; the next night tries again. Only the message reaches the log.
        r.failed += 1;
        console.warn(`nightly uploads: ${message(err)}`);
      }
    }
    if (rows.length < CLEANUP_BATCH) return r;
  }
}

/** The real cleaner, or undefined while FILEBASE_ACCESS_KEY, FILEBASE_SECRET_KEY or FILEBASE_BUCKET is unset: the phase is then skipped. */
export function createUploadCleaner(): UploadCleaner | undefined {
  const storage = filebaseConfig();
  if (!storage) return undefined;
  const client = createChainClient();
  return {
    blockTimestamp: async (block) => Number((await client.getBlock({ blockNumber: BigInt(block) })).timestamp),
    objectModifiedAt: (key) => headObject(storage, key),
    deleteObject: (key) => deleteObject(storage, key),
  };
}
