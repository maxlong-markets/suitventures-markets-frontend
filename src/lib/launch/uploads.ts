import "server-only";

import type { Db } from "@/lib/db/client";

/**
 * market.launch_uploads bookkeeping (instant launchpad design, section 6). A row exists only after both pins succeeded,
 * so the persistent limits count successful uploads, never attempts; `refused` rows (pinned, then refused by the locked
 * recount) are not counted and are cleaned like stale `pending` ones.
 */
export const UPLOADS_PER_HOUR = 5;
export const UPLOADS_PER_DAY = 20;

export type UploadRow = {
  wallet: string; imageCid: string; metadataCid: string; imageKey: string; metadataKey: string;
  name: string; symbol: string; description: string; website: string; x: string; telegram: string;
};
export type UploadCounts = { hour: number; day: number };
export type UploadStatus = "pending" | "refused";
export type CleanableUpload = { id: number; createdAt: number; imageCid: string; metadataCid: string; imageKey: string; metadataKey: string };

const COUNTS_SQL = `select count(*) filter (where created_at > $2::int - 3600) as hour, count(*) as day
  from market.launch_uploads
  where wallet = $1 and status in ('pending', 'used', 'deleted') and created_at > $2::int - 86400`;

export async function uploadCounts(db: Db, wallet: string, now: number): Promise<UploadCounts> {
  const [row] = await db.query<{ hour: number | string; day: number | string }>(COUNTS_SQL, [wallet.toLowerCase(), now]);
  return { hour: Number(row!.hour), day: Number(row!.day) };
}

export function overLimit(c: UploadCounts): boolean {
  return c.hour >= UPLOADS_PER_HOUR || c.day >= UPLOADS_PER_DAY;
}

/**
 * Step 12 of the route: one short transaction under a per-wallet advisory lock, so two parallel uploads from one wallet
 * count each other. Over the limit the row is still written, as `refused`, so the nightly clean-up can remove its objects.
 */
export async function recordUpload(db: Db, row: UploadRow, now: number): Promise<UploadStatus> {
  const wallet = row.wallet.toLowerCase();
  return db.tx(async (t) => {
    await t.query("select pg_advisory_xact_lock(hashtext($1))", [wallet]);
    const status: UploadStatus = overLimit(await uploadCounts(t, wallet, now)) ? "refused" : "pending";
    await t.query(
      `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, description,
         website, x, telegram, status, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::int)`,
      [wallet, row.imageCid, row.metadataCid, row.imageKey, row.metadataKey, row.name, row.symbol, row.description,
        row.website, row.x, row.telegram, status, now],
    );
    return status;
  });
}

/**
 * Up to `limit` cleanable rows, oldest first. `after` is a keyset cursor over (created_at, id): the nightly phase walks
 * past the rows it just left in place (a failed delete, a re-pinned object) instead of reading them again.
 */
export async function cleanableUploads(
  db: Db,
  cutoff: number,
  limit: number,
  after?: { createdAt: number; id: number },
): Promise<CleanableUpload[]> {
  const rows = await db.query<{ id: number | string; created_at: number; image_cid: string; metadata_cid: string; image_key: string; metadata_key: string }>(
    `select id, created_at, image_cid, metadata_cid, image_key, metadata_key from market.launch_uploads
     where status in ('pending', 'refused') and created_at < $1::int
       and (created_at, id) > ($3::int, $4::bigint)
     order by created_at, id limit $2::int`,
    [cutoff, limit, after?.createdAt ?? -1, after?.id ?? -1],
  );
  return rows.map((r) => ({
    id: Number(r.id), createdAt: Number(r.created_at), imageCid: r.image_cid, metadataCid: r.metadata_cid,
    imageKey: r.image_key, metadataKey: r.metadata_key,
  }));
}

/**
 * Whether an object must stay pinned (design section 6, orphans step 3): another row with the same CID is `used`, or is
 * `pending` or `refused` and not older than the cut-off. Object keys are content hashes, so one object can back many rows.
 */
export async function objectNeeded(db: Db, kind: "image" | "metadata", cid: string, exceptId: number, cutoff: number): Promise<boolean> {
  const column = kind === "image" ? "image_cid" : "metadata_cid";
  const [row] = await db.query<{ needed: boolean }>(
    `select exists (select 1 from market.launch_uploads where ${column} = $1 and id <> $2
       and (status = 'used' or (status in ('pending', 'refused') and created_at >= $3::int))) as needed`,
    [cid, exceptId, cutoff],
  );
  return row!.needed;
}

export async function markUploadDeleted(db: Db, id: number): Promise<void> {
  // Only a cleanable row: a row the reader marked used in the meantime keeps its status.
  await db.query("update market.launch_uploads set status = 'deleted' where id = $1 and status in ('pending', 'refused')", [id]);
}
