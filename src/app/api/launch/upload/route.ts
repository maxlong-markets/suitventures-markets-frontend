import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createChainClient } from "@/lib/chain/onchain";
import { getDb } from "@/lib/db/client";
import { svLaunchpadAbi } from "@/lib/launch/abi";
import { LAUNCHPAD_ADDRESS } from "@/lib/launch/address";
import { IMAGE_MAX_BYTES, metadataJson, validateFields, type LaunchFields } from "@/lib/launch/fields";
import { filebaseConfig, putObject, type FilebaseConfig } from "@/lib/launch/filebase";
import { reencodeImage, sniffImage } from "@/lib/launch/image";
import { overLimit, recordUpload, uploadCounts } from "@/lib/launch/uploads";
import { allowUploadClient, allowWrite } from "@/lib/social/rateLimit";
import { nowSec } from "@/lib/time";
import type { Address } from "@/lib/types";
import { failure, tooManyRequests } from "../../_lib/respond";
import { clientIp, requireSession } from "../../_lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };
/** Room for the 2,097,152-byte image plus the text fields and the multipart framing (spec 6 step 5). */
const BODY_CAP = 2_200_000;
const PUT_TIMEOUT_MS = 15_000;

/** Every refusal is `{ error, code }`, never cached; `error` is a fixed phrase or a field name, never an echo of the input. */
function refuse(status: number, code: string, error: string = code): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

/** One paced server client, created once and reused across requests (spec 6 step 4). */
let gateClient: ReturnType<typeof createChainClient> | undefined;
function gate(): ReturnType<typeof createChainClient> {
  gateClient ??= createChainClient();
  return gateClient;
}

/** The body, counted as it arrives and abandoned the moment it passes `cap`: content-length is only a hint. */
async function readBody(req: Request, cap: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        // No cancel: undici rejects a cancel on a stream it has already closed ("ReadableStream is already closed"),
        // which escapes even a .catch and fails the run. Returning is enough; releaseLock runs in finally.
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};

type Pinned = { imageCid: string; metadataCid: string; imageKey: string; metadataKey: string };

/** Step 11: the WebP, then the metadata JSON naming it. Keys are content hashes, so a repeat is a harmless overwrite. No database transaction is open here. */
async function pin(storage: FilebaseConfig, webp: Uint8Array<ArrayBuffer>, fields: LaunchFields): Promise<Pinned> {
  const imageKey = `launch/img/${sha256Hex(webp)}.webp`;
  const imageCid = await putObject(storage, imageKey, webp, "image/webp", PUT_TIMEOUT_MS);
  const json = metadataJson(fields, imageCid);
  const metadataKey = `launch/meta/${sha256Hex(json)}.json`;
  const metadataCid = await putObject(storage, metadataKey, json, "application/json", PUT_TIMEOUT_MS);
  return { imageCid, metadataCid, imageKey, metadataKey };
}

/**
 * `POST /api/launch/upload` (instant launchpad design, section 6): a Suits holder's image and links, re-encoded and pinned
 * on Filebase before the launch transaction, answered as `{ imageCid, metadataCid, metadataUri }`. The checks run in the
 * spec's order: session, budgets, configuration, gate, body, fields, image, persistent limit, pins, the locked insert.
 */
export async function POST(req: Request) {
  // 1. Session.
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const wallet = session.address.toLowerCase() as Address;
  const now = nowSec();

  // 2. The in-process budgets: the wallet's write budget, and an upload-only per-IP one.
  if (!allowWrite(wallet, now) || !allowUploadClient(clientIp(req), now)) return tooManyRequests();

  // 3. Configuration. FILEBASE_GATEWAY_URL is optional and not needed here.
  const launchpad = LAUNCHPAD_ADDRESS;
  const storage = filebaseConfig();
  if (!launchpad || !storage) return refuse(503, "not-live", "launching is not live");

  // 4. The launchpad's own gate, so the server applies exactly the contract's rule. A failed read is never a pass.
  let allowed: boolean;
  try {
    allowed = await gate().readContract({ address: launchpad, abi: svLaunchpadAbi, functionName: "isAllowedLauncher", args: [wallet] });
  } catch {
    return refuse(503, "gate-unavailable", "the launcher check could not be read");
  }
  if (!allowed) return refuse(403, "not-allowed", "launching is open to Suits holders");

  // 5. Multipart, read with a running count.
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) return refuse(400, "bad-form");
  const body = await readBody(req, BODY_CAP);
  if (!body) return refuse(413, "too-large");
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    return refuse(400, "bad-form");
  }

  // 6. Field rules, the image's presence first.
  const image = form.get("image");
  if (!(image instanceof Blob) || image.size === 0) return refuse(400, "bad-field", "image");
  const checked = validateFields({
    name: text(form, "name"),
    symbol: text(form, "symbol"),
    description: text(form, "description"),
    website: text(form, "website"),
    x: text(form, "x"),
    telegram: text(form, "telegram"),
  });
  if (!checked.ok) return refuse(400, "bad-field", checked.field);

  // 7. Size and magic bytes.
  if (image.size > IMAGE_MAX_BYTES) return refuse(413, "too-large");
  const bytes = new Uint8Array(await image.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) return refuse(415, "bad-image");

  // 8 and 9. sharp agrees on the format, then one 512 x 512 WebP frame.
  const encoded = await reencodeImage(bytes, kind);
  if (!encoded.ok) return refuse(encoded.code === "bad-image" ? 415 : 422, encoded.code);

  // 10. The persistent budget, a quick unlocked read, so a wallet over its limit costs no pin.
  try {
    if (overLimit(await uploadCounts(getDb(), wallet, now))) return refuse(429, "upload-limit");
  } catch (err) {
    return failure(err);
  }

  // 11. The pins.
  let pinned: Pinned;
  try {
    pinned = await pin(storage, encoded.webp, checked.fields);
  } catch (err) {
    console.warn(`launch upload: ${err instanceof Error ? err.message : String(err)}`);
    return refuse(502, "storage-failed");
  }

  // 12. The locked recount and insert. A refused row is still written, so the nightly clean-up can remove its objects;
  // the pinned objects are never deleted here, because the same content-hash key may back another upload or a live launch.
  try {
    const status = await recordUpload(getDb(), { wallet, ...pinned, ...checked.fields }, now);
    if (status === "refused") return refuse(429, "upload-limit");
    return NextResponse.json(
      { imageCid: pinned.imageCid, metadataCid: pinned.metadataCid, metadataUri: `ipfs://${pinned.metadataCid}` },
      { headers: NO_STORE },
    );
  } catch (err) {
    return failure(err);
  }
}
