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

/**
 * Why one field is refused, one name per thing the creator can fix; `fieldMessage` gives the sentence the form shows under
 * the field. The rules are the ones `validateFields` applies: these only name which rule a field broke.
 * - "empty": the name or symbol, once trimmed.
 * - "joined-emoji": emoji joined into one picture by a zero-width joiner, such as the technologist or the rainbow flag.
 * - "hidden": a control character, line break, bidi control or zero-width character.
 * - "control": in the description, a tab, a bare carriage return or another control character (a newline is fine).
 * - "query": an X or Telegram link with a ? or # part, such as X's share links (?s=21).
 * - "post-link": a link to a post rather than to the profile, group or channel.
 * - "invite-link": a Telegram invite link, t.me/+… or t.me/joinchat/….
 * - "bad-handle": an X handle or Telegram name of the wrong length or characters.
 * - "wrong-site": neither a handle nor a link to the right site.
 */
export type FieldIssue =
  | "empty" | "too-long" | "joined-emoji" | "hidden" | "control" | "not-https" | "bad-url" | "spaces" | "query" | "post-link"
  | "invite-link" | "bad-handle" | "wrong-site";
export type FieldIssues = Partial<Record<LaunchFieldName, FieldIssue>>;

const encoder = new TextEncoder();

export function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}

/**
 * The name and symbol as they go on chain: without leading or trailing whitespace, which the contract would keep for good
 * (UX review 7). `validateFields` checks and returns this form, so the upload route stores it too; the form previews and
 * sends it.
 */
export function onChainText(s: string): string {
  return s.trim();
}

/** Every C0 control character, DEL and every C1 control character, except the newline. */
const CONTROL = /[\x00-\x09\x0B-\x1F\x7F-\x9F]/;
/**
 * What a name, symbol or website may not hold, so a token cannot pass itself off as another: C0 and C1 controls and DEL (line
 * breaks included), U+2028 and U+2029, the bidi controls (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069) and
 * the zero-width characters (U+200B to U+200D, U+2060, U+FEFF).
 */
const SPOOFING = /[\x00-\x1F\x7F-\x9F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/;
/** An emoji joined to the next by a zero-width joiner, after an optional variation selector or skin tone: a SPOOFING case. */
const JOINED_EMOJI = /\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?\u{200D}/u;
const X_HANDLE = /^@?([A-Za-z0-9_]{1,15})$/;
const X_URL = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/;
const TG_NAME = /^@?([A-Za-z0-9_]{5,32})$/;
const TG_URL = /^https:\/\/(?:www\.)?t\.me\/([A-Za-z0-9_]{5,32})\/?$/;
/** Any spelling of an X or Telegram link (scheme, path, then a ? or # part), only to name what is wrong with a refused one. */
const X_LINK = /^(https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([^?#]*)([?#].*)?$/;
const TG_LINK = /^(https?:\/\/)?(?:www\.)?t\.me\/([^?#]*)([?#].*)?$/;
const TG_INVITE = /^(?:\+|joinchat\/)/;
const HANDLE_CHARS = /^@?\w+$/;

type Checked = { ok: true; value: string } | { ok: false; issue: FieldIssue };
const pass = (value: string): Checked => ({ ok: true, value });
const fail = (issue: FieldIssue): Checked => ({ ok: false, issue });

/** Trimmed first. A joined emoji is named apart from the other hidden characters: its joiner hides inside the picture. */
function nameOrSymbol(raw: string, maxBytes: number): Checked {
  const value = onChainText(raw);
  if (value === "") return fail("empty");
  if (JOINED_EMOJI.test(value)) return fail("joined-emoji");
  if (SPOOFING.test(value)) return fail("hidden");
  return utf8Bytes(value) > maxBytes ? fail("too-long") : pass(value);
}

/** Multipart encoding turns every newline into CRLF; the newline the person typed is stored. A bare CR stays refused. */
function description(raw: string): Checked {
  const value = raw.replace(/\r\n/g, "\n");
  if (CONTROL.test(value)) return fail("control");
  return [...value].length > DESCRIPTION_MAX_CHARS ? fail("too-long") : pass(value);
}

/**
 * An https URL of at most 200 characters, stored as the URL parser writes it. The spoofing characters are refused first:
 * the parser would silently drop a tab or line break and keep a bidi control, so the link shown could differ from the
 * one typed.
 */
function website(raw: string): Checked {
  if (raw === "") return pass("");
  if (SPOOFING.test(raw)) return fail("hidden");
  if (!raw.startsWith("https://")) return fail("not-https");
  if (raw.length > WEBSITE_MAX_CHARS) return fail("too-long");
  try {
    const url = new URL(raw);
    if (url.hostname === "") return fail("bad-url");
    return url.href.length <= WEBSITE_MAX_CHARS ? pass(url.href) : fail("too-long");
  } catch {
    return fail("bad-url");
  }
}

function xProfile(raw: string): Checked {
  if (raw === "") return pass("");
  const handle = X_HANDLE.exec(raw)?.[1] ?? X_URL.exec(raw)?.[1];
  return handle ? pass(`https://x.com/${handle}`) : fail(linkIssue(raw, X_LINK, false));
}

function telegram(raw: string): Checked {
  if (raw === "") return pass("");
  const name = TG_NAME.exec(raw)?.[1] ?? TG_URL.exec(raw)?.[1];
  return name ? pass(`https://t.me/${name}`) : fail(linkIssue(raw, TG_LINK, true));
}

/** Which rule a refused X or Telegram entry broke, checked in the order a fix would go. */
function linkIssue(raw: string, link: RegExp, telegramInvites: boolean): FieldIssue {
  if (SPOOFING.test(raw)) return "hidden";
  if (/\s/.test(raw)) return "spaces";
  const m = link.exec(raw);
  if (!m) return HANDLE_CHARS.test(raw) ? "bad-handle" : "wrong-site";
  const [, scheme, path = "", tail] = m;
  if (telegramInvites && TG_INVITE.test(path)) return "invite-link";
  if (path.replace(/\/$/, "").includes("/")) return "post-link";
  if (tail !== undefined) return "query";
  return scheme === "https://" ? "bad-handle" : "not-https";
}

const FIELD_ORDER: readonly LaunchFieldName[] = ["name", "symbol", "description", "website", "x", "telegram"];

function checkEach(raw: LaunchFields): Record<LaunchFieldName, Checked> {
  return {
    name: nameOrSymbol(raw.name, NAME_MAX_BYTES),
    symbol: nameOrSymbol(raw.symbol, SYMBOL_MAX_BYTES),
    description: description(raw.description),
    website: website(raw.website),
    x: xProfile(raw.x),
    telegram: telegram(raw.telegram),
  };
}

/** The first failing field in form order, or the fields as they will be stored (name and symbol trimmed, links normalised). */
export function validateFields(raw: LaunchFields): FieldCheck {
  const each = checkEach(raw);
  const fields: LaunchFields = { ...raw };
  for (const field of FIELD_ORDER) {
    const c = each[field];
    if (!c.ok) return { ok: false, field };
    fields[field] = c.value;
  }
  return { ok: true, fields };
}

/** Every field's own issue, by the same rules, so the form can say under each field what to change. A field that passes is absent. */
export function fieldIssues(raw: LaunchFields): FieldIssues {
  const each = checkEach(raw);
  const issues: FieldIssues = {};
  for (const field of FIELD_ORDER) {
    const c = each[field];
    if (!c.ok) issues[field] = c.issue;
  }
  return issues;
}

/** How the messages name each field, and the form's pointer under its button ("Check the X link."). */
export const FIELD_LABELS: Readonly<Record<LaunchFieldName, string>> = {
  name: "name", symbol: "symbol", description: "description", website: "website", x: "X link", telegram: "Telegram link",
};
/** The technologist: a man, a zero-width joiner, a laptop. */
const JOINED_EXAMPLE = "\u{1F468}\u{200D}\u{1F4BB}";

/** One sentence that says what to change, for the form to show under the field. */
export function fieldMessage(field: LaunchFieldName, issue: FieldIssue): string {
  const label = FIELD_LABELS[field];
  const onX = field === "x";
  switch (issue) {
    case "empty":
      return `Enter a ${label}.`;
    case "too-long":
      if (field === "name" || field === "symbol") {
        const max = field === "name" ? NAME_MAX_BYTES : SYMBOL_MAX_BYTES;
        return `Shorten the ${label} to ${max} bytes. An emoji takes 4 bytes, an accented letter 2.`;
      }
      return field === "description"
        ? `Shorten the description to ${DESCRIPTION_MAX_CHARS} characters.`
        : `Use a website link of ${WEBSITE_MAX_CHARS} characters or fewer.`;
    case "joined-emoji":
      return `Joined emoji such as ${JOINED_EXAMPLE} cannot go in the ${label}. Use single emoji.`;
    case "hidden":
      return `The ${label} holds a hidden character, such as a tab or line break. Type it again by hand.`;
    case "control":
      return "The description holds a tab or a similar hidden character. Use spaces instead.";
    case "not-https":
      if (field === "website") return "The website must start with https://, as in https://example.com.";
      return onX ? "Start the X link with https://, or enter just the handle." : "Start the Telegram link with https://, or enter just the name.";
    case "bad-url":
      return "That website link is not valid. Check it for typos.";
    case "spaces":
      return onX ? "Remove the spaces from the X handle." : "Remove the spaces from the Telegram name.";
    case "query":
      return `Remove the ? and everything after it from the ${label}.`;
    case "post-link":
      return onX
        ? "Use the profile link, like https://x.com/name, not a link to a post."
        : "Use the group or channel link, like https://t.me/name, not a link to a post.";
    case "invite-link":
      return "Invite links cannot be listed. Use a public group or channel, like https://t.me/name.";
    case "bad-handle":
      return onX ? "An X handle is 1 to 15 letters, digits or underscores." : "A Telegram name is 5 to 32 letters, digits or underscores.";
    case "wrong-site":
      return onX ? "Enter an X handle, like @name, or an x.com profile link." : "Enter a Telegram name, like @name, or a t.me link.";
  }
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
