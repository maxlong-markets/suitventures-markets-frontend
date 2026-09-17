import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/envio/cache";
import { getBackend, type HealthReport } from "@/lib/market/backend";

export const dynamic = "force-dynamic";
/** Short: a monitor polling this must not be able to drive the indexer's or the database's budget. */
const TTL_MS = 5_000;

/**
 * Memoises the *outcome*, never an exception. `ttlCache` keeps serving the last good value when a
 * reload throws, so a loader that threw would pin this route at the last healthy answer for the
 * whole outage. Backends report their own failures; this catch covers a backend that throws anyway.
 */
function load(): Promise<HealthReport> {
  return ttlCache("health", TTL_MS, async () => {
    const backend = getBackend();
    try {
      return await backend.health();
    } catch (err) {
      // Only the message reaches the log: a driver error can carry a connection string.
      console.warn(`health check failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, backend: backend.kind, lag: null, quotes: [], error: "health check failed" };
    }
  });
}

export async function GET() {
  // Always no-store: a cached health answer is worse than no health answer.
  const result = await load();
  return NextResponse.json(result, { status: result.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
