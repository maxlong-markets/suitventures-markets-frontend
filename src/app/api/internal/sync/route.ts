import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { syncDeps } from "@/lib/sync/deps";
import { runSync } from "@/lib/sync/run";
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

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  try {
    const { db, source } = syncDeps("market");
    // 50 s: the second cycle's tail (its last request and writes) ends before the next minute's lease attempt.
    const report = await runSync(db, source, {
      job: "market", owner: randomUUID(), now: Date.now, sleep,
      windowSec: 50, intervalSec: intervalSec(), queryBudget: 150, leaseSec: 120,
    });
    return NextResponse.json(report, { headers: NO_STORE });
  } catch (err) {
    // failure() answers 503 for DbUnavailableError; a cycle's own errors are inside the report, not thrown.
    return failure(err);
  }
}
