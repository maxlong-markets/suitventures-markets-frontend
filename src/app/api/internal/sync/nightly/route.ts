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
    const { db, source } = syncDeps();
    // One pass per invocation: the runner breaks after a nightly result, so intervalSec is never used.
    const report = await runSync(db, source, {
      job: "nightly", owner: randomUUID(), now: Date.now, sleep,
      windowSec: 250, intervalSec: 250, queryBudget: 400, leaseSec: 300,
    });
    return NextResponse.json(report, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}
