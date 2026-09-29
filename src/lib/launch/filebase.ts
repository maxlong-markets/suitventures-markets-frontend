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

export type FilebaseConfig = { accessKey: string; secretKey: string; bucket: string };

export class FilebaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilebaseError";
  }
}

/** The three required names, or null: the route answers 503 "not-live" and the nightly phase is skipped. Values never logged. */
export function filebaseConfig(): FilebaseConfig | null {
  const accessKey = process.env.FILEBASE_ACCESS_KEY || "";
  const secretKey = process.env.FILEBASE_SECRET_KEY || "";
  const bucket = process.env.FILEBASE_BUCKET || "";
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
  if (!cid) throw new FilebaseError(`PUT ${key} answered no CID`);
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
