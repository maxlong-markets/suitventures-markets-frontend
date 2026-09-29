import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LaunchFeesRow, LaunchRow } from "@/lib/chain/types";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import { applyPayouts, attachUploads, insertLaunchFees, insertLaunches, launchHealth } from "./store";

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(() => db.exec("delete from market.launches; delete from market.launch_fee_events; delete from market.launch_uploads"));

const T0 = 1_790_000_000;
const TOKEN = "0x" + "a1".repeat(20);
const TOKEN_B = "0x" + "a2".repeat(20);
const CREATOR = "0x" + "c1".repeat(20);
const PAYOUT = "0x" + "c2".repeat(20);
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const POOL = "0x" + "11".repeat(32);
const TX = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const META_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const OTHER_META_CID = "bafkreid7qoywk77r7rj3slobqfekdvs57qwuwh5d2z3sqsw52iabe3mqne";
const IMAGE_CID = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";
const NEWER_IMAGE_CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

function launchRow(o: Partial<LaunchRow> = {}): LaunchRow {
  return {
    tokenId: TOKEN, poolId: POOL, quoteId: USDG, creator: CREATOR, payout: CREATOR, hook: "0x" + "0".repeat(40),
    tokenIsCurrency0: true, creatorShareBps: 7000, openTick: -398_400, openingValuation: 4_995_430_000n,
    liquidity: 2_240_000_000_000_000_000n, tokensInPool: 999_999_999_999_999_999_700_000_000n, firstBuyIn: 0n, firstBuyTokens: 0n,
    routerFee: 0n, creationFee: 0n, name: "Tailor's Chalk", symbol: "CHALK", metadataUri: `ipfs://${META_CID}`, metadataCid: META_CID,
    block: 100, logIndex: 7, txHash: TX(1), timestamp: T0, ...o,
  };
}
function feeRow(o: Partial<LaunchFeesRow> = {}): LaunchFeesRow {
  return {
    txHash: TX(9), logIndex: 2, tokenId: TOKEN, payout: CREATOR, tokenPayout: 700n, tokenPlatform: 300n, quotePayout: 7_000_000n,
    quotePlatform: 3_000_000n, timestamp: T0 + 600, block: 160, ...o,
  };
}
/** One market.launch_uploads row, written straight: the route's own insert is uploads.ts's business. */
async function upload(
  o: { metadataCid?: string; imageCid?: string; status?: string; createdAt?: number; website?: string; wallet?: string } = {},
): Promise<number> {
  const [row] = await db.query<{ id: number | string }>(
    `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, description, website, x, telegram, status, created_at)
     values ($1, $2, $3, 'launch/img/k.webp', 'launch/meta/k.json', 'Tailor''s Chalk', 'CHALK', 'Chalk for tailors.', $4, 'https://x.com/chalk', '', $5, $6)
     returning id`,
    [o.wallet ?? CREATOR, o.imageCid ?? IMAGE_CID, o.metadataCid ?? META_CID, o.website ?? "", o.status ?? "pending", o.createdAt ?? T0 - 60],
  );
  return Number(row!.id);
}
const launch = async (tokenId = TOKEN) =>
  (await db.query<Record<string, unknown>>(
    `select payout, payout_block, payout_log_index, opening_valuation::text as opening_valuation, tokens_in_pool::text as tokens_in_pool,
       image_cid, description, website, x, telegram, updated_at from market.launches where token_id = $1`,
    [tokenId],
  ))[0];
const uploadRows = () => db.query<{ id: number | string; status: string; used_at: number; token_id: string }>(
  "select id, status, used_at, token_id from market.launch_uploads order by id",
);

describe("insertLaunches", () => {
  it("inserts a launch once, keyed by token: a replayed Launched changes nothing, and the payout position starts at the launch's own", async () => {
    expect(await insertLaunches(db, [launchRow()], T0 + 10)).toBe(1);
    expect(await insertLaunches(db, [launchRow({ payout: PAYOUT, openingValuation: 1n })], T0 + 20)).toBe(0);
    expect(await launch()).toMatchObject({
      payout: CREATOR, payout_block: 100, payout_log_index: 7, opening_valuation: "4995430000",
      tokens_in_pool: "999999999999999999700000000", image_cid: "", updated_at: T0 + 10,
    });
  });
});

describe("attachUploads", () => {
  it("copies the newest live upload's image and links onto the launch and marks every pending upload of that CID used", async () => {
    const older = await upload({ createdAt: T0 - 600 });
    const newer = await upload({ imageCid: NEWER_IMAGE_CID, website: "https://chalk.test", createdAt: T0 - 60 });
    const unrelated = await upload({ metadataCid: OTHER_META_CID });
    await insertLaunches(db, [launchRow()], T0);
    await attachUploads(db, [TOKEN], T0 + 5);
    expect(await launch()).toMatchObject({
      image_cid: NEWER_IMAGE_CID, description: "Chalk for tailors.", website: "https://chalk.test", x: "https://x.com/chalk",
      telegram: "", updated_at: T0 + 5,
    });
    expect((await uploadRows()).map((r) => [Number(r.id), r.status, r.used_at, r.token_id])).toEqual([
      [older, "used", T0 + 5, TOKEN],
      [newer, "used", T0 + 5, TOKEN],
      [unrelated, "pending", 0, ""],
    ]);
  });

  it("never copies from, nor revives, a deleted upload: that launch shows no image and the health count says so", async () => {
    const gone = await upload({ status: "deleted" });
    await insertLaunches(db, [launchRow()], T0);
    await attachUploads(db, [TOKEN], T0 + 5);
    expect(await launch()).toMatchObject({ image_cid: "", website: "" });
    expect((await uploadRows()).map((r) => [Number(r.id), r.status])).toEqual([[gone, "deleted"]]);
    expect(await launchHealth(db)).toEqual({ missingUploads: 1, deletedUploads: 1 });
  });

  it("never copies from a refused upload, whose objects the clean-up will remove: the launch gets nothing and the row stays refused", async () => {
    const refused = await upload({ status: "refused", website: "https://chalk.test" });
    await insertLaunches(db, [launchRow()], T0);
    await attachUploads(db, [TOKEN], T0 + 5);
    expect(await launch()).toMatchObject({ image_cid: "", description: "", website: "", x: "", telegram: "", updated_at: T0 });
    expect((await uploadRows()).map((r) => [Number(r.id), r.status, r.used_at, r.token_id])).toEqual([[refused, "refused", 0, ""]]);
  });

  it("leaves a launch whose URI carried no ipfs CID alone", async () => {
    await upload({ metadataCid: "" });
    await insertLaunches(db, [launchRow({ metadataUri: "https://example.test/meta.json", metadataCid: "" })], T0);
    await attachUploads(db, [TOKEN], T0 + 5);
    expect(await launch()).toMatchObject({ image_cid: "" });
    expect((await uploadRows())[0]!.status).toBe("pending");
    expect(await launchHealth(db)).toEqual({ missingUploads: 0, deletedUploads: 0 });
  });

  it("attaches only an upload made by the launch's creator: another wallet's upload of the same metadata CID is never borrowed", async () => {
    const theirs = await upload({ wallet: PAYOUT, imageCid: NEWER_IMAGE_CID, website: "https://borrowed.test", createdAt: T0 - 30 });
    const mine = await upload({ createdAt: T0 - 600 });
    await insertLaunches(db, [launchRow()], T0);
    await attachUploads(db, [TOKEN], T0 + 5);
    expect(await launch()).toMatchObject({ image_cid: IMAGE_CID, website: "", description: "Chalk for tailors." });
    expect((await uploadRows()).map((r) => [Number(r.id), r.status, r.token_id])).toEqual([
      [theirs, "pending", ""],
      [mine, "used", TOKEN],
    ]);
  });

  it("attaches nothing when the only upload of that metadata CID came from another wallet", async () => {
    const theirs = await upload({ wallet: PAYOUT });
    await insertLaunches(db, [launchRow()], T0);
    await attachUploads(db, [TOKEN], T0 + 5);
    expect(await launch()).toMatchObject({ image_cid: "", description: "", website: "", x: "", updated_at: T0 });
    expect((await uploadRows()).map((r) => [Number(r.id), r.status, r.token_id])).toEqual([[theirs, "pending", ""]]);
  });

  it("does nothing for an empty list", async () => {
    await expect(attachUploads(db, [], T0)).resolves.toBeUndefined();
  });
});

describe("insertLaunchFees", () => {
  it("inserts one row per log and nothing when the same logs come again", async () => {
    const rows = [feeRow(), feeRow({ logIndex: 5, tokenId: TOKEN_B })];
    expect(await insertLaunchFees(db, rows)).toBe(2);
    expect(await insertLaunchFees(db, rows)).toBe(0);
    const stored = await db.query<{ token_payout: string; quote_platform: string }>(
      "select token_payout::text as token_payout, quote_platform::text as quote_platform from market.launch_fee_events order by log_index",
    );
    expect(stored).toEqual([
      { token_payout: "700", quote_platform: "3000000" },
      { token_payout: "700", quote_platform: "3000000" },
    ]);
  });
});

describe("applyPayouts", () => {
  it("moves the payout only forward by (block, log index): an older change is a no-op, a newer one wins", async () => {
    await insertLaunches(db, [launchRow()], T0);
    expect(await applyPayouts(db, [{ tokenId: TOKEN, payout: PAYOUT, block: 120, logIndex: 3 }], T0 + 1)).toBe(1);
    expect(await applyPayouts(db, [{ tokenId: TOKEN, payout: CREATOR, block: 120, logIndex: 2 }], T0 + 2)).toBe(0);
    expect(await applyPayouts(db, [{ tokenId: TOKEN, payout: PAYOUT, block: 120, logIndex: 3 }], T0 + 3)).toBe(0);
    expect(await launch()).toMatchObject({ payout: PAYOUT, payout_block: 120, payout_log_index: 3, updated_at: T0 + 1 });
    expect(await applyPayouts(db, [{ tokenId: TOKEN, payout: CREATOR, block: 121, logIndex: 0 }], T0 + 4)).toBe(1);
    expect(await launch()).toMatchObject({ payout: CREATOR, payout_block: 121, payout_log_index: 0 });
  });

  it("keeps only the latest change when one token appears twice in one call, in either order", async () => {
    await insertLaunches(db, [launchRow()], T0);
    const later = { tokenId: TOKEN, payout: PAYOUT, block: 130, logIndex: 1 };
    const earlier = { tokenId: TOKEN, payout: CREATOR, block: 130, logIndex: 0 };
    expect(await applyPayouts(db, [later, earlier], T0 + 1)).toBe(1);
    expect(await launch()).toMatchObject({ payout: PAYOUT, payout_block: 130, payout_log_index: 1 });
    const third = { tokenId: TOKEN, payout: CREATOR, block: 131, logIndex: 0 };
    const fourth = { tokenId: TOKEN, payout: PAYOUT, block: 131, logIndex: 4 };
    expect(await applyPayouts(db, [third, fourth], T0 + 2)).toBe(1);
    expect(await launch()).toMatchObject({ payout: PAYOUT, payout_block: 131, payout_log_index: 4 });
  });
});
