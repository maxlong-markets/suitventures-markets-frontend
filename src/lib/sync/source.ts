import type { Numeric } from "@/lib/envio/queries";

export type QuoteRec = { id: string; address: string; symbol: string; name: string; decimals: number; enabled: boolean };
export type QuotePriceRec = { id: string; usdPrice: Numeric; updatedAt: number; aggregator: string };
export type PoolRec = {
  id: string; token_id: string; quote_id: string; tokenIsCurrency0: boolean; hooks: string; fee: number; tickSpacing: number;
  origin: string; createdAt: number; priceQuote: Numeric; tvlToken: string | null; tvlQuote: string | null;
  swapCount: number; lastSwapAt: number | null; volumeQuoteAllTime: Numeric;
  /** The pool's last sqrtPriceX96 (uint160): a decimal string end to end, never run through Number. Null until set. */
  sqrtPriceX96: string | null;
};
export type TokenRec = {
  id: string; address: string; symbol: string; name: string; decimals: number; totalSupply: string; holdersCount: number;
  poolCount: number; origin: string; createdAt: number; primaryPool_id: string | null; metadataLoaded: boolean;
};
export type SwapRec = {
  id: string; pool_id: string; token_id: string; timestamp: number; side: "buy" | "sell";
  amountToken: Numeric; amountQuote: Numeric; priceQuote: Numeric; wallet: string; txHash: string;
};
export type CandleRec = {
  id: string; pool_id: string; t: number; open: Numeric; high: Numeric; low: Numeric; close: Numeric;
  volumeQuote: Numeric; volumeToken: Numeric; trades: number;
};
export type BalanceRec = { id: string; token_id: string; holder: string; balance: string; updatedAt: number };

export type PoolCursor = { lastSwapAt: number; id: string };
export type CreatedCursor = { createdAt: number; id: string };
export type SwapCursor = { timestamp: number; id: string };
export type CandleCursor = { t: number; id: string };

export interface EnvioSource {
  quotes(): Promise<{ quotes: QuoteRec[]; prices: QuotePriceRec[] }>;
  /** Pools with lastSwapAt >= since, ordered (lastSwapAt asc, id asc), strictly after `after`. */
  poolsSince(since: number, after: PoolCursor | null, limit: number): Promise<PoolRec[]>;
  /** Pools with createdAt >= since and lastSwapAt null, ordered (createdAt asc, id asc), strictly after `after`. */
  poolsCreatedSince(since: number, after: CreatedCursor | null, limit: number): Promise<PoolRec[]>;
  /** Swaps of the pools with timestamp >= since, ordered (timestamp asc, id asc), strictly after `after`. */
  swapsFor(poolIds: readonly string[], since: number, after: SwapCursor | null, limit: number): Promise<SwapRec[]>;
  /** `recent`: candles of the pools with t >= since, ordered (t asc, id asc), strictly after `after`. `open`: the candles whose ids are in openIds, fetched only when `after` is null (first page); otherwise []. */
  candlesFor(poolIds: readonly string[], since: number, openIds: readonly string[], after: CandleCursor | null, limit: number): Promise<{ recent: CandleRec[]; open: CandleRec[] }>;
  tokensById(ids: readonly string[]): Promise<TokenRec[]>;
  /** Non-zero balances of each of the given tokens, largest first per token, one request, flattened in the order of tokenIds. Empty input returns [] without a request. */
  topHoldersBatch(tokenIds: readonly string[], limit: number): Promise<BalanceRec[]>;
  chainMeta(): Promise<{ latestProcessedBlock: number; blockHeight: number }>;
  /** Id-range walks (seed, nightly): rows with id > afterId, and id < beforeId when given, ascending by id, at most limit. */
  tokensPage(afterId: string, limit: number): Promise<TokenRec[]>;
  poolsPage(afterId: string, limit: number): Promise<PoolRec[]>;
  swapsPage(afterId: string, beforeId: string | null, limit: number): Promise<SwapRec[]>;
  candlesPage(afterId: string, beforeId: string | null, limit: number): Promise<CandleRec[]>;
  /** Requests issued so far by this source. */
  readonly queries: number;
}
