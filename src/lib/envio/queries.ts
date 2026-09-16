export type QuotePriceRow = { id: string; usdPrice: number; updatedAt: number; aggregator: string };
export type QuoteRow = { id: string; symbol: string; name: string; decimals: number; address: string };
export type PoolRow = {
  id: string; quote_id: string; tokenIsCurrency0: boolean; hooks: string; fee: number; tickSpacing: number;
  origin: string; createdAt: number; priceQuote: number; tvlToken: string | null; tvlQuote: string | null;
  swapCount: number; lastSwapAt: number | null; quote: { symbol: string; decimals: number };
};
export type TokenRow = {
  id: string; address: string; symbol: string; name: string; decimals: number; totalSupply: string;
  holdersCount: number; origin: string; createdAt: number; primaryPool: PoolRow | null;
};
export type WindowRow = { pool_id: string; t: number; open: number; close: number; volumeQuote: number };
export type CandleRow = { t: number; open: number; high: number; low: number; close: number; volumeQuote: number };
export type SwapRow = { timestamp: number; side: "buy" | "sell"; amountToken: number; priceQuote: number; wallet: string; txHash: string };
export type BalanceRow = { holder: string; balance: string };

const POOL_FIELDS = "id quote_id tokenIsCurrency0 hooks fee tickSpacing origin createdAt priceQuote tvlToken tvlQuote swapCount lastSwapAt quote { symbol decimals }";
const TOKEN_FIELDS = `id address symbol name decimals totalSupply holdersCount origin createdAt primaryPool { ${POOL_FIELDS} }`;

export const PAIRS_QUERY = `
query Pairs($limit: Int!) {
  Token(where: { primaryPool: { swapCount: { _gt: 0 } } }, order_by: { primaryPool: { lastSwapAt: desc_nulls_last } }, limit: $limit) { ${TOKEN_FIELDS} }
  QuotePrice { id usdPrice updatedAt aggregator }
}`;

export const PAIRS_LAUNCHPAD_QUERY = `
query PairsLaunchpad($limit: Int!) {
  Token(where: { origin: { _in: [LONG, Pons] }, primaryPool: { swapCount: { _gt: 0 } } }, order_by: { primaryPool: { lastSwapAt: desc_nulls_last } }, limit: $limit) { ${TOKEN_FIELDS} }
  QuotePrice { id usdPrice updatedAt aggregator }
}`;

const POOL_ID = /^0x[0-9a-f]{64}$/;

/**
 * One aliased selection per pool: its h1 candles since `sinceSec`, oldest first.
 * Never filters on `interval` (broken on the deployed schema); the id pattern does that job.
 * Pool ids are validated before interpolation, so nothing user-supplied reaches the document.
 */
export function windowQuery(poolIds: string[], sinceSec: number): string {
  const parts = poolIds.map((id, i) => {
    if (!POOL_ID.test(id)) throw new Error(`bad pool id ${id}`);
    return `w${i}: Candle(where: { pool_id: { _eq: "${id}" }, id: { _like: "${id}-h1-%" }, t: { _gte: ${Math.floor(sinceSec)} } }, order_by: { t: asc }) { pool_id t open close volumeQuote }`;
  });
  return `query Window { ${parts.join(" ")} }`;
}

export const QUOTES_QUERY = `
query Quotes { Quote { id symbol name decimals address } QuotePrice { id usdPrice updatedAt aggregator } }`;

export const CANDLES_QUERY = `
query Candles($pool: String!, $like: String!, $limit: Int!) {
  Candle(where: { pool_id: { _eq: $pool }, id: { _like: $like } }, order_by: { t: desc }, limit: $limit) { t open high low close volumeQuote }
}`;

export const TOKEN_QUERY = `
query Token($id: String!) {
  Token(where: { id: { _eq: $id } }, limit: 1) { ${TOKEN_FIELDS} }
  QuotePrice { id usdPrice updatedAt aggregator }
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
