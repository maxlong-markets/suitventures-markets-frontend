import { NextResponse } from "next/server";
import {
  TOTAL_BUDGET_MS,
  USER_AGENT,
  guardedFetch,
  normaliseImageType,
  resolveLogo,
} from "@/lib/logos/resolve";
import { badRequest, isAddress } from "../../../_lib/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const IMAGE_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;

/** A day in the browser, a week at the edge: a token's logo effectively never changes. */
const HIT_CACHE = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400";
/** A launch's logo (spec 5.6): an hour at both layers, so a takedown through `hidden` reaches everyone within the hour. */
const LAUNCH_CACHE = "public, max-age=3600, s-maxage=3600";
/**
 * Settled answers that are not images: no logo anywhere, a malformed address, a query string.
 * All three are stable facts about the request, so the CDN can answer them instead of us.
 */
const HOUR_CACHE = "public, max-age=3600, s-maxage=3600";
/**
 * We could not find out. A logo may exist and the gateway be rate-limited, or the budget ran
 * out — so this gets the shortest hold the CDN will take, not the hour a real "no logo" earns:
 * one flaky minute must not hide a good logo for the rest of the afternoon.
 */
const UNAVAILABLE_CACHE = "public, max-age=60, s-maxage=60";

type Image = { bytes: Uint8Array<ArrayBuffer>; contentType: string };

const json = (body: unknown, status: number, cache: string) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": cache } });

/** A bad path is bad forever, so let the CDN absorb the retries instead of this function. */
function badRequestCached(error: string): NextResponse {
  const res = badRequest(error);
  res.headers.set("Cache-Control", HOUR_CACHE);
  return res;
}

/**
 * Reads at most `cap` bytes. Content-length is a hint a host may omit or lie about, so the
 * body is counted as it arrives and abandoned the moment it goes over.
 */
async function readCapped(res: Response, cap: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const whole = new Uint8Array(await res.arrayBuffer());
    return whole.byteLength > cap ? null : whole;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    // Also runs when the read throws part-way, so the body never stays locked.
    reader.releaseLock();
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** One candidate, redirects and all. Null for every failure, so the caller just moves on. */
async function fetchImage(url: string, timeoutMs: number): Promise<Image | null> {
  try {
    const res = await guardedFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "image/*", "user-agent": USER_AGENT },
    });
    // Null: a hop left the allowlist, or the chain never ended. Not ok: the host said no.
    if (!res || !res.ok) return null;
    // An IPFS gateway answers a rate limit or a missing CID with an HTML page at 200, and an
    // SVG would be script in this origin; both are just a failed candidate.
    const contentType = normaliseImageType(res.headers.get("content-type") ?? "");
    if (!contentType) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) return null;
    const bytes = await readCapped(res, MAX_BYTES);
    // A 0-byte 200 is a broken gateway, not a logo; serving it renders as a broken image and
    // would then be cached as a good answer for a day.
    if (!bytes || bytes.byteLength === 0) return null;
    return { bytes, contentType };
  } catch {
    return null;
  }
}

/**
 * The token logo, proxied. The browser never talks to an IPFS gateway or DexScreener directly:
 * one same-origin URL per token, cached, so a dead gateway is this route's problem and the page
 * keeps its letter avatars. This route never touches the indexer.
 */
export async function GET(req: Request, ctx: { params: Promise<{ address: string }> }) {
  // One address is one cache key. A query string changes nothing about the answer but does
  // change the URL, so allowing it would let anyone walk past the CDN straight into the
  // gateways behind this route, as many times as they like.
  if (new URL(req.url).search !== "") return json({ error: "no query allowed" }, 400, HOUR_CACHE);

  const { address } = await ctx.params;
  const id = address.toLowerCase();
  if (!isAddress(id)) return badRequestCached("bad address");

  // One wall-clock budget for the whole request, shared with the resolver, so the work is cut
  // short with a cacheable answer rather than killed by the platform at maxDuration.
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const { logo, definite } = await resolveLogo(id, undefined, deadline);
  if (!logo) {
    // A definite "nothing has one" is worth an hour; "we could not ask" is worth a minute.
    return definite
      ? json({ error: "no logo" }, 404, HOUR_CACHE)
      : json({ error: "logo unavailable" }, 404, UNAVAILABLE_CACHE);
  }

  for (const url of logo.candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const image = await fetchImage(url, Math.min(IMAGE_TIMEOUT_MS, remaining));
    if (!image) continue;
    return new Response(image.bytes, {
      headers: {
        "Content-Type": image.contentType,
        "Cache-Control": logo.source === "launch" ? LAUNCH_CACHE : HIT_CACHE,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return json({ error: "logo unavailable" }, 404, UNAVAILABLE_CACHE);
}
