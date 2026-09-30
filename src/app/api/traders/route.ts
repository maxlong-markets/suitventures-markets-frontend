import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/envio/cache";
import { getDb, hasDb } from "@/lib/db/client";
import { topTraders } from "@/lib/social/store";
import { nowSec } from "@/lib/time";
import type { TradersBy } from "@/lib/types";
import { badRequest, cached, failure } from "../_lib/respond";

export const dynamic = "force-dynamic";
/**
 * Like every other route here that touches the store. Measured 19 Sep 2026 against the seeded
 * table (16.6 M rows): about 40 s per ordering, cold or warm — the seed wrote rows in id order, so
 * the BRIN on `ts` prunes nothing and the 24-hour slice is a full scan. Until the table is
 * reordered by time or the board reads a rollup, `TRADERS_BOARD=off` keeps the page behind the
 * honest "needs the market store" answer (see `boardOff`) instead of a 30-second failure.
 * Corrected 30 Sep 2026: no page calls this route any more; the tab and /traders are removed and the route is parked.
 */
export const maxDuration = 30;

const TTL = 60;
/** The board's window. Well inside the store's 5-day trade retention (D39, amended 18 Sep 2026; window changed to 5 days, Task 8, 21 Sep 2026). */
const WINDOW_SEC = 86_400;
const LIMIT = 50;

/**
 * The top 50 wallets of the last 24 hours by USD volume or by trade count. The indexer records a
 * swap's `wallet` as the transaction sender, so a routed trade counts for the person who made it
 * rather than for the router.
 *
 * Without a database there is nothing to rank: 503 with a plain sentence the page can print, a
 * `code: "no-store"` the data source matches on, and `no-store`, so the CDN does not hold that
 * answer past the deploy that configures the store. A database that *is* configured but
 * unreachable also answers 503, from `failure()` below — but without that code, which is how the
 * data source tells the two apart without matching on either sentence (review I1).
 */
/** The operator's switch: "off" while the store cannot rank inside the route's duration (see `maxDuration`). */
function boardOff(): boolean {
  return process.env.TRADERS_BOARD === "off";
}

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("by") ?? "volume";
  if (raw !== "volume" && raw !== "trades") return badRequest("bad by");
  const by: TradersBy = raw;
  if (!hasDb() || boardOff()) {
    return NextResponse.json(
      { error: "traders board needs the market store", code: "no-store" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    // One memo per ordering, and the window ends whenever the memo is refilled, not when this
    // module loaded.
    const rows = await ttlCache(`traders:${by}`, TTL * 1000, () =>
      topTraders(getDb(), { sinceTs: nowSec() - WINDOW_SEC, by, limit: LIMIT }),
    );
    return cached(rows, TTL);
  } catch (err) {
    return failure(err);
  }
}
