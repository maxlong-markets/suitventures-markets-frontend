import { feeTierLabel, hookLabel, isStale, toOrigin, units, type WindowStats } from "@/lib/envio/shape";
import type { Address, TokenPair } from "@/lib/types";

export type PairRow = {
  id: string; symbol: string; name: string; address: string; decimals: number; total_supply: string; holders_count: number;
  pool_id: string; quote_id: string; pool_origin: string; hooks: string; fee: number; pool_created_at: number;
  price_quote: number; tvl_token: string | null; tvl_quote: string | null; routable: boolean | null;
  quote_symbol: string; quote_decimals: number; usd_price: number | null; usd_updated_at: number | null; aggregator: string | null;
};

/** One row per listed token. numeric(78,0) columns are cast to text so both drivers hand back strings. */
export const PAIR_SELECT = `
select t.id, t.symbol, t.name, t.address, t.decimals, t.total_supply::text as total_supply, t.holders_count,
  p.id as pool_id, p.quote_id, p.origin as pool_origin, p.hooks, p.fee, p.created_at as pool_created_at,
  p.price_quote, p.tvl_token::text as tvl_token, p.tvl_quote::text as tvl_quote, p.routable,
  q.symbol as quote_symbol, q.decimals as quote_decimals, q.usd_price, q.usd_updated_at, q.aggregator
from market.tokens t
join market.pools p on p.id = t.listed_pool_id
join market.quotes q on q.id = p.quote_id`;

/** Same arithmetic and field order as shapePairs(); `stats` from windowStats() keyed by pool id. */
export function pairFromRow(row: PairRow, stats: WindowStats | undefined, nowSec: number): TokenPair {
  const priceQuote = row.price_quote;
  // usdMap(): no feed row, or a feed older than 3 days that is not pinned, is no USD price at all.
  const fresh = row.usd_price !== null && row.usd_updated_at !== null
    && !isStale({ updatedAt: row.usd_updated_at, aggregator: row.aggregator ?? "" }, nowSec);
  const q = fresh ? row.usd_price : null;
  const usdPrice = q ?? 0; // stale or unknown quote: USD figures read 0, liquidity null
  const priceUsd = priceQuote * usdPrice;
  const supply = Number(BigInt(row.total_supply)) / 10 ** row.decimals;
  const tvlQuote = units(row.tvl_quote, row.quote_decimals);
  // Quote side only: the real money in the pool, and the side a seller is paid out of. The token
  // side at the token's own price values a one-sided position at its market cap — KIDKOBS, a
  // Doppler launch, read $20,005 of "liquidity" against about $1 of USDG on 28 Sep 2026 (D43).
  const liquidity = q === null || tvlQuote === null ? null : tvlQuote * q;
  const ref1 = stats?.ref1h ?? undefined;
  const ref24 = stats?.ref24h ?? undefined;
  const origin = toOrigin(row.pool_origin);
  return {
    id: row.id,
    ticker: row.symbol,
    name: row.name,
    address: row.address as `0x${string}`,
    logoUrl: `/api/tokens/${row.id}/logo`,
    quote: row.quote_symbol,
    origin,
    // routable is null until the nightly probe (spec section 2) has attempted this pool at least
    // once. Null is optimistic, not unknown-so-hide-it: the table must not hide a freshly listed
    // pool for lack of a probe yet, and the quote route tells the truth about any one amount on
    // the page itself. Only an explicit false — the probe's own verdict — hides the Buy/Sell form.
    tradeable: row.routable !== false,
    priceUsd,
    priceQuote,
    change1h: ref1 !== undefined && ref1 > 0 ? (priceQuote / ref1 - 1) * 100 : null,
    change24h: ref24 !== undefined && ref24 > 0 ? (priceQuote / ref24 - 1) * 100 : null,
    vol24h: (stats?.vol24h ?? 0) * usdPrice,
    mcap: priceUsd * supply,
    fdv: priceUsd * supply,
    liquidity,
    stale: q === null,
    holders: row.holders_count,
    createdAt: row.pool_created_at * 1000,
    bull: 0,
    bear: 0,
    poolId: row.pool_id as `0x${string}`,
    hook: hookLabel(origin),
    hookAddress: row.hooks.toLowerCase() as Address,
    feeTier: feeTierLabel(row.fee),
  };
}
