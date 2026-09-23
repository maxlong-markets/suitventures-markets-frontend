import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { QUOTES } from "@/lib/chain/math/quotes";
import { runHoldersBuild } from "@/lib/holders/run";
import { holdersDeps } from "@/lib/sync/deps";
import { isCronAuthorized } from "../../_lib/cron";
import { failure } from "../../_lib/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The quote assets are never given a holder list of their own (design section 4, step 2). */
const QUOTE_IDS = QUOTES.map((q) => q.address);

/**
 * The top-holder builder's minute cron (docs/superpowers/specs/2026-09-23-top-holders-design.md, section 4).
 * See src/lib/holders/run.ts for the cycle; this route only supplies the clock, the owner and the window.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  try {
    const { db, source } = holdersDeps();
    // 50 s and leaseSec 300 for the same reasons as the chain job's route: the last slice's tail ends before
    // the next minute's lease attempt, and a lease as long as maxDuration makes a second writer — which would
    // fold an overlapping block range into the same additive balances — structurally impossible.
    const report = await runHoldersBuild(
      db,
      { source },
      { owner: randomUUID(), now: Date.now, sleep, windowSec: 50, leaseSec: 300, excludedIds: QUOTE_IDS },
    );
    return NextResponse.json(report, { headers: NO_STORE });
  } catch (err) {
    // failure() answers 503 for DbUnavailableError; a slice's own errors are counted inside the report, not thrown.
    return failure(err);
  }
}
