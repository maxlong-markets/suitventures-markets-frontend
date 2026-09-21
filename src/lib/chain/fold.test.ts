import { describe, it, expect } from "vitest";
import { foldEvents, newTokenCandidates } from "./fold";
import type {
  FoldState,
  InitializeEvent,
  SwapEvent,
  ModifyLiquidityEvent,
  PoolState,
  TokenState,
} from "./types";
import { amountsForLiquidityDelta } from "./math/liquidity";
import { sqrtPriceX96FromPrice } from "./math/price";
import denylist from "./math/config/token-denylist.json" with { type: "json" };

// Ported from the old indexer's src/handlers/poolManager.test.ts. Addresses are lowercase
// here (unlike that file's checksummed constants) because ChainEvent documents its fields as
// already-lowercased by the decoder (types.ts) — the fold trusts that boundary rather than
// re-normalizing every address itself. AI/NVDA/USDG/WYFI are the same real addresses used
// there; NVDA, USDG and WYFI are real rows of config/quotes.json (Task 2).
const AI = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const WYFI = "0x9e7abd3c9139d14e4c86dce0e455aab7a0c2fb3e";
const DOPPLER = "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544";
const ZERO = "0x0000000000000000000000000000000000000000";
const POOL = "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27";
const OTHER_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const WALLET = "0x3f8a7c21e9b4d0a6f15c8e2b7d9a4c0e1f6b9a2c";
const TX = "0x" + "ab".repeat(32);
const Q96 = 2n ** 96n;

function emptyState(): FoldState {
  return { pools: new Map(), tokens: new Map(), quotes: new Map(), candles: new Map(), poolsByToken: new Map() };
}

function initEvent(over: Partial<InitializeEvent> = {}, block = 100): InitializeEvent {
  return {
    kind: "initialize",
    block,
    logIndex: 0,
    timestamp: 1_700_000_000 + block,
    txHash: "0x" + "00".repeat(32),
    txFrom: null,
    poolId: POOL,
    currency0: AI,
    currency1: NVDA,
    fee: 8_388_608,
    tickSpacing: 8,
    hooks: DOPPLER,
    sqrtPriceX96: Q96,
    tick: 0,
    ...over,
  };
}

function swapEvent(
  amount0: bigint,
  amount1: bigint,
  sqrtPriceX96: bigint,
  block: number,
  over: Partial<SwapEvent> = {},
): SwapEvent {
  return {
    kind: "swap",
    block,
    logIndex: 0,
    timestamp: 1_700_000_000 + block * 60,
    txHash: TX,
    txFrom: WALLET,
    poolId: POOL,
    amount0,
    amount1,
    sqrtPriceX96,
    liquidity: 10n ** 18n,
    tick: 0,
    fee: 3000,
    ...over,
  };
}

function modifyLiquidityEvent(
  poolId: string,
  liquidityDelta: bigint,
  block: number,
  over: Partial<ModifyLiquidityEvent> = {},
): ModifyLiquidityEvent {
  return {
    kind: "modifyLiquidity",
    block,
    logIndex: 0,
    timestamp: 1_700_000_000 + block,
    txHash: TX,
    txFrom: WALLET,
    poolId,
    tickLower: -887272,
    tickUpper: 887272,
    liquidityDelta,
    ...over,
  };
}

/** A pool already in state, as if loaded from the store — for tests that don't go through Initialize. */
function poolFixture(over: Partial<PoolState> = {}): PoolState {
  return {
    id: POOL,
    tokenId: AI,
    quoteId: NVDA,
    tokenIsCurrency0: true,
    hooks: DOPPLER,
    fee: 3000,
    tickSpacing: 8,
    origin: "LONG",
    createdAt: 100,
    priceQuote: 1,
    sqrtPriceX96: Q96,
    tvlToken: 0n,
    tvlQuote: 0n,
    swapCount: 0,
    lastSwapAt: null,
    volumeQuoteAllTime: 0,
    baselineAt: 0,
    ...over,
  };
}

function tokenFixture(over: Partial<TokenState> = {}): TokenState {
  return {
    id: AI,
    address: AI,
    symbol: "AI",
    name: "AI",
    decimals: 18,
    poolCount: 1,
    origin: "LONG",
    primaryPoolId: POOL,
    createdAt: 100,
    metadataLoaded: true,
    ...over,
  };
}

function seededState(poolOver: Partial<PoolState> = {}, tokenOver: Partial<TokenState> = {}): FoldState {
  const state = emptyState();
  const pool = poolFixture(poolOver);
  const token = tokenFixture(tokenOver);
  state.pools.set(pool.id, pool);
  state.tokens.set(token.id, token);
  state.poolsByToken.set(token.id, [pool.id]);
  return state;
}

describe("Initialize discovery", () => {
  it("tracks a pool with exactly one quote side, registers the token, labels LONG", () => {
    const state = emptyState();
    const result = foldEvents([initEvent()], state);
    const pool = state.pools.get(POOL)!;
    expect(pool.tokenId).toBe(AI);
    expect(pool.quoteId).toBe(NVDA);
    expect(pool.tokenIsCurrency0).toBe(true);
    expect(pool.origin).toBe("LONG");
    expect(pool.priceQuote).toBeCloseTo(1, 9);
    const token = state.tokens.get(AI)!;
    expect(token.primaryPoolId).toBe(POOL);
    expect(token.poolCount).toBe(1);
    expect(token.origin).toBe("LONG");
    expect(result.newTokens).toContain(AI);
    expect(result.pools).toEqual([pool]);
    expect(result.tokens).toEqual([token]);
  });

  it("ignores pools where both sides are quotes", () => {
    const state = emptyState();
    const id = "0x" + "11".repeat(32);
    foldEvents([initEvent({ poolId: id, currency0: USDG, currency1: NVDA })], state);
    expect(state.pools.has(id)).toBe(false);
  });

  it("orients a token that is currency1 and inverts the price", () => {
    const state = emptyState();
    const id = "0x" + "22".repeat(32);
    foldEvents(
      [initEvent({ poolId: id, currency0: NVDA, currency1: OTHER_TOKEN, hooks: ZERO, sqrtPriceX96: 2n * Q96 })],
      state,
    );
    const pool = state.pools.get(id)!;
    expect(pool.tokenIsCurrency0).toBe(false);
    expect(pool.origin).toBe("Uniswap");
    expect(pool.priceQuote).toBeCloseTo(0.25, 9);
  });

  it("skips native currency: no ERC-20 contract to index", () => {
    const state = emptyState();
    const id = "0x" + "44".repeat(32);
    const result = foldEvents([initEvent({ poolId: id, currency0: ZERO, currency1: NVDA })], state);
    expect(state.pools.has(id)).toBe(false);
    expect(state.tokens.has(ZERO)).toBe(false);
    expect(result.newTokens).not.toContain(ZERO);
  });

  // Uses the first entry of the real generated config/token-denylist.json, so this exercises
  // the actual production data, same as the ported test.
  it("creates no Pool or Token for a denylisted token paired with USDG", () => {
    const state = emptyState();
    const denylisted = denylist[0]!.address;
    const id = "0x" + "88".repeat(32);
    const result = foldEvents(
      [initEvent({ poolId: id, currency0: denylisted, currency1: USDG, hooks: ZERO })],
      state,
    );
    expect(state.pools.has(id)).toBe(false);
    expect(state.tokens.has(denylisted)).toBe(false);
    expect(result.newTokens).not.toContain(denylisted);
  });

  it("treats WYFI as a quote and pairs it with a non-quote token as that token's pool", () => {
    const state = emptyState();
    const id = "0x" + "99".repeat(32);
    const result = foldEvents(
      [initEvent({ poolId: id, currency0: OTHER_TOKEN, currency1: WYFI, hooks: ZERO, fee: 3000 })],
      state,
    );
    const pool = state.pools.get(id)!;
    expect(pool.tokenId).toBe(OTHER_TOKEN);
    expect(pool.quoteId).toBe(WYFI);
    expect(pool.tokenIsCurrency0).toBe(true);
    expect(result.newTokens).toContain(OTHER_TOKEN);
  });

  // New: replay safety. Not in the original file (Envio never replays a log within one run);
  // the fold can be handed the same block range twice (a restarted cron, an overlapping
  // catch-up window), so an Initialize for a pool id already tracked must be a pure no-op.
  it("ignores a replayed Initialize for a pool id already tracked", () => {
    const state = emptyState();
    foldEvents([initEvent()], state);
    const poolBefore = state.pools.get(POOL);
    const tokenBefore = state.tokens.get(AI);
    const second = foldEvents([initEvent()], state);
    expect(state.pools.get(POOL)).toEqual(poolBefore);
    expect(state.tokens.get(AI)).toEqual(tokenBefore);
    expect(second.pools).toEqual([]);
    expect(second.tokens).toEqual([]);
    expect(second.newTokens).toEqual([]);
  });
});

describe("Swap", () => {
  it("records a buy, updates price, candles and TVL net of the swap fee", () => {
    const state = emptyState();
    // swapper receives 1000 AI (amount0 positive), pays 1 NVDA (amount1 negative); price after = 4
    const result = foldEvents(
      [initEvent({}, 100), swapEvent(1000n * 10n ** 18n, -(10n ** 18n), 2n * Q96, 101)],
      state,
    );
    const pool = state.pools.get(POOL)!;
    expect(pool.swapCount).toBe(1);
    expect(pool.priceQuote).toBeCloseTo(4, 9);
    expect(pool.tvlToken).toBe(-(1000n * 10n ** 18n));
    // Paid side nets out the 0.3% swap fee: 1e18 * (1_000_000 - 3000) / 1_000_000 = 997n * 10n ** 15n.
    expect(pool.tvlQuote).toBe(997n * 10n ** 15n);
    expect(pool.volumeQuoteAllTime).toBeCloseTo(1, 9);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.side).toBe("buy");
    expect(result.trades[0]!.amountToken).toBeCloseTo(1000, 9);
    expect(result.trades[0]!.priceQuote).toBeCloseTo(0.001, 12); // execution price 1 NVDA / 1000 AI
    expect(result.trades[0]!.wallet).toBe(WALLET);
    // Five candles per swap: one bucket per interval.
    expect(result.candles).toHaveLength(5);
    const m1 = result.candles.find((c) => c.interval === "m1")!;
    expect(m1.open).toBeCloseTo(1, 9); // previous pool price (gapless)
    expect(m1.close).toBeCloseTo(4, 9);
    expect(m1.high).toBeCloseTo(4, 9);
    expect(m1.low).toBeCloseTo(1, 9);
    expect(m1.volumeQuote).toBeCloseTo(1, 9);
    expect(m1.trades).toBe(1);
  });

  it("ignores zero-amount swaps", () => {
    const state = emptyState();
    const result = foldEvents([initEvent({}, 100), swapEvent(0n, 0n, Q96, 101)], state);
    const pool = state.pools.get(POOL)!;
    expect(pool.swapCount).toBe(0);
    expect(pool.tvlToken).toBe(0n);
    expect(pool.tvlQuote).toBe(0n);
    expect(result.trades).toHaveLength(0);
    expect(result.candles).toHaveLength(0);
  });

  it("aggregates two swaps in one bucket and opens the next bucket at the previous close", () => {
    const state = emptyState();
    const result = foldEvents(
      [
        initEvent({}, 100),
        swapEvent(10n ** 18n, -(10n ** 18n), 2n * Q96, 101),
        swapEvent(-(10n ** 18n), 10n ** 18n, Q96, 101), // same block: same buckets
        swapEvent(10n ** 18n, -(10n ** 18n), 3n * Q96, 200), // 99 minutes later: new m1 bucket
      ],
      state,
    );
    const candles = result.candles.filter((c) => c.interval === "m1").sort((a, b) => a.t - b.t);
    expect(candles).toHaveLength(2);
    expect(candles[0]!.trades).toBe(2);
    expect(candles[0]!.high).toBeCloseTo(4, 9);
    expect(candles[0]!.close).toBeCloseTo(1, 9);
    expect(candles[1]!.open).toBeCloseTo(1, 9); // gapless: opens at the previous bucket's close
    expect(candles[1]!.close).toBeCloseTo(9, 9);
  });

  it("ignores swaps on untracked pools and counts them", () => {
    const state = emptyState();
    const result = foldEvents([swapEvent(1n, -1n, Q96, 5)], state);
    expect(result.trades).toHaveLength(0);
    expect(result.ignoredPools).toBe(1);
  });

  it("sells on a pool where the token is currency1, excluding the fee from tvl", () => {
    const state = emptyState();
    const id = "0x" + "77".repeat(32);
    const result = foldEvents(
      [
        // token price 1 USDG at Initialize: ratio^2 = 1e12 and 10^(6-18) cancel.
        initEvent({ poolId: id, currency0: USDG, currency1: OTHER_TOKEN, hooks: ZERO, sqrtPriceX96: Q96 * 1_000_000n }, 100),
        // Swapper pays 1 token (amount1 negative) and receives 2 USDG (amount0 positive), fee 1%.
        swapEvent(2_000_000n, -(10n ** 18n), Q96 * 2_000_000n, 101, { poolId: id, fee: 10000, timestamp: 1_700_000_101 }),
      ],
      state,
    );
    const pool = state.pools.get(id)!;
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.side).toBe("sell");
    expect(result.trades[0]!.amountToken).toBeCloseTo(1, 9);
    expect(result.trades[0]!.amountQuote).toBeCloseTo(2, 9);
    expect(result.trades[0]!.priceQuote).toBeCloseTo(2, 9); // execution price: 2 USDG / 1 token
    expect(pool.priceQuote).toBeCloseTo(0.25, 9); // post-swap pool price at the chosen sqrtPriceX96
    expect(pool.tvlQuote).toBe(-2_000_000n); // received side: subtracted in full
    // Paid side nets out the 1% fee: 10n**18n * (1_000_000n - 10_000n) / 1_000_000n.
    expect(pool.tvlToken).toBe((10n ** 18n * 990_000n) / 1_000_000n);
  });

  it("rounds a non-divisible fee toward zero, in the pool's favor", () => {
    const state = emptyState();
    foldEvents(
      [
        initEvent({}, 100),
        // Swapper pays 1001 wei of NVDA (quote) and receives 1 wei of AI (token), fee 0.3%.
        swapEvent(1n, -1001n, Q96, 101, { fee: 3000, timestamp: 1_700_000_101 }),
      ],
      state,
    );
    const pool = state.pools.get(POOL)!;
    // 1001n * (1_000_000n - 3000n) = 997_997_000n; BigInt division truncates toward zero:
    // -997_997_000n / 1_000_000n = -997n, so tvlQuote = 0n - (-997n) = 997n exactly.
    expect(pool.tvlQuote).toBe(997n);
    expect(pool.tvlToken).toBe(-1n); // received side: subtracted in full
  });

  it("throws when a Swap has no transaction sender", () => {
    const state = seededState();
    expect(() =>
      foldEvents([swapEvent(1000n * 10n ** 18n, -(10n ** 18n), 2n * Q96, 1, { txFrom: null })], state),
    ).toThrow();
  });

  it("updates tvlQuote while leaving a null tvlToken untouched (independent per-side null handling)", () => {
    const state = seededState({ tvlToken: null, tvlQuote: 222n });
    foldEvents([swapEvent(1000n * 10n ** 18n, -(10n ** 18n), 2n * Q96, 1, { timestamp: 1000 })], state);
    const pool = state.pools.get(POOL)!;
    expect(pool.tvlToken).toBeNull();
    expect(pool.tvlQuote).toBe(222n + 997n * 10n ** 15n);
  });
});

describe("recomputePrimaryPool", () => {
  it("switches the primary pool to the one with higher USD tvl", () => {
    const state = emptyState();
    // Simulates what the store would have loaded: USDG priced at 1, NVDA unpriced (no
    // Chainlink feed simulated). The fold no longer seeds Quote/QuotePrice rows itself
    // (that was the old indexer's ensureQuote, which this port deliberately drops).
    state.quotes.set(USDG, { id: USDG, decimals: 6, usdPrice: 1 });
    const usdgPoolId = "0x" + "55".repeat(32);
    foldEvents(
      [
        initEvent({}, 100), // AI/NVDA, Doppler hook
        initEvent({ poolId: usdgPoolId, currency0: AI, currency1: USDG, hooks: ZERO }, 101), // AI/USDG, hookless
      ],
      state,
    );
    let token = state.tokens.get(AI)!;
    expect(token.poolCount).toBe(2);
    // Both pools have 0 tvl and 0 swaps, so the tiebreak falls to createdAt: the NVDA pool is earliest.
    expect(token.primaryPoolId).toBe(POOL);

    foldEvents([modifyLiquidityEvent(usdgPoolId, 10n ** 18n, 102)], state);
    token = state.tokens.get(AI)!;
    // USDG is priced at 1, so the USDG pool now has a nonzero USD tvl while the NVDA pool
    // still has none, and it takes over.
    expect(token.primaryPoolId).toBe(usdgPoolId);
    expect(token.origin).toBe("Uniswap");

    // Exercises the Swap handler's own poolCount > 1 branch: a swap on the now-non-primary
    // NVDA pool must not disturb the primary pool, since NVDA still has no USD price.
    foldEvents([swapEvent(1000n * 10n ** 18n, -(10n ** 18n), 2n * Q96, 103)], state);
    const nvdaPool = state.pools.get(POOL)!;
    expect(nvdaPool.swapCount).toBe(1);
    token = state.tokens.get(AI)!;
    expect(token.primaryPoolId).toBe(usdgPoolId);
  });
});

describe("ModifyLiquidity", () => {
  it("orients tvl by currency and leaves exact rounding dust after a full add and remove", () => {
    const state = emptyState();
    const id = "0x" + "66".repeat(32);
    // A price far from 1:1 makes amount0 and amount1 wildly different magnitudes, so this
    // test fails if tokenAmt/quoteAmt were ever swapped in the handler.
    const price = Q96 * 1_000_000n;
    foldEvents(
      [initEvent({ poolId: id, currency0: USDG, currency1: OTHER_TOKEN, hooks: ZERO, sqrtPriceX96: price }, 100)],
      state,
    );
    const { amount0: added0, amount1: added1 } = amountsForLiquidityDelta(price, -887272, 887272, 10n ** 18n);
    expect(added0).toBe(1000000000000n);
    expect(added1).toBe(1000000000000000000000000n);

    const addResult = foldEvents([modifyLiquidityEvent(id, 10n ** 18n, 101)], state);
    const afterAdd = state.pools.get(id)!;
    expect(afterAdd.tvlToken).toBe(added1); // token is currency1
    expect(afterAdd.tvlQuote).toBe(added0); // quote (USDG) is currency0
    // NIT-C (round-3 re-review): an ordinary, successful ModifyLiquidity must leave
    // skippedLiquidity at 0 — a mutation that increments it unconditionally must fail here.
    expect(addResult.skippedLiquidity).toBe(0);

    const { amount0: removed0, amount1: removed1 } = amountsForLiquidityDelta(price, -887272, 887272, -(10n ** 18n));
    const removeResult = foldEvents([modifyLiquidityEvent(id, -(10n ** 18n), 102)], state);
    const afterRemove = state.pools.get(id)!;
    // Adds round up and removes round down, so a few wei of dust remain instead of exactly 0.
    expect(afterRemove.tvlToken).toBe(added1 + removed1);
    expect(afterRemove.tvlQuote).toBe(added0 + removed0);
    expect(afterRemove.tvlToken).toBe(1n);
    expect(removeResult.skippedLiquidity).toBe(0);
    expect(afterRemove.tvlQuote).toBe(1n);
  });

  // Ruling (Fix round 1): ignoredPools counts an unknown pool for ModifyLiquidity too, since
  // the field means "events naming a pool nothing tracks" and the runner reports it as a
  // health signal — not just Swap's unknown-pool case.
  it("ignores ModifyLiquidity on an untracked pool and counts it in ignoredPools", () => {
    const state = emptyState();
    const result = foldEvents([modifyLiquidityEvent("0x" + "aa".repeat(32), 10n ** 18n, 5)], state);
    expect(result.pools).toEqual([]);
    expect(result.ignoredPools).toBe(1);
  });

  // The null-TVL guard is a DIFFERENT condition from an unknown pool (this pool is tracked,
  // just without TVL history), so it must NOT feed ignoredPools.
  it("ignores ModifyLiquidity when the pool's tvl was never tracked (null), without counting it in ignoredPools", () => {
    const state = seededState({ tvlToken: null, tvlQuote: null });
    const result = foldEvents([modifyLiquidityEvent(POOL, 10n ** 18n, 1)], state);
    expect(result.pools).toEqual([]);
    expect(result.ignoredPools).toBe(0);
    const pool = state.pools.get(POOL)!;
    expect(pool.tvlToken).toBeNull();
    expect(pool.tvlQuote).toBeNull();
  });

  it("uses the price-derived sqrtPriceX96 when the pool's own is null", () => {
    const state = seededState({ sqrtPriceX96: null, priceQuote: 4, tvlToken: 0n, tvlQuote: 0n });
    // Pool fixture: tokenIsCurrency0 = true, AI (18 dec) / NVDA (18 dec).
    const derivedSqrt = sqrtPriceX96FromPrice(4, 18, 18, true);
    const expected = amountsForLiquidityDelta(derivedSqrt, -887272, 887272, 10n ** 18n);
    foldEvents([modifyLiquidityEvent(POOL, 10n ** 18n, 1)], state);
    const pool = state.pools.get(POOL)!;
    expect(pool.tvlToken).toBe(expected.amount0); // tokenIsCurrency0 -> tokenAmt = amount0
    expect(pool.tvlQuote).toBe(expected.amount1);
  });
});

describe("baselineAt gating", () => {
  it("a Swap at or before baselineAt still prices the pool, writes its trade and candles, but freezes totals", () => {
    const baselineAt = 1_700_000_500;
    const state = seededState({
      baselineAt,
      swapCount: 5,
      volumeQuoteAllTime: 123,
      tvlToken: 111n,
      tvlQuote: 222n,
      lastSwapAt: 1_700_000_000,
      priceQuote: 1,
      sqrtPriceX96: Q96,
    });
    const result = foldEvents(
      [swapEvent(1000n * 10n ** 18n, -(10n ** 18n), 2n * Q96, 1, { timestamp: baselineAt })],
      state,
    );
    const pool = state.pools.get(POOL)!;
    // Always updated, even at the baseline:
    expect(result.trades).toHaveLength(1);
    expect(pool.priceQuote).toBeCloseTo(4, 9);
    expect(pool.sqrtPriceX96).toBe(2n * Q96);
    expect(pool.lastSwapAt).toBe(baselineAt);
    expect(result.candles).toHaveLength(5);
    // Frozen for event.timestamp <= baselineAt:
    expect(pool.swapCount).toBe(5);
    expect(pool.volumeQuoteAllTime).toBe(123);
    expect(pool.tvlToken).toBe(111n);
    expect(pool.tvlQuote).toBe(222n);
  });

  it("a Swap after baselineAt updates totals normally", () => {
    const baselineAt = 1_700_000_500;
    const state = seededState({ baselineAt, swapCount: 5, volumeQuoteAllTime: 123, tvlToken: 111n, tvlQuote: 222n });
    foldEvents(
      [swapEvent(1000n * 10n ** 18n, -(10n ** 18n), 2n * Q96, 1, { timestamp: baselineAt + 1 })],
      state,
    );
    const pool = state.pools.get(POOL)!;
    expect(pool.swapCount).toBe(6);
    expect(pool.volumeQuoteAllTime).toBeCloseTo(124, 9);
    expect(pool.tvlToken).toBe(111n - 1000n * 10n ** 18n);
    expect(pool.tvlQuote).toBe(222n + 997n * 10n ** 15n);
  });

  it("a ModifyLiquidity at or before baselineAt is ignored entirely", () => {
    const baselineAt = 1_700_000_500;
    const state = seededState({ baselineAt, tvlToken: 111n, tvlQuote: 222n });
    const result = foldEvents([modifyLiquidityEvent(POOL, 10n ** 18n, 1, { timestamp: baselineAt })], state);
    expect(result.pools).toEqual([]);
    const pool = state.pools.get(POOL)!;
    expect(pool.tvlToken).toBe(111n);
    expect(pool.tvlQuote).toBe(222n);
  });

  it("a ModifyLiquidity after baselineAt applies normally", () => {
    const baselineAt = 1_700_000_500;
    const state = seededState({ baselineAt, tvlToken: 111n, tvlQuote: 222n });
    const result = foldEvents([modifyLiquidityEvent(POOL, 10n ** 18n, 1, { timestamp: baselineAt + 1 })], state);
    expect(result.pools).toHaveLength(1);
    const pool = state.pools.get(POOL)!;
    expect(pool.tvlToken).not.toBe(111n);
    expect(pool.tvlQuote).not.toBe(222n);
  });
});

describe("determinism", () => {
  it("folding the same batch into two structurally equal states gives equal results", () => {
    const events = [
      initEvent({}, 100),
      swapEvent(1000n * 10n ** 18n, -(10n ** 18n), 2n * Q96, 101),
      modifyLiquidityEvent(POOL, 10n ** 18n, 102),
    ];
    const stateA = emptyState();
    const stateB = emptyState();
    const resultA = foldEvents(events, stateA);
    const resultB = foldEvents(events, stateB);
    expect(resultA).toEqual(resultB);
    expect(stateA).toEqual(stateB);
  });
});

// Fix round 1: the runner must read a new token's metadata BEFORE folding the batch that
// creates it, not after — otherwise a token created and traded in the same batch prices its
// first trade and all five of its candles with the 18-decimals fallback, permanently wrong
// for any token that isn't actually 18 decimals.
describe("newTokenCandidates", () => {
  it("returns the token address an Initialize would create", () => {
    expect(newTokenCandidates([initEvent()], emptyState())).toEqual([AI]);
  });

  it("never returns the quote side", () => {
    expect(newTokenCandidates([initEvent()], emptyState())).not.toContain(NVDA);
  });

  it("never returns a denylisted token", () => {
    const denylisted = denylist[0]!.address;
    const id = "0x" + "88".repeat(32);
    const candidates = newTokenCandidates(
      [initEvent({ poolId: id, currency0: denylisted, currency1: USDG, hooks: ZERO })],
      emptyState(),
    );
    expect(candidates).toEqual([]);
  });

  it("never returns a token already in state with metadata loaded", () => {
    const state = emptyState();
    state.tokens.set(AI, tokenFixture()); // metadataLoaded: true by default
    expect(newTokenCandidates([initEvent()], state)).toEqual([]);
  });

  it("deduplicates the same token across two Initializes in one batch, in first-seen order", () => {
    const usdgPoolId = "0x" + "55".repeat(32);
    const candidates = newTokenCandidates(
      [
        initEvent({}, 100), // AI/NVDA
        initEvent({ poolId: usdgPoolId, currency0: AI, currency1: USDG, hooks: ZERO }, 101), // AI/USDG: same token
      ],
      emptyState(),
    );
    expect(candidates).toEqual([AI]);
  });

  it("ignores a pool with both sides quotes and a native-currency pool", () => {
    const bothQuotes = "0x" + "11".repeat(32);
    const native = "0x" + "44".repeat(32);
    const candidates = newTokenCandidates(
      [
        initEvent({ poolId: bothQuotes, currency0: USDG, currency1: NVDA }),
        initEvent({ poolId: native, currency0: ZERO, currency1: NVDA }),
      ],
      emptyState(),
    );
    expect(candidates).toEqual([]);
  });
});

describe("foldEvents with pre-supplied token metadata (opts.tokenMetadata)", () => {
  it("a token created and traded in the same batch is priced with the supplied decimals, not the 18-decimals fallback", () => {
    const events = [
      initEvent({}, 100),
      // raw amount0 = 2_000_000n: 2 tokens at 6 decimals, or 2e-12 tokens at the 18-decimals fallback.
      swapEvent(2_000_000n, -(10n ** 18n), 2n * Q96, 101),
    ];

    const stateWithFallback = emptyState();
    expect(newTokenCandidates(events, stateWithFallback)).toEqual([AI]); // what the runner would read metadata for
    const fallbackResult = foldEvents(events, stateWithFallback);

    const stateWithMetadata = emptyState();
    const tokenMetadata = new Map([[AI, { symbol: "AI", name: "AI Token", decimals: 6 }]]);
    const metadataResult = foldEvents(events, stateWithMetadata, { tokenMetadata });

    const tokenWithMetadata = stateWithMetadata.tokens.get(AI)!;
    expect(tokenWithMetadata.decimals).toBe(6);
    expect(tokenWithMetadata.symbol).toBe("AI");
    expect(tokenWithMetadata.name).toBe("AI Token");
    expect(tokenWithMetadata.metadataLoaded).toBe(true);

    const tokenWithFallback = stateWithFallback.tokens.get(AI)!;
    expect(tokenWithFallback.decimals).toBe(18);
    expect(tokenWithFallback.metadataLoaded).toBe(false);

    // The trade amount differs by 10**12 (the gap between 6 and 18 decimals) for the identical
    // raw on-chain amount — proof the supplied decimals, not the fallback, priced this trade.
    expect(fallbackResult.trades[0]!.amountToken).toBeCloseTo(2e-12, 13);
    expect(metadataResult.trades[0]!.amountToken).toBeCloseTo(2, 9);

    // Same proof for the candles this same swap folds.
    const fallbackM1 = fallbackResult.candles.find((c) => c.interval === "m1")!;
    const metadataM1 = metadataResult.candles.find((c) => c.interval === "m1")!;
    expect(fallbackM1.volumeToken).toBeCloseTo(2e-12, 13);
    expect(metadataM1.volumeToken).toBeCloseTo(2, 9);
  });

  it("keeps today's fallback metadata for a created token absent from opts.tokenMetadata", () => {
    const state = emptyState();
    foldEvents([initEvent()], state, { tokenMetadata: new Map() });
    const token = state.tokens.get(AI)!;
    expect(token.decimals).toBe(18);
    expect(token.symbol).toBe(AI.slice(0, 6));
    expect(token.name).toBe(AI);
    expect(token.metadataLoaded).toBe(false);
  });

  it("still lists the token id in newTokens even when metadata was supplied (newTokens now just means 'created in this batch')", () => {
    const state = emptyState();
    const tokenMetadata = new Map([[AI, { symbol: "AI", name: "AI Token", decimals: 6 }]]);
    const result = foldEvents([initEvent()], state, { tokenMetadata });
    expect(result.newTokens).toEqual([AI]);
  });
});

// Round-2 review, MAJOR-1: the reference re-applies metadata to an EXISTING token on every
// Initialize, and retries hourly from Swap. That repair path had no equivalent after Fix
// round 1 — metadata was only ever applied when a token was first created — so a token whose
// first read failed was pinned at 18 decimals and `metadataLoaded: false` forever, with every
// later trade, candle and the pool's own priceQuote silently wrong. These tests exercise the
// fix: newTokenCandidates also surfaces an already-known, still-unloaded token whenever this
// batch touches its pool (via ANY event kind, not only a second Initialize), and foldEvents
// applies a supplied entry for it before that same event finishes pricing anything.
describe("metadata repair for an already-known token (MAJOR-1)", () => {
  it("newTokenCandidates returns an already-known token's id when this batch's Swap touches its pool", () => {
    const state = seededState({}, { metadataLoaded: false, decimals: 18 });
    const events = [swapEvent(2_000_000n, -(10n ** 18n), 2n * Q96, 1)];
    expect(newTokenCandidates(events, state)).toEqual([AI]);
  });

  it("a swap in the same batch with supplied metadata for an already-known token produces amounts at the supplied decimals", () => {
    const state = seededState({}, { metadataLoaded: false, decimals: 18, symbol: AI.slice(0, 6), name: AI });
    const events = [swapEvent(2_000_000n, -(10n ** 18n), 2n * Q96, 1)]; // 2_000_000n raw: 2 at 6 decimals, 2e-12 at 18
    const tokenMetadata = new Map([[AI, { symbol: "AI", name: "AI Token", decimals: 6 }]]);

    const result = foldEvents(events, state, { tokenMetadata });

    const token = state.tokens.get(AI)!;
    expect(token.decimals).toBe(6);
    expect(token.symbol).toBe("AI");
    expect(token.name).toBe("AI Token");
    expect(token.metadataLoaded).toBe(true);
    expect(result.trades[0]!.amountToken).toBeCloseTo(2, 9); // supplied 6 decimals, not the stale 18
  });

  it("repairs on a ModifyLiquidity too, not only a Swap", () => {
    const state = seededState({}, { metadataLoaded: false, decimals: 18 });
    const tokenMetadata = new Map([[AI, { symbol: "AI", name: "AI Token", decimals: 6 }]]);
    foldEvents([modifyLiquidityEvent(POOL, 10n ** 18n, 1)], state, { tokenMetadata });
    const token = state.tokens.get(AI)!;
    expect(token.decimals).toBe(6);
    expect(token.metadataLoaded).toBe(true);
  });

  it("leaves an already-loaded token's metadata untouched even when a (mistaken) entry is supplied for it", () => {
    const state = seededState({}, { metadataLoaded: true, decimals: 18, symbol: "REAL", name: "Real Token" });
    const tokenMetadata = new Map([[AI, { symbol: "WRONG", name: "Wrong Token", decimals: 6 }]]);
    foldEvents([swapEvent(2_000_000n, -(10n ** 18n), 2n * Q96, 1)], state, { tokenMetadata });
    const token = state.tokens.get(AI)!;
    expect(token.decimals).toBe(18);
    expect(token.symbol).toBe("REAL");
  });
});

// Round-2 review, BLOCKER: measured against the production database, not theoretical. Every
// one of the 238,391 pools copied from the old indexer has a null sqrtPriceX96, so every
// ModifyLiquidity on one derives a sqrt from pool.priceQuote instead. 2,349 copied pools carry
// a garbage priceQuote around 3.40256786836388e50 (18/18 decimals derives a 55-digit sqrt,
// out of amountsForLiquidityDelta's valid range) and 532 carry one below 1e-30 — one of the
// over-large-price pools has 101,092 swaps, so this is not a dead row. A throw here used to
// abort the whole batch; since rows and the cursor move in one transaction, that would wedge
// the cron and the catch-up on that block permanently.
describe("skippedLiquidity: a legacy pool with an underivable price never wedges the batch", () => {
  it("skips just the one ModifyLiquidity, counts it, leaves that pool's TVL untouched, and still applies the rest of the batch", () => {
    const state = seededState({ sqrtPriceX96: null, priceQuote: 3.40256786836388e50, tvlToken: 5n, tvlQuote: 7n });
    const events = [
      modifyLiquidityEvent(POOL, 10n ** 18n, 1), // underivable: must be skipped, not thrown
      swapEvent(1000n * 10n ** 18n, -(10n ** 18n), 2n * Q96, 2), // rest of the batch: must still apply
    ];

    const result = foldEvents(events, state); // must not throw: the batch completes

    expect(result.skippedLiquidity).toBe(1);
    expect(result.trades).toHaveLength(1); // the swap after the skipped event still ran
    const pool = state.pools.get(POOL)!;
    // TVL reflects only the swap (starting 5n/7n, minus/plus its principal): the skipped
    // ModifyLiquidity contributed nothing at all, not even a partial or garbage amount.
    expect(pool.tvlToken).toBe(5n - 1000n * 10n ** 18n);
    expect(pool.tvlQuote).toBe(7n + 997n * 10n ** 15n);
  });

  it("skips a price below MIN_SQRT_RATIO too, not only an out-of-range-high one", () => {
    // 18-decimals token against a 6-decimals quote (USDG): sqrtPriceX96FromPrice(1e-35, 18, 6,
    // true) derives 250541, below MIN_SQRT_RATIO (4295128739n) — verified with the ported
    // math directly. At 18/18 decimals the same priceQuote derives 250541448375, which is
    // NOT out of range, so the quote's decimals matter for reproducing this one.
    const state = seededState({ sqrtPriceX96: null, priceQuote: 1e-35, tvlToken: 0n, tvlQuote: 0n, quoteId: USDG });
    const result = foldEvents([modifyLiquidityEvent(POOL, 10n ** 18n, 1)], state);
    expect(result.skippedLiquidity).toBe(1);
    expect(result.pools).toEqual([]);
  });

  // Fix round 4 (.superpowers/sdd/2026-09-21-chain-reader/missing-token-report.md): a missing
  // token used to throw here, which — since applyFold writes rows and the cursor in one
  // transaction — would wedge the whole batch's transaction and, on a replay, the cron/catch-up
  // permanently. It is now a different kind of "ignored" from an underivable legacy price: still
  // distinguished from skippedLiquidity (NIT-D's original concern — a regression that miscounts
  // it there would hide a real signal), but skipped rather than thrown either way.
  it("skips rather than throws when the pool's token is missing, counting it as ignoredPools, not skippedLiquidity", () => {
    const state = seededState({ sqrtPriceX96: null, priceQuote: 3.40256786836388e50 });
    state.tokens.delete(AI); // break the pool -> token invariant on purpose
    const result = foldEvents([modifyLiquidityEvent(POOL, 10n ** 18n, 1)], state);
    expect(result.ignoredPools).toBe(1);
    expect(result.skippedLiquidity).toBe(0);
    expect(result.pools).toEqual([]);
  });

  // Round-3 re-review, MINOR-A: the catch in tryDeriveLiquidityAmounts must apply ONLY when the
  // sqrt is DERIVED (pool.sqrtPriceX96 === null). A pool with a REAL, chain-captured sqrt is
  // always in range, so the only way amountsForLiquidityDelta can throw for it is a bad tick
  // range — and ticks come straight from the decoded log, so that throw means a decoder or
  // sign-extension bug, not stale legacy data. It must stay loud, not get silently counted as
  // skippedLiquidity (which would let TVL quietly stop moving with no signal why).
  it("still throws for a pool with a REAL stored sqrtPriceX96 and an inverted tick range (a decoder bug, not stale data) — not counted as skipped", () => {
    const state = seededState({ sqrtPriceX96: Q96, tvlToken: 0n, tvlQuote: 0n }); // real sqrt, not derived
    const invertedTicks = modifyLiquidityEvent(POOL, 10n ** 18n, 1, { tickLower: 100, tickUpper: -100 });
    expect(() => foldEvents([invertedTicks], state)).toThrow(/tickLower must be less than tickUpper/);
  });
});

// Fix round 4, production incident: .superpowers/sdd/2026-09-21-chain-reader/missing-token-report.md.
// A torn read in the original snapshot copy left one pool with no matching token row at all — not
// merely unloaded metadata, an absent map entry. loadFoldState (store.ts) now closes this gap by
// synthesizing a fallback TokenState (see store.test.ts), which should make the branch below
// unreachable in practice; it stays as a defensive skip (never a throw) precisely so one future bad
// row, of any origin, can never wedge applyFold's one-transaction batch and stop the whole reader.
describe("a pool whose token is entirely missing from state (defensive: should be unreachable after loadFoldState's fix)", () => {
  it("skips a Swap and counts it in ignoredPools rather than throwing", () => {
    const state = seededState();
    state.tokens.delete(AI); // break the pool -> token invariant on purpose
    const result = foldEvents([swapEvent(1000n * 10n ** 18n, -(10n ** 18n), 2n * Q96, 1)], state);
    expect(result.ignoredPools).toBe(1);
    expect(result.trades).toHaveLength(0);
    expect(result.pools).toEqual([]); // the pool itself is untouched: the event never priced it
    const pool = state.pools.get(POOL)!;
    expect(pool.swapCount).toBe(0);
  });

  it("skips a ModifyLiquidity and counts it in ignoredPools rather than throwing", () => {
    const state = seededState();
    state.tokens.delete(AI); // break the pool -> token invariant on purpose
    const result = foldEvents([modifyLiquidityEvent(POOL, 10n ** 18n, 1)], state);
    expect(result.ignoredPools).toBe(1);
    expect(result.pools).toEqual([]); // the pool itself is untouched
    const pool = state.pools.get(POOL)!;
    expect(pool.tvlToken).toBe(0n); // seededState/poolFixture default: unchanged
  });
});

describe("lastSwapAt never moves backwards (MINOR-3)", () => {
  it("keeps a later existing lastSwapAt when a swap's own timestamp is earlier", () => {
    const baselineAt = 1_700_000_500;
    const state = seededState({ baselineAt, lastSwapAt: baselineAt + 1000 });
    foldEvents([swapEvent(1000n * 10n ** 18n, -(10n ** 18n), 2n * Q96, 1, { timestamp: baselineAt })], state);
    const pool = state.pools.get(POOL)!;
    expect(pool.lastSwapAt).toBe(baselineAt + 1000);
  });
});
