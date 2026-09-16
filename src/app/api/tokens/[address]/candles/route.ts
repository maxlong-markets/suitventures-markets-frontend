import { gql } from "@/lib/envio/client";
import { ttlCache } from "@/lib/envio/cache";
import { CANDLES_QUERY, TOKEN_QUERY, type CandleRow, type QuotePriceRow, type TokenRow } from "@/lib/envio/queries";
import { resolvePool, shapeCandles, usdMap } from "@/lib/envio/shape";
import { badRequest, cached, failure, isAddress, nowSec } from "../../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 10;
const INTERVALS: Record<string, string> = { "1m": "m1", "5m": "m5", "15m": "m15", "1h": "h1", "1d": "d1" };

export async function GET(req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  // Validate before the cache: an unbounded key space is a memory leak, and a bad id is a 400.
  if (!isAddress(id)) return badRequest("bad address");
  const key = new URL(req.url).searchParams.get("interval") ?? "15m";
  // hasOwn, not a truthiness check: `?interval=constructor` would otherwise reach the indexer.
  if (!Object.hasOwn(INTERVALS, key)) return badRequest("bad interval");
  const interval = INTERVALS[key];
  try {
    const data = await ttlCache(`candles:${id}:${interval}`, TTL * 1000, async () => {
      const now = nowSec();
      const t = await gql<{ Token: TokenRow[]; QuotePrice: QuotePriceRow[] }>(TOKEN_QUERY, { id });
      const token = t.Token[0];
      const pool = token ? resolvePool(token) : null;
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
