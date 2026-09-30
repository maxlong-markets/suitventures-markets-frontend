import { ttlCache } from "@/lib/envio/cache";
import { gql } from "@/lib/envio/client";
import { loadPairs } from "@/lib/envio/pairs";
import {
  CANDLES_QUERY, HEALTH_QUERY, HOLDERS_QUERY, POOL_KEY_QUERY, QUOTES_QUERY, TOKEN_QUERY, TRADES_QUERY, windowQuery,
  type BalanceRow, type CandleRow, type PoolKeyPoolRow, type PoolKeyTokenRow, type PoolRow, type QuotePriceRow, type QuoteRow, type SwapRow, type TokenRow, type WindowRow,
} from "@/lib/envio/queries";
import { isSanePool, isStale, num, resolvePool, shapeCandles, shapeHolders, shapePairs, shapeQuotes, shapeTrades, usdMap, windowStats } from "@/lib/envio/shape";
import { createQuoter, NotRoutableError, type Quoter } from "@/lib/quote/quoter";
import { probeCall } from "@/lib/sync/probe";
import { nowSec } from "@/lib/time";
import type { HealthReport, MarketBackend } from "./backend";
import { poolKeyRow, type PoolKeyParts } from "./poolKey";

const CHAIN_ID = 4663;
const MAX_LAG = 500;
/** Same window as the nightly probe's own memo would need on the token page (spec section 2): "5 minutes". */
const PROBE_TTL_MS = 300_000;
type TokenRows = { Token: TokenRow[]; QuotePrice: QuotePriceRow[] };
type HealthRows = {
  chain_metadata: { chain_id: number; latest_processed_block: number; block_height: number }[];
  QuotePrice: { id: string; updatedAt: number; aggregator: string }[];
};
/** The same window as `loadWindowRows` in pairs.ts: h1 candles from a day before the 24h bucket. */
const windowSince = (now: number) => Math.floor((now - 86400) / 3600) * 3600 - 86400;

/** Either candidate pool, shaped for `poolKeyRow` — factored out so poolKey() can try it twice. */
function poolKeyParts(token: PoolKeyTokenRow, pool: PoolKeyPoolRow): PoolKeyParts {
  return {
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
  };
}

/**
 * The listed pool, shaped for `poolKeyRow`/`probeCall` — pair()'s own probe, not poolKey()'s (hence
 * a second helper: the `PoolRow` this method reads carries no `quote.address` field, only
 * `quote_id`). The indexer always mints a Quote's id as its own address, lowercased — asserted by
 * the indexer's own Initialize-discovery tests — so `quote_id` doubles as the address here. A
 * read-only simulate call is the reason this stands on that identity rather than widening every
 * pairs/candles/trades query for an address field only this probe would use; `poolKey()`, which
 * hands a real signature its currencies, does not take the same shortcut (POOL_KEY_QUERY fetches
 * `quote.address` explicitly) and neither does the nightly probe (probe.ts's own CANDIDATES_SQL).
 */
function poolKeyPartsFromPair(token: TokenRow, pool: PoolRow): PoolKeyParts {
  return {
    poolId: pool.id,
    hooks: pool.hooks,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    tokenIsCurrency0: pool.tokenIsCurrency0,
    priceQuote: num(pool.priceQuote),
    tokenAddress: token.address,
    tokenDecimals: token.decimals,
    quoteAddress: pool.quote_id,
    quoteDecimals: pool.quote.decimals,
  };
}

/**
 * The token page's lazy probe (spec section 2 / 6 task 2): the same Quoter, the same call
 * (`probeCall`, shared with the nightly's sweep so the two can never disagree), memoised 300 s per
 * pool. `NotRoutableError` is an answer — false, and cached like any other outcome. Anything else
 * (`QuoterUnavailableError`, a bad poolKey) is not an answer: it rejects out of `ttlCache`, whose
 * own contract (a failed load caches nothing) is exactly "do not cache this verdict" — the caller
 * below turns that rejection into the optimistic default instead of a broken page.
 */
function probeTradeable(quoter: Quoter, token: TokenRow, pool: PoolRow): Promise<boolean> {
  return ttlCache(`routable:${pool.id}`, PROBE_TTL_MS, async () => {
    const call = probeCall(poolKeyPartsFromPair(token, pool), pool.quote_id);
    if (!call) return true; // cannot even build the call: nothing was answered, same as unavailable
    try {
      await quoter.exactIn(call);
      return true; // any answer, 0n included, is the honest-zero ruling (spec section 2)
    } catch (err) {
      if (err instanceof NotRoutableError) return false;
      throw err; // QuoterUnavailableError or anything else: propagates, so ttlCache does not cache it
    }
  });
}

/** The M1 route bodies, unchanged, behind the interface. `pairs` keeps its memo inside `loadPairs`. */
export function createEnvioBackend(opts: { quoter?: Quoter } = {}): MarketBackend {
  const quoter = opts.quoter ?? createQuoter();
  return {
    kind: "envio",
    // "sv" is not a Hasura query. This path is not used in production, where the store answers it from market.launches;
    // here it is the launchpad list narrowed to SV, which carries no launchCreator and misses a delisted launch.
    pairs: async (scope) => (scope === "sv" ? (await loadPairs("launchpad")).filter((p) => p.origin === "SV") : loadPairs(scope)),
    async pair(id) {
      const now = nowSec();
      const t = await gql<TokenRows>(TOKEN_QUERY, { id });
      const token = t.Token[0];
      const pool = token ? resolvePool(token) : null;
      if (!token || !pool) return null;
      const w = await gql<Record<string, WindowRow[]>>(windowQuery([pool.id], windowSince(now)));
      const base = shapePairs([token], usdMap(t.QuotePrice, now), windowStats(Object.values(w).flat(), now))[0];
      if (!base) return null;
      // Only the token page's single pair() probes (spec section 2): pairs() cannot afford one
      // eth_call per row. A probe that could not answer at all leaves the optimistic default alone.
      let tradeable = true;
      try {
        tradeable = await probeTradeable(quoter, token, pool);
      } catch {
        tradeable = true;
      }
      return { ...base, tradeable };
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
    /**
     * The indexer's own balances, which carry no build state: always `ready`, and `asOf` null because
     * nothing here knows when that list was last current (the tab then simply shows no "as of" line).
     * The four states of the top-holders design belong to the store backend; this one is the parity
     * path, kept for `scripts/db/parity.mts`.
     */
    async holders(id) {
      const t = await gql<TokenRows>(TOKEN_QUERY, { id });
      const token = t.Token[0];
      if (!token) return { holders: [], count: 0, status: "ready", asOf: null };
      const rows = await gql<{ TokenBalance: BalanceRow[] }>(HOLDERS_QUERY, { token: id });
      return {
        holders: shapeHolders(rows.TokenBalance, token.decimals, BigInt(token.totalSupply)),
        count: token.holdersCount,
        status: "ready",
        asOf: null,
      };
    },
    // One trading-pool rule, identical to dbBackend's (MarketBackend.poolKey): the token's primary
    // pool when it prices sanely, no swap-count floor — a freshly launched token can have liquidity
    // and zero trades and still be perfectly tradeable — else the sane pool with the most swaps
    // (POOL_KEY_QUERY's own fallbackPool, wider than TOKEN_QUERY's, which requires a trade). Two
    // different meanings of "the token's pool" meet here: the market table lists through
    // listedPool (writers.ts, spec section 6: traded, or an SV launch inside its 24 h window; a
    // product decision); this rule decides trading instead, and the two coincide whenever the
    // primary pool has traded.
    //
    // fallbackPool is already restricted to quote_id: quoteId in the document (POOL_KEY_QUERY), so
    // a higher-swap-count pool in a different quote asset can never crowd out the one actually
    // asked for (C2). primaryPool carries no such restriction — Hasura does not accept a `where`
    // on an object relation — so a sane primary in a different quote asset is caught here by hand,
    // through poolKeyRow, the one place both backends share that check, and falls through to the
    // (already-restricted) fallback exactly as an insane primary does.
    async poolKey(tokenId, quoteId) {
      const t = await gql<{ Token: PoolKeyTokenRow[] }>(POOL_KEY_QUERY, { id: tokenId, quoteId });
      const token = t.Token[0];
      if (!token) return null;
      const primary = token.primaryPool && isSanePool(token.primaryPool)
        ? poolKeyRow(poolKeyParts(token, token.primaryPool), quoteId)
        : null;
      if (primary) return primary;
      const fallback = token.fallbackPool?.[0];
      return fallback && isSanePool(fallback) ? poolKeyRow(poolKeyParts(token, fallback), quoteId) : null;
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
