import { gql } from "@/lib/envio/client";
import { ttlCache } from "@/lib/envio/cache";
import { HOLDERS_QUERY, TOKEN_QUERY, type BalanceRow, type QuotePriceRow, type TokenRow } from "@/lib/envio/queries";
import { shapeHolders } from "@/lib/envio/shape";
import { cached, failure } from "../../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 60;

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  try {
    const data = await ttlCache(`holders:${id}`, TTL * 1000, async () => {
      const t = await gql<{ Token: TokenRow[]; QuotePrice: QuotePriceRow[] }>(TOKEN_QUERY, { id });
      const token = t.Token[0];
      if (!token) return { holders: [], count: 0 };
      const rows = await gql<{ TokenBalance: BalanceRow[] }>(HOLDERS_QUERY, { token: id });
      return { holders: shapeHolders(rows.TokenBalance, token.decimals, BigInt(token.totalSupply)), count: token.holdersCount };
    });
    return cached(data, TTL);
  } catch (err) {
    return failure(err);
  }
}
