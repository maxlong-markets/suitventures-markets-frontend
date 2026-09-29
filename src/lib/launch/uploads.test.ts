import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import {
  UPLOADS_PER_DAY, UPLOADS_PER_HOUR, cleanableUploads, markUploadDeleted, objectNeeded, overLimit, recordUpload, uploadCounts,
  type UploadRow,
} from "./uploads";

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(() => db.exec("delete from market.launch_uploads"));

const NOW = 1_790_000_000;
const WALLET = "0x" + "c1".repeat(20);
const OTHER = "0x" + "c2".repeat(20);
const META = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const IMAGE = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";

function row(o: Partial<UploadRow> = {}): UploadRow {
  return {
    wallet: WALLET, imageCid: IMAGE, metadataCid: META, imageKey: "launch/img/aa.webp", metadataKey: "launch/meta/bb.json",
    name: "Tailor's Chalk", symbol: "CHALK", description: "", website: "", x: "", telegram: "", ...o,
  };
}
async function seed(status: string, createdAt: number, o: Partial<UploadRow> = {}): Promise<number> {
  const r = row(o);
  const [out] = await db.query<{ id: number | string }>(
    `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, status, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [r.wallet, r.imageCid, r.metadataCid, r.imageKey, r.metadataKey, r.name, r.symbol, status, createdAt],
  );
  return Number(out!.id);
}

describe("uploadCounts and overLimit", () => {
  it("counts this wallet's pending, used and deleted rows over the last hour and day, never refused ones or other wallets", async () => {
    await seed("pending", NOW - 60);
    await seed("used", NOW - 3000);
    await seed("deleted", NOW - 7200);
    await seed("refused", NOW - 60);
    await seed("pending", NOW - 90_000); // older than a day
    await seed("pending", NOW - 60, { wallet: OTHER });
    expect(await uploadCounts(db, WALLET, NOW)).toEqual({ hour: 2, day: 3 });
  });

  it("refuses at 5 an hour and at 20 a day", () => {
    expect([UPLOADS_PER_HOUR, UPLOADS_PER_DAY]).toEqual([5, 20]);
    expect(overLimit({ hour: 4, day: 19 })).toBe(false);
    expect(overLimit({ hour: 5, day: 5 })).toBe(true);
    expect(overLimit({ hour: 0, day: 20 })).toBe(true);
  });
});

describe("recordUpload", () => {
  it("stores the row pending under the limit and refused at it, and a refused row never counts", async () => {
    for (let i = 0; i < 4; i += 1) await seed("pending", NOW - 100 - i);
    expect(await recordUpload(db, row(), NOW)).toBe("pending");
    expect(await recordUpload(db, row(), NOW)).toBe("refused");
    expect(await uploadCounts(db, WALLET, NOW)).toEqual({ hour: 5, day: 5 });
    const stored = await db.query<{ status: string; created_at: number; wallet: string }>(
      "select status, created_at, wallet from market.launch_uploads where created_at = $1 order by id",
      [NOW],
    );
    expect(stored).toEqual([
      { status: "pending", created_at: NOW, wallet: WALLET },
      { status: "refused", created_at: NOW, wallet: WALLET },
    ]);
  });

  it("makes two parallel uploads from one wallet count each other: at 4, exactly one is accepted", async () => {
    for (let i = 0; i < 4; i += 1) await seed("pending", NOW - 100 - i);
    // PGlite runs one transaction at a time, so the outcome alone would pass without the lock. Record every statement
    // each transaction issues, so a missing pg_advisory_xact_lock fails this test (on Postgres, it is what serialises them).
    const statements: string[] = [];
    const realTx = db.tx.bind(db);
    vi.spyOn(db, "tx").mockImplementation(<T,>(fn: (t: Db) => Promise<T>) =>
      realTx((t) => fn({ ...t, query: (sql: string, params?: readonly unknown[]) => { statements.push(sql); return t.query(sql, params); } } as Db)),
    );
    const results = await Promise.all([recordUpload(db, row(), NOW), recordUpload(db, row(), NOW)]);
    vi.restoreAllMocks();
    expect([...results].sort()).toEqual(["pending", "refused"]);
    expect((await uploadCounts(db, WALLET, NOW)).hour).toBe(5);
    const locks = statements.flatMap((sql, i) => (sql.includes("pg_advisory_xact_lock(hashtext($1))") ? [i] : []));
    expect(locks).toHaveLength(2);
    // Each transaction takes the lock before its recount and its insert.
    for (const i of locks) expect(statements[i + 1]).toContain("count(*)");
  });
});

describe("the clean-up queries", () => {
  it("lists pending and refused rows older than the cut-off, oldest first, up to the limit", async () => {
    const a = await seed("pending", NOW - 5000);
    const b = await seed("refused", NOW - 4000);
    await seed("used", NOW - 6000);
    await seed("deleted", NOW - 6000);
    await seed("pending", NOW - 10); // after the cut-off
    const c = await seed("pending", NOW - 3000);
    expect((await cleanableUploads(db, NOW - 1000, 10)).map((r) => r.id)).toEqual([a, b, c]);
    expect((await cleanableUploads(db, NOW - 1000, 2)).map((r) => r.id)).toEqual([a, b]);
    expect((await cleanableUploads(db, NOW - 1000, 1))[0]).toEqual({
      id: a, createdAt: NOW - 5000, imageCid: IMAGE, metadataCid: META, imageKey: "launch/img/aa.webp", metadataKey: "launch/meta/bb.json",
    });
    // The keyset cursor walks on past rows already seen, ties on created_at broken by id.
    const d = await seed("refused", NOW - 4000);
    expect((await cleanableUploads(db, NOW - 1000, 10, { createdAt: NOW - 5000, id: a })).map((r) => r.id)).toEqual([b, d, c]);
    expect((await cleanableUploads(db, NOW - 1000, 10, { createdAt: NOW - 4000, id: b })).map((r) => r.id)).toEqual([d, c]);
  });

  it("keeps an object another row still needs: a used row, or a pending or refused row newer than the cut-off", async () => {
    const stale = await seed("pending", NOW - 5000);
    expect(await objectNeeded(db, "metadata", META, stale, NOW - 1000)).toBe(false);
    await seed("pending", NOW - 4500); // also stale: does not protect
    expect(await objectNeeded(db, "metadata", META, stale, NOW - 1000)).toBe(false);
    await seed("refused", NOW - 10); // fresh
    expect(await objectNeeded(db, "metadata", META, stale, NOW - 1000)).toBe(true);
    expect(await objectNeeded(db, "image", IMAGE, stale, NOW - 1000)).toBe(true);
    expect(await objectNeeded(db, "image", "bafyother", stale, NOW - 1000)).toBe(false);
    await db.exec("delete from market.launch_uploads");
    const lone = await seed("pending", NOW - 5000);
    await seed("used", NOW - 9000, { imageCid: "bafyimg2" });
    expect(await objectNeeded(db, "metadata", META, lone, NOW - 1000)).toBe(true);
  });

  it("marks a pending or refused row deleted, and never a row the reader has since marked used", async () => {
    const id = await seed("pending", NOW - 5000);
    await markUploadDeleted(db, id);
    expect(await db.query("select status from market.launch_uploads where id = $1", [id])).toEqual([{ status: "deleted" }]);
    const refused = await seed("refused", NOW - 5000);
    await markUploadDeleted(db, refused);
    expect(await db.query("select status from market.launch_uploads where id = $1", [refused])).toEqual([{ status: "deleted" }]);
    const used = await seed("used", NOW - 5000);
    await markUploadDeleted(db, used);
    expect(await db.query("select status from market.launch_uploads where id = $1", [used])).toEqual([{ status: "used" }]);
  });
});
