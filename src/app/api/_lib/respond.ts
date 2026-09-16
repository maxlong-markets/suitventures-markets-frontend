import { NextResponse } from "next/server";
import { EnvioUnavailableError } from "@/lib/envio/client";

export function cached<T>(data: T, ttlSec: number): NextResponse {
  return NextResponse.json(data, {
    headers: { "Cache-Control": `public, s-maxage=${ttlSec}, stale-while-revalidate=60` },
  });
}

export function failure(err: unknown): NextResponse {
  if (err instanceof EnvioUnavailableError) {
    return NextResponse.json({ error: "indexer unavailable" }, { status: 503, headers: { "Retry-After": "15" } });
  }
  console.error(err);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}

export const nowSec = () => Math.floor(Date.now() / 1000);
