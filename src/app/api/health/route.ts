import { NextResponse } from "next/server";
import { gql } from "@/lib/envio/client";
import { HEALTH_QUERY } from "@/lib/envio/queries";
import { isStale } from "@/lib/envio/shape";
import { nowSec } from "../_lib/respond";

export const dynamic = "force-dynamic";

type HealthRows = {
  chain_metadata: { chain_id: number; latest_processed_block: number; block_height: number }[];
  QuotePrice: { id: string; updatedAt: number; aggregator: string }[];
};

export async function GET() {
  try {
    const h = await gql<HealthRows>(HEALTH_QUERY);
    const chain = h.chain_metadata.find((c) => c.chain_id === 4663);
    const now = nowSec();
    const quotes = h.QuotePrice.map((q) => ({ id: q.id, ageSec: now - q.updatedAt, stale: isStale(q, now) }));
    const lag = chain ? chain.block_height - chain.latest_processed_block : null;
    const ok = lag !== null && lag < 500 && quotes.every((q) => !q.stale);
    return NextResponse.json({ ok, lag, quotes }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
