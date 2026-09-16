import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/envio/cache";
import { gql } from "@/lib/envio/client";
import { HEALTH_QUERY } from "@/lib/envio/queries";
import { isStale } from "@/lib/envio/shape";
import { nowSec } from "../_lib/respond";

export const dynamic = "force-dynamic";
/** Short: a monitor polling this must not be able to drive the indexer's query budget. */
const TTL_MS = 5_000;
const CHAIN_ID = 4663;
const MAX_LAG = 500;

type HealthRows = {
  chain_metadata: { chain_id: number; latest_processed_block: number; block_height: number }[];
  QuotePrice: { id: string; updatedAt: number; aggregator: string }[];
};

/**
 * Memoises the *outcome*, never an exception. `ttlCache` keeps serving the last good value when a
 * reload throws, so a loader that threw would pin this route at the last healthy answer for the
 * whole outage — and retry the indexer on every single request while doing it.
 */
function load() {
  return ttlCache("health", TTL_MS, async () => {
    try {
      const h = await gql<HealthRows>(HEALTH_QUERY);
      const chain = h.chain_metadata.find((c) => c.chain_id === CHAIN_ID);
      const now = nowSec();
      const quotes = h.QuotePrice.map((q) => ({ id: q.id, ageSec: now - q.updatedAt, stale: isStale(q, now) }));
      const lag = chain ? chain.block_height - chain.latest_processed_block : null;
      return { ok: lag !== null && lag < MAX_LAG && quotes.every((q) => !q.stale), lag, quotes };
    } catch (err) {
      // Logged, never echoed: the indexer's error text is not for the public.
      console.warn(`health check failed: ${String(err)}`);
      return { ok: false, error: "indexer unavailable" };
    }
  });
}

export async function GET() {
  // Always no-store: a cached health answer is worse than no health answer.
  const result = await load();
  return NextResponse.json(result, { status: result.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
