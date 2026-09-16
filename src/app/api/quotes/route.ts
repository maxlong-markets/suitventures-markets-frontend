import { gql } from "@/lib/envio/client";
import { ttlCache } from "@/lib/envio/cache";
import { loadPairs } from "@/lib/envio/pairs";
import { QUOTES_QUERY, type QuotePriceRow, type QuoteRow } from "@/lib/envio/queries";
import { shapeQuotes, usdMap } from "@/lib/envio/shape";
import { cached, failure, nowSec } from "../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 30;

export async function GET() {
  try {
    const data = await ttlCache("quotes", TTL * 1000, async () => {
      const now = nowSec();
      const [q, pairs] = await Promise.all([gql<{ Quote: QuoteRow[]; QuotePrice: QuotePriceRow[] }>(QUOTES_QUERY), loadPairs()]);
      return shapeQuotes(q.Quote, pairs, usdMap(q.QuotePrice, now), q.QuotePrice, now);
    });
    return cached(data, TTL);
  } catch (err) {
    return failure(err);
  }
}
