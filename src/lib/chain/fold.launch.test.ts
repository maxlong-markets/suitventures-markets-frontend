import { describe, expect, it } from "vitest";
import { foldEvents, newTokenCandidates } from "./fold";
import type {
  FoldState, InitializeEvent, LaunchFeesEvent, LaunchedEvent, PayoutChangedEvent, PoolState, SwapEvent, TokenState,
} from "./types";

// USDG is a real quotes.json row, so classify() treats it as the quote side exactly as production does.
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TOKEN = "0x" + "7a".repeat(20);
const SV_POOL = "0x" + "5a".repeat(32);
const OTHER_POOL = "0x" + "6b".repeat(32);
const ZERO = "0x" + "0".repeat(40);
const CREATOR = "0x" + "c1".repeat(20);
const PAYOUT = "0x" + "c2".repeat(20);
const TX = "0x" + "ab".repeat(32);
const Q96 = 2n ** 96n;
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

function emptyState(): FoldState {
  return { pools: new Map(), tokens: new Map(), quotes: new Map(), candles: new Map(), poolsByToken: new Map() };
}
const at = (block: number, logIndex: number) => ({ block, logIndex, timestamp: 1_790_000_000 + block, txHash: TX, txFrom: CREATOR });

function init(o: Partial<InitializeEvent> = {}): InitializeEvent {
  return {
    kind: "initialize", ...at(100, 0), poolId: SV_POOL, currency0: USDG, currency1: TOKEN, fee: 10_000, tickSpacing: 200,
    hooks: ZERO, sqrtPriceX96: Q96, tick: 0, ...o,
  };
}
function launched(o: Partial<LaunchedEvent> = {}): LaunchedEvent {
  return {
    kind: "launched", ...at(100, 3), token: TOKEN, creator: CREATOR, quote: USDG, poolId: SV_POOL, payout: CREATOR, hook: ZERO,
    tokenIsCurrency0: false, openTick: 398_400, openingValuation: 4_995_430_000n, liquidity: 2_240_000_000_000_000_000n,
    tokensInPool: 10n ** 27n - 300n, firstBuyIn: 0n, firstBuyTokens: 0n, routerFee: 0n, creationFee: 0n, creatorShareBps: 7000,
    name: "Tailor's Chalk", symbol: "CHALK", metadataUri: `ipfs://${CID}`, ...o,
  };
}
function fees(o: Partial<LaunchFeesEvent> = {}): LaunchFeesEvent {
  return {
    kind: "launchFees", ...at(160, 2), token: TOKEN, payout: CREATOR, tokenFees: 1000n, quoteFees: 10_000_000n,
    tokenToPayout: 700n, quoteToPayout: 7_000_000n, ...o,
  };
}
function payoutChanged(o: Partial<PayoutChangedEvent> = {}): PayoutChangedEvent {
  return { kind: "payoutChanged", ...at(170, 1), token: TOKEN, previous: CREATOR, payout: PAYOUT, ...o };
}
function pool(o: Partial<PoolState> = {}): PoolState {
  return {
    id: SV_POOL, tokenId: TOKEN, quoteId: USDG, tokenIsCurrency0: false, hooks: ZERO, fee: 10_000, tickSpacing: 200, origin: "SV",
    createdAt: 1_790_000_100, priceQuote: 0.000005, sqrtPriceX96: Q96, tvlToken: 0n, tvlQuote: 0n, swapCount: 0, lastSwapAt: null,
    volumeQuoteAllTime: 0, baselineAt: 0, ...o,
  };
}
function token(o: Partial<TokenState> = {}): TokenState {
  return {
    id: TOKEN, address: TOKEN, symbol: "CHALK", name: "Tailor's Chalk", decimals: 18, poolCount: 1, origin: "SV",
    primaryPoolId: SV_POOL, createdAt: 1_790_000_100, metadataLoaded: true, ...o,
  };
}

describe("foldEvents: the launchpad (instant launchpad design, section 5.2)", () => {
  it("labels the pool and the token SV when Initialize and Launched arrive in one batch, and records one launch row", () => {
    const state = emptyState();
    const result = foldEvents([init(), launched()], state);
    expect(state.pools.get(SV_POOL)?.origin).toBe("SV");
    expect(state.tokens.get(TOKEN)).toMatchObject({ origin: "SV", primaryPoolId: SV_POOL });
    expect(result.launches).toEqual([
      {
        tokenId: TOKEN, poolId: SV_POOL, quoteId: USDG, creator: CREATOR, payout: CREATOR, hook: ZERO, tokenIsCurrency0: false,
        creatorShareBps: 7000, openTick: 398_400, openingValuation: 4_995_430_000n, liquidity: 2_240_000_000_000_000_000n,
        tokensInPool: 10n ** 27n - 300n, firstBuyIn: 0n, firstBuyTokens: 0n, routerFee: 0n, creationFee: 0n,
        name: "Tailor's Chalk", symbol: "CHALK", metadataUri: `ipfs://${CID}`, metadataCid: CID,
        block: 100, logIndex: 3, txHash: TX, timestamp: 1_790_000_100,
      },
    ]);
    expect(result.launchEvents).toBe(1);
    expect(result.newTokens).toEqual([TOKEN]);
  });

  it("relabels a pool whose Initialize fell into an earlier batch, and its token, SV", () => {
    const state = emptyState();
    state.pools.set(SV_POOL, pool({ origin: "Uniswap" }));
    state.tokens.set(TOKEN, token({ origin: "Uniswap" }));
    state.poolsByToken.set(TOKEN, [SV_POOL]);
    const result = foldEvents([launched()], state);
    expect(result.pools.map((p) => [p.id, p.origin])).toEqual([[SV_POOL, "SV"]]);
    expect(result.tokens.map((t) => [t.id, t.origin])).toEqual([[TOKEN, "SV"]]);
  });

  it("keeps the token SV when a later second pool with more quote money becomes primary (D43 still picks the primary)", () => {
    const state = emptyState();
    state.quotes.set(USDG, { id: USDG, decimals: 6, usdPrice: 1 });
    state.pools.set(SV_POOL, pool());
    state.pools.set(OTHER_POOL, pool({ id: OTHER_POOL, origin: "Uniswap", tvlQuote: 1_000_000_000n, tvlToken: 10n ** 24n, createdAt: 1_790_000_900 }));
    state.tokens.set(TOKEN, token({ poolCount: 2 }));
    state.poolsByToken.set(TOKEN, [SV_POOL, OTHER_POOL]);
    const swap: SwapEvent = {
      kind: "swap", ...at(200, 0), poolId: OTHER_POOL, amount0: -1_000_000n, amount1: 10n ** 18n, sqrtPriceX96: Q96,
      liquidity: 10n ** 18n, tick: 0, fee: 3000,
    };
    const result = foldEvents([swap], state);
    expect(state.tokens.get(TOKEN)).toMatchObject({ primaryPoolId: OTHER_POOL, origin: "SV" });
    expect(result.tokens.map((t) => t.id)).toEqual([TOKEN]);
  });

  it("appends one fee row per FeesCollected, never summed, with the platform share as total minus payout", () => {
    const result = foldEvents([fees(), fees({ ...at(161, 0), tokenFees: 10n, quoteFees: 0n, tokenToPayout: 7n, quoteToPayout: 0n })], emptyState());
    expect(result.launchFees).toEqual([
      { txHash: TX, logIndex: 2, tokenId: TOKEN, payout: CREATOR, tokenPayout: 700n, tokenPlatform: 300n, quotePayout: 7_000_000n, quotePlatform: 3_000_000n, timestamp: 1_790_000_160, block: 160 },
      { txHash: TX, logIndex: 0, tokenId: TOKEN, payout: CREATOR, tokenPayout: 7n, tokenPlatform: 3n, quotePayout: 0n, quotePlatform: 0n, timestamp: 1_790_000_161, block: 161 },
    ]);
    expect(result.launchEvents).toBe(2);
  });

  it("keeps only the last payout change per token", () => {
    const result = foldEvents([payoutChanged(), payoutChanged({ ...at(171, 4), previous: PAYOUT, payout: CREATOR })], emptyState());
    expect(result.payouts).toEqual([{ tokenId: TOKEN, payout: CREATOR, block: 171, logIndex: 4 }]);
  });

  it("stores no metadata CID for a URI that is not exactly ipfs://<CID> (Review Focus 3)", () => {
    const https = foldEvents([launched({ metadataUri: "https://example.test/meta.json" })], emptyState());
    const withPath = foldEvents([launched({ metadataUri: `ipfs://${CID}/meta.json` })], emptyState());
    const empty = foldEvents([launched({ metadataUri: "" })], emptyState());
    expect([https, withPath, empty].map((r) => r.launches[0]!.metadataCid)).toEqual(["", "", ""]);
  });

  it("folds a batch of only fee and payout events without touching a pool, and asks for no token metadata", () => {
    const events = [fees(), payoutChanged()];
    expect(newTokenCandidates(events, emptyState())).toEqual([]);
    const result = foldEvents(events, emptyState());
    expect(result).toMatchObject({ pools: [], tokens: [], trades: [], ignoredPools: 0, launchEvents: 2 });
  });
});
