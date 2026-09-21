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
    const report = await runChainSync(
      db,
      { source, client, quotes },
      { owner: randomUUID(), now: Date.now, sleep, windowSec: 50, intervalSec: intervalSec(), leaseSec: 120 },
    );
    return NextResponse.json(report, { headers: NO_STORE });
  } catch (err) {
    // failure() answers 503 for DbUnavailableError; a cycle's own errors are inside the report, not thrown
    // (except the cursor-not-initialised refusal, which is a genuine throw the catch-up script must fix).
    return failure(err);
  }
}
