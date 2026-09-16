/**
 * Typed models for SuitVentures Markets. Every component consumes these —
 * never literals — so the Envio/Alchemy layer can replace the mock source
 * without touching UI code. The core interface is copied from the design
 * handoff README; additions are marked at the bottom.
 */

export type Origin = "LONG" | "Pons" | "Uniswap" | "Other" | "SUIT" | "SV";
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
  /** true when `usdPrice` is the last known price, not a fresh one. */
  stale?: boolean;
}

export interface TokenPair {
  /** Token contract address, lowercase. The canonical key: thousands of memecoins share tickers. */
  id: string;
  ticker: string;
  name: string;
  address: Address;
  logoUrl?: string;
  /** QuoteAsset.symbol */
  quote: string;
  origin: Origin;
  /** false → "Not tradeable here yet" card */
  tradeable: boolean;
  priceUsd: number;
  priceQuote: number;
  /** percent; null when no candle exists before the window ("new") */
  change1h: number | null;
  change24h: number | null;
  vol24h: number;
  mcap: number;
  fdv: number;
  /** USD; null while liquidity accounting is unavailable */
  liquidity: number | null;
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
  candles(id: string, interval: Interval): Promise<Candle[]>;
  trades(id: string): Promise<Trade[]>;
  holders(id: string): Promise<Holder[]>;
  quoteSwap(
    id: string,
    side: Side,
    amount: number,
    denom: Denom,
    isSuitHolder: boolean,
    slippagePct: number,
  ): Promise<Quote>;
  /** token addresses */
  watchlist(address: Address): Promise<string[]>;
  setWatch(
    address: Address,
    id: string,
    on: boolean,
    signature: string,
  ): Promise<void>;
  /**
   * Casting the same direction twice clears the vote; casting the other
   * direction switches it.
   */
  vote(
    address: Address,
    id: string,
    dir: VoteDir,
    signature: string,
  ): Promise<void>;

  // --- Additions beyond the handoff interface ---------------------------

  /**
   * The caller's current vote per token address. Not in the handoff
   * interface; the token page needs it to render the voted state after a
   * reload.
   */
  votes(address: Address): Promise<Record<string, VoteDir>>;
}
