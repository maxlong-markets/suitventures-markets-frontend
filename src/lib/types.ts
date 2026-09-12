/**
 * Typed models for SuitVentures Markets. Every component consumes these —
 * never literals — so the Envio/Alchemy layer can replace the mock source
 * without touching UI code. The core interface is copied from the design
 * handoff README; additions are marked at the bottom.
 */

export type Launchpad = "LONG" | "Pons" | "Bags" | "SV";
export type Address = `0x${string}`;
export type Interval = "1m" | "5m" | "15m" | "1h" | "1d";
export type Side = "buy" | "sell";
/** Which asset the typed trade amount is denominated in. */
export type Denom = "quote" | "token";
export type VoteDir = "bull" | "bear";

export interface QuoteAsset {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  usdPrice: number;
  pairs: number;
  vol24h: number;
}

export interface TokenPair {
  ticker: string;
  name: string;
  address: Address;
  logoUrl?: string;
  /** QuoteAsset.symbol */
  quote: string;
  launchpad: Launchpad;
  /** false → "Not tradeable here yet" card */
  tradeable: boolean;
  priceUsd: number;
  priceQuote: number;
  /** percent */
  change1h: number;
  /** percent */
  change24h: number;
  vol24h: number;
  mcap: number;
  fdv: number;
  liquidity: number;
  holders: number;
  /** unix ms → age */
  createdAt: number;
  bull: number;
  bear: number;
  poolId: Address;
  hook: string;
  feeTier: string;
}

export interface Candle {
  /** unix ms, candle open time */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** USD volume in the candle */
  v: number;
}

export interface Trade {
  /** unix ms */
  t: number;
  side: Side;
  /** token amount */
  amount: number;
  priceUsd: number;
  wallet: Address;
  tx: Address;
}

export interface Holder {
  wallet: Address;
  balance: number;
  /** percent of supply */
  share: number;
  tag?: "Pool" | "Suit";
}

export interface Quote {
  payAmount: number;
  receiveAmount: number;
  priceImpactPct: number;
  routerFeePct: 0 | 0.5;
  poolFeePct: number;
  minReceived: number;
}

export interface MarketsDataSource {
  quotes(): Promise<QuoteAsset[]>;
  pairs(): Promise<TokenPair[]>;
  candles(ticker: string, interval: Interval): Promise<Candle[]>;
  trades(ticker: string): Promise<Trade[]>;
  holders(ticker: string): Promise<Holder[]>;
  quoteSwap(
    ticker: string,
    side: Side,
    amount: number,
    denom: Denom,
    isSuitHolder: boolean,
    slippagePct: number,
  ): Promise<Quote>;
  /** tickers */
  watchlist(address: Address): Promise<string[]>;
  setWatch(
    address: Address,
    ticker: string,
    on: boolean,
    signature: string,
  ): Promise<void>;
  /**
   * Casting the same direction twice clears the vote; casting the other
   * direction switches it.
   */
  vote(
    address: Address,
    ticker: string,
    dir: VoteDir,
    signature: string,
  ): Promise<void>;

  // --- Additions beyond the handoff interface ---------------------------

  /**
   * The caller's current vote per ticker. Not in the handoff interface; the
   * token page needs it to render the voted state after a reload.
   */
  votes(address: Address): Promise<Record<string, VoteDir>>;
}
