import "server-only";

import {
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  http,
} from "viem";
import { robinhoodChain } from "@/lib/chain";
import { getDb, hasDb } from "@/lib/db/client";
import { filebaseGatewayBase } from "@/lib/launch/gateway";

/**
 * Where a token's logo comes from, in one place.
 *
 * Nothing in the indexer carries a logo, so each origin is asked on its own terms and the
 * answers are normalised to a list of fetchable URLs:
 *  - Pons tokens expose `logo() view returns (string)` on the token contract;
 *  - LONG tokens (Doppler DERC20) expose `tokenURI()`, an ipfs:// JSON whose `image_hash`
 *    (or `image`) is the logo;
 *  - everything else — Uniswap-origin pairs above all — is looked up on DexScreener.
 *
 * The order is origin-agnostic: a missing function reverts fast, so asking is cheap and no
 * caller has to know which kind of token it holds.
 *
 * Every stage distinguishes "this token has no logo" from "we could not ask". Only the first is
 * an answer worth remembering; the second must never be cached as an absence, or one rate-limited
 * minute would blank a token's logo for the next hour.
 */

/**
 * Tried in order; the first that answers wins. Each already ends in `/ipfs/`. The Filebase gateway leads (instant
 * launchpad design, section 5.6): launch images are pinned there, so it answers them fastest.
 * w3s.link answers with a redirect to another gateway, which `guardedFetch` follows.
 */
export const IPFS_GATEWAYS: readonly string[] = [
  `${filebaseGatewayBase()}/ipfs/`,
  "https://gateway.pinata.cloud/ipfs/",
  "https://dweb.link/ipfs/",
  "https://w3s.link/ipfs/",
  "https://ipfs.io/ipfs/",
];

const GATEWAY_TIMEOUT_MS = 5_000;
const RPC_TIMEOUT_MS = 5_000;
const DEXSCREENER_URL = "https://api.dexscreener.com/latest/dex/tokens/";

/** DexScreener asks for an identifying agent; it rate-limits anonymous clients harder. */
export const USER_AGENT = "MaxLongMarkets/0.1 (+https://github.com/KobeSergio)";

/**
 * The whole lookup's budget, comfortably inside the route's `maxDuration = 30`. Four gateways
 * plus two RPC reads plus a candidate walk can each be individually quick and still add up past
 * the platform's limit, which would kill the request instead of answering a cacheable 404.
 */
export const TOTAL_BUDGET_MS = 25_000;

const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
/** A launch's logo, hit or hidden, is held for an hour, not a day: setting `hidden` must reach every visitor within the hour. */
export const LAUNCH_TTL_MS = 60 * 60 * 1000;

export type ResolvedLogo = {
  /** Fetchable URLs, best first; the proxy route walks them until one returns an image. */
  candidates: string[];
  source: "launch" | "pons" | "long" | "dexscreener";
};

/** A launch made here, as market.launches holds it (spec 5.6). */
export type LaunchImageRow = { imageCid: string; metadataUri: string; hidden: boolean };
/** `{ ok: false }` is a database error: the lookup answers "no logo" for this request, never cached, never falling through. */
export type LaunchImageRead = { ok: true; row: LaunchImageRow | null } | { ok: false };

/** A stage either answered (with a value or a definite nothing) or could not be asked. */
export type ReadResult = { ok: true; value: string | null } | { ok: false };

export type LogoLookup = {
  logo: ResolvedLogo | null;
  /**
   * False when a stage could not be asked at all — an RPC that threw, a gateway that timed out,
   * a DexScreener 429, or the budget running out. `logo: null, definite: false` means "unknown",
   * not "none", and the route must not let a CDN hold it for an hour.
   */
  definite: boolean;
};

export type LogoDeps = {
  /** A `view returns (string)` read. `{ ok: false }` for anything that is not a real answer. */
  readString(address: string, fn: "logo" | "tokenURI", timeoutMs: number): Promise<ReadResult>;
  fetchJson(url: string, timeoutMs: number): Promise<unknown>;
  now(): number;
  /** The launch row for this token, if it was launched here. */
  launchImage(address: string): Promise<LaunchImageRead>;
};

const LOGO_ABI = [
  { type: "function", name: "logo", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

function createClient() {
  // An empty ROBINHOOD_RPC_URL means "use the chain's public RPC".
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(process.env.ROBINHOOD_RPC_URL || undefined, { timeout: RPC_TIMEOUT_MS }),
  });
}

let client: ReturnType<typeof createClient> | undefined;

/**
 * A revert, or `0x` back from a contract without the function, is the chain telling us this
 * token has no logo — an answer. Everything else (a dead RPC, a timeout) is a failure to ask.
 * viem wraps both in ContractFunctionExecutionError, so the cause chain is what separates them.
 */
function isDefiniteAbsence(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 8; depth++) {
    if (cur instanceof ContractFunctionRevertedError || cur instanceof ContractFunctionZeroDataError) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Bounds the wait on work that cannot itself be cancelled; the transport has its own timeout. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const defaultDeps: LogoDeps = {
  async readString(address, fn, timeoutMs) {
    try {
      client ??= createClient();
      const out = await withTimeout(
        client.readContract({ address: address as `0x${string}`, abi: LOGO_ABI, functionName: fn }),
        timeoutMs,
      );
      return { ok: true, value: typeof out === "string" && out.trim() !== "" ? out : null };
    } catch (err) {
      return isDefiniteAbsence(err) ? { ok: true, value: null } : { ok: false };
    }
  },
  async fetchJson(url, timeoutMs) {
    // A token's tokenURI() is attacker-chosen just like its logo(), so these reads need the
    // same treatment as the image proxy's: guarded, and re-guarded on every redirect.
    const res = await guardedFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
    if (!res) throw new Error(`${url} was refused or redirected out of bounds`);
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return res.json();
  },
  now: Date.now,
  async launchImage(address) {
    if (!hasDb()) return { ok: true, row: null };
    try {
      const [row] = await getDb().query<{ image_cid: string; metadata_uri: string; hidden: boolean }>(
        "select image_cid, metadata_uri, hidden from market.launches where token_id = $1",
        [address],
      );
      return { ok: true, row: row ? { imageCid: row.image_cid, metadataUri: row.metadata_uri, hidden: row.hidden } : null };
    } catch (err) {
      // Visible in the logs as well as in /api/health's `launches.error`: a missing table (migration not applied) lands here.
      console.warn(`logo: launch row unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false };
    }
  },
};

/**
 * `ipfs://CID[/path]` onto every gateway, `https://` straight through, anything else nothing.
 * A doubled `ipfs://ipfs/CID` prefix is written by some pinning services; strip it.
 * Plain `http://` is dropped here rather than passed on, because `isAllowedLogoUrl` would refuse
 * it later anyway and a candidate nothing can ever fetch is just a wasted slot in the list.
 */
export function toHttpCandidates(uri: string): string[] {
  const trimmed = uri.trim();
  if (trimmed.startsWith("https://")) return [trimmed];
  if (!trimmed.startsWith("ipfs://")) return [];
  let path = trimmed.slice("ipfs://".length).replace(/^\/+/, "");
  if (path.startsWith("ipfs/")) path = path.slice("ipfs/".length);
  if (path === "") return [];
  return IPFS_GATEWAYS.map((gateway) => `${gateway}${path}`);
}

/** Dotted-decimal after WHATWG parsing, which normalises 2130706433 and 0x7f.1 into this form. */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const PRIVATE_SUFFIXES = [".local", ".internal", ".localhost"];

/**
 * Whether a URL may be fetched server-side. Logo URLs come from a token contract's own return
 * value and from DexScreener, so they are attacker-chosen: without this a hostile token could
 * point `logo()` at the cloud metadata endpoint or an internal service and have the server
 * fetch it. Checked before the first request and again on every redirect hop, since a public
 * host can bounce to a private one.
 */
export function isAllowedLogoUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.port !== "" && parsed.port !== "443") return false;
  // A fully qualified name keeps its root dot, and DNS resolves "localhost." exactly as
  // "localhost": without stripping it, every check below is one keystroke away from useless.
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "" || host === "localhost") return false;
  // WHATWG keeps the brackets on an IPv6 host, so this catches [::1] and every other literal.
  if (host.startsWith("[") || IPV4.test(host)) return false;
  return !PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Redirect hops followed per request; w3s.link alone needs one, to dweb.link. */
export const MAX_REDIRECTS = 3;

/**
 * `fetch`, with the redirect chain walked by hand. The only reason this exists rather than
 * `redirect: "follow"`: the whole point of `isAllowedLogoUrl` is that a permitted public host
 * must not be able to bounce the server onto a private one, and the browser's own follower
 * would never re-check. Both the image proxy and the resolver's JSON reads go through here, so
 * there is one hop-following implementation to review rather than two that can drift.
 *
 * Returns the terminal response, or null when a hop is disallowed, a redirect carries no usable
 * Location, or the chain is still going after MAX_REDIRECTS. Network errors throw, as `fetch`
 * does, and the callers decide what a throw means. The caller owns the signal, so one deadline
 * covers the whole chain instead of resetting per hop.
 */
export async function guardedFetch(
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
): Promise<Response | null> {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedLogoUrl(target)) return null;
    const res = await fetch(target, { ...init, redirect: "manual", cache: "no-store" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    await res.body?.cancel();
    if (!location) return null;
    try {
      target = new URL(location, target).toString();
    } catch {
      return null;
    }
  }
  return null;
}

const RASTER_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/**
 * The media type stripped of parameters and lowercased, or null if it is not one we serve.
 * Raster only: an `image/svg+xml` logo opened at the route URL would be a document in this
 * origin and could run script, and nosniff does not help — it stops sniffing, not an honestly
 * declared SVG. Returning the normalised string lets the route echo that rather than whatever
 * casing and parameters the upstream host chose to send.
 */
export function normaliseImageType(contentType: string): string | null {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return RASTER_IMAGE_TYPES.has(type) ? type : null;
}

export function isAllowedImageType(contentType: string): boolean {
  return normaliseImageType(contentType) !== null;
}

/** One lookup's shared state: the deps, the wall-clock budget, and whether a stage went unasked. */
type Ctx = { deps: LogoDeps; deadline: number; incomplete: boolean };

/** What a step may spend: its own limit, or whatever is left of the budget, whichever is less. */
function slice(ctx: Ctx, stepMs: number): number {
  return Math.min(stepMs, ctx.deadline - ctx.deps.now());
}

async function read(address: string, fn: "logo" | "tokenURI", ctx: Ctx): Promise<ReadResult> {
  const ms = slice(ctx, RPC_TIMEOUT_MS);
  if (ms <= 0) {
    ctx.incomplete = true;
    return { ok: false };
  }
  const out = await ctx.deps.readString(address, fn, ms);
  if (!out.ok) ctx.incomplete = true;
  return out;
}

type JsonResult = { ok: true; value: unknown } | { ok: false };

/** The first gateway that returns JSON wins; a gateway that is down must not lose the logo. */
async function fetchJsonFromCandidates(candidates: string[], ctx: Ctx): Promise<JsonResult> {
  const allowed = candidates.filter(isAllowedLogoUrl);
  // Nothing fetchable in the document's own URI is a definite dead end, not a failure to ask.
  if (allowed.length === 0) return { ok: false };
  for (const url of allowed) {
    const ms = slice(ctx, GATEWAY_TIMEOUT_MS);
    if (ms <= 0) break;
    try {
      return { ok: true, value: await ctx.deps.fetchJson(url, ms) };
    } catch {
      // Next gateway.
    }
  }
  // Every gateway refused, or the budget ran out: the logo may well exist and be unreachable.
  ctx.incomplete = true;
  return { ok: false };
}

function pick(record: unknown, key: string): string | null {
  if (typeof record !== "object" || record === null) return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

async function fromTokenUri(address: string, ctx: Ctx): Promise<ResolvedLogo | null> {
  const uri = await read(address, "tokenURI", ctx);
  if (!uri.ok || !uri.value) return null;
  const doc = await fetchJsonFromCandidates(toHttpCandidates(uri.value), ctx);
  if (!doc.ok) return null;
  const image = pick(doc.value, "image_hash") ?? pick(doc.value, "image");
  if (!image) return null;
  const candidates = toHttpCandidates(image);
  return candidates.length > 0 ? { candidates, source: "long" } : null;
}

async function fromDexScreener(address: string, ctx: Ctx): Promise<ResolvedLogo | null> {
  const ms = slice(ctx, GATEWAY_TIMEOUT_MS);
  if (ms <= 0) {
    ctx.incomplete = true;
    return null;
  }
  let body: unknown;
  try {
    body = await ctx.deps.fetchJson(`${DEXSCREENER_URL}${address}`, ms);
  } catch {
    // A 429 or a timeout here is the single most likely reason a real logo goes missing.
    ctx.incomplete = true;
    return null;
  }
  const pairs = (body as { pairs?: unknown })?.pairs;
  if (!Array.isArray(pairs)) return null;
  for (const pair of pairs) {
    const imageUrl = pick((pair as { info?: unknown })?.info, "imageUrl");
    const candidates = imageUrl ? toHttpCandidates(imageUrl) : [];
    if (candidates.length > 0) return { candidates, source: "dexscreener" };
  }
  return null;
}

/** The launch's own image CID, else its metadata JSON's `image`, like a LONG `tokenURI` (spec 5.6's table). */
async function fromLaunchRow(row: LaunchImageRow, ctx: Ctx): Promise<ResolvedLogo | null> {
  if (row.imageCid !== "") return { candidates: toHttpCandidates(`ipfs://${row.imageCid}`), source: "launch" };
  if (row.metadataUri === "") return null;
  const doc = await fetchJsonFromCandidates(toHttpCandidates(row.metadataUri), ctx);
  if (!doc.ok) return null;
  const image = pick(doc.value, "image");
  const candidates = image ? toHttpCandidates(image) : [];
  return candidates.length > 0 ? { candidates, source: "launch" } : null;
}

type Entry = { value: ResolvedLogo | null; expires: number };
const memo = new Map<string, Entry>();
/** The route is public, so the key space is every address anyone cares to ask for. */
const MAX_MEMO_ENTRIES = 5_000;

export function clearLogoCache(): void {
  memo.clear();
}

/** Insertion-ordered, so the oldest key is the first one out once the cap is reached. */
function remember(key: string, entry: Entry): void {
  // Delete first: re-resolving an address has to move it to the back of the queue, or an
  // address the app keeps asking for would still be evicted ahead of one asked for once.
  memo.delete(key);
  if (memo.size >= MAX_MEMO_ENTRIES) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(key, entry);
}

/**
 * Per-process memo keyed by the lowercase address: a hit holds for a day, a definite miss for an
 * hour. A miss is the common case (most Uniswap-origin tokens have no logo anywhere) and each one
 * costs two RPC reads plus a DexScreener call, so it has to be remembered too — just for less
 * long, since a logo can appear later.
 *
 * Only answers are memoised. If any stage could not be asked and nothing was found, nothing is
 * written: the next request retries rather than inheriting a minute's bad luck. The route's own
 * 60s cache header is what keeps that from costing a lookup per request.
 *
 * `deadline` is a wall-clock timestamp, so the route's budget and this one are the same budget.
 */
export async function resolveLogo(
  address: string,
  deps?: Partial<LogoDeps>,
  deadline?: number,
): Promise<LogoLookup> {
  const d: LogoDeps = { ...defaultDeps, ...deps };
  const key = address.toLowerCase();
  const now = d.now();
  const cached = memo.get(key);
  // Only definite results are ever stored, so a live entry is always an answer.
  if (cached && cached.expires > now) return { logo: cached.value, definite: true };

  const ctx: Ctx = { deps: d, deadline: deadline ?? now + TOTAL_BUDGET_MS, incomplete: false };

  // Spec 5.6: a launch made here answers from its own row and nothing else. A failed read answers "no logo" for this
  // request only, and a launch row never falls through to the later stages: either could answer, and cache, a
  // DexScreener image for a hidden launch, or one anybody could attach to a launch whose own image is missing.
  const launch = await d.launchImage(key);
  if (!launch.ok) return { logo: null, definite: false };
  if (launch.row) {
    const own = launch.row.hidden ? null : await fromLaunchRow(launch.row, ctx);
    const definite = own !== null || !ctx.incomplete;
    if (definite) remember(key, { value: own, expires: now + LAUNCH_TTL_MS });
    return { logo: own, definite };
  }

  let logo: ResolvedLogo | null = null;
  const direct = await read(key, "logo", ctx);
  if (direct.ok && direct.value) {
    const candidates = toHttpCandidates(direct.value);
    if (candidates.length > 0) logo = { candidates, source: "pons" };
  }
  logo ??= await fromTokenUri(key, ctx);
  logo ??= await fromDexScreener(key, ctx);

  const definite = !ctx.incomplete;
  if (logo || definite) {
    remember(key, { value: logo, expires: now + (logo ? HIT_TTL_MS : MISS_TTL_MS) });
  }
  return { logo, definite };
}
