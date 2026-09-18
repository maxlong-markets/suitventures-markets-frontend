import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { syncDeps } from "@/lib/sync/deps";
import { runSync } from "@/lib/sync/run";
import { isCronAuthorized } from "../../../_lib/cron";
import { failure } from "../../../_lib/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  try {
    const { db, source, quoter } = syncDeps("nightly");
    // One pass per invocation: the runner breaks after a nightly result, so intervalSec is never used. The window
    // fits the walk at the nightly's 120 requests a minute and stays inside maxDuration.
    const report = await runSync(db, source, {
      job: "nightly", owner: randomUUID(), now: Date.now, sleep,
      windowSec: 280, intervalSec: 280, queryBudget: 400, leaseSec: 300, quoter,
    });
    return NextResponse.json(report, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}
