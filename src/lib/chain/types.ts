/**
 * The chain reader's shared contract (spec: docs/superpowers/specs/2026-09-21-chain-reader-design.md).
 *
 * The reader replaces the hosted indexer: it reads the Uniswap v4 PoolManager's events straight from the
 * chain, folds them with the indexer's own arithmetic, and writes market.* in one transaction with its
 * block cursor. Every module under src/lib/chain/ meets at these types, so they are written first and the
 * modules are built against them in parallel.
 *
 * Conventions: addresses, pool ids and tx hashes are lowercase hex strings; block timestamps are unix
 * seconds; raw on-chain integers are bigint and never pass through `number`.
 */

/** What every decoded PoolManager log carries. `txFrom` is the transaction's sender, the wallet a trade is credited to. */
export type ChainEventBase = {
  block: number;
  logIndex: number;
  timestamp: number;
  txHash: string;
  txFrom: string | null;
};

export type InitializeEvent = ChainEventBase & {
  kind: "initialize";
  poolId: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  sqrtPriceX96: bigint;
  tick: number;
};

export type SwapEvent = ChainEventBase & {
  kind: "swap";
  poolId: string;
  /** The swapper's deltas, as emitted: negative means the swapper paid that currency into the pool. */
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  /** Swap fee in pips (LP plus protocol), as emitted. */
  fee: number;
};

export type ModifyLiquidityEvent = ChainEventBase & {
  kind: "modifyLiquidity";
  poolId: string;
  tickLower: number;
  tickUpper: number;
  liquidityDelta: bigint;
};

export type ChainEvent = InitializeEvent | SwapEvent | ModifyLiquidityEvent;

/** One ERC-20 Transfer of one token, from HyperSync (LogSource.transfers): addresses lowercase, value as emitted. */
export type TransferEvent = { block: number; logIndex: number; from: string; to: string; value: bigint };

/** Where events come from. HyperSync is the first implementation; a plain-RPC one can follow behind the same interface. */
export interface LogSource {
  /** The newest block this source can serve right now. */
  head(): Promise<number>;
  /**
   * The PoolManager's Initialize, Swap and ModifyLiquidity events in [fromBlock, toBlock], ascending by
   * (block, logIndex). A source may cover fewer blocks than asked (responses are size-capped): `nextBlock`
   * is the first block NOT covered, so the caller continues from it. `nextBlock > fromBlock` always, or
   * the call throws: a fetch that makes no progress must never look like an empty range.
   */
  fetch(fromBlock: number, toBlock: number): Promise<{ events: ChainEvent[]; nextBlock: number }>;
  /**
   * `token`'s ERC-20 Transfer events from `fromBlock` on, ascending by (block, logIndex), as many blocks as one
   * response covers (top holders, 23 Sep 2026): `nextBlock` is the first block NOT covered and is always
   * greater than `fromBlock`, or the call throws — the same contract as fetch(). `toBlock`, when given, is an
   * inclusive ceiling: no event past it comes back and `nextBlock` never passes `toBlock + 1`, so the builder can
   * hand the source its `head - safety` line and never fold past it. Omitted, the source covers what it likes.
   */
  transfers(token: string, fromBlock: number, toBlock?: number): Promise<{ transfers: TransferEvent[]; nextBlock: number }>;
  /** Requests issued so far, for budgets and reports. */
  readonly requests: number;
  /**
   * The key's advertised budget in requests per minute, from the service's rate-limit headers on the
   * last answered request (24 Sep 2026: the free package answers `x-ratelimit-limit=30000;w=60` with
   * `x-ratelimit-cost=1000`, i.e. 30 a minute; the paid package sends no limit and a cost of 0), or null
   * when none has been seen. A source that cannot know it (a test fake) may omit the field.
   */
  readonly rateLimitPerMinute?: number | null;
}

/** A pool as the fold sees it. Mirrors market.pools; `baselineAt` is market.pools.baseline_at. */
export type PoolState = {
  id: string;
  tokenId: string;
  quoteId: string;
  tokenIsCurrency0: boolean;
  hooks: string;
  fee: number;
  tickSpacing: number;
  origin: string;
  createdAt: number;
  priceQuote: number;
  /** Null for pools copied from the old indexer before it was captured; derive from priceQuote when needed. */
  sqrtPriceX96: bigint | null;
  tvlToken: bigint | null;
  tvlQuote: bigint | null;
  swapCount: number;
  lastSwapAt: number | null;
  volumeQuoteAllTime: number;
  /**
   * The running totals (tvl, swapCount, volumeQuoteAllTime) already include every event with
   * timestamp <= baselineAt, because they were copied from the old indexer at that moment. The fold applies
   * totals only for events after it. 0 for pools the reader created itself. Price, last trade time, trade
   * rows and candles are never gated by it.
   */
  baselineAt: number;
};

/** A token as the fold sees it. Holder count and supply are deliberately absent: the fold never writes them. */
export type TokenState = {
  id: string;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  poolCount: number;
  origin: string;
  primaryPoolId: string | null;
  createdAt: number;
  metadataLoaded: boolean;
};

export type QuoteState = { id: string; decimals: number; usdPrice: number | null };

export type CandleInterval = "m1" | "m5" | "m15" | "h1" | "d1";

export type CandleState = {
  poolId: string;
  interval: CandleInterval;
  /** Bucket start, unix seconds. */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeQuote: number;
  volumeToken: number;
  trades: number;
};

/** One trade row, shaped for market.swaps. `id` is `${txHash}-${logIndex}`. */
export type TradeRow = {
  id: string;
  poolId: string;
  tokenId: string;
  timestamp: number;
  side: "buy" | "sell";
  amountToken: number;
  amountQuote: number;
  priceQuote: number;
  wallet: string;
  txHash: string;
  logIndex: number;
};

/** Everything the fold needs to know before it sees a batch. Keys: pool id, token id, quote id, `${poolId}-${interval}-${t}`. */
export type FoldState = {
  pools: Map<string, PoolState>;
  tokens: Map<string, TokenState>;
  quotes: Map<string, QuoteState>;
  candles: Map<string, CandleState>;
  /** Every pool id of each token present in `tokens`, for primary-pool choice; includes pools not otherwise touched. */
  poolsByToken: Map<string, string[]>;
};

/** What a batch changed: final states, not deltas, so writing them twice is harmless. */
export type FoldResult = {
  pools: PoolState[];
  tokens: TokenState[];
  candles: CandleState[];
  trades: TradeRow[];
  /** Token ids created in this batch (the runner records their supply and metadata retry state from it). */
  newTokens: string[];
  /**
   * Events naming a pool nothing tracks: a Swap or a ModifyLiquidity whose pool id is not in
   * state.pools and no Initialize in this batch created — a health signal the runner reports.
   * Does NOT include ModifyLiquidity's null-TVL guard: that pool is tracked, just without TVL
   * history, which is a different (and unremarkable) condition.
   * Does NOT include a tracked pool whose token is missing from state.tokens — see
   * `orphanedTokens` below; that used to be folded in here too (Fix round 4) but is now counted
   * separately (observability review, missing-token-review.md, MAJOR-1) so a real anomaly is not
   * buried in this field's ordinary, high-volume count (measured 62% of all events in one run).
   */
  ignoredPools: number;
  /**
   * A Swap or a ModifyLiquidity whose pool IS tracked (in state.pools) but whose token has no
   * entry in state.tokens at all — a torn-read gap in the original snapshot copy (Fix round 4,
   * missing-token-report.md). `loadFoldState`'s synthesized fallback (store.ts) makes this
   * structurally unreachable in normal operation, so this should always be 0; a nonzero value
   * means either that synthesis, or the "every loaded pool's token is in state.tokens" invariant
   * it depends on, is broken. Split out from `ignoredPools` (observability review,
   * missing-token-review.md, MAJOR-1) precisely so it stays a legible signal instead of one
   * anomaly buried in that field's routine, six-figure count. The event is still skipped rather
   * than thrown either way: one bad row must never wedge the whole batch's transaction.
   */
  orphanedTokens: number;
  /**
   * ModifyLiquidity events on a pool with no real, chain-captured sqrtPriceX96 (copied from the
   * old indexer before it was captured) whose priceQuote could not be turned into a usable sqrt
   * in range, so the liquidity change could not be applied. Never counts a pool with a real
   * sqrtPriceX96: a throw there means the decoded tick range is wrong (a decoder bug), not that
   * the price is stale, and it propagates instead of being counted here.
   */
  skippedLiquidity: number;
};

/**
 * One `Launched` event, shaped for market.launches (instant launchpad design, section 5.2). `metadataCid` is the part
 * after `ipfs://` when `metadataUri` matches `^ipfs://[A-Za-z0-9]{46,128}$`, else "".
 */
export type LaunchRow = {
  tokenId: string; poolId: string; quoteId: string; creator: string; payout: string; hook: string;
  tokenIsCurrency0: boolean; creatorShareBps: number; openTick: number; openingValuation: bigint; liquidity: bigint;
  tokensInPool: bigint; firstBuyIn: bigint; firstBuyTokens: bigint; routerFee: bigint; creationFee: bigint;
  name: string; symbol: string; metadataUri: string; metadataCid: string;
  block: number; logIndex: number; txHash: string; timestamp: number;
};

/** One `FeesCollected` log, the key of market.launch_fee_events. Platform amounts are the event's total minus its payout amount. */
export type LaunchFeesRow = {
  txHash: string; logIndex: number;
  tokenId: string; payout: string; tokenPayout: bigint; tokenPlatform: bigint; quotePayout: bigint; quotePlatform: bigint;
  timestamp: number; block: number;
};

/** The last `PayoutChanged` of a token in a batch, applied only over an older (block, log index). */
export type PayoutRow = { tokenId: string; payout: string; block: number; logIndex: number };
