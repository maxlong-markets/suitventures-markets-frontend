import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { runChainSync } from "@/lib/chain/run";
import { chainDeps } from "@/lib/sync/deps";
import { isCronAuthorized } from "../../_lib/cron";
import { failure } from "../../_lib/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** SYNC_INTERVAL_SEC, default 30. An empty or malformed value is the default, never zero. */
function intervalSec(): number {
  const n = Number(process.env.SYNC_INTERVAL_SEC);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/**
 * The chain job (Task 6): reads the PoolManager's own events through HyperSync in place of the Envio market
 * job this route used to run, cancelled 21 Sep 2026. See src/lib/chain/run.ts for the cycle.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  try {
    const { db, source, client, quotes } = chainDeps();
    // 50 s: the last cycle's tail (its last request and write) ends before the next minute's lease attempt.
    // leaseSec 300, matching maxDuration (review fix round 1, item 3): the lease must outlive any invocation
    // that can possibly still be running, and Vercel will not let one exceed maxDuration, so setting the two
    // equal makes an overlapping second writer structurally impossible rather than merely improbable. At the
    // old 120 s, a slow chain of HyperSync retries (five attempts, backoff capped at 30 s each) can outlive
    // the lease while a fetch is still in flight, and the next minute's cron would then acquire it and fold
    // an overlapping block range against the same un-advanced cursor — candle volume and pool running totals
    // accumulate on a re-fold (trade rows alone are conflict-safe), so that overlap is a real double-count,
    // not just wasted work. The cost of the wider lease is a hard-killed invocation (a deploy, a crash) now
    // stalls the job for up to 5 minutes instead of 2 — the reader recovers that in about two cycles once the
    // lease expires, since the cursor itself was never at risk (it only ever moves inside applyFold's own
    // transaction).
    const report = await runChainSync(
      db,
      { source, client, quotes },
      { owner: randomUUID(), now: Date.now, sleep, windowSec: 50, intervalSec: intervalSec(), leaseSec: 300 },
    );
    return NextResponse.json(report, { headers: NO_STORE });
  } catch (err) {
    // failure() answers 503 for DbUnavailableError; a cycle's own errors are inside the report, not thrown
    // (except the cursor-not-initialised refusal, which is a genuine throw the catch-up script must fix).
    return failure(err);
  }
}
