import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/envio/cache";
import { getDb, hasDb } from "@/lib/db/client";
import { topTraders } from "@/lib/social/store";
import type { TradersBy } from "@/lib/types";
import { badRequest, cached, failure } from "../_lib/respond";

export const dynamic = "force-dynamic";

const TTL = 60;
/** The board's window. Well inside the store's 10-day trade retention (D39, amended 18 Sep 2026). */
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
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("by") ?? "volume";
  if (raw !== "volume" && raw !== "trades") return badRequest("bad by");
  const by: TradersBy = raw;
  if (!hasDb()) {
    return NextResponse.json(
      { error: "traders board needs the market store", code: "no-store" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    // One memo per ordering, and the window ends whenever the memo is refilled, not when this
    // module loaded.
    const rows = await ttlCache(`traders:${by}`, TTL * 1000, () =>
      topTraders(getDb(), { sinceTs: Math.floor(Date.now() / 1000) - WINDOW_SEC, by, limit: LIMIT }),
    );
    return cached(rows, TTL);
  } catch (err) {
    return failure(err);
  }
}
