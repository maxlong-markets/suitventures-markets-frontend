/**
 * The launch's text fields (instant launchpad design, section 6's request table), shared by the upload route and the form
 * so the two can never disagree. The name and symbol are measured in UTF-8 bytes, because the contract counts bytes
 * (spec 4.5 step 4); the description and website in characters. No server import: the browser bundles this file.
 */
export const NAME_MAX_BYTES = 32;
export const SYMBOL_MAX_BYTES = 11;
export const DESCRIPTION_MAX_CHARS = 500;
export const WEBSITE_MAX_CHARS = 200;
/** Exactly 2 MiB: an image of this size is accepted, one byte more is refused. */
export const IMAGE_MAX_BYTES = 2_097_152;

export type LaunchFields = { name: string; symbol: string; description: string; website: string; x: string; telegram: string };
export type LaunchFieldName = keyof LaunchFields;
export type FieldCheck = { ok: true; fields: LaunchFields } | { ok: false; field: LaunchFieldName };

const encoder = new TextEncoder();

export function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}

/** Every C0 control character and DEL, except the newline. */
const CONTROL = /[\x00-\x09\x0B-\x1F\x7F]/;
const X_HANDLE = /^@?([A-Za-z0-9_]{1,15})$/;
const X_URL = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/;
const TG_NAME = /^@?([A-Za-z0-9_]{5,32})$/;
const TG_URL = /^https:\/\/(?:www\.)?t\.me\/([A-Za-z0-9_]{5,32})\/?$/;

function website(raw: string): string | null {
  if (raw === "") return "";
  if (raw.length > WEBSITE_MAX_CHARS || !raw.startsWith("https://")) return null;
  try {
    return new URL(raw).hostname !== "" ? raw : null;
  } catch {
    return null;
  }
}

function xProfile(raw: string): string | null {
  if (raw === "") return "";
  const handle = X_HANDLE.exec(raw)?.[1] ?? X_URL.exec(raw)?.[1];
  return handle ? `https://x.com/${handle}` : null;
}

function telegram(raw: string): string | null {
  if (raw === "") return "";
  const name = TG_NAME.exec(raw)?.[1] ?? TG_URL.exec(raw)?.[1];
  return name ? `https://t.me/${name}` : null;
}

/** The first failing field in form order, or the fields as they will be stored (links normalised). */
export function validateFields(raw: LaunchFields): FieldCheck {
  const nameBytes = utf8Bytes(raw.name);
  if (nameBytes === 0 || nameBytes > NAME_MAX_BYTES) return { ok: false, field: "name" };
  const symbolBytes = utf8Bytes(raw.symbol);
  if (symbolBytes === 0 || symbolBytes > SYMBOL_MAX_BYTES) return { ok: false, field: "symbol" };
  if ([...raw.description].length > DESCRIPTION_MAX_CHARS || CONTROL.test(raw.description)) return { ok: false, field: "description" };
  const site = website(raw.website);
  if (site === null) return { ok: false, field: "website" };
  const x = xProfile(raw.x);
  if (x === null) return { ok: false, field: "x" };
  const tg = telegram(raw.telegram);
  if (tg === null) return { ok: false, field: "telegram" };
  return { ok: true, fields: { name: raw.name, symbol: raw.symbol, description: raw.description, website: site, x, telegram: tg } };
}

/** The pinned metadata document (spec 6): keys in this order, no whitespace, empty strings kept. */
export function metadataJson(fields: LaunchFields, imageCid: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify({
      name: fields.name,
      symbol: fields.symbol,
      description: fields.description,
      image: `ipfs://${imageCid}`,
      website: fields.website,
      x: fields.x,
      telegram: fields.telegram,
    }),
  );
}
