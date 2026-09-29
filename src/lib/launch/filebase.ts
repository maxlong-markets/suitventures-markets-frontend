import "server-only";

import { AwsClient } from "aws4fetch";

/**
 * Filebase's S3-compatible API on an IPFS bucket (instant launchpad design, section 6): a PUT pins the object and answers
 * its CID in `x-amz-meta-cid`; a DeleteObject unpins it. Signed with `aws4fetch`, a small SigV4 signer, rather than the
 * AWS SDK. Server-side keys only. `retries: 0`, because the route has one 15-second budget per PUT and aws4fetch would
 * otherwise retry a 5xx ten times.
 */
export const FILEBASE_S3_URL = "https://s3.filebase.com";
const DEFAULT_TIMEOUT_MS = 15_000;
/** A CIDv0 (base58 "Qm…") or a base32 CIDv1 ("b…"): the only shapes the route will put into a metadata document. */
const CID_SHAPE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;

export type FilebaseConfig = { accessKey: string; secretKey: string; bucket: string };

export class FilebaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilebaseError";
  }
}

/** The three required names, or null: the route answers 503 "not-live" and the nightly phase is skipped. Values never logged. */
export function filebaseConfig(): FilebaseConfig | null {
  // Trimmed: a value pasted into a dashboard with a newline or a space around it is that value, not another one. A
  // bucket name or an S3 key never contains whitespace, so nothing real is lost (a leading newline on the bucket name
  // sent every production upload to a bucket that does not exist, 29 Sep 2026).
  const accessKey = (process.env.FILEBASE_ACCESS_KEY || "").trim();
  const secretKey = (process.env.FILEBASE_SECRET_KEY || "").trim();
  const bucket = (process.env.FILEBASE_BUCKET || "").trim();
  return accessKey && secretKey && bucket ? { accessKey, secretKey, bucket } : null;
}

function client(cfg: FilebaseConfig): AwsClient {
  return new AwsClient({ accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey, service: "s3", region: "us-east-1", retries: 0 });
}

function objectUrl(cfg: FilebaseConfig, key: string): string {
  return `${FILEBASE_S3_URL}/${encodeURIComponent(cfg.bucket)}/${key}`;
}

export async function putObject(
  cfg: FilebaseConfig,
  key: string,
  body: Uint8Array<ArrayBuffer>,
  contentType: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  let res: Response;
  try {
    res = await client(cfg).fetch(objectUrl(cfg, key), {
      method: "PUT",
      body,
      headers: { "content-type": contentType },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new FilebaseError(`PUT ${key} got no answer`);
  }
  if (!res.ok) throw new FilebaseError(`PUT ${key} answered ${res.status}`);
  const cid = res.headers.get("x-amz-meta-cid");
  if (!cid || !CID_SHAPE.test(cid)) throw new FilebaseError(`PUT ${key} answered no CID`);
  return cid;
}

export async function deleteObject(cfg: FilebaseConfig, key: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  let res: Response;
  try {
    res = await client(cfg).fetch(objectUrl(cfg, key), { method: "DELETE", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new FilebaseError(`DELETE ${key} got no answer`);
  }
  // S3 answers 204 whether or not the object existed; a 404 from a gateway in front of it means the same.
  if (!res.ok && res.status !== 404) throw new FilebaseError(`DELETE ${key} answered ${res.status}`);
}

/** What `/api/health` says about the upload path: a status and the lengths of the values behind it, never a value or a name. */
export type StorageStatus = { status: string; accessKeyLength?: number; secretKeyLength?: number; bucketLength?: number };

/**
 * HeadBucket, for `/api/health`: "ok" when the configured keys reach the configured bucket; otherwise Filebase's own
 * answer ("answered 403" is a wrong access key or secret, "answered 404" a wrong bucket name), "no answer" for a
 * network failure, or "unset" while `filebaseConfig()` is null. The three lengths ride along, so a value pasted with a
 * stray character shows up as a length one off; health is public, so neither a value nor the bucket's name leaves.
 */
export async function storageStatus(cfg: FilebaseConfig | null, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<StorageStatus> {
  if (!cfg) return { status: "unset" };
  const shape = { accessKeyLength: cfg.accessKey.length, secretKeyLength: cfg.secretKey.length, bucketLength: cfg.bucket.length };
  let res: Response;
  try {
    res = await client(cfg).fetch(`${FILEBASE_S3_URL}/${encodeURIComponent(cfg.bucket)}`, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { status: "no answer", ...shape };
  }
  return { status: res.ok ? "ok" : `answered ${res.status}`, ...shape };
}

/**
 * HeadObject: the object's Last-Modified in unix seconds, or null when it is already gone (404). The nightly clean-up
 * asks this right before each delete, because a re-upload of the same content re-pins the same key after the rows were
 * judged. An answer without a readable Last-Modified is an error: nothing proves the object old, so it is not deleted.
 */
export async function headObject(cfg: FilebaseConfig, key: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<number | null> {
  let res: Response;
  try {
    res = await client(cfg).fetch(objectUrl(cfg, key), { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new FilebaseError(`HEAD ${key} got no answer`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new FilebaseError(`HEAD ${key} answered ${res.status}`);
  const ms = Date.parse(res.headers.get("last-modified") ?? "");
  if (!Number.isFinite(ms)) throw new FilebaseError(`HEAD ${key} answered no Last-Modified`);
  return Math.floor(ms / 1000);
}
