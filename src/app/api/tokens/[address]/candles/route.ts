import { NextResponse } from "next/server";
import { gql } from "@/lib/envio/client";
import { ttlCache } from "@/lib/envio/cache";
import { CANDLES_QUERY, TOKEN_QUERY, type CandleRow, type QuotePriceRow, type TokenRow } from "@/lib/envio/queries";
import { shapeCandles, usdMap } from "@/lib/envio/shape";
import { cached, failure, nowSec } from "../../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 10;
const INTERVALS: Record<string, string> = { "1m": "m1", "5m": "m5", "15m": "m15", "1h": "h1", "1d": "d1" };

export async function GET(req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  const interval = INTERVALS[new URL(req.url).searchParams.get("interval") ?? "15m"];
  if (!interval) return NextResponse.json({ error: "bad interval" }, { status: 400 });
  try {
    const data = await ttlCache(`candles:${id}:${interval}`, TTL * 1000, async () => {
      const now = nowSec();
      const t = await gql<{ Token: TokenRow[]; QuotePrice: QuotePriceRow[] }>(TOKEN_QUERY, { id });
      const pool = t.Token[0]?.primaryPool;
      if (!pool) return [];
      const rows = await gql<{ Candle: CandleRow[] }>(CANDLES_QUERY, { pool: pool.id, like: `${pool.id}-${interval}-%`, limit: 300 });
      // One current USD price per quote in M1; per-candle history is an M6 refinement.
      const usd = usdMap(t.QuotePrice, now).get(pool.quote_id) ?? null;
      return shapeCandles(rows.Candle, () => usd);
    });
    return cached(data, TTL);
  } catch (err) {
    return failure(err);
  }
}
