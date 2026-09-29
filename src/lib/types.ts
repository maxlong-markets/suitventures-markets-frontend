import type { SwapCall } from "./quote/price";

/**
 * Typed models for MaxLong Markets. Every component consumes these —
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

/** A 0x-prefixed hex string. Spelt here rather than imported from viem, exactly as `Address` is. */
export type Hex = `0x${string}`;

/**
 * Signs an EIP-191 personal message: wagmi's `signMessageAsync` with its options object adapted
 * away, so the data source can run the sign-in flow without importing a React hook.
 */
export type SignMessage = (message: string) => Promise<Hex>;

/** How the traders board is ranked. */
export type TradersBy = "volume" | "trades";

/**
 * What a vote write answers: the direction that now stands for this wallet (null when the vote was
 * cleared) and the token's bull/bear counts with that write already in them. The counts come back
 * with the write because the read that would otherwise supply them is a thirty-second cache, and a
 * client that refetched it to show its own vote was reading a number from before the vote (the
 * 23 Sep report). It is the wire shape of `VoteWrite` in `src/lib/social/store.ts`, flattened:
 * that module is `server-only` and this type is what the client-side data sources answer.
 */
export interface VoteResult {
  dir: VoteDir | null;
  bull: number;
  bear: number;
}

/**
 * The execution block the quote route returns. It lives in `src/lib/quote/price.ts` next to the
 * code that builds it; this is a type-only re-export, erased at build time, so nothing client-side
 * gains a runtime dependency on the route's internals. Both sides of the
 * `types.ts` ↔ `quote/price.ts` pair import the other with `import type`, so nothing circular
 * survives to runtime.
 */
export type { SwapCall };

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

/**
 * A token launched here (instant launchpad design, section 5.5): the single-token response only, never the 500-row list.
 * Raw amounts are decimal strings in raw units.
 */
export type LaunchInfo = {
  creator: Address;
  payout: Address;
  quoteAddress: Address;
  quoteDecimals: number;
  tokenIsCurrency0: boolean;
  openTick: number;
  /** V', raw quote units for the whole supply, decimal string. */
  openingValuation: string;
  firstBuyIn: string;
  firstBuyTokens: string;
  creatorShareBps: number;
  /** unix seconds */
  launchedAt: number;
  launchBlock: number;
  launchTx: Hex;
  hidden: boolean;
  /** All "" when hidden. */
  imageCid: string;
  description: string;
  website: string;
  x: string;
  telegram: string;
  /** Router fee taken out of the first buy; firstBuyIn + routerFee is the gross the creator paid. */
  routerFee: string;
  /** Summed on read over market.launch_fee_events, raw units, decimal strings; all "0" before any collection. */
  feesCollected: { tokenToPayout: string; tokenToPlatform: string; quoteToPayout: string; quoteToPlatform: string };
  /** Unix seconds of the latest collection, 0 before any. */
  feesCollectedAt: number;
};

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
  /**
   * true when the quote has no usable USD price (no feed, or a feed older than
   * 3 days); the USD fields then read 0 and render as a dash
   */
  stale?: boolean;
  holders: number;
  /** unix ms → age */
  createdAt: number;
  bull: number;
  bear: number;
  poolId: Address;
  hook: string;
  /** The listed pool's `hooks` field, lowercase; the zero address when the pool has no hook. */
  hookAddress: Address;
  feeTier: string;
  /** Instant launchpad (spec 5.5): undefined on list rows, null for a token not launched here. */
  launch?: LaunchInfo | null;
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

/** The Holders tab's answer (docs/superpowers/specs/2026-09-23-top-holders-design.md, sections 1 and 5). */
export type HoldersStatus = "ready" | "building" | "skipped";
export interface HoldersView {
  holders: Holder[];
  /** market.tokens.holders_count: exact once a list is ready, the reader's drifted count before. */
  count: number;
  status: HoldersStatus;
  /** Unix seconds the list was last brought to the chain head; null until it first is. */
  asOf: number | null;
}

export interface Quote {
  payAmount: number;
  receiveAmount: number;
  priceImpactPct: number;
  routerFeePct: 0 | 0.5;
  poolFeePct: number;
  minReceived: number;
  /**
   * `false` when the quote route simulated the pool and could not route it, `true` when it priced
   * it, `undefined` when nothing has been priced yet — amount 0, or the mock source's local
   * approximation. Only an explicit `false` shows the "Not routed" card.
   */
  routable?: boolean;
  /**
   * Execution, verbatim from the route. The browser never recomputes an amount in it; it signs and
   * sends it as it stands. Absent means "nothing can be submitted from this quote".
   */
  call?: SwapCall;
}

export interface MarketsDataSource {
  quotes(): Promise<QuoteAsset[]>;
  pairs(): Promise<TokenPair[]>;
  /** One token by address, listed or not; null when the source does not know it. */
  pair(id: string): Promise<TokenPair | null>;
  candles(id: string, interval: Interval): Promise<Candle[]>;
  trades(id: string): Promise<Trade[]>;
  holders(id: string): Promise<HoldersView>;
  /**
   * The typed amount travels as the string the user typed: a float would round it to 17
   * significant digits before `toBase` turned it into the amount Permit2 transfers (Global
   * Constraint 1). Only the two float models — `localQuote` and the panel's display gating —
   * parse it.
   */
  quoteSwap(
    id: string,
    side: Side,
    amount: string,
    denom: Denom,
    isSuitHolder: boolean,
    slippagePct: number,
  ): Promise<Quote>;

  /** The top 50 wallets of the last 24 hours. Public: no session is involved. */
  traders(by: TradersBy): Promise<TraderRow[]>;

  // --- The signed-in user's own data ------------------------------------
  // None of these takes an address: the `svm_session` cookie is the only identity the user
  // routes trust (spec section 2), and a client-supplied address would be a claim, not a fact.

  /** The token addresses this session has starred. Empty when nobody is signed in. */
  watchlist(): Promise<string[]>;
  setWatch(id: string, on: boolean): Promise<void>;
  /**
   * The caller's current vote per token address. Not in the handoff interface; the token page
   * needs it to render the voted state after a reload.
   */
  votes(): Promise<Record<string, VoteDir>>;
  /**
   * Casting the same direction twice clears the vote; casting the other direction switches it.
   * Answers the direction that now stands and the token's counts with the write in them.
   */
  vote(id: string, dir: VoteDir): Promise<VoteResult>;

  // --- Session ----------------------------------------------------------

  /** The signed-in address, or null for nobody signed in. Rejects with `SessionsOffError` where sessions are not configured. */
  session(): Promise<Address | null>;
  /** Nonce, EIP-4361 message, signature, cookie. Answers the address the server accepted. */
  signIn(sign: SignMessage, address: Address): Promise<Address>;
  signOut(): Promise<void>;
}

/**
 * One row of the top-traders board (M4 spec section 4): a wallet's last-24h volume in USD, its trade
 * count and the number of distinct tokens it traded. It lives here rather than in
 * `src/lib/social/store.ts`, which is `server-only`, because the `/traders` page renders these rows in
 * a client component.
 *
 * This is the **only** declaration of the type in the plan (Ruling 5): Task 5 adds `TradersBy` beside
 * it and the `traders` method to `MarketsDataSource`, and re-declares nothing.
 */
export interface TraderRow {
  wallet: Address;
  /**
   * Display only: the 24-hour volume already converted through the pool's quote asset and its USD
   * price. Never an execution amount, so a float is the right shape for it (Global Constraint 1
   * governs amounts the chain will see; this one it never does).
   */
  volumeUsd: number;
  trades: number;
  /** Distinct tokens this wallet traded in the window. */
  tokens: number;
}
