/**
 * The fold: turns decoded PoolManager events into pool, token, candle and trade rows.
 *
 * Ported from the old indexer's src/handlers/poolManager.ts (classify, the Initialize
 * handler, updateCandles, principalDelta, the Swap handler, the ModifyLiquidity handler)
 * and src/handlers/shared.ts (ensureToken, recomputePrimaryPool), with
 * `context.X.get/set` replaced by direct reads and writes against the maps in `FoldState`.
 * Every formula, guard and ordering is kept exactly as the handler has it — in particular,
 * the Swap handler reads the pool's price BEFORE updating it (candles open gapless at the
 * previous price) and writes the pool AFTER building the candles.
 *
 * Deliberately NOT ported (see docs/superpowers/plans/2026-09-21-chain-reader.md, Task 3,
 * "What the plan cannot tell you"):
 *   - the transfer-history replay at Initialize (getTransferHistory/applyTransfer/historyLoaded)
 *   - the token metadata effect call itself and its retry throttling (metadataRetryAt) — the
 *     fold never touches the network. It reads metadata from `opts.tokenMetadata` when the
 *     caller supplies it (see below); `newTokens` lists every id created in this batch either way.
 *   - ensureQuote's quote-row seeding — quotes already exist in the store; decimals fall back to
 *     the ported quotes.ts config when a pool's quote id is not (yet) in `state.quotes`
 *   - candleWindowAllows / env-gated candle windows — all five intervals always update
 *
 * New in this port: `PoolState.baselineAt` gating (see its doc comment in types.ts). A Swap
 * always writes its trade row, price, sqrtPriceX96, candles and the `lastSwapAt` max; it only
 * skips swapCount/volumeQuoteAllTime/tvlToken/tvlQuote when `event.timestamp <= pool.baselineAt`.
 * A ModifyLiquidity at or before the baseline is ignored entirely.
 *
 * Also new (Fix round 1, on top of the first version of this file): metadata now arrives
 * BEFORE the fold, not after. The old indexer read a new token's metadata synchronously
 * inside its Initialize handler, before any Swap on that token could be processed — so a
 * token created and traded in the same batch was always priced with its real decimals. A
 * "read metadata after the fold" design would price that same-batch trade (and all five of
 * its candles) with the `decimals = 18` fallback instead, which is silently wrong forever for
 * any token that isn't 18 decimals. `newTokenCandidates` lets the runner read metadata for a
 * batch's new tokens BEFORE calling `foldEvents`, and pass it back in via `opts.tokenMetadata`.
 */

import type {
  ChainEvent,
  InitializeEvent,
  SwapEvent,
  ModifyLiquidityEvent,
  FoldState,
  FoldResult,
  PoolState,
  TokenState,
  CandleState,
  TradeRow,
} from "./types";
import { isQuote, quoteRow } from "./math/quotes";
import { isDenylisted } from "./math/denylist";
import { originFor } from "./math/origin";
import { priceFromSqrtPriceX96, sqrtPriceX96FromPrice, toUnits, absBig } from "./math/price";
import { INTERVALS, bucketStart, candleId } from "./math/candles";
import { amountsForLiquidityDelta } from "./math/liquidity";
import { choosePrimaryPool, type PoolRank } from "./math/primaryPool";
import { ZERO_ADDRESS } from "./math/constants";

/** A new token's real metadata, read from the chain before the fold runs (see newTokenCandidates). */
export type TokenMetadata = { symbol: string; name: string; decimals: number };

export type FoldOptions = {
  /** Keyed by the lowercase token address, for every id newTokenCandidates returned that the
   * caller managed to read. A token this batch creates with no entry here keeps the fallback
   * metadata (symbol = address.slice(0,6), name = address, decimals = 18, metadataLoaded = false). */
  tokenMetadata?: ReadonlyMap<string, TokenMetadata>;
};

/** Accumulates what one foldEvents call touched, so the same id is reported once. */
type FoldContext = {
  touchedPools: Set<string>;
  touchedTokens: Set<string>;
  touchedCandles: Set<string>;
  trades: TradeRow[];
  newTokenIds: string[];
  ignoredPools: number;
  tokenMetadata: ReadonlyMap<string, TokenMetadata> | undefined;
};

/**
 * foldEvents mutates `state` in place and returns the FINAL state of everything this batch
 * touched (never deltas), so applying the same FoldResult twice is harmless. Events are folded
 * strictly in the order given; callers are responsible for (block, logIndex) ordering.
 *
 * `opts.tokenMetadata` supplies real symbol/name/decimals for tokens this batch is about to
 * create (see `newTokenCandidates`, called before this). A created token with no entry there
 * keeps the fallback metadata, exactly as if `opts` were omitted.
 */
export function foldEvents(events: readonly ChainEvent[], state: FoldState, opts?: FoldOptions): FoldResult {
  const ctx: FoldContext = {
    touchedPools: new Set(),
    touchedTokens: new Set(),
    touchedCandles: new Set(),
    trades: [],
    newTokenIds: [],
    ignoredPools: 0,
    tokenMetadata: opts?.tokenMetadata,
  };

  for (const event of events) {
    switch (event.kind) {
      case "initialize":
        handleInitialize(event, state, ctx);
        break;
      case "swap":
        handleSwap(event, state, ctx);
        break;
      case "modifyLiquidity":
        handleModifyLiquidity(event, state, ctx);
        break;
    }
  }

  return {
    pools: Array.from(ctx.touchedPools, (id) => state.pools.get(id)!),
    tokens: Array.from(ctx.touchedTokens, (id) => state.tokens.get(id)!),
    candles: Array.from(ctx.touchedCandles, (id) => state.candles.get(id)!),
    trades: ctx.trades,
    newTokens: ctx.newTokenIds,
    ignoredPools: ctx.ignoredPools,
  };
}

/**
 * The lowercase token addresses the Initialize events in `events` would create: classified
 * exactly as `foldEvents` classifies them (the same `classify` function — same quote/denylist/
 * native rules, same choice of which side is the token), excluding ids already in
 * `state.tokens`, deduplicated, in first-seen order. Call this BEFORE `foldEvents`, read
 * metadata for the result from the chain, and pass it back in as `opts.tokenMetadata` — a
 * token created and traded within the same batch must be priced with its real decimals, not
 * the 18-decimals fallback (see the module doc comment, "Fix round 1").
 *
 * Pure: does not mutate `state`, and does not itself decide replay safety beyond "is this
 * token already known" — a replayed Initialize's pool is always already in `state.pools`,
 * and under a consistent FoldState that pool's token is therefore already in `state.tokens`
 * too, so it is excluded by the same check as any other already-known token.
 */
export function newTokenCandidates(events: readonly ChainEvent[], state: FoldState): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const event of events) {
    if (event.kind !== "initialize") continue;
    const c = classify(event.currency0, event.currency1);
    if (!c) continue;
    if (state.tokens.has(c.token) || seen.has(c.token)) continue;
    seen.add(c.token);
    result.push(c.token);
  }
  return result;
}

/**
 * Ported from poolManager.ts's classify: one side a quote and the other not; not native ETH;
 * not denylisted. Returns null (ignore the Initialize) otherwise.
 */
function classify(
  currency0: string,
  currency1: string,
): { token: string; quote: string; tokenIsCurrency0: boolean } | null {
  const q0 = isQuote(currency0);
  const q1 = isQuote(currency1);
  if (q0 === q1) return null; // both quotes or neither: not a memestock pool
  const token = q1 ? currency0 : currency1;
  const quote = q1 ? currency1 : currency0;
  if (token.toLowerCase() === ZERO_ADDRESS) return null; // no ERC-20 contract to register
  if (isDenylisted(token)) return null; // would replay a real asset's entire chain history
  return { token, quote, tokenIsCurrency0: q1 };
}

/** Quote decimals for a pool's math: state.quotes when loaded, else the ported allowlist. */
function resolveQuoteDecimals(state: FoldState, quoteId: string): number {
  const known = state.quotes.get(quoteId);
  if (known) return known.decimals;
  // classify() only ever treats an address as a quote when quoteRow() has a row for it
  // (both isQuote and quoteRow read the same allowlist), so this is always found in
  // practice; the fallback only keeps a config/state mismatch from aborting the batch.
  return quoteRow(quoteId)?.decimals ?? 18;
}

function addPoolToToken(state: FoldState, tokenId: string, poolId: string): void {
  const existing = state.poolsByToken.get(tokenId);
  if (existing) {
    if (!existing.includes(poolId)) existing.push(poolId);
  } else {
    state.poolsByToken.set(tokenId, [poolId]);
  }
}

/**
 * Ported from shared.ts's recomputePrimaryPool: re-picks primaryPoolId (and the token's
 * origin) from every pool `poolsByToken` lists for this token, using state.quotes for USD
 * prices. Updates the token only when the choice or the resulting origin actually changes.
 */
function recomputePrimaryPool(state: FoldState, tokenId: string, ctx: FoldContext): void {
  const token = state.tokens.get(tokenId);
  if (!token) return;
  const poolIds = state.poolsByToken.get(tokenId) ?? [];
  const pools: PoolState[] = [];
  for (const id of poolIds) {
    const p = state.pools.get(id);
    if (p) pools.push(p);
  }
  if (pools.length === 0) return;

  const ranks: PoolRank[] = pools.map((p) => ({
    id: p.id,
    quoteId: p.quoteId,
    tvlToken: p.tvlToken ?? undefined,
    tvlQuote: p.tvlQuote ?? undefined,
    priceQuote: p.priceQuote,
    tokenDecimals: token.decimals,
    quoteDecimals: resolveQuoteDecimals(state, p.quoteId),
    swapCount: p.swapCount,
    createdAt: p.createdAt,
  }));
  const best = choosePrimaryPool(ranks, (quoteId) => state.quotes.get(quoteId)?.usdPrice ?? undefined);
  if (best === undefined) return; // only possible when pools is empty, already guarded above

  const bestPool = pools.find((p) => p.id === best);
  if (bestPool && (token.primaryPoolId !== best || token.origin !== bestPool.origin)) {
    const updatedToken: TokenState = { ...token, primaryPoolId: best, origin: bestPool.origin };
    state.tokens.set(tokenId, updatedToken);
    ctx.touchedTokens.add(tokenId);
  }
}

function handleInitialize(event: InitializeEvent, state: FoldState, ctx: FoldContext): void {
  if (state.pools.has(event.poolId)) return; // replay safety: already tracked
  const c = classify(event.currency0, event.currency1);
  if (!c) return;
  const ts = event.timestamp;

  let token = state.tokens.get(c.token);
  if (!token) {
    // Real metadata when the caller read it up front (see newTokenCandidates) and supplied
    // it via opts.tokenMetadata — so a token created and traded within this very batch still
    // prices its pool, trades and candles with real decimals, not the 18-decimals fallback.
    // Otherwise the same fallback the old indexer used while a read was pending.
    const meta = ctx.tokenMetadata?.get(c.token);
    token = {
      id: c.token,
      address: c.token,
      symbol: meta?.symbol ?? c.token.slice(0, 6),
      name: meta?.name ?? c.token,
      decimals: meta?.decimals ?? 18,
      poolCount: 0,
      origin: "Other",
      primaryPoolId: null,
      createdAt: ts,
      metadataLoaded: meta !== undefined,
    };
    ctx.newTokenIds.push(c.token);
  }

  const quoteDecimals = resolveQuoteDecimals(state, c.quote);
  const dec0 = c.tokenIsCurrency0 ? token.decimals : quoteDecimals;
  const dec1 = c.tokenIsCurrency0 ? quoteDecimals : token.decimals;
  const origin = originFor(event.poolId, event.hooks);

  const pool: PoolState = {
    id: event.poolId,
    tokenId: token.id,
    quoteId: c.quote,
    tokenIsCurrency0: c.tokenIsCurrency0,
    hooks: event.hooks.toLowerCase(),
    fee: event.fee,
    tickSpacing: event.tickSpacing,
    origin,
    createdAt: ts,
    priceQuote: priceFromSqrtPriceX96(event.sqrtPriceX96, dec0, dec1, c.tokenIsCurrency0),
    sqrtPriceX96: event.sqrtPriceX96,
    tvlToken: 0n,
    tvlQuote: 0n,
    swapCount: 0,
    lastSwapAt: null,
    volumeQuoteAllTime: 0,
    baselineAt: 0,
  };
  state.pools.set(pool.id, pool);
  ctx.touchedPools.add(pool.id);

  const poolCount = token.poolCount + 1;
  const updatedToken: TokenState = {
    ...token,
    poolCount,
    primaryPoolId: token.primaryPoolId ?? pool.id,
    origin: token.primaryPoolId ? token.origin : origin,
  };
  state.tokens.set(updatedToken.id, updatedToken);
  ctx.touchedTokens.add(updatedToken.id);

  addPoolToToken(state, updatedToken.id, pool.id);

  if (poolCount > 1) recomputePrimaryPool(state, updatedToken.id, ctx);
}

/**
 * Ported from poolManager.ts's updateCandles, minus the candleWindowAllows filter: all five
 * intervals always update. A new bucket opens gapless, at the pool's price BEFORE this swap.
 */
function updateCandles(
  state: FoldState,
  ctx: FoldContext,
  poolId: string,
  prevPrice: number,
  price: number,
  amountQuote: number,
  amountToken: number,
  timestamp: number,
): void {
  for (const interval of INTERVALS) {
    const t = bucketStart(timestamp, interval);
    const id = candleId(poolId, interval, t);
    const existing = state.candles.get(id);
    if (existing) {
      const updated: CandleState = {
        ...existing,
        high: Math.max(existing.high, price),
        low: Math.min(existing.low, price),
        close: price,
        volumeQuote: existing.volumeQuote + amountQuote,
        volumeToken: existing.volumeToken + amountToken,
        trades: existing.trades + 1,
      };
      state.candles.set(id, updated);
    } else {
      const candle: CandleState = {
        poolId,
        interval,
        t,
        open: prevPrice,
        high: Math.max(prevPrice, price),
        low: Math.min(prevPrice, price),
        close: price,
        volumeQuote: amountQuote,
        volumeToken: amountToken,
        trades: 1,
      };
      state.candles.set(id, candle);
    }
    ctx.touchedCandles.add(id);
  }
}

// v4 swap fees (LP plus protocol fee, `feePips` in pips) never become pool liquidity: they
// accrue to fee growth, and LPs collect them later through separate modifyLiquidity calls
// whose events carry no fee amount at all. So the side the swapper paid (a negative delta,
// meaning the pool's balance grows) grows only by its net-of-fee amount; the side the swapper
// received (a positive delta, meaning the pool's balance shrinks) shrinks by the full amount,
// since that side actually left the pool's reserves. Ported verbatim from poolManager.ts.
function principalDelta(delta: bigint, feePips: bigint): bigint {
  return delta < 0n ? (delta * (1_000_000n - feePips)) / 1_000_000n : delta;
}

function handleSwap(event: SwapEvent, state: FoldState, ctx: FoldContext): void {
  const pool = state.pools.get(event.poolId);
  if (!pool) {
    ctx.ignoredPools += 1;
    return;
  }
  if (event.amount0 === 0n && event.amount1 === 0n) return; // no-op swap

  const token = state.tokens.get(pool.tokenId);
  if (!token) {
    // Should never happen: every PoolState in a consistent FoldState names a real token.
    throw new Error(`fold: swap on pool ${pool.id} references missing token ${pool.tokenId}`);
  }
  const quoteDecimals = resolveQuoteDecimals(state, pool.quoteId);
  const ts = event.timestamp;

  // Swap amounts are the swapper's deltas, emitted before afterSwap: pre-hook-fee.
  const tokenDelta = pool.tokenIsCurrency0 ? event.amount0 : event.amount1;
  const quoteDelta = pool.tokenIsCurrency0 ? event.amount1 : event.amount0;
  const amountToken = toUnits(absBig(tokenDelta), token.decimals);
  const amountQuote = toUnits(absBig(quoteDelta), quoteDecimals);
  const dec0 = pool.tokenIsCurrency0 ? token.decimals : quoteDecimals;
  const dec1 = pool.tokenIsCurrency0 ? quoteDecimals : token.decimals;
  const price = priceFromSqrtPriceX96(event.sqrtPriceX96, dec0, dec1, pool.tokenIsCurrency0);

  if (event.txFrom === null) {
    throw new Error(`fold: swap ${event.txHash}-${event.logIndex} has no transaction sender`);
  }
  const trade: TradeRow = {
    id: `${event.txHash}-${event.logIndex}`,
    poolId: pool.id,
    tokenId: token.id,
    timestamp: ts,
    side: tokenDelta > 0n ? "buy" : "sell",
    amountToken,
    amountQuote,
    priceQuote: amountToken > 0 ? amountQuote / amountToken : price,
    wallet: event.txFrom.toLowerCase(),
    txHash: event.txHash,
    logIndex: event.logIndex,
  };
  ctx.trades.push(trade);

  // Candles read the pool's price from BEFORE this swap (gapless open); the pool itself is
  // updated after, below.
  updateCandles(state, ctx, pool.id, pool.priceQuote, price, amountQuote, amountToken, ts);

  // baselineAt gating (new — see the module doc comment): a swap at or before the pool's
  // baseline still prices the pool, updates lastSwapAt and folds the candles, but must not
  // double-count totals the old indexer already accumulated up to that moment.
  const postBaseline = ts > pool.baselineAt;
  const feePips = BigInt(event.fee);
  const updatedPool: PoolState = {
    ...pool,
    priceQuote: price,
    sqrtPriceX96: event.sqrtPriceX96,
    lastSwapAt: pool.lastSwapAt === null ? ts : Math.max(pool.lastSwapAt, ts),
    swapCount: postBaseline ? pool.swapCount + 1 : pool.swapCount,
    volumeQuoteAllTime: postBaseline ? pool.volumeQuoteAllTime + amountQuote : pool.volumeQuoteAllTime,
    tvlToken: postBaseline
      ? pool.tvlToken === null
        ? null
        : pool.tvlToken - principalDelta(tokenDelta, feePips)
      : pool.tvlToken,
    tvlQuote: postBaseline
      ? pool.tvlQuote === null
        ? null
        : pool.tvlQuote - principalDelta(quoteDelta, feePips)
      : pool.tvlQuote,
  };
  state.pools.set(pool.id, updatedPool);
  ctx.touchedPools.add(pool.id);

  if (token.poolCount > 1) recomputePrimaryPool(state, token.id, ctx);
}

function handleModifyLiquidity(event: ModifyLiquidityEvent, state: FoldState, ctx: FoldContext): void {
  const pool = state.pools.get(event.poolId);
  if (!pool) {
    // Ruling (Fix round 1): ignoredPools counts every event naming a pool nothing tracks,
    // not just Swap's — see FoldResult.ignoredPools's doc comment in types.ts.
    ctx.ignoredPools += 1;
    return;
  }
  const tvlToken = pool.tvlToken;
  const tvlQuote = pool.tvlQuote;
  // A known pool whose TVL was never tracked is a different, unremarkable condition — not
  // counted as ignoredPools.
  if (tvlToken === null || tvlQuote === null) return;
  if (event.timestamp <= pool.baselineAt) return; // baselineAt gating (new)

  const token = state.tokens.get(pool.tokenId);
  if (!token) {
    // Should never happen: every PoolState in a consistent FoldState names a real token.
    throw new Error(`fold: modifyLiquidity on pool ${pool.id} references missing token ${pool.tokenId}`);
  }
  const quoteDecimals = resolveQuoteDecimals(state, pool.quoteId);
  const dec0 = pool.tokenIsCurrency0 ? token.decimals : quoteDecimals;
  const dec1 = pool.tokenIsCurrency0 ? quoteDecimals : token.decimals;
  // sqrtPriceX96 is null for pools copied from the old indexer before it was captured
  // (see PoolState.sqrtPriceX96's doc comment): derive it from the stored price instead.
  const sqrt = pool.sqrtPriceX96 ?? sqrtPriceX96FromPrice(pool.priceQuote, dec0, dec1, pool.tokenIsCurrency0);

  const { amount0, amount1 } = amountsForLiquidityDelta(sqrt, event.tickLower, event.tickUpper, event.liquidityDelta);
  const tokenAmt = pool.tokenIsCurrency0 ? amount0 : amount1;
  const quoteAmt = pool.tokenIsCurrency0 ? amount1 : amount0;

  const updatedPool: PoolState = { ...pool, tvlToken: tvlToken + tokenAmt, tvlQuote: tvlQuote + quoteAmt };
  state.pools.set(pool.id, updatedPool);
  ctx.touchedPools.add(pool.id);

  if (token.poolCount > 1) recomputePrimaryPool(state, token.id, ctx);
}
