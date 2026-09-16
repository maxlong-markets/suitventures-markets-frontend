import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/envio/cache";
import { gql } from "@/lib/envio/client";
import { HEALTH_QUERY } from "@/lib/envio/queries";
import { isStale } from "@/lib/envio/shape";
import { nowSec } from "../_lib/respond";

export const dynamic = "force-dynamic";
/** Short: a monitor polling this must not be able to drive the indexer's query budget. */
const TTL_MS = 5_000;

type HealthRows = {
  chain_metadata: { chain_id: number; latest_processed_block: number; block_height: number }[];
  QuotePrice: { id: string; updatedAt: number; aggregator: string }[];
};

export async function GET() {
  // Always no-store: a cached health answer is worse than no health answer.
  const headers = { "Cache-Control": "no-store" };
  try {
    const h = await ttlCache("health", TTL_MS, () => gql<HealthRows>(HEALTH_QUERY));
    const chain = h.chain_metadata.find((c) => c.chain_id === 4663);
    const now = nowSec();
    const quotes = h.QuotePrice.map((q) => ({ id: q.id, ageSec: now - q.updatedAt, stale: isStale(q, now) }));
    const lag = chain ? chain.block_height - chain.latest_processed_block : null;
    const ok = lag !== null && lag < 500 && quotes.every((q) => !q.stale);
    return NextResponse.json({ ok, lag, quotes }, { headers });
  } catch (err) {
    console.warn(`health check failed: ${String(err)}`);
    return NextResponse.json({ ok: false, error: "indexer unavailable" }, { status: 503, headers });
  }
}
