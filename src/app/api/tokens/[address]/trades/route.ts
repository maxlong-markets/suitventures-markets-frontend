import { gql } from "@/lib/envio/client";
import { ttlCache } from "@/lib/envio/cache";
import { TRADES_QUERY, TOKEN_QUERY, type QuotePriceRow, type SwapRow, type TokenRow } from "@/lib/envio/queries";
import { shapeTrades, usdMap } from "@/lib/envio/shape";
import { cached, failure, nowSec } from "../../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 10;

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  try {
    const data = await ttlCache(`trades:${id}`, TTL * 1000, async () => {
      const t = await gql<{ Token: TokenRow[]; QuotePrice: QuotePriceRow[] }>(TOKEN_QUERY, { id });
      const token = t.Token[0];
      if (!token?.primaryPool) return [];
      const rows = await gql<{ Swap: SwapRow[] }>(TRADES_QUERY, { pool: token.primaryPool.id });
      return shapeTrades(rows.Swap, usdMap(t.QuotePrice, nowSec()).get(token.primaryPool.quote_id) ?? null, token.symbol);
    });
    return cached(data, TTL);
  } catch (err) {
    return failure(err);
  }
}
