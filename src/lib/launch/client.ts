import type { LaunchFields } from "./fields";

/**
 * The browser's half of `POST /api/launch/upload` (instant launchpad design, section 7.2, submit step 2). Every refusal
 * becomes one plain sentence; the route's codes never reach the screen.
 */
export type UploadAnswer = { imageCid: string; metadataCid: string; metadataUri: string };

export class UploadError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}

/** An answer older than this is refreshed, well inside the nightly clean-up's 24-hour window (spec 7.2). */
export const UPLOAD_REUSE_MS = 12 * 60 * 60 * 1000;

export const UPLOAD_MESSAGES = {
  signIn: "Sign in again, then press Launch.",
  limit: "You have uploaded too many images for now. Try again later.",
  notAllowed: "Launching is open to Suits holders.",
  notLive: "Launching is not live yet.",
  tooLarge: "The image is larger than 2 MB.",
  badImage: "That image could not be read. Use a PNG, JPEG, WebP or GIF.",
  failed: "The upload failed. Nothing was spent. Try again.",
} as const;

const FIELD_LABELS: Readonly<Record<string, string>> = {
  image: "image", name: "name", symbol: "symbol", description: "description", website: "website", x: "X", telegram: "Telegram",
};

/** What a cached answer is valid for: exactly these fields and this file. */
export function uploadKey(fields: LaunchFields, image: File): string {
  return JSON.stringify([fields.name, fields.symbol, fields.description, fields.website, fields.x, fields.telegram, image.name, image.size, image.type, image.lastModified]);
}

export async function uploadLaunchAssets(fields: LaunchFields, image: Blob, fetchImpl: typeof fetch = fetch): Promise<UploadAnswer> {
  const body = new FormData();
  body.set("image", image);
  body.set("name", fields.name);
  body.set("symbol", fields.symbol);
  body.set("description", fields.description);
  body.set("website", fields.website);
  body.set("x", fields.x);
  body.set("telegram", fields.telegram);
  let res: Response;
  try {
    res = await fetchImpl("/api/launch/upload", { method: "POST", body, credentials: "same-origin" });
  } catch {
    throw new UploadError(UPLOAD_MESSAGES.failed, "network");
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // A plain-text 429 or an HTML error page: the status alone decides below.
  }
  if (res.ok) {
    const a = parsed as Partial<UploadAnswer> | null;
    if (a && typeof a.imageCid === "string" && typeof a.metadataCid === "string" && typeof a.metadataUri === "string") {
      return { imageCid: a.imageCid, metadataCid: a.metadataCid, metadataUri: a.metadataUri };
    }
    throw new UploadError(UPLOAD_MESSAGES.failed, "bad-answer");
  }
  const { code = "", error = "" } = (parsed ?? {}) as { code?: string; error?: string };
  if (res.status === 401) throw new UploadError(UPLOAD_MESSAGES.signIn, "not-signed-in");
  if (res.status === 429) throw new UploadError(UPLOAD_MESSAGES.limit, code || "rate-limited");
  switch (code) {
    case "not-allowed":
      throw new UploadError(UPLOAD_MESSAGES.notAllowed, code);
    case "not-live":
      throw new UploadError(UPLOAD_MESSAGES.notLive, code);
    case "too-large":
      throw new UploadError(UPLOAD_MESSAGES.tooLarge, code);
    case "bad-image":
    case "unreadable-image":
      throw new UploadError(UPLOAD_MESSAGES.badImage, code);
    case "bad-field":
      throw new UploadError(`Check the ${FIELD_LABELS[error] ?? "form's"} field.`, code);
    default:
      throw new UploadError(UPLOAD_MESSAGES.failed, code || String(res.status));
  }
}
