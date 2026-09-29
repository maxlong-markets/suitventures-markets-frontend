import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { allowUploadClient, allowWrite, resetRateLimit } from "@/lib/social/rateLimit";
import { nowSec } from "@/lib/time";
import type { Address } from "@/lib/types";
import { testDb } from "@/test/db";
import { TEST_SESSION_SECRET, sessionHeader } from "@/test/session";
import { POST } from "./route";

const LAUNCHPAD = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const h = vi.hoisted(() => ({
  db: null as import("@/lib/db/client").Db | null,
  launchpad: "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a" as string | undefined,
  gate: vi.fn(),
}));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, hasDb: () => h.db !== null, getDb: () => h.db as Db };
});
vi.mock("@/lib/launch/address", () => ({
  get LAUNCHPAD_ADDRESS() {
    return h.launchpad;
  },
  hasLaunchpad: () => h.launchpad !== undefined,
}));
vi.mock("@/lib/chain/onchain", () => ({ createChainClient: () => ({ readContract: h.gate }) }));

const WALLET = `0x${"a".repeat(40)}` as Address;
const IMAGE_CID = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";
const META_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

/** Every Filebase call the route makes, with its body read, so tests can check what was pinned and that nothing was deleted. */
const calls: { method: string; url: string; body: Uint8Array }[] = [];
async function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  calls.push({ method: req.method, url: req.url, body: new Uint8Array(await req.clone().arrayBuffer()) });
  if (req.method !== "PUT") return new Response(null, { status: 204 });
  return new Response(null, { status: 200, headers: { "x-amz-meta-cid": req.url.includes("/launch/img/") ? IMAGE_CID : META_CID } });
}
const filebase = vi.fn(answer);

let db: Db;
let png: Buffer;
let animated: Buffer;
beforeAll(async () => {
  db = await testDb();
  h.db = db;
  png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#00ff00" } }).png().toBuffer();
  const red = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#ff0000" } }).png().toBuffer();
  const blue = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#0000ff" } }).png().toBuffer();
  animated = await sharp([red, blue], { join: { animated: true } }).gif().toBuffer();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", TEST_SESSION_SECRET);
  vi.stubEnv("FILEBASE_ACCESS_KEY", "test-access");
  vi.stubEnv("FILEBASE_SECRET_KEY", "test-secret");
  vi.stubEnv("FILEBASE_BUCKET", "test-bucket");
  vi.stubGlobal("fetch", filebase);
  calls.length = 0;
  filebase.mockReset();
  filebase.mockImplementation(answer);
  h.db = db;
  h.launchpad = LAUNCHPAD;
  h.gate.mockReset();
  h.gate.mockResolvedValue(true);
  resetRateLimit();
  await db.exec("delete from market.launch_uploads");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Fields = { name: string; symbol: string; description: string; website: string; x: string; telegram: string };
function form(o: Partial<Fields> & { image?: Blob | null } = {}): FormData {
  const f = new FormData();
  if (o.image !== null) f.set("image", o.image ?? new Blob([new Uint8Array(png)], { type: "image/png" }), "logo.png");
  f.set("name", o.name ?? "Tailor's Chalk");
  f.set("symbol", o.symbol ?? "CHALK");
  f.set("description", o.description ?? "Chalk for tailors.");
  f.set("website", o.website ?? "https://chalk.test");
  f.set("x", o.x ?? "@chalk");
  f.set("telegram", o.telegram ?? "");
  return f;
}
const post = (body: BodyInit | null, headers: Record<string, string> = { cookie: sessionHeader(WALLET) }) =>
  POST(new Request("http://localhost:3000/api/launch/upload", { method: "POST", body, headers }));
const refusal = async (res: Response) => ({ status: res.status, cache: res.headers.get("Cache-Control"), body: await res.json() });
async function seedRows(n: number, status = "pending"): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await db.query(
      `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, status, created_at)
       values ($1, 'i', 'm', 'ik', 'mk', 'N', 'S', $2, $3)`,
      [WALLET, status, nowSec() - 10 - i],
    );
  }
}
const rows = () => db.query<{ status: string; wallet: string; x: string; image_key: string }>("select status, wallet, x, image_key from market.launch_uploads order by id");

describe("POST /api/launch/upload, in the order of spec 6's checks", () => {
  it("1: answers 401 without a session and 503 while sessions are not configured", async () => {
    expect((await post(form(), {})).status).toBe(401);
    vi.stubEnv("SESSION_SECRET", undefined);
    expect((await post(form())).status).toBe(503);
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("2: answers 429 when the wallet's write budget or the per-IP upload budget is spent", async () => {
    for (let i = 0; i < 60; i += 1) allowWrite(WALLET, nowSec());
    expect((await post(form())).status).toBe(429);
    resetRateLimit();
    for (let i = 0; i < 10; i += 1) allowUploadClient("unknown", nowSec()); // no proxy header in tests: the "unknown" key
    expect((await post(form())).status).toBe(429);
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("3: answers 503 not-live while the launchpad or a required Filebase name is unset", async () => {
    h.launchpad = undefined;
    expect(await refusal(await post(form()))).toMatchObject({ status: 503, cache: "no-store", body: { code: "not-live" } });
    h.launchpad = LAUNCHPAD;
    vi.stubEnv("FILEBASE_BUCKET", "");
    expect(await refusal(await post(form()))).toMatchObject({ status: 503, body: { code: "not-live" } });
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("4: asks the launchpad's own isAllowedLauncher, refusing 403 on false and 503 when the read fails, never passing", async () => {
    h.gate.mockResolvedValueOnce(false);
    expect(await refusal(await post(form()))).toMatchObject({ status: 403, body: { code: "not-allowed" } });
    expect(h.gate).toHaveBeenCalledWith(expect.objectContaining({ address: LAUNCHPAD, functionName: "isAllowedLauncher", args: [WALLET] }));
    h.gate.mockRejectedValueOnce(new Error("rpc down"));
    expect(await refusal(await post(form()))).toMatchObject({ status: 503, body: { code: "gate-unavailable" } });
    expect(calls).toEqual([]);
  });

  it("5: refuses a body that is not multipart (400) or larger than 2,200,000 bytes (413)", async () => {
    const json = await post(JSON.stringify({ name: "x" }), { cookie: sessionHeader(WALLET), "content-type": "application/json" });
    expect(await refusal(json)).toMatchObject({ status: 400, body: { code: "bad-form" } });
    const big = await post(form({ image: new Blob([new Uint8Array(2_300_000)], { type: "image/png" }) }));
    expect(await refusal(big)).toMatchObject({ status: 413, body: { code: "too-large" } });
  });

  it("6: names the first bad field: a missing image, a name over 32 bytes, a bad X handle", async () => {
    expect(await refusal(await post(form({ image: null })))).toMatchObject({ status: 400, body: { code: "bad-field", error: "image" } });
    expect(await refusal(await post(form({ name: "🚀".repeat(9) })))).toMatchObject({ status: 400, body: { code: "bad-field", error: "name" } });
    expect(await refusal(await post(form({ x: "not a handle" })))).toMatchObject({ status: 400, body: { code: "bad-field", error: "x" } });
    expect(calls).toEqual([]);
  });

  it("7: accepts an image of exactly 2,097,152 bytes and refuses one byte more; refuses SVG and unknown types", async () => {
    const exact = new Uint8Array(2_097_152);
    exact.set(png);
    expect((await post(form({ image: new Blob([exact], { type: "image/png" }) }))).status).toBe(200);
    const over = new Uint8Array(2_097_153);
    over.set(png);
    expect(await refusal(await post(form({ image: new Blob([over], { type: "image/png" }) })))).toMatchObject({ status: 413, body: { code: "too-large" } });
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: "image/svg+xml" });
    expect(await refusal(await post(form({ image: svg })))).toMatchObject({ status: 415, body: { code: "bad-image" } });
  });

  it("8 and 9: refuses magic bytes that disagree with the real format (415) and an image it cannot decode (422)", async () => {
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ff0000" } }).jpeg().toBuffer();
    const disguised = new Blob([new Uint8Array(Buffer.concat([png.subarray(0, 8), jpeg]))], { type: "image/png" });
    expect(await refusal(await post(form({ image: disguised })))).toMatchObject({ status: 415, body: { code: "bad-image" } });
    const huge = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: "#00ff00" } }).png({ compressionLevel: 9 }).toBuffer();
    expect(await refusal(await post(form({ image: new Blob([new Uint8Array(huge)], { type: "image/png" }) })))).toMatchObject({
      status: 422,
      body: { code: "unreadable-image" },
    });
    expect(calls).toEqual([]);
  });

  it("10: refuses a wallet at 5 uploads this hour before pinning anything; refused rows do not count", async () => {
    await seedRows(3, "refused");
    await seedRows(4);
    expect((await post(form())).status).toBe(200); // the 5th
    calls.length = 0;
    expect(await refusal(await post(form()))).toMatchObject({ status: 429, body: { code: "upload-limit" } });
    expect(calls).toEqual([]);
  });

  it("11: answers 502 storage-failed when a PUT fails or carries no CID, and records nothing", async () => {
    filebase.mockImplementationOnce(async () => new Response("down", { status: 503 }));
    expect(await refusal(await post(form()))).toMatchObject({ status: 502, body: { code: "storage-failed" } });
    filebase.mockImplementationOnce(async () => new Response(null, { status: 200 }));
    expect(await refusal(await post(form()))).toMatchObject({ status: 502, body: { code: "storage-failed" } });
    filebase.mockImplementationOnce(async () => new Response(null, { status: 200, headers: { "x-amz-meta-cid": "not a cid" } }));
    expect(await refusal(await post(form()))).toMatchObject({ status: 502, body: { code: "storage-failed" } });
    expect(await rows()).toEqual([]);
  });

  it("12: pins the WebP under its content hash, then the metadata JSON, records one pending row and answers the CIDs", async () => {
    const res = await post(form());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ imageCid: IMAGE_CID, metadataCid: META_CID, metadataUri: `ipfs://${META_CID}` });
    expect(calls.map((c) => c.method)).toEqual(["PUT", "PUT"]);
    const [img, meta] = calls;
    const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    expect(img!.url).toBe(`https://s3.filebase.com/test-bucket/launch/img/${sha(img!.body)}.webp`);
    expect(await sharp(img!.body).metadata()).toMatchObject({ format: "webp", width: 512, height: 512 });
    expect(meta!.url).toBe(`https://s3.filebase.com/test-bucket/launch/meta/${sha(meta!.body)}.json`);
    expect(new TextDecoder().decode(meta!.body)).toBe(
      `{"name":"Tailor's Chalk","symbol":"CHALK","description":"Chalk for tailors.","image":"ipfs://${IMAGE_CID}","website":"https://chalk.test","x":"https://x.com/chalk","telegram":""}`,
    );
    expect(await rows()).toEqual([{ status: "pending", wallet: WALLET, x: "https://x.com/chalk", image_key: `launch/img/${sha(img!.body)}.webp` }]);
  });

  it("6: takes a multi-line description through real multipart encoding and pins the newline, not CRLF", async () => {
    const res = await post(form({ description: "Chalk for tailors.\nAnd for chalkboards." }));
    expect(res.status).toBe(200);
    const pinned = new TextDecoder().decode(calls[1]!.body);
    expect(pinned).toContain('"description":"Chalk for tailors.\\nAnd for chalkboards."');
    expect(pinned).not.toContain("\\r");
    const [row] = await db.query<{ description: string }>("select description from market.launch_uploads");
    expect(row!.description).toBe("Chalk for tailors.\nAnd for chalkboards.");
  });

  it("pins one still frame of an animated GIF, and nothing appended after a PNG's end", async () => {
    expect((await post(form({ image: new Blob([new Uint8Array(animated)], { type: "image/gif" }) }))).status).toBe(200);
    expect((await sharp(calls[0]!.body, { pages: -1 }).metadata()).pages ?? 1).toBe(1);
    calls.length = 0;
    const tail = new Uint8Array(Buffer.concat([png, Buffer.from("PAYLOAD-AFTER-THE-END")]));
    expect((await post(form({ image: new Blob([tail], { type: "image/png" }) }))).status).toBe(200);
    expect(Buffer.from(calls[0]!.body).includes(Buffer.from("PAYLOAD"))).toBe(false);
  });

  it("12: two parallel uploads at the limit count each other: one accepted, the other stored refused and not counted", async () => {
    await seedRows(4);
    // Hold both image PUTs until both requests have arrived there, so both have passed the unlocked read of step 10 and
    // only the locked recount of step 12 can tell them apart.
    let images = 0;
    let release: () => void = () => {};
    const bothPinning = new Promise<void>((resolve) => {
      release = resolve;
    });
    filebase.mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/launch/img/")) {
        images += 1;
        if (images === 2) release();
        await bothPinning;
      }
      return answer(input, init);
    });
    // PGlite serialises transactions on its own, so also record what each transaction issues: the lock must be there.
    const statements: string[] = [];
    const realTx = db.tx.bind(db);
    h.db = {
      ...db,
      tx: <T,>(fn: (t: Db) => Promise<T>) =>
        realTx((t) => fn({ ...t, query: (sql: string, params?: readonly unknown[]) => { statements.push(sql); return t.query(sql, params); } } as Db)),
    } as Db;
    const statuses = (await Promise.all([post(form()), post(form())])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 429]);
    expect((await rows()).map((r) => r.status).sort()).toEqual(["pending", "pending", "pending", "pending", "pending", "refused"]);
    expect(statements.filter((sql) => sql.includes("pg_advisory_xact_lock"))).toHaveLength(2);
  });

  it("12: never deletes a pinned object when the insert fails: the same key may back another upload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.db = { ...db, tx: async () => { throw new Error("insert failed"); } } as Db;
    expect((await post(form())).status).toBe(500);
    expect(calls.map((c) => c.method)).toEqual(["PUT", "PUT"]);
  });
});
