/**
 * Hasura serialises every `numeric` column as a JSON string, so a Float-derived field
 * arrives as `"0.000866"`, not `0.000866`. Int columns (swapCount, lastSwapAt, updatedAt,
 * timestamp, holdersCount) really are numbers, and BigInt columns stay decimal strings.
 * Shaping funnels every one of these through `num()`.
 */
export type Numeric = number | string;

export type QuotePriceRow = { id: string; usdPrice: Numeric; updatedAt: number; aggregator: string };
export type QuoteRow = { id: string; symbol: string; name: string; decimals: number; address: string };
export type PoolRow = {
  id: string; quote_id: string; tokenIsCurrency0: boolean; hooks: string; fee: number; tickSpacing: number;
  origin: string; createdAt: number; priceQuote: Numeric; tvlToken: string | null; tvlQuote: string | null;
  swapCount: number; lastSwapAt: number | null; quote: { symbol: string; decimals: number };
};
export type TokenRow = {
  id: string; address: string; symbol: string; name: string; decimals: number; totalSupply: string;
  holdersCount: number; origin: string; createdAt: number; primaryPool: PoolRow | null;
  /** Best sane pool by swap count, selected only by the queries that can recover a broken primary. */
  fallbackPool?: PoolRow[];
};
export type WindowRow = { pool_id: string; t: number; open: Numeric; close: Numeric; volumeQuote: Numeric };
export type CandleRow = { t: number; open: Numeric; high: Numeric; low: Numeric; close: Numeric; volumeQuote: Numeric };
export type SwapRow = { timestamp: number; side: "buy" | "sell"; amountToken: Numeric; priceQuote: Numeric; wallet: string; txHash: string };
export type BalanceRow = { holder: string; balance: string };
/** Only what a swap needs: the v4 PoolKey's five fields, the direction, the stored price and both assets' decimals. */
export type PoolKeyPoolRow = {
  id: string; quote_id: string; tokenIsCurrency0: boolean; hooks: string; fee: number; tickSpacing: number;
  priceQuote: Numeric; quote: { address: string; decimals: number };
};
export type PoolKeyTokenRow = {
  id: string; address: string; decimals: number;
  primaryPool: PoolKeyPoolRow | null;
  /** Best sane pool by swap count, as in TOKEN_QUERY. */
  fallbackPool?: PoolKeyPoolRow[];
};

const POOL_FIELDS = "id quote_id tokenIsCurrency0 hooks fee tickSpacing origin createdAt priceQuote tvlToken tvlQuote swapCount lastSwapAt quote { symbol decimals }";
const TOKEN_FIELDS = `id address symbol name decimals totalSupply holdersCount origin createdAt primaryPool { ${POOL_FIELDS} }`;
const QUOTE_PRICES = "QuotePrice { id usdPrice updatedAt aggregator }";

/**
 * The indexer ranks `primaryPool` by TVL, which picks dead pools parked at a tick boundary
 * for more than a thousand tokens (AI, CASHCAT, DINO, GOOGL). Those quote around 3.4e50 or
 * about 0, so every document here filters them out and the API resolves the pool itself.
 */
const SANE_PRICE = 'priceQuote: { _gt: "1e-24", _lt: "1e18" }';
/** The mirror image: a primary pool that sits at one of those boundaries. */
const BROKEN_PRIMARY = 'primaryPool: { _or: [{ priceQuote: { _gte: "1e18" } }, { priceQuote: { _lte: "1e-24" } }] }';
const FALLBACK_POOL = `fallbackPool: pools(where: { swapCount: { _gt: 0 }, ${SANE_PRICE} }, order_by: { swapCount: desc }, limit: 1) { ${POOL_FIELDS} }`;

export const PAIRS_QUERY = `
query Pairs($limit: Int!) {
  Token(where: { primaryPool: { swapCount: { _gt: 0 }, ${SANE_PRICE} } }, order_by: { primaryPool: { lastSwapAt: desc_nulls_last } }, limit: $limit) { ${TOKEN_FIELDS} }
  ${QUOTE_PRICES}
}`;

// Filtering on `Token.origin` is filtering on the resolved pool's origin: the indexer keeps the
// two equal (verified, zero mismatches), and this document only admits a sane primary pool.
export const PAIRS_LAUNCHPAD_QUERY = `
query PairsLaunchpad($limit: Int!) {
  Token(where: { origin: { _in: [LONG, Pons] }, primaryPool: { swapCount: { _gt: 0 }, ${SANE_PRICE} } }, order_by: { primaryPool: { lastSwapAt: desc_nulls_last } }, limit: $limit) { ${TOKEN_FIELDS} }
  ${QUOTE_PRICES}
}`;

/**
 * Tokens the main query drops because their primary pool is broken, but which still trade
 * somewhere sane. Ordered by the newest swap across a token's pools so that `$limit` takes the
 * most recently traded candidates rather than an arbitrary slice of the thousand-odd matches.
 */
export const PAIRS_RECOVERY_QUERY = `
query PairsRecovery($since: Int!, $limit: Int!) {
  Token(where: { ${BROKEN_PRIMARY}, pools: { ${SANE_PRICE}, swapCount: { _gt: 0 }, lastSwapAt: { _gte: $since } } }, order_by: { pools_aggregate: { max: { lastSwapAt: desc } } }, limit: $limit) {
    ${TOKEN_FIELDS}
    ${FALLBACK_POOL}
  }
  ${QUOTE_PRICES}
}`;

export const PAIRS_RECOVERY_LAUNCHPAD_QUERY = `
query PairsRecoveryLaunchpad($since: Int!, $limit: Int!) {
  Token(where: { ${BROKEN_PRIMARY}, pools: { ${SANE_PRICE}, swapCount: { _gt: 0 }, lastSwapAt: { _gte: $since }, origin: { _in: [LONG, Pons] } } }, order_by: { pools_aggregate: { max: { lastSwapAt: desc } } }, limit: $limit) {
    ${TOKEN_FIELDS}
    fallbackPool: pools(where: { swapCount: { _gt: 0 }, ${SANE_PRICE}, origin: { _in: [LONG, Pons] } }, order_by: { swapCount: desc }, limit: 1) { ${POOL_FIELDS} }
  }
  ${QUOTE_PRICES}
}`;

const POOL_ID = /^0x[0-9a-f]{64}$/;

/**
 * One aliased selection per pool: its h1 candles since `sinceSec`, oldest first.
 * Never filters on `interval` (broken on the deployed schema); the id pattern does that job.
 * Pool ids are validated before interpolation, so nothing user-supplied reaches the document.
 */
export function windowQuery(poolIds: string[], sinceSec: number): string {
  // An empty selection set is a parse error at the indexer, not an empty result.
  if (poolIds.length === 0) throw new Error("windowQuery needs at least one pool id");
  const parts = poolIds.map((id, i) => {
    if (!POOL_ID.test(id)) throw new Error(`bad pool id ${id}`);
    return `w${i}: Candle(where: { pool_id: { _eq: "${id}" }, id: { _like: "${id}-h1-%" }, t: { _gte: ${Math.floor(sinceSec)} } }, order_by: { t: asc }) { pool_id t open close volumeQuote }`;
  });
  return `query Window { ${parts.join(" ")} }`;
}

export const QUOTES_QUERY = `
query Quotes { Quote { id symbol name decimals address } ${QUOTE_PRICES} }`;

export const CANDLES_QUERY = `
query Candles($pool: String!, $like: String!, $limit: Int!) {
  Candle(where: { pool_id: { _eq: $pool }, id: { _like: $like } }, order_by: { t: desc }, limit: $limit) { t open high low close volumeQuote }
}`;

export const TOKEN_QUERY = `
query Token($id: String!) {
  Token(where: { id: { _eq: $id } }, limit: 1) {
    ${TOKEN_FIELDS}
    ${FALLBACK_POOL}
  }
  ${QUOTE_PRICES}
}`;

const POOL_KEY_FIELDS = "id quote_id tokenIsCurrency0 hooks fee tickSpacing priceQuote quote { address decimals }";

/**
 * One token's pool to trade against: the same TVL-picked `primaryPool` as TOKEN_QUERY, but a
 * *wider* fallback than TOKEN_QUERY's own. TOKEN_QUERY's `fallbackPool` (market listing — what
 * pairs/candles/trades show) requires `swapCount: { _gt: 0 }`, mirroring the store's
 * `listed_pool_id`. Trading is a looser bar: any sane-priced pool is routable whether or not it
 * has swapped yet, because a freshly launched token can have liquidity and zero trades and still
 * be perfectly tradeable (see MarketBackend.poolKey) — so this fallback drops the swap-count
 * filter and orders by swap count, then recency, then id, so the pick is deterministic.
 * Carries the quote's own address — the field QUOTES_QUERY already selects on the same entity —
 * because a PoolKey needs both currencies and `quote_id` is an id, not an address the swap can
 * sign over.
 */
export const POOL_KEY_QUERY = `
query PoolKey($id: String!) {
  Token(where: { id: { _eq: $id } }, limit: 1) {
    id address decimals
    primaryPool { ${POOL_KEY_FIELDS} }
    fallbackPool: pools(where: { ${SANE_PRICE} }, order_by: [{ swapCount: desc }, { lastSwapAt: desc_nulls_last }, { id: asc }], limit: 1) { ${POOL_KEY_FIELDS} }
  }
}`;

export const TRADES_QUERY = `
query Trades($pool: String!) {
  Swap(where: { pool_id: { _eq: $pool } }, order_by: { timestamp: desc }, limit: 50) { timestamp side amountToken priceQuote wallet txHash }
}`;

export const HOLDERS_QUERY = `
query Holders($token: String!) {
  TokenBalance(where: { token_id: { _eq: $token }, balance: { _gt: "0" } }, order_by: { balance: desc }, limit: 10) { holder balance }
}`;

export const HEALTH_QUERY = `
query Health { chain_metadata { chain_id latest_processed_block block_height } QuotePrice { id updatedAt aggregator } }`;
