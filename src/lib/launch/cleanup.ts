import "server-only";

import { createChainClient } from "@/lib/chain/onchain";
import type { Db } from "@/lib/db/client";
import { readState } from "@/lib/sync/state";
import { deleteObject, filebaseConfig } from "./filebase";
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
  /** S3 DeleteObject, which unpins the CID. */
  deleteObject(key: string): Promise<void>;
};
export type CleanupResult = { skipped: "reader-stale" | null; deleted: number; failed: number; done: boolean };

export async function cleanUploads(db: Db, cleaner: UploadCleaner, now: number, deadlineMs: number): Promise<CleanupResult> {
  const chain = await readState(db, "chain");
  // A stalled reader's cursor says nothing about recent launches, so nothing is safe to judge.
  if (chain.lastOkAt === null || now - chain.lastOkAt > READER_STALE_SEC) return { skipped: "reader-stale", deleted: 0, failed: 0, done: true };
  const cutoff = (await cleaner.blockTimestamp(chain.cursor)) - UPLOAD_GRACE_SEC - LAUNCH_DEADLINE_SEC;
  const rows = await cleanableUploads(db, cutoff, CLEANUP_BATCH);
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    if (Date.now() >= deadlineMs) return { skipped: null, deleted, failed, done: false };
    try {
      if (!(await objectNeeded(db, "metadata", row.metadataCid, row.id, cutoff))) await cleaner.deleteObject(row.metadataKey);
      if (!(await objectNeeded(db, "image", row.imageCid, row.id, cutoff))) await cleaner.deleteObject(row.imageKey);
      await markUploadDeleted(db, row.id);
      deleted += 1;
    } catch (err) {
      // The row stays as it was; the next night tries again. Only the message reaches the log.
      failed += 1;
      console.warn(`nightly uploads: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // A full batch may have more behind it; but a night where every delete failed must not keep the probe waiting.
  return { skipped: null, deleted, failed, done: rows.length < CLEANUP_BATCH || deleted === 0 };
}

/** The real cleaner, or undefined while FILEBASE_ACCESS_KEY, FILEBASE_SECRET_KEY or FILEBASE_BUCKET is unset: the phase is then skipped. */
export function createUploadCleaner(): UploadCleaner | undefined {
  const storage = filebaseConfig();
  if (!storage) return undefined;
  const client = createChainClient();
  return {
    blockTimestamp: async (block) => Number((await client.getBlock({ blockNumber: BigInt(block) })).timestamp),
    deleteObject: (key) => deleteObject(storage, key),
  };
}
