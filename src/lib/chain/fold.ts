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
 *
 * Fix round 2, on top of round 1, from the review at
 * .superpowers/sdd/2026-09-21-chain-reader/task-3-review.md:
 *   - MAJOR-1: the reference's "a failed metadata read gets fixed at the next Initialize, and
 *     retried hourly from Swap" has an equivalent again. `repairTokenMetadata` runs from every
 *     handler (not only a second Initialize) and applies a supplied `opts.tokenMetadata` entry
 *     to an already-known token with `metadataLoaded === false`; `newTokenCandidates` now also
 *     returns such a token's id for any pool the batch touches, not only pools it creates.
 *   - MINOR-2: `handleInitialize`'s replay guard and `classify` are hoisted into one shared
 *     `initializeTarget`, called by both `handleInitialize` and `newTokenCandidates`, so the
 *     two cannot drift on which Initializes count.
 *   - BLOCKER (measured against production, not theoretical — every copied pool has a null
 *     `sqrtPriceX96`, and some carry a garbage `priceQuote`): `handleModifyLiquidity`'s price
 *     derivation and liquidity math can throw for a legacy pool with an unusable stored price.
 *     `tryDeriveLiquidityAmounts` catches that (and only that) and the event is skipped and
 *     counted in `FoldResult.skippedLiquidity`, instead of aborting the whole batch's
 *     transaction and wedging the cron on that block permanently.
 *
 * Fix round 3, on top of round 2, from the re-review at
 * .superpowers/sdd/2026-09-21-chain-reader/task-3-rereview.md:
 *   - MINOR-A: `tryDeriveLiquidityAmounts`'s catch narrowed to ONLY the derived-sqrt path
 *     (`pool.sqrtPriceX96 === null`). A pool with a real, chain-captured sqrt calls
 *     `amountsForLiquidityDelta` directly, outside any try/catch, so a throw there (a bad tick
 *     range — a decoder bug, not stale legacy data) still propagates instead of being silently
 *     counted as `skippedLiquidity`. See the function's own doc comment for the full reasoning.
 *
 * Fix round 4, from the production incident at
 * .superpowers/sdd/2026-09-21-chain-reader/missing-token-report.md: a torn read in the original
 * snapshot copy left exactly one pool row with no matching market.tokens row, and
 * `handleModifyLiquidity`/`handleSwap` threw on it — inside `applyFold`'s one transaction, so the
 * throw rolled back the whole batch and wedged the catch-up on that block forever. `loadFoldState`
 * (store.ts) now synthesizes a fallback `TokenState` for any pool it loads whose token has no row,
 * which should make this unreachable via the normal `newTokenCandidates` -> real-metadata-read ->
 * `applyFold` path. Both handlers no longer throw on a still-missing token regardless: they skip
 * the event instead — one bad row must never be able to stop the whole reader. Every other throw
 * in this file is untouched.
 *
 * Fix round 5, from the observability review at
 * .superpowers/sdd/2026-09-21-chain-reader/missing-token-review.md (MAJOR-1): round 4's skip was
 * counted in `FoldResult.ignoredPools`, which already means "an event naming a pool nothing
 * tracks" — routine and enormous (62% of all events in one measured run). A missing-token skip is
 * a structural anomaly (it should be impossible once `loadFoldState` synthesizes a fallback) and
 * was invisible inside that count. It now has its own `FoldResult.orphanedTokens` counter, and
 * each skip site also `console.warn`s once per distinct pool id (capped per `foldEvents` call —
 * see `MAX_ORPHAN_WARNINGS` below) so the pool/token ids the old throw message used to carry are
 * still visible to an operator watching logs.
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

/**
 * A token's real metadata, read from the chain before the fold runs (see newTokenCandidates).
 * The caller must supply an entry only for a read that actually succeeded (Task 5's
 * `readTokenMetadata`'s `ok: true`) — never a fallback/failed read, or the fold marks a
 * failure `metadataLoaded: true` forever (round-2 review, MAJOR-1).
 */
export type TokenMetadata = { symbol: string; name: string; decimals: number };

export type FoldOptions = {
  /** Keyed by the lowercase token address, for every id `newTokenCandidates` returned that the
   * caller managed to read: a token this batch is about to create, or an already-known token
   * with `metadataLoaded === false` that this batch touches again. Either way, a token with no
   * entry here keeps its current metadata (the 18-decimals fallback for a new one, whatever it
   * already had for an existing one) — exactly as if `opts` were omitted. */
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
  orphanedTokens: number;
  skippedLiquidity: number;
  tokenMetadata: ReadonlyMap<string, TokenMetadata> | undefined;
  /** Pool ids `warnOrphanedToken` has already warned about, this call only — caps log spam. */
  warnedOrphanPools: Set<string>;
};

/**
 * Fix round 5 (observability review, missing-token-review.md, MAJOR-1): the softened throw in
 * handleSwap/handleModifyLiquidity left no forensic trace of which pool/token hit it, unlike the
 * throw it replaced. Cap at a handful of distinct pool ids per `foldEvents` call — the uncapped
 * signal is `FoldResult.orphanedTokens` itself; this is only so a batch that somehow hits many
 * distinct orphaned pools at once cannot flood stdout/Vercel logs.
 */
const MAX_ORPHAN_WARNINGS = 5;

function warnOrphanedToken(ctx: FoldContext, poolId: string, tokenId: string): void {
  if (ctx.warnedOrphanPools.has(poolId)) return;
  if (ctx.warnedOrphanPools.size >= MAX_ORPHAN_WARNINGS) return;
  ctx.warnedOrphanPools.add(poolId);
  console.warn(`fold: pool ${poolId} references missing token ${tokenId} — skipping event (orphanedTokens)`);
}

/**
 * foldEvents mutates `state` in place and returns the FINAL state of everything this batch
 * touched (never deltas), so applying the same FoldResult twice is harmless. Events are folded
 * strictly in the order given; callers are responsible for (block, logIndex) ordering.
 *
 * `opts.tokenMetadata` supplies real symbol/name/decimals for tokens `newTokenCandidates`
 * returned for this same batch — both a token about to be created and an already-known token
 * with a failed earlier read that this batch touches again. An id with no entry there keeps
 * its current metadata, exactly as if `opts` were omitted.
 */
export function foldEvents(events: readonly ChainEvent[], state: FoldState, opts?: FoldOptions): FoldResult {
  const ctx: FoldContext = {
    touchedPools: new Set(),
    touchedTokens: new Set(),
    touchedCandles: new Set(),
    trades: [],
    newTokenIds: [],
    ignoredPools: 0,
    orphanedTokens: 0,
    skippedLiquidity: 0,
    tokenMetadata: opts?.tokenMetadata,
    warnedOrphanPools: new Set(),
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
    orphanedTokens: ctx.orphanedTokens,
    skippedLiquidity: ctx.skippedLiquidity,
  };
}

/**
 * The lowercase token ids `foldEvents` will want metadata for if this same batch is folded
 * next: every token an Initialize in `events` would create (via the shared `initializeTarget`
 * — same replay guard, same `classify`, so this can never drift from `handleInitialize`), PLUS
 * — since round-2 review MAJOR-1 — the token of any pool a Swap or ModifyLiquidity in `events`
 * touches whose token is already in `state` but still has `metadataLoaded === false`: a repair
 * opportunity the fold has no other way to reach, now that the reference's hourly
 * Swap-handler retry is not ported. Deduplicated, in first-seen order. Call this BEFORE
 * `foldEvents`, read metadata for the result from the chain, and pass it back in as
 * `opts.tokenMetadata`.
 *
 * Pure: does not mutate `state`. Bounded to tokens this batch actually touches — never a scan
 * of every `metadataLoaded: false` row in `state`.
 */
export function newTokenCandidates(events: readonly ChainEvent[], state: FoldState): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (tokenId: string): void => {
    if (seen.has(tokenId)) return;
    seen.add(tokenId);
    result.push(tokenId);
  };

  for (const event of events) {
    if (event.kind === "initialize") {
      const c = initializeTarget(event, state);
      if (!c) continue;
      const existing = state.tokens.get(c.token);
      if (!existing || !existing.metadataLoaded) add(c.token);
      continue;
    }
    // Swap and ModifyLiquidity: a pool this batch touches whose token is known but still
    // unloaded is the MAJOR-1 repair case, not a creation — same rule either way: worth
    // reading again.
    const pool = state.pools.get(event.poolId);
    const token = pool ? state.tokens.get(pool.tokenId) : undefined;
    if (token && !token.metadataLoaded) add(token.id);
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

/**
 * The replay guard plus classify, as one step: what an Initialize event would create, or null
 * if it would not. Shared by `handleInitialize` and `newTokenCandidates` (round-2 review,
 * MINOR-2) so the two can never drift on which Initializes count — a comment saying they agree
 * is a weaker guarantee than one code path both call.
 */
function initializeTarget(
  event: InitializeEvent,
  state: FoldState,
): { token: string; quote: string; tokenIsCurrency0: boolean } | null {
  if (state.pools.has(event.poolId)) return null; // replay safety: already tracked
  return classify(event.currency0, event.currency1);
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

/**
 * MAJOR-1 (round-2 review): the reference's "metadata read failed, fix it later" repair,
 * generalized to every handler instead of only Initialize — the fold has no equivalent of the
 * reference's hourly Swap-handler retry (`metadataRetryAt`, deliberately not ported), so this
 * is the only remaining chance to correct a token that was created with the 18-decimals
 * fallback because its first read failed. Returns `token` unchanged (no state write, no touch)
 * when it is already loaded or the caller supplied nothing for it this batch; otherwise writes
 * the corrected `TokenState` into `state.tokens`, marks it touched, and returns it — so every
 * caller must use the RETURNED value for the rest of that event's handling, not the one passed
 * in, exactly as a same-batch Initialize-creation already does for a brand-new token.
 */
function repairTokenMetadata(state: FoldState, ctx: FoldContext, token: TokenState): TokenState {
  if (token.metadataLoaded) return token;
  const meta = ctx.tokenMetadata?.get(token.id);
  if (!meta) return token;
  const updated: TokenState = { ...token, symbol: meta.symbol, name: meta.name, decimals: meta.decimals, metadataLoaded: true };
  state.tokens.set(token.id, updated);
  ctx.touchedTokens.add(token.id);
  return updated;
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
    tvlQuote: p.tvlQuote ?? undefined,
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
  const c = initializeTarget(event, state);
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
  } else {
    // MAJOR-1 (round-2 review): a direct port of poolManager.ts:56-65 — a token whose earlier
    // metadata read failed gets another chance at every later Initialize that touches it.
    token = repairTokenMetadata(state, ctx, token);
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

  const rawToken = state.tokens.get(pool.tokenId);
  if (!rawToken) {
    // Fix round 4: should be unreachable now that loadFoldState synthesizes a fallback
    // TokenState for every pool it loads (store.ts) — but applyFold writes rows and the cursor
    // in one transaction, so a throw here would roll back the whole batch and wedge the cron on
    // this block forever over a single bad row. Skip the event.
    // Fix round 5 (missing-token-review.md, MAJOR-1): counted in its own orphanedTokens, NOT the
    // pool-missing check's ignoredPools above — that field's routine, six-figure count would
    // bury this structural anomaly. Warned too, capped, so the ids survive in the logs.
    ctx.orphanedTokens += 1;
    warnOrphanedToken(ctx, pool.id, pool.tokenId);
    return;
  }
  // MAJOR-1 (round-2 review): repair before pricing, so a swap that is this batch's only
  // chance to fix a metadata-failed token also prices ITSELF with the corrected decimals.
  const token = repairTokenMetadata(state, ctx, rawToken);
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

/**
 * BLOCKER (round-2 review, MINOR-5), measured against production, not theoretical: every one
 * of the 238,391 pools copied from the old indexer has a null `sqrtPriceX96`, so every
 * ModifyLiquidity on one takes the `sqrtPriceX96FromPrice(pool.priceQuote, …)` DERIVED path
 * below. 2,349 of those copied pools carry a garbage `priceQuote` around 3.40256786836388e50
 * and 532 carry one below 1e-30 — neither is non-finite or non-positive, so
 * `sqrtPriceX96FromPrice` itself does not reject them, but the sqrt it derives is then out of
 * `amountsForLiquidityDelta`'s valid range (a 55-digit value for the first case, one below
 * `MIN_SQRT_RATIO` for a token paired with a 6-decimals quote in the second — see the test for
 * why the quote's decimals matter there), and it throws. One of the over-large-price pools has
 * 101,092 swaps — actively traded, not a dead row. Since `applyFold` writes rows and the cursor
 * in one transaction, an uncaught throw here would roll back the whole batch and wedge the cron
 * and the catch-up on that block permanently. So: catch it, skip just this one event, and count
 * it in `skippedLiquidity` — never let one bad legacy pool's price take down the pipeline.
 *
 * NARROWED (round-3 re-review, MINOR-A): the catch below applies ONLY on the derived path, i.e.
 * only when `pool.sqrtPriceX96` is null. A pool with a REAL, chain-captured `sqrtPriceX96` (set
 * unconditionally by `handleInitialize` or `handleSwap` from an actual on-chain event) is
 * always inside `[MIN_SQRT_RATIO, MAX_SQRT_RATIO)` by construction — the only way
 * `amountsForLiquidityDelta` can then throw for it is `tickLower`/`tickUpper` being
 * non-integer, out of range, or inverted, and ticks come straight from the decoded log,
 * unmodified. A throw there means the ABI decode or the int24 sign-extension is wrong, not that
 * the row is legacy data, and it must stay loud: silently swallowing it would let a broken
 * decoder count every ModifyLiquidity as "skipped" while TVL quietly stopped moving, with
 * nothing in the batch's result to say why. So a real `sqrtPriceX96` calls
 * `amountsForLiquidityDelta` directly, outside any try/catch, and any throw propagates exactly
 * as it would if this function did not exist.
 */
function tryDeriveLiquidityAmounts(
  pool: PoolState,
  dec0: number,
  dec1: number,
  event: ModifyLiquidityEvent,
): { amount0: bigint; amount1: bigint } | null {
  if (pool.sqrtPriceX96 !== null) {
    return amountsForLiquidityDelta(pool.sqrtPriceX96, event.tickLower, event.tickUpper, event.liquidityDelta);
  }
  // Only the DERIVED path — a pool copied from the old indexer, sqrtPriceX96 never captured —
  // can carry a garbage priceQuote with no real sqrt to fall back on instead.
  try {
    const sqrt = sqrtPriceX96FromPrice(pool.priceQuote, dec0, dec1, pool.tokenIsCurrency0);
    return amountsForLiquidityDelta(sqrt, event.tickLower, event.tickUpper, event.liquidityDelta);
  } catch {
    return null;
  }
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

  const rawToken = state.tokens.get(pool.tokenId);
  if (!rawToken) {
    // Fix round 4: should be unreachable now that loadFoldState synthesizes a fallback
    // TokenState for every pool it loads (store.ts) — but applyFold writes rows and the cursor
    // in one transaction, so a throw here would roll back the whole batch and wedge the cron on
    // this block forever over a single bad row. Skip the event.
    // Fix round 5 (missing-token-review.md, MAJOR-1): counted in its own orphanedTokens, NOT the
    // pool-missing check's ignoredPools above — that field's routine, six-figure count would
    // bury this structural anomaly. Warned too, capped, so the ids survive in the logs.
    ctx.orphanedTokens += 1;
    warnOrphanedToken(ctx, pool.id, pool.tokenId);
    return;
  }
  // MAJOR-1 (round-2 review): repair before deriving, same reasoning as handleSwap above.
  const token = repairTokenMetadata(state, ctx, rawToken);
  const quoteDecimals = resolveQuoteDecimals(state, pool.quoteId);
  const dec0 = pool.tokenIsCurrency0 ? token.decimals : quoteDecimals;
  const dec1 = pool.tokenIsCurrency0 ? quoteDecimals : token.decimals;

  // BLOCKER (round-2 review, MINOR-5): a legacy pool's derived sqrt or the liquidity math
  // itself can throw (see tryDeriveLiquidityAmounts's doc comment) — that must skip this one
  // event, never abort the batch.
  const amounts = tryDeriveLiquidityAmounts(pool, dec0, dec1, event);
  if (!amounts) {
    ctx.skippedLiquidity += 1;
    return;
  }
  const tokenAmt = pool.tokenIsCurrency0 ? amounts.amount0 : amounts.amount1;
  const quoteAmt = pool.tokenIsCurrency0 ? amounts.amount1 : amounts.amount0;

  const updatedPool: PoolState = { ...pool, tvlToken: tvlToken + tokenAmt, tvlQuote: tvlQuote + quoteAmt };
  state.pools.set(pool.id, updatedPool);
  ctx.touchedPools.add(pool.id);

  if (token.poolCount > 1) recomputePrimaryPool(state, token.id, ctx);
}
