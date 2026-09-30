import type { Hex } from "viem";
import type { Address } from "@/lib/types";
import type { LaunchFields } from "./fields";

/**
 * The browser's half of `POST /api/launch/upload` (instant launchpad design, section 7.2, submit step 2). Every refusal
 * becomes one plain sentence; the route's codes never reach the screen. Also this tab's memory of a launch whose outcome
 * is not known (the end of this file).
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
  // The form drops the session on this code, so the next press of Launch asks for the signature (UX review B2).
  signIn: "Your sign-in has expired. Press Launch to sign in again.",
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

/**
 * What a cached answer is valid for: exactly these fields, this file and this wallet. The store links an upload to a
 * launch only when the same wallet made both, so another wallet's answer would launch the coin with no image or links.
 */
export function uploadKey(fields: LaunchFields, image: File, wallet: Address): string {
  return JSON.stringify([
    wallet.toLowerCase(), fields.name, fields.symbol, fields.description, fields.website, fields.x, fields.telegram,
    image.name, image.size, image.type, image.lastModified,
  ]);
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

/**
 * A launch that was sent, or may have been, whose outcome is not known (UX review B3, fix round 1 ruling 6). The form
 * keeps it for this browser tab, so a reload for the same wallet shows the same locked card instead of a blank form one
 * press away from a second coin. `hash` is missing when the wallet erred after it was asked to send; `at` is when.
 */
export type UnsettledLaunch = { wallet: Address; token: Address; hash?: Hex; at: number };

export const UNSETTLED_KEY = "maxlong:launch:unsettled";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const unsettledListeners = new Set<() => void>();
/** The record last forgotten, never read back even when the storage refused to remove it, so the way out always works. */
let forgotten: string | null = null;

/** The tab's storage, or null on the server or where the browser refuses it (private windows, blocked site data). */
function tabStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The stored record as text, for `useSyncExternalStore`: the same text reads as the same snapshot. Never throws. */
export function readUnsettled(): string | null {
  let raw: string | null = null;
  try {
    raw = tabStorage()?.getItem(UNSETTLED_KEY) ?? null;
  } catch {
    return null;
  }
  return raw !== null && raw === forgotten ? null : raw;
}

/** One of this file's own records, or null for anything else: the storage is the browser's, not ours to trust. */
export function parseUnsettled(raw: string | null): UnsettledLaunch | null {
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const { wallet, token, hash, at } = v as Record<string, unknown>;
  if (typeof wallet !== "string" || !ADDRESS_RE.test(wallet) || typeof token !== "string" || !ADDRESS_RE.test(token)) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (hash !== undefined && (typeof hash !== "string" || !HASH_RE.test(hash))) return null;
  const launch: UnsettledLaunch = { wallet: wallet.toLowerCase() as Address, token: token as Address, at };
  if (hash !== undefined) launch.hash = hash as Hex;
  return launch;
}

function notifyUnsettled(): void {
  for (const listener of unsettledListeners) listener();
}

/** Keeps the launch for this tab. A storage that refuses only loses the reload case: the open form stays locked anyway. */
export function rememberUnsettled(launch: UnsettledLaunch): void {
  const record: UnsettledLaunch = { wallet: launch.wallet.toLowerCase() as Address, token: launch.token, at: launch.at };
  if (launch.hash !== undefined) record.hash = launch.hash;
  try {
    tabStorage()?.setItem(UNSETTLED_KEY, JSON.stringify(record));
    forgotten = null;
  } catch {
    // Nothing to do: see above.
  }
  notifyUnsettled();
}

/** The card's "Start a new launch": forgets the launch, even where the storage refuses to remove it. */
export function forgetUnsettled(): void {
  forgotten = readUnsettled() ?? forgotten;
  try {
    tabStorage()?.removeItem(UNSETTLED_KEY);
  } catch {
    // `forgotten` keeps it from being read back.
  }
  notifyUnsettled();
}

export function subscribeUnsettled(listener: () => void): () => void {
  unsettledListeners.add(listener);
  return () => void unsettledListeners.delete(listener);
}
