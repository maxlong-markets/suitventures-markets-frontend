import { bucketStart, candleId, type IndexerInterval } from "./ids";
import type { CandleRec, PoolRec, QuotePriceRec, QuoteRec, SwapRec, TokenRec } from "./source";

/** Rows in the shape FakeSource serves and the writers consume. Ids are lowercase like the indexer's. */
export const hex = (n: number, digits: number) => "0x" + n.toString(16).padStart(digits, "0");
export const addr = (n: number) => hex(n, 40);
export const poolId = (n: number) => hex(n, 64);
export const txHash = (n: number) => hex(n, 64);

export const T0 = 1_789_000_000;
export const QUOTE = addr(0xa1);
export const TOKEN_A = addr(0xb1);
export const TOKEN_B = addr(0xb2);
export const POOL_A = poolId(0x11);
export const POOL_B = poolId(0x12);
export const WALLET = addr(0xc1);

export function quoteRec(o: Partial<QuoteRec> = {}): QuoteRec {
  return { id: QUOTE, address: QUOTE, symbol: "NVDA", name: "NVIDIA", decimals: 18, enabled: true, ...o };
}
export function priceRec(o: Partial<QuotePriceRec> = {}): QuotePriceRec {
  return { id: QUOTE, usdPrice: "182.5", updatedAt: T0, aggregator: addr(0xfeed), ...o };
}
export function poolRec(o: Partial<PoolRec> = {}): PoolRec {
  return {
    id: POOL_A, token_id: TOKEN_A, quote_id: QUOTE, tokenIsCurrency0: true, hooks: addr(0), fee: 3000, tickSpacing: 60,
    origin: "LONG", createdAt: T0, priceQuote: "0.000866", tvlToken: "1000000000000000000000", tvlQuote: "500000000000000000",
    swapCount: 3, lastSwapAt: T0 + 500, volumeQuoteAllTime: "12.5", sqrtPriceX96: null, ...o,
  };
}
export function tokenRec(o: Partial<TokenRec> = {}): TokenRec {
  return {
    id: TOKEN_A, address: TOKEN_A, symbol: "AI", name: "Artificial Inu", decimals: 18, totalSupply: "1000000000000000000000000000",
    holdersCount: 42, poolCount: 1, origin: "LONG", createdAt: T0, primaryPool_id: POOL_A, metadataLoaded: true, ...o,
  };
}
export function swapRec(o: Partial<SwapRec> = {}): SwapRec {
  const tx = o.txHash ?? txHash(1);
  return {
    id: `${tx}-0`, pool_id: POOL_A, token_id: TOKEN_A, timestamp: T0 + 500, side: "buy", amountToken: "1000", amountQuote: "0.866",
    priceQuote: "0.000866", wallet: WALLET, txHash: tx, ...o,
  };
}
/** The id is derived from pool, interval and t unless overridden, so it always parses. */
export function candleRec(o: Partial<CandleRec> & { interval?: IndexerInterval } = {}): CandleRec {
  const { interval = "m1", ...rest } = o;
  const pool = rest.pool_id ?? POOL_A;
  const t = rest.t ?? bucketStart(T0 + 500, interval);
  return {
    id: candleId(pool, interval, t), pool_id: pool, t, open: "0.0008", high: "0.0009", low: "0.0007", close: "0.000866",
    volumeQuote: "1.2", volumeToken: "1500", trades: 2, ...rest,
  };
}
