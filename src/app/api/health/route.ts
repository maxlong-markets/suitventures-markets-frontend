import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/envio/cache";
import { getBackend, type HealthReport, type MarketBackend } from "@/lib/market/backend";

export const dynamic = "force-dynamic";
/** Short: a monitor polling this must not be able to drive the indexer's or the database's budget. */
const TTL_MS = 5_000;

/**
 * Memoises the *outcome*, never an exception. `ttlCache` keeps serving the last good value when a
 * reload throws, so a loader that threw would pin this route at the last healthy answer for the
 * whole outage. Backends report their own failures; this catch covers a backend that throws anyway.
 *
 * `getBackend()` itself can now throw too (Task 6: it always builds the db backend, so a missing
 * DATABASE_URL throws DbUnavailableError right here rather than falling back to an Envio backend
 * that no longer exists) — a case `backend.kind` cannot label, since there is no backend instance
 * yet, so it gets its own catch with a hardcoded "db" (the only kind `getBackend()` ever produces
 * post-Task-6) instead of reusing the `backend.health()` catch below, which still labels its
 * fallback with the real instance's own kind.
 */
function load(): Promise<HealthReport> {
  return ttlCache("health", TTL_MS, async () => {
    const warn = (err: unknown) => console.warn(`health check failed: ${err instanceof Error ? err.message : String(err)}`);
    let backend: MarketBackend;
    try {
      backend = getBackend();
    } catch (err) {
      warn(err); // only the message reaches the log: a driver error can carry a connection string
      return { ok: false, backend: "db", lag: null, quotes: [], error: "health check failed" };
    }
    try {
      return await backend.health();
    } catch (err) {
      warn(err);
      return { ok: false, backend: backend.kind, lag: null, quotes: [], error: "health check failed" };
    }
  });
}

export async function GET() {
  // Always no-store: a cached health answer is worse than no health answer.
  const result = await load();
  return NextResponse.json(result, { status: result.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
