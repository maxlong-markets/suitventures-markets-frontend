import { gql } from "@/lib/envio/client";
import { loadPairs } from "@/lib/envio/pairs";
import {
  CANDLES_QUERY, HEALTH_QUERY, HOLDERS_QUERY, POOL_KEY_QUERY, QUOTES_QUERY, TOKEN_QUERY, TRADES_QUERY, windowQuery,
  type BalanceRow, type CandleRow, type PoolKeyTokenRow, type QuotePriceRow, type QuoteRow, type SwapRow, type TokenRow, type WindowRow,
} from "@/lib/envio/queries";
import { isStale, num, resolvePool, shapeCandles, shapeHolders, shapePairs, shapeQuotes, shapeTrades, usdMap, windowStats } from "@/lib/envio/shape";
import { nowSec } from "@/lib/time";
import type { HealthReport, MarketBackend } from "./backend";
import { poolKeyRow } from "./poolKey";

const CHAIN_ID = 4663;
const MAX_LAG = 500;
type TokenRows = { Token: TokenRow[]; QuotePrice: QuotePriceRow[] };
type HealthRows = {
  chain_metadata: { chain_id: number; latest_processed_block: number; block_height: number }[];
  QuotePrice: { id: string; updatedAt: number; aggregator: string }[];
};
/** The same window as `loadWindowRows` in pairs.ts: h1 candles from a day before the 24h bucket. */
const windowSince = (now: number) => Math.floor((now - 86400) / 3600) * 3600 - 86400;

/** The M1 route bodies, unchanged, behind the interface. `pairs` keeps its memo inside `loadPairs`. */
export function createEnvioBackend(): MarketBackend {
  return {
    kind: "envio",
    pairs: (scope) => loadPairs(scope),
    async pair(id) {
      const now = nowSec();
      const t = await gql<TokenRows>(TOKEN_QUERY, { id });
      const token = t.Token[0];
      const pool = token ? resolvePool(token) : null;
      if (!token || !pool) return null;
      const w = await gql<Record<string, WindowRow[]>>(windowQuery([pool.id], windowSince(now)));
      return shapePairs([token], usdMap(t.QuotePrice, now), windowStats(Object.values(w).flat(), now))[0] ?? null;
    },
    async quotes() {
      const now = nowSec();
      const [q, pairs] = await Promise.all([gql<{ Quote: QuoteRow[]; QuotePrice: QuotePriceRow[] }>(QUOTES_QUERY), loadPairs()]);
      return shapeQuotes(q.Quote, pairs, usdMap(q.QuotePrice, now), q.QuotePrice, now);
    },
    async candles(id, interval) {
      const now = nowSec();
      const t = await gql<TokenRows>(TOKEN_QUERY, { id });
      const token = t.Token[0];
      const pool = token ? resolvePool(token) : null;
      if (!pool) return [];
      const rows = await gql<{ Candle: CandleRow[] }>(CANDLES_QUERY, { pool: pool.id, like: `${pool.id}-${interval}-%`, limit: 300 });
      // One current USD price per quote in M1; per-candle history is an M6 refinement.
      const usd = usdMap(t.QuotePrice, now).get(pool.quote_id) ?? null;
      return shapeCandles(rows.Candle, () => usd);
    },
    async trades(id) {
      const t = await gql<TokenRows>(TOKEN_QUERY, { id });
      const token = t.Token[0];
      const pool = token ? resolvePool(token) : null;
      if (!token || !pool) return [];
      const rows = await gql<{ Swap: SwapRow[] }>(TRADES_QUERY, { pool: pool.id });
      return shapeTrades(rows.Swap, usdMap(t.QuotePrice, nowSec()).get(pool.quote_id) ?? null, token.symbol);
    },
    async holders(id) {
      const t = await gql<TokenRows>(TOKEN_QUERY, { id });
      const token = t.Token[0];
      if (!token) return { holders: [], count: 0 };
      const rows = await gql<{ TokenBalance: BalanceRow[] }>(HOLDERS_QUERY, { token: id });
      return { holders: shapeHolders(rows.TokenBalance, token.decimals, BigInt(token.totalSupply)), count: token.holdersCount };
    },
    async poolKey(tokenId) {
      const t = await gql<{ Token: PoolKeyTokenRow[] }>(POOL_KEY_QUERY, { id: tokenId });
      const token = t.Token[0];
      const pool = token ? resolvePool(token) : null;
      if (!token || !pool) return null;
      return poolKeyRow({
        poolId: pool.id,
        hooks: pool.hooks,
        fee: pool.fee,
        tickSpacing: pool.tickSpacing,
        tokenIsCurrency0: pool.tokenIsCurrency0,
        // Hasura sends every numeric as a string; `+` on one of these would concatenate.
        priceQuote: num(pool.priceQuote),
        tokenAddress: token.address,
        tokenDecimals: token.decimals,
        quoteAddress: pool.quote.address,
        quoteDecimals: pool.quote.decimals,
      });
    },
    async health(): Promise<HealthReport> {
      try {
        const h = await gql<HealthRows>(HEALTH_QUERY);
        const chain = h.chain_metadata.find((c) => c.chain_id === CHAIN_ID);
        const now = nowSec();
        const quotes = h.QuotePrice.map((q) => ({ id: q.id, ageSec: now - q.updatedAt, stale: isStale(q, now) }));
        const lag = chain ? chain.block_height - chain.latest_processed_block : null;
        return { ok: lag !== null && lag < MAX_LAG && quotes.every((q) => !q.stale), backend: "envio", lag, quotes };
      } catch (err) {
        // Logged, never echoed: the indexer's error text is not for the public. Only the message travels to the log.
        console.warn(`health check failed: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, backend: "envio", lag: null, quotes: [], error: "indexer unavailable" };
      }
    },
  };
}
