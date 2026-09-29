import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Db } from "@/lib/db/client";
import { finishRun, saveCursors } from "@/lib/sync/state";
import { testDb } from "@/test/db";
import { cleanUploads, type UploadCleaner } from "./cleanup";

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(() => db.exec("delete from market.launch_uploads; delete from market.sync_state"));

const NOW = 1_790_000_000;
const CURSOR_BLOCK = 5_000;
const CURSOR_TS = NOW - 120; // the reader's cursor block is two minutes old
const CUTOFF = CURSOR_TS - 86_400 - 1_200;

type MockCleaner = { blockTimestamp: Mock<UploadCleaner["blockTimestamp"]>; deleteObject: Mock<UploadCleaner["deleteObject"]> };
function cleaner(o: Partial<MockCleaner> = {}): MockCleaner {
  return {
    blockTimestamp: vi.fn<UploadCleaner["blockTimestamp"]>(async () => CURSOR_TS),
    deleteObject: vi.fn<UploadCleaner["deleteObject"]>(async () => {}),
    ...o,
  };
}
async function reader(lastOkAt: number): Promise<void> {
  await saveCursors(db, "chain", { cursor: CURSOR_BLOCK });
  await finishRun(db, "chain", { now: lastOkAt, ok: true, rows: 0, queries: 0 });
}
async function seed(status: string, createdAt: number, meta: string, image: string): Promise<number> {
  const [row] = await db.query<{ id: number | string }>(
    `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, status, created_at)
     values ('0xc1', $1, $2, $3, $4, 'N', 'S', $5, $6) returning id`,
    [image, meta, `launch/img/${image}.webp`, `launch/meta/${meta}.json`, status, createdAt],
  );
  return Number(row!.id);
}
const statuses = async () => (await db.query<{ status: string }>("select status from market.launch_uploads order by id")).map((r) => r.status);

describe("cleanUploads (instant launchpad design, section 6, orphans)", () => {
  it("deletes the objects of pending and refused rows below the cursor-based cut-off, and marks those rows deleted", async () => {
    await reader(NOW - 60);
    await seed("pending", CUTOFF - 10, "m1", "i1");
    await seed("refused", CUTOFF - 5, "m2", "i2");
    await seed("pending", CUTOFF + 10, "m3", "i3"); // the reader may not have folded its launch yet
    const c = cleaner();
    expect(await cleanUploads(db, c, NOW, Date.now() + 60_000)).toEqual({ skipped: null, deleted: 2, failed: 0, done: true });
    expect(c.blockTimestamp).toHaveBeenCalledWith(CURSOR_BLOCK);
    expect(c.deleteObject.mock.calls.map(([key]) => key)).toEqual([
      "launch/meta/m1.json", "launch/img/i1.webp", "launch/meta/m2.json", "launch/img/i2.webp",
    ]);
    expect(await statuses()).toEqual(["deleted", "deleted", "pending"]);
  });

  it("does nothing while the chain job's last success is over an hour old", async () => {
    await reader(NOW - 3_601);
    await seed("pending", CUTOFF - 10, "m1", "i1");
    const c = cleaner();
    expect(await cleanUploads(db, c, NOW, Date.now() + 60_000)).toEqual({ skipped: "reader-stale", deleted: 0, failed: 0, done: true });
    expect(c.blockTimestamp).not.toHaveBeenCalled();
    expect(c.deleteObject).not.toHaveBeenCalled();
    expect(await statuses()).toEqual(["pending"]);
  });

  it("keeps an object another row still needs: a used row, or a fresh pending one", async () => {
    await reader(NOW - 60);
    await seed("pending", CUTOFF - 10, "m1", "i1");
    await seed("used", CUTOFF - 900, "m1", "i9"); // a live launch's metadata
    await seed("pending", CUTOFF + 50, "m7", "i1"); // a fresh upload of the same image
    const c = cleaner();
    await cleanUploads(db, c, NOW, Date.now() + 60_000);
    expect(c.deleteObject).not.toHaveBeenCalled();
    expect(await statuses()).toEqual(["deleted", "used", "pending"]);
  });

  it("leaves a row as it was when a delete fails, for the next night", async () => {
    await reader(NOW - 60);
    await seed("pending", CUTOFF - 10, "m1", "i1");
    const c = cleaner({ deleteObject: vi.fn<UploadCleaner["deleteObject"]>(async () => { throw new Error("Filebase down"); }) });
    expect(await cleanUploads(db, c, NOW, Date.now() + 60_000)).toMatchObject({ deleted: 0, failed: 1, done: true });
    expect(await statuses()).toEqual(["pending"]);
  });

  it("stops at the deadline with done false and nothing deleted", async () => {
    await reader(NOW - 60);
    await seed("pending", CUTOFF - 10, "m1", "i1");
    const c = cleaner();
    expect(await cleanUploads(db, c, NOW, Date.now() - 1)).toEqual({ skipped: null, deleted: 0, failed: 0, done: false });
    expect(c.deleteObject).not.toHaveBeenCalled();
  });
});
