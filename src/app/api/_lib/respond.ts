import { NextResponse } from "next/server";
import { DbUnavailableError } from "@/lib/db/client";
import { EnvioUnavailableError } from "@/lib/envio/client";

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** Expects an already-lowercased address; the routes lowercase the path segment first. */
export function isAddress(id: string): boolean {
  return ADDRESS.test(id);
}

/** `no-store` like every other refusal: a 400 is about this request, and six new routes can answer one (review M7). */
export function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400, headers: { "Cache-Control": "no-store" } });
}

/**
 * 409 for a write the store will not take as things stand — today, a wallet at its row cap
 * (`WalletCapError`). `error` is a fixed constant the client can show; it names no wallet and no
 * count, and it is never cached.
 */
export function conflict(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 409, headers: { "Cache-Control": "no-store" } });
}

export function cached<T>(data: T, ttlSec: number): NextResponse {
  return NextResponse.json(data, {
    headers: { "Cache-Control": `public, s-maxage=${ttlSec}, stale-while-revalidate=60` },
  });
}

export function failure(err: unknown): NextResponse {
  // Never let a CDN hold an error: both answers are no-store, so the next request retries.
  const headers = { "Cache-Control": "no-store" };
  if (err instanceof EnvioUnavailableError) {
    console.warn(`envio unavailable: ${err.message}`);
    return NextResponse.json({ error: "indexer unavailable" }, { status: 503, headers: { ...headers, "Retry-After": "15" } });
  }
  if (err instanceof DbUnavailableError) {
    console.warn(`database unavailable: ${err.message}`);
    return NextResponse.json({ error: "database unavailable" }, { status: 503, headers: { ...headers, "Retry-After": "15" } });
  }
  // Name, code and message only, never the object: a driver error carries its query and parameters.
  const code = (err as { code?: unknown } | null)?.code;
  const line = err instanceof Error ? `${err.name}${typeof code === "string" ? ` (${code})` : ""}: ${err.message}` : String(err);
  console.error(`internal error: ${line}`);
  return NextResponse.json({ error: "internal error" }, { status: 500, headers });
}

/** A user's own data: no CDN, no browser cache, no shared copy of one wallet's watchlist. */
export function noStore<T>(data: T): NextResponse {
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}

/** 401 for a missing or unusable session. `error` is always a fixed constant: never an address, never a nonce. */
export function unauthorized(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

/** 429 for a wallet past its write budget (Task 3). A plain body: there is nothing here worth parsing. */
export function tooManyRequests(): NextResponse {
  return new NextResponse("too many requests", {
    status: 429,
    headers: { "Cache-Control": "no-store", "Retry-After": "60", "Content-Type": "text/plain; charset=utf-8" },
  });
}
