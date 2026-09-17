import { NextResponse } from "next/server";
import { DbUnavailableError } from "@/lib/db/client";
import { EnvioUnavailableError } from "@/lib/envio/client";

export { nowSec } from "@/lib/time";

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** Expects an already-lowercased address; the routes lowercase the path segment first. */
export function isAddress(id: string): boolean {
  return ADDRESS.test(id);
}

export function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
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
  console.error(err);
  return NextResponse.json({ error: "internal error" }, { status: 500, headers });
}
