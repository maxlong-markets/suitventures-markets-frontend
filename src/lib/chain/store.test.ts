import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { bucketStart } from "@/lib/sync/ids";
import { testDb } from "@/test/db";
import { foldEvents, newTokenCandidates } from "./fold";
import type { TokenMetadataReading } from "./onchain";
import { applyFold, dueForMetadata, loadFoldState, readChainCursor, refreshTokenMetadata } from "./store";
import type {
  CandleInterval, CandleState, FoldResult, InitializeEvent, LaunchFeesEvent, LaunchFeesRow, LaunchRow, LaunchedEvent, PayoutChangedEvent,
  PoolState, SwapEvent, TokenState, TradeRow,
} from "./types";

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(() =>
  db.exec(
    "delete from market.quotes; delete from market.tokens; delete from market.pools; delete from market.swaps; delete from market.candles; delete from market.sync_state; delete from market.launches; delete from market.launch_fee_events; delete from market.launch_uploads",
  ),
);

const count = async (table: string) => Number((await db.query<{ n: unknown }>(`select count(*) as n from market.${table}`))[0].n);

// Rows in the shape the fold produces. Ids are lowercase like the indexer's, following src/lib/sync/testRows.ts's conventions.
const hex = (n: number, digits: number) => "0x" + n.toString(16).padStart(digits, "0");
const addr = (n: number) => hex(n, 40);
const poolId = (n: number) => hex(n, 64);
const txHash = (n: number) => hex(n, 64);

const T0 = 1_789_000_000;
const QUOTE = addr(0xa1);
const TOKEN_A = addr(0xb1);
const TOKEN_B = addr(0xb2);
const POOL_A = poolId(0x11);
const POOL_B = poolId(0x12);
const WALLET = addr(0xc1);

function pool(o: Partial<PoolState> = {}): PoolState {
  return {
    id: POOL_A, tokenId: TOKEN_A, quoteId: QUOTE, tokenIsCurrency0: true, hooks: addr(0), fee: 3000, tickSpacing: 60,
    origin: "LONG", createdAt: T0, priceQuote: 0.000866, sqrtPriceX96: 123456789012345678901234567890n,
    tvlToken: 1_000_000_000_000_000_000_000n, tvlQuote: 500_000_000_000_000_000n, swapCount: 3, lastSwapAt: T0 + 500,
    volumeQuoteAllTime: 12.5, baselineAt: 0, ...o,
  };
}
function token(o: Partial<TokenState> = {}): TokenState {
  return {
    id: TOKEN_A, address: TOKEN_A, symbol: "AI", name: "Artificial Inu", decimals: 18, poolCount: 1, origin: "LONG",
    primaryPoolId: POOL_A, createdAt: T0, metadataLoaded: true, ...o,
  };
}
function candle(o: Partial<CandleState> = {}): CandleState {
  const interval = o.interval ?? "m1";
  return {
    poolId: POOL_A, interval, t: bucketStart(T0 + 500, interval), open: 0.0008, high: 0.0009, low: 0.0007,
    close: 0.000866, volumeQuote: 1.2, volumeToken: 1500, trades: 2, ...o,
  };
}
function trade(o: Partial<TradeRow> = {}): TradeRow {
  const tx = o.txHash ?? txHash(1);
  const logIndex = o.logIndex ?? 0;
  return {
    id: `${tx}-${logIndex}`, poolId: POOL_A, tokenId: TOKEN_A, timestamp: T0 + 500, side: "buy", amountToken: 1000,
    amountQuote: 0.866, priceQuote: 0.000866, wallet: WALLET, txHash: tx, logIndex, ...o,
  };
}
function swapEvent(o: Partial<SwapEvent> = {}): SwapEvent {
  return {
    kind: "swap", block: 100, logIndex: 0, timestamp: T0 + 500, txHash: txHash(1), txFrom: WALLET,
    poolId: POOL_A, amount0: -1000n, amount1: 866n, sqrtPriceX96: 123n, liquidity: 1n, tick: 0, fee: 3000, ...o,
  };
}
function initEvent(o: Partial<InitializeEvent> = {}): InitializeEvent {
  return {
    kind: "initialize", block: 200, logIndex: 0, timestamp: T0 + 2000, txHash: txHash(50), txFrom: WALLET,
    poolId: poolId(0x14), currency0: TOKEN_A, currency1: QUOTE, fee: 3000, tickSpacing: 60, hooks: addr(0),
    sqrtPriceX96: 111n, tick: 0, ...o,
  };
}
function result(o: Partial<FoldResult> = {}): FoldResult {
  return {
    pools: [pool()], tokens: [token()], candles: [candle()], trades: [trade()], newTokens: [],
    ignoredPools: 0, orphanedTokens: 0, skippedLiquidity: 0, launches: [], launchFees: [], payouts: [], launchEvents: 0, ...o,
  };
}
async function insertQuote(o: { id?: string; usdPrice?: number | null } = {}) {
  const id = o.id ?? QUOTE;
  await db.query(
    `insert into market.quotes (id, address, symbol, name, decimals, enabled, usd_price, usd_updated_at, aggregator)
     values ($1, $1, 'NVDA', 'NVIDIA', 18, true, $2, $3, $4)`,
    [id, o.usdPrice === undefined ? 182.5 : o.usdPrice, T0, addr(0xfeed)],
  );
}

/** Wraps a real Db, counting only `.query` calls (what loadFoldState issues); exact copy of everything else. */
function countingDb(inner: Db): { db: Db; total: () => number; matching: (needle: string) => number } {
  const calls: string[] = [];
  const db: Db = {
    query: async (text, params) => {
      calls.push(text);
      return inner.query(text, params);
    },
    exec: (text) => inner.exec(text),
    copy: (table, columns, rows) => inner.copy(table, columns, rows),
    tx: (fn) => inner.tx(fn),
    end: () => inner.end(),
  };
  return { db, total: () => calls.length, matching: (needle) => calls.filter((c) => c.includes(needle)).length };
}

describe("readChainCursor", () => {
  it("is 0 when the chain job has never run", async () => {
    expect(await readChainCursor(db)).toBe(0);
  });
});

describe("loadFoldState", () => {
  it("loads the pools events name, their tokens, every quote, and leaves untouched maps empty", async () => {
    await applyFold(db, result(), 100, T0);
    await insertQuote();
    const state = await loadFoldState(db, [swapEvent()]);
    expect(state.pools.get(POOL_A)).toEqual(pool());
    expect(state.tokens.get(TOKEN_A)).toEqual(token());
    expect(state.quotes.get(QUOTE)).toEqual({ id: QUOTE, decimals: 18, usdPrice: 182.5 });
    expect(state.poolsByToken.get(TOKEN_A)).toEqual([POOL_A]);
    expect(state.candles.get(`${POOL_A}-m1-${bucketStart(T0 + 500, "m1")}`)).toEqual(candle());
  });

  it("returns empty maps for an empty event batch, but still loads every quote", async () => {
    await insertQuote();
    const state = await loadFoldState(db, []);
    expect(state.pools.size).toBe(0);
    expect(state.tokens.size).toBe(0);
    expect(state.poolsByToken.size).toBe(0);
    expect(state.candles.size).toBe(0);
    expect(state.quotes.get(QUOTE)?.usdPrice).toBe(182.5);
  });

  it("loads sibling pools of a multi-pool token even when only one is named by an event", async () => {
    const poolC = poolId(0x13);
    await applyFold(
      db,
      result({
        pools: [pool({ id: POOL_B, tokenId: TOKEN_B }), pool({ id: poolC, tokenId: TOKEN_B })],
        tokens: [token({ id: TOKEN_B, address: TOKEN_B, poolCount: 2, primaryPoolId: POOL_B })],
        candles: [],
        trades: [],
      }),
      100,
      T0,
    );
    const state = await loadFoldState(db, [swapEvent({ poolId: poolC })]);
    expect(new Set(state.poolsByToken.get(TOKEN_B))).toEqual(new Set([POOL_B, poolC]));
    // The sibling POOL_B was never named by an event: proves it is loaded fully, not just listed by id.
    expect(state.pools.get(POOL_B)).toEqual(pool({ id: POOL_B, tokenId: TOKEN_B }));
    expect(state.pools.get(poolC)).toEqual(pool({ id: poolC, tokenId: TOKEN_B }));
  });

  it("fetches candle keys with one query regardless of how many pools or intervals are touched", async () => {
    const poolC = poolId(0x13);
    await applyFold(
      db,
      result({
        pools: [pool(), pool({ id: POOL_B, tokenId: TOKEN_B }), pool({ id: poolC, tokenId: TOKEN_B })],
        tokens: [token(), token({ id: TOKEN_B, address: TOKEN_B, poolCount: 2, primaryPoolId: POOL_B })],
        candles: [candle(), candle({ poolId: POOL_B, interval: "h1" }), candle({ poolId: poolC, interval: "d1" })],
        trades: [],
      }),
      100,
      T0,
    );
    const events = [POOL_A, POOL_B, poolC].flatMap((p, i) => [
      swapEvent({ poolId: p, logIndex: i * 2, txHash: txHash(10 + i) }),
      swapEvent({ poolId: p, logIndex: i * 2 + 1, timestamp: T0 + 1000, txHash: txHash(20 + i) }),
    ]);
    const wrapped = countingDb(db);
    const state = await loadFoldState(wrapped.db, events);
    // 3 pools x up to 5 intervals x 2 distinct timestamps = up to 30 keys, fetched in one join.
    expect(wrapped.matching("market.candles")).toBe(1);
    // Bounded, not proportional to event/key count: pool-id lookup, tokens, sibling pools, quotes, candles.
    expect(wrapped.total()).toBeLessThanOrEqual(5);
    expect(state.candles.get(`${POOL_A}-m1-${bucketStart(T0 + 500, "m1")}`)).toBeDefined();
    expect(state.candles.get(`${POOL_B}-h1-${bucketStart(T0 + 500, "h1")}`)).toBeDefined();
    expect(state.candles.get(`${poolC}-d1-${bucketStart(T0 + 500, "d1")}`)).toBeDefined();
  });

  it("discovers an existing token and its sibling pools from an Initialize naming only a brand-new pool id", async () => {
    // Two existing, already-traded pools under one token with real metadata — as if copied from the old indexer.
    await applyFold(db, result({ pools: [pool(), pool({ id: POOL_B })], tokens: [token({ poolCount: 2 })], candles: [], trades: [] }), 100, T0);

    // poolC does not exist in market.pools yet: the pool-named query alone finds nothing and would miss the token.
    const poolC = poolId(0x14);
    const state = await loadFoldState(db, [initEvent({ poolId: poolC, currency0: TOKEN_A, currency1: QUOTE })]);
    expect(state.tokens.get(TOKEN_A)).toEqual(token({ poolCount: 2 }));
    expect(new Set(state.poolsByToken.get(TOKEN_A))).toEqual(new Set([POOL_A, POOL_B]));
    expect(state.pools.get(POOL_A)).toEqual(pool());
    expect(state.pools.get(POOL_B)).toEqual(pool({ id: POOL_B }));
  });

  it("discovers an existing token when it is the Initialize event's currency1, not currency0", async () => {
    // Same setup as the currency0 case above, but the new pool's event carries the token on the other side.
    // Every other test in this file puts the tracked token in currency0, so this is the only thing that would
    // catch initCurrencies dropping the currency1 term.
    await applyFold(db, result({ pools: [pool(), pool({ id: POOL_B })], tokens: [token({ poolCount: 2 })], candles: [], trades: [] }), 100, T0);

    const poolC = poolId(0x14);
    const state = await loadFoldState(db, [initEvent({ poolId: poolC, currency0: QUOTE, currency1: TOKEN_A })]);
    expect(state.tokens.get(TOKEN_A)).toEqual(token({ poolCount: 2 }));
    expect(new Set(state.poolsByToken.get(TOKEN_A))).toEqual(new Set([POOL_A, POOL_B]));
    expect(state.pools.get(POOL_A)).toEqual(pool());
    expect(state.pools.get(POOL_B)).toEqual(pool({ id: POOL_B }));
  });

  it("an Initialize currency that is a quote, or a genuinely new token, matches no row: harmless", async () => {
    await insertQuote();
    const state = await loadFoldState(db, [initEvent({ currency0: addr(0x99), currency1: QUOTE })]);
    expect(state.tokens.size).toBe(0);
    expect(state.pools.size).toBe(0);
    expect(state.quotes.get(QUOTE)?.usdPrice).toBe(182.5);
  });

  it("two Initialize events in one batch for two new pools of the same not-yet-existing token load and apply as one token", async () => {
    const tokenNew = addr(0xb3);
    const poolE = poolId(0x15);
    const poolF = poolId(0x16);

    // Nothing exists yet: loadFoldState must not crash or double-count the token named by both events.
    const before = await loadFoldState(db, [
      initEvent({ poolId: poolE, currency0: tokenNew, currency1: QUOTE }),
      initEvent({ poolId: poolF, currency0: tokenNew, currency1: QUOTE, logIndex: 1, txHash: txHash(51) }),
    ]);
    expect(before.tokens.has(tokenNew)).toBe(false);
    expect(before.pools.size).toBe(0);

    // What the fold (Task 3) would produce from those two events: one token, poolCount 2, both new pools,
    // and a primary chosen between them (here, the first).
    await applyFold(
      db,
      result({
        pools: [pool({ id: poolE, tokenId: tokenNew }), pool({ id: poolF, tokenId: tokenNew })],
        tokens: [token({ id: tokenNew, address: tokenNew, poolCount: 2, primaryPoolId: poolE })],
        candles: [],
        trades: [],
      }),
      250,
      T0 + 2000,
    );

    const after = await loadFoldState(db, [swapEvent({ poolId: poolE })]);
    expect(after.tokens.get(tokenNew)).toEqual(token({ id: tokenNew, address: tokenNew, poolCount: 2, primaryPoolId: poolE }));
    expect(new Set(after.poolsByToken.get(tokenNew))).toEqual(new Set([poolE, poolF]));
    expect(after.pools.get(poolE)).toEqual(pool({ id: poolE, tokenId: tokenNew }));
    expect(after.pools.get(poolF)).toEqual(pool({ id: poolF, tokenId: tokenNew }));
  });

  // Production incident: .superpowers/sdd/2026-09-21-chain-reader/missing-token-report.md. A
  // torn read in the original snapshot copy left one pool row with no matching market.tokens
  // row at all — there are no foreign keys, so nothing caught it. Simulated here by applying a
  // fold that writes only the pool, never its token.
  it("synthesizes a fallback TokenState for a pool whose token row is missing (a torn snapshot read)", async () => {
    await applyFold(db, result({ pools: [pool({ id: POOL_A, tokenId: TOKEN_B })], tokens: [], candles: [], trades: [] }), 100, T0);
    expect(await db.query("select id from market.tokens where id = $1", [TOKEN_B])).toEqual([]);

    const state = await loadFoldState(db, [swapEvent({ poolId: POOL_A })]);

    // The pool itself loads normally...
    expect(state.pools.get(POOL_A)).toEqual(pool({ id: POOL_A, tokenId: TOKEN_B }));
    expect(state.poolsByToken.get(TOKEN_B)).toEqual([POOL_A]);
    // ...and the gap in the map is healed with the old indexer's own never-seen-token fallback
    // (the same shape handleInitialize uses), not left empty.
    expect(state.tokens.get(TOKEN_B)).toEqual({
      id: TOKEN_B,
      address: TOKEN_B,
      symbol: TOKEN_B.slice(0, 6),
      name: TOKEN_B,
      decimals: 18,
      poolCount: 1, // the number of TOKEN_B's pools this load found
      origin: "LONG", // from the pool
      // Fix round 5 (missing-token-review.md, MINOR-1): a single-pool token matches
      // handleInitialize's final state, which always sets its one pool as primary — otherwise
      // primaryPoolId would stay null forever (recomputePrimaryPool is gated on poolCount > 1).
      primaryPoolId: POOL_A,
      createdAt: T0, // from the pool
      metadataLoaded: false,
    });
  });

  it("leaves primaryPoolId null when synthesizing a token with more than one loaded pool (self-corrects on the token's next event instead of guessing)", async () => {
    const poolC = poolId(0x13);
    await applyFold(
      db,
      result({
        pools: [pool({ id: POOL_A, tokenId: TOKEN_B }), pool({ id: poolC, tokenId: TOKEN_B })],
        tokens: [],
        candles: [],
        trades: [],
      }),
      100,
      T0,
    );

    const state = await loadFoldState(db, [swapEvent({ poolId: POOL_A })]);

    const synthesized = state.tokens.get(TOKEN_B)!;
    expect(synthesized.poolCount).toBe(2);
    expect(synthesized.primaryPoolId).toBeNull();
  });

  it("never synthesizes a token for an id no loaded pool references (an Initialize currency alone doesn't count)", async () => {
    // Same shape as the "matches no row: harmless" test above, but pinned specifically against
    // the new synthesis loop: TOKEN_B is named only by initCurrencies, no pool row loads it.
    const state = await loadFoldState(db, [initEvent({ currency0: TOKEN_B, currency1: QUOTE })]);
    expect(state.pools.size).toBe(0);
    expect(state.tokens.has(TOKEN_B)).toBe(false);
  });

  // The full self-healing chain the fix relies on: loadFoldState's synthesized fallback is
  // exactly the shape newTokenCandidates already looks for (metadataLoaded: false), so the
  // runner's normal newTokenCandidates -> read real metadata -> foldEvents -> applyFold path
  // closes the gap with no manual SQL. See missing-token-report.md for the full chain.
  it("heals end to end: synthesized fallback -> newTokenCandidates -> real metadata prices the same-batch swap -> applyFold writes the token row for real", async () => {
    await applyFold(db, result({ pools: [pool({ id: POOL_A, tokenId: TOKEN_B })], tokens: [], candles: [], trades: [] }), 100, T0);

    const event = swapEvent({ poolId: POOL_A, amount0: -2_000_000n });
    const state = await loadFoldState(db, [event]);
    expect(state.tokens.get(TOKEN_B)?.metadataLoaded).toBe(false);

    // Step 2: the runner asks newTokenCandidates who needs a metadata read before folding.
    expect(newTokenCandidates([event], state)).toEqual([TOKEN_B]);

    // Step 3: the runner reads real metadata from the chain and supplies it to the fold.
    const tokenMetadata = new Map([[TOKEN_B, { symbol: "PAWS", name: "Paws Of Cat", decimals: 6 }]]);
    const folded = foldEvents([event], state, { tokenMetadata });

    // The same-batch swap is priced at the REAL decimals, not the 18-decimals fallback:
    // -2_000_000n raw is 2 tokens at 6 decimals (2e-12 at 18).
    expect(folded.trades[0]!.amountToken).toBeCloseTo(2, 9);
    const repaired = state.tokens.get(TOKEN_B)!;
    expect(repaired.decimals).toBe(6);
    expect(repaired.metadataLoaded).toBe(true);

    // Step 4: applyFold's token insert is `on conflict do nothing` — since TOKEN_B never had a
    // row, this insert is a real, first-time write, not a no-op.
    await applyFold(db, folded, event.block, T0);
    const row = (await db.query<{ symbol: string; decimals: number; metadata_loaded: boolean }>(
      "select symbol, decimals, metadata_loaded from market.tokens where id = $1",
      [TOKEN_B],
    ))[0]!;
    expect(row).toEqual({ symbol: "PAWS", decimals: 6, metadata_loaded: true });
  });
});

describe("applyFold", () => {
  it("round-trips through loadFoldState: create, then update in a second fold", async () => {
    await insertQuote();
    await applyFold(db, result(), 100, T0);
    expect(await readChainCursor(db)).toBe(100);

    let state = await loadFoldState(db, [swapEvent()]);
    expect(state.pools.get(POOL_A)?.swapCount).toBe(3);

    const updated = result({
      pools: [pool({ swapCount: 9, priceQuote: 0.0009, lastSwapAt: T0 + 900 })],
      tokens: [token({ poolCount: 2, symbol: "AI2" })],
      candles: [candle({ close: 0.0009, trades: 5 })],
      trades: [trade({ txHash: txHash(2), amountToken: 500 })],
    });
    await applyFold(db, updated, 150, T0 + 900);
    expect(await readChainCursor(db)).toBe(150);

    state = await loadFoldState(db, [swapEvent()]);
    expect(state.pools.get(POOL_A)).toEqual(pool({ swapCount: 9, priceQuote: 0.0009, lastSwapAt: T0 + 900 }));
    expect(state.tokens.get(TOKEN_A)).toEqual(token({ poolCount: 2, symbol: "AI2" }));
    expect(state.candles.get(`${POOL_A}-m1-${bucketStart(T0 + 500, "m1")}`)).toEqual(candle({ close: 0.0009, trades: 5 }));
    expect(await count("swaps")).toBe(2);
  });

  it("is idempotent: applying the same result twice changes nothing", async () => {
    const r = result();
    await applyFold(db, r, 100, T0);
    const snapshot = async () => ({
      pools: await db.query("select * from market.pools order by id"),
      tokens: await db.query("select * from market.tokens order by id"),
      swaps: await db.query("select * from market.swaps order by tx_hash, log_index"),
      candles: await db.query("select * from market.candles order by pool_id, interval, t"),
      cursor: await readChainCursor(db),
    });
    const before = await snapshot();
    await applyFold(db, r, 100, T0);
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(await count("pools")).toBe(1);
    expect(await count("tokens")).toBe(1);
    expect(await count("swaps")).toBe(1);
    expect(await count("candles")).toBe(1);
  });

  it("leaves pools, tokens, trades, candles and the cursor untouched when one statement in the transaction throws", async () => {
    // A pool from an earlier, successful fold: proves the failed batch does not touch prior state either.
    await applyFold(db, result({ candles: [] }), 50, T0 - 100);
    const before = {
      pools: await db.query("select * from market.pools order by id"),
      tokens: await db.query("select * from market.tokens order by id"),
      swaps: await db.query("select * from market.swaps order by tx_hash, log_index"),
      candles: await db.query("select * from market.candles order by pool_id, interval, t"),
      cursor: await readChainCursor(db),
    };

    const bad = result({
      pools: [pool({ id: POOL_B, tokenId: TOKEN_B, sqrtPriceX96: null, tvlToken: null, tvlQuote: null })],
      tokens: [token({ id: TOKEN_B, address: TOKEN_B, primaryPoolId: POOL_B })],
      trades: [trade({ txHash: txHash(9), poolId: POOL_B, tokenId: TOKEN_B })],
      candles: [candle({ poolId: POOL_B, interval: "bogus" as CandleInterval })],
    });
    await expect(applyFold(db, bad, 999, T0 + 5000)).rejects.toThrow();

    const after = {
      pools: await db.query("select * from market.pools order by id"),
      tokens: await db.query("select * from market.tokens order by id"),
      swaps: await db.query("select * from market.swaps order by tx_hash, log_index"),
      candles: await db.query("select * from market.candles order by pool_id, interval, t"),
      cursor: await readChainCursor(db),
    };
    expect(after).toEqual(before);
    // Specifically: the bad batch's own new pool/token/trade never landed either.
    expect(await db.query("select id from market.pools where id = $1", [POOL_B])).toEqual([]);
    expect(await db.query("select id from market.tokens where id = $1", [TOKEN_B])).toEqual([]);
    expect(after.cursor).toBe(50);
  });

  it("round-trips a uint160 and TVL values far beyond 2^63 exactly", async () => {
    const huge = 1461446703485210103287273052203988822378723970341n; // 2^160 - 1
    const hugeTvl = 123456789012345678901234567890123456789012345678n;
    await applyFold(db, result({ pools: [pool({ sqrtPriceX96: huge, tvlToken: hugeTvl, tvlQuote: hugeTvl + 1n })] }), 100, T0);
    const state = await loadFoldState(db, [swapEvent()]);
    const p = state.pools.get(POOL_A);
    expect(p?.sqrtPriceX96).toBe(huge);
    expect(p?.tvlToken).toBe(hugeTvl);
    expect(p?.tvlQuote).toBe(hugeTvl + 1n);
    expect(typeof p?.sqrtPriceX96).toBe("bigint");
  });

  it("recomputes listed_pool_id for a pool's token even when the fold returns no token for it", async () => {
    // A never-traded pool: created but swap_count 0, so listed_pool_id starts null.
    await applyFold(db, result({ pools: [pool({ swapCount: 0, lastSwapAt: null, volumeQuoteAllTime: 0 })] }), 100, T0);
    expect((await db.query<{ listed_pool_id: string | null }>("select listed_pool_id from market.tokens where id = $1", [TOKEN_A]))[0].listed_pool_id).toBeNull();

    // The pool's first swap: a single-pool token's primary does not change on a swap (Task 3, plan line 80),
    // so the fold would not return TOKEN_A here — only the pool row changes.
    await applyFold(db, result({ pools: [pool({ swapCount: 1, priceQuote: 0.001, lastSwapAt: T0 + 999 })], tokens: [] }), 150, T0 + 999);

    expect((await db.query<{ listed_pool_id: string | null }>("select listed_pool_id from market.tokens where id = $1", [TOKEN_A]))[0].listed_pool_id).toBe(POOL_A);
  });

  describe("opts.newTokenSupply", () => {
    it("uses the map's value, exactly, for a brand-new token's total_supply", async () => {
      const supply = 123456789012345678901234567890123456789n; // far beyond 2^63
      await applyFold(db, result(), 100, T0, { newTokenSupply: new Map([[TOKEN_A, supply]]) });
      const row = (await db.query<{ total_supply: string }>("select total_supply from market.tokens where id = $1", [TOKEN_A]))[0];
      expect(row.total_supply).toBe(supply.toString());
    });

    it("defaults to 0 for a brand-new token absent from the map", async () => {
      await applyFold(db, result(), 100, T0, { newTokenSupply: new Map([[TOKEN_B, 999n]]) });
      const row = (await db.query<{ total_supply: string }>("select total_supply from market.tokens where id = $1", [TOKEN_A]))[0];
      expect(row.total_supply).toBe("0");
    });

    it("leaves an existing token's stored supply alone even when the map names its id", async () => {
      await applyFold(db, result(), 100, T0);
      await db.query("update market.tokens set total_supply = $1 where id = $2", ["777777777777777777777777777777", TOKEN_A]);
      // The map now names TOKEN_A, as if the runner passed a supply for an id that already exists: the update
      // path never reads this map, so it must have no effect.
      await applyFold(db, result({ tokens: [token({ symbol: "NEW" })] }), 200, T0 + 1000, { newTokenSupply: new Map([[TOKEN_A, 5n]]) });
      const row = (await db.query<{ total_supply: string; symbol: string }>("select total_supply, symbol from market.tokens where id = $1", [TOKEN_A]))[0];
      expect(row).toEqual({ total_supply: "777777777777777777777777777777", symbol: "NEW" });
    });
  });

  describe("opts.holderDeltas (holder-count upkeep)", () => {
    const holdersOf = async (id: string) =>
      (await db.query<{ holders_count: number }>("select holders_count from market.tokens where id = $1", [id]))[0]!.holders_count;

    it("adds a positive delta to an existing token's holders_count", async () => {
      await applyFold(db, result(), 100, T0); // TOKEN_A starts at 0
      await db.query("update market.tokens set holders_count = 10 where id = $1", [TOKEN_A]);
      await applyFold(db, result({ tokens: [token({ symbol: "NEW" })] }), 200, T0 + 1000, {
        holderDeltas: new Map([[TOKEN_A, 3]]),
      });
      expect(await holdersOf(TOKEN_A)).toBe(13);
    });

    it("subtracts a negative delta", async () => {
      await applyFold(db, result(), 100, T0);
      await db.query("update market.tokens set holders_count = 10 where id = $1", [TOKEN_A]);
      await applyFold(db, result({ tokens: [token({ symbol: "NEW" })] }), 200, T0 + 1000, {
        holderDeltas: new Map([[TOKEN_A, -4]]),
      });
      expect(await holdersOf(TOKEN_A)).toBe(6);
    });

    it("clamps at 0 rather than going negative", async () => {
      await applyFold(db, result(), 100, T0);
      await db.query("update market.tokens set holders_count = 2 where id = $1", [TOKEN_A]);
      await applyFold(db, result({ tokens: [token({ symbol: "NEW" })] }), 200, T0 + 1000, {
        holderDeltas: new Map([[TOKEN_A, -50]]),
      });
      expect(await holdersOf(TOKEN_A)).toBe(0);
    });

    it("never touches a token not named in the map, even when other tokens in the same fold are", async () => {
      await applyFold(
        db,
        result({
          tokens: [token(), token({ id: TOKEN_B, address: TOKEN_B, primaryPoolId: null, poolCount: 0 })],
        }),
        100,
        T0,
      );
      await db.query("update market.tokens set holders_count = 5 where id = $1", [TOKEN_B]);
      await applyFold(
        db,
        result({ tokens: [token({ symbol: "NEW" }), token({ id: TOKEN_B, address: TOKEN_B, primaryPoolId: null, poolCount: 0, symbol: "NEW2" })] }),
        200,
        T0 + 1000,
        { holderDeltas: new Map([[TOKEN_A, 7]]) }, // TOKEN_B not named
      );
      expect(await holdersOf(TOKEN_A)).toBe(7);
      expect(await holdersOf(TOKEN_B)).toBe(5); // untouched, even though TOKEN_B was folded this same cycle
    });

    it("is a no-op — and never errors — when the map is empty, undefined, or every entry is 0", async () => {
      await applyFold(db, result(), 100, T0);
      await db.query("update market.tokens set holders_count = 9 where id = $1", [TOKEN_A]);

      await applyFold(db, result({ tokens: [token({ symbol: "A" })] }), 200, T0 + 1000); // opts omitted entirely
      expect(await holdersOf(TOKEN_A)).toBe(9);

      await applyFold(db, result({ tokens: [token({ symbol: "B" })] }), 300, T0 + 2000, { holderDeltas: new Map() });
      expect(await holdersOf(TOKEN_A)).toBe(9);

      await applyFold(db, result({ tokens: [token({ symbol: "C" })] }), 400, T0 + 3000, { holderDeltas: new Map([[TOKEN_A, 0]]) });
      expect(await holdersOf(TOKEN_A)).toBe(9);
    });

    it("seeds a brand-new token at 0 and then applies its own same-cycle delta on top", async () => {
      // A token created and given its first holder in the SAME cycle: upsertTokensFromFold's insert
      // (holders_count 0) must run before applyHolderDeltas' update, or this update would match no row.
      await applyFold(db, result(), 100, T0, { holderDeltas: new Map([[TOKEN_A, 1]]) });
      expect(await holdersOf(TOKEN_A)).toBe(1);
    });

    it("commits holders_count in the same transaction as the rest of the fold, and rolls both back together when a later statement in that transaction throws", async () => {
      await applyFold(db, result(), 100, T0); // seed TOKEN_A: holders_count 0, symbol "AI"
      await db.query("update market.tokens set holders_count = 10 where id = $1", [TOKEN_A]);
      const cursorBefore = await readChainCursor(db);

      // Wraps `db`, letting every query through unchanged until it sees this new statement's own SQL
      // run (the marker), then throws on the very next query — whichever statement in applyFold that
      // happens to be (recomputeListedPools or saveCursors) — to prove holders_count is not committed
      // ahead of, or independently from, the rest of applyFold's one transaction.
      function throwAfterHoldersUpdate(inner: Db): Db {
        let seenMarker = false;
        let thrown = false;
        function level(target: Db): Db {
          return {
            query: async (text, params) => {
              if (seenMarker && !thrown) {
                thrown = true;
                throw new Error("test-injected failure: after the holders_count update");
              }
              if (text.includes("holders_count = greatest")) seenMarker = true;
              return target.query(text, params);
            },
            exec: (text) => target.exec(text),
            copy: (table, columns, rows) => target.copy(table, columns, rows),
            tx: (fn) => target.tx((t) => fn(level(t))),
            end: () => target.end(),
          };
        }
        return level(inner);
      }

      await expect(
        applyFold(throwAfterHoldersUpdate(db), result({ tokens: [token({ symbol: "SHOULD_NOT_STICK" })] }), 999, T0 + 1000, {
          holderDeltas: new Map([[TOKEN_A, 5]]),
        }),
      ).rejects.toThrow("test-injected failure: after the holders_count update");

      const row = (await db.query<{ holders_count: number; symbol: string }>(
        "select holders_count, symbol from market.tokens where id = $1",
        [TOKEN_A],
      ))[0]!;
      expect(row.holders_count).toBe(10); // the +5 rolled back with everything else
      expect(row.symbol).toBe("AI"); // token()'s default symbol — "SHOULD_NOT_STICK" rolled back too
      expect(await readChainCursor(db)).toBe(cursorBefore); // the cursor advance rolled back too
    });
  });

  describe("protected columns", () => {
    it("adds metadata_retry_at defaulting to 0, which this task's statements never mention", async () => {
      await applyFold(db, result(), 100, T0);
      const row = (await db.query<{ metadata_retry_at: number }>("select metadata_retry_at from market.tokens where id = $1", [TOKEN_A]))[0];
      expect(row.metadata_retry_at).toBe(0);
    });

    it("never writes metadata_retry_at on an update either: a non-zero value survives a fold that changes the token's other columns", async () => {
      // The insert-default test above would also pass if some statement wrote a literal 0 on every write;
      // this is the case that actually proves the column is never in the token update's SET list at all.
      await applyFold(db, result(), 100, T0);
      await db.query("update market.tokens set metadata_retry_at = $1 where id = $2", [T0 + 3600, TOKEN_A]);

      await applyFold(db, result({ tokens: [token({ poolCount: 5, symbol: "CHANGED" })] }), 200, T0 + 1000);

      const row = (await db.query<{ metadata_retry_at: number; pool_count: number; symbol: string }>(
        "select metadata_retry_at, pool_count, symbol from market.tokens where id = $1",
        [TOKEN_A],
      ))[0];
      expect(row.metadata_retry_at).toBe(T0 + 3600); // untouched
      expect(row.pool_count).toBe(5); // other columns still update
      expect(row.symbol).toBe("CHANGED");
    });

    it("never writes baseline_at, defaults it to 0 for a pool it creates, and leaves an existing value alone", async () => {
      await applyFold(db, result(), 100, T0);
      expect((await db.query<{ baseline_at: number }>("select baseline_at from market.pools where id = $1", [POOL_A]))[0].baseline_at).toBe(0);

      // Simulate the migration's backfill: a pool copied from the old indexer with a real baseline.
      await db.query("update market.pools set baseline_at = $1 where id = $2", [T0 - 5000, POOL_A]);
      await applyFold(db, result({ pools: [pool({ swapCount: 20, priceQuote: 0.001 })] }), 200, T0 + 1000);

      const row = (await db.query<{ baseline_at: number; swap_count: number }>("select baseline_at, swap_count from market.pools where id = $1", [POOL_A]))[0];
      expect(row.baseline_at).toBe(T0 - 5000); // untouched
      expect(row.swap_count).toBe(20); // other columns still update
    });

    it("never writes holders_count or total_supply: 0 for a token it creates, and an externally set value survives further folds", async () => {
      await applyFold(db, result(), 100, T0);
      let row = (await db.query<{ holders_count: number; total_supply: string }>(
        "select holders_count, total_supply from market.tokens where id = $1",
        [TOKEN_A],
      ))[0];
      expect(row.holders_count).toBe(0);
      expect(row.total_supply).toBe("0");

      // Simulate the holder-refresh job (out of scope here) setting real values.
      await db.query("update market.tokens set holders_count = $1, total_supply = $2 where id = $3", [777, "999999999999999999999999999999", TOKEN_A]);
      await applyFold(db, result({ tokens: [token({ poolCount: 3, symbol: "NEW" })] }), 200, T0 + 1000);

      row = (await db.query<{ holders_count: number; total_supply: string }>(
        "select holders_count, total_supply from market.tokens where id = $1",
        [TOKEN_A],
      ))[0];
      expect(row.holders_count).toBe(777); // untouched
      expect(row.total_supply).toBe("999999999999999999999999999999"); // untouched
      const updated = (await db.query<{ pool_count: number; symbol: string }>("select pool_count, symbol from market.tokens where id = $1", [TOKEN_A]))[0];
      expect(updated).toEqual({ pool_count: 3, symbol: "NEW" }); // other columns still update
    });
  });
});

describe("dueForMetadata", () => {
  it("returns a loaded token whose total_supply is 0 (final review, MAJOR narrow half)", async () => {
    // token()'s default is metadataLoaded: true; result()'s bare applyFold gives it total_supply "0" (no
    // newTokenSupply map) — exactly the stuck-at-zero shape the review describes.
    await applyFold(db, result(), 100, T0);
    expect(await dueForMetadata(db, T0 + 1000, 10)).toEqual([TOKEN_A]);
  });

  it("does not return a loaded token that already carries a real total_supply", async () => {
    await applyFold(db, result(), 100, T0, { newTokenSupply: new Map([[TOKEN_A, 123n]]) });
    expect(await dueForMetadata(db, T0 + 1000, 10)).toEqual([]);
  });

  it("still returns a token with metadata_loaded = false regardless of its total_supply (the original Task 6 predicate)", async () => {
    await applyFold(db, result({ tokens: [token({ metadataLoaded: false })] }), 100, T0, { newTokenSupply: new Map([[TOKEN_A, 999n]]) });
    expect(await dueForMetadata(db, T0 + 1000, 10)).toEqual([TOKEN_A]);
  });

  it("gates the zero-supply case by metadata_retry_at <= now, exactly like the unloaded case", async () => {
    await applyFold(db, result(), 100, T0);
    await db.query("update market.tokens set metadata_retry_at = $1 where id = $2", [T0 + 3600, TOKEN_A]);
    expect(await dueForMetadata(db, T0 + 1000, 10)).toEqual([]); // not due yet
    expect(await dueForMetadata(db, T0 + 3600, 10)).toEqual([TOKEN_A]); // due now
  });
});

describe("refreshTokenMetadata: repairing a zero-supply loaded token", () => {
  it("writes the real total_supply once a retry's reading succeeds, drops it from dueForMetadata, and never writes holders_count", async () => {
    await applyFold(db, result(), 100, T0); // TOKEN_A: metadata_loaded true, total_supply "0"
    await db.query("update market.tokens set holders_count = $1 where id = $2", [42, TOKEN_A]);
    expect(await dueForMetadata(db, T0 + 1000, 10)).toEqual([TOKEN_A]);

    const reading: TokenMetadataReading = { ok: true, symbol: "AI", name: "Artificial Inu", decimals: 18, totalSupply: 777_000_000n };
    await refreshTokenMetadata(db, new Map([[TOKEN_A, reading]]), T0 + 1000);

    const row = (await db.query<{ total_supply: string; metadata_loaded: boolean; metadata_retry_at: number; holders_count: number }>(
      "select total_supply, metadata_loaded, metadata_retry_at, holders_count from market.tokens where id = $1",
      [TOKEN_A],
    ))[0]!;
    expect(row).toEqual({ total_supply: "777000000", metadata_loaded: true, metadata_retry_at: 0, holders_count: 42 }); // holders_count untouched

    expect(await dueForMetadata(db, T0 + 2000, 10)).toEqual([]); // repaired: no longer due
  });

  it("leaves total_supply at 0 (still due) when the retry's totalSupply() call fails again, even though the rest of the reading is ok", async () => {
    await applyFold(db, result(), 100, T0);
    // ok: true (symbol/name/decimals succeeded, exactly why the token is metadata_loaded already) but
    // totalSupply null (the independent call failed again) — store.ts's own coalesce leaves total_supply
    // alone rather than overwriting it with a fallback.
    const reading: TokenMetadataReading = { ok: true, symbol: "AI", name: "Artificial Inu", decimals: 18, totalSupply: null };
    await refreshTokenMetadata(db, new Map([[TOKEN_A, reading]]), T0 + 1000);
    const row = (await db.query<{ total_supply: string }>("select total_supply from market.tokens where id = $1", [TOKEN_A]))[0]!;
    expect(row.total_supply).toBe("0");
  });
});

describe("applyFold and loadFoldState: the launchpad (instant launchpad design, section 5.2)", () => {
  const LAUNCH_TOKEN = addr(0xd1);
  const NEW_PAYOUT = addr(0xe2);
  const META_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
  const IMAGE_CID = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";
  const launchRow = (o: Partial<LaunchRow> = {}): LaunchRow => ({
    tokenId: LAUNCH_TOKEN, poolId: POOL_B, quoteId: QUOTE, creator: WALLET, payout: WALLET, hook: addr(0), tokenIsCurrency0: true,
    creatorShareBps: 7000, openTick: -168_200, openingValuation: 49_605_800_000_000_000_000n, liquidity: 10n ** 23n,
    tokensInPool: 10n ** 27n, firstBuyIn: 0n, firstBuyTokens: 0n, routerFee: 0n, creationFee: 0n, name: "Tailor's Chalk",
    symbol: "CHALK", metadataUri: `ipfs://${META_CID}`, metadataCid: META_CID, block: 140, logIndex: 5, txHash: txHash(40), timestamp: T0, ...o,
  });
  const feeRow = (o: Partial<LaunchFeesRow> = {}): LaunchFeesRow => ({
    txHash: txHash(41), logIndex: 2, tokenId: LAUNCH_TOKEN, payout: WALLET, tokenPayout: 7n, tokenPlatform: 3n, quotePayout: 70n,
    quotePlatform: 30n, timestamp: T0 + 60, block: 145, ...o,
  });
  const base = (block: number) => ({ block, logIndex: 0, timestamp: T0 + block, txHash: txHash(block), txFrom: WALLET });

  it("writes the launch, attaches its upload, inserts the fee row and applies the payout in the fold's transaction; a re-applied result changes nothing", async () => {
    await db.query(
      `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, website, status, created_at)
       values ($1, $2, $3, 'launch/img/k.webp', 'launch/meta/k.json', 'Tailor''s Chalk', 'CHALK', 'https://chalk.test', 'pending', $4)`,
      [WALLET, IMAGE_CID, META_CID, T0 - 30],
    );
    const r = result({
      launches: [launchRow()], launchFees: [feeRow()], launchEvents: 3,
      payouts: [{ tokenId: LAUNCH_TOKEN, payout: NEW_PAYOUT, block: 150, logIndex: 1 }],
    });
    await applyFold(db, r, 150, T0 + 100);
    await applyFold(db, r, 150, T0 + 200);
    expect(await db.query("select payout, payout_block, image_cid, website from market.launches")).toEqual([
      { payout: NEW_PAYOUT, payout_block: 150, image_cid: IMAGE_CID, website: "https://chalk.test" },
    ]);
    expect(await count("launch_fee_events")).toBe(1);
    expect(await db.query("select status, token_id from market.launch_uploads")).toEqual([{ status: "used", token_id: LAUNCH_TOKEN }]);
    expect(await readChainCursor(db)).toBe(150);
  });

  it("rolls the launch rows back with the cursor when any statement of the batch throws", async () => {
    const bad = result({ launches: [launchRow()], launchFees: [feeRow({ tokenPlatform: -1n })] }); // violates token_platform >= 0
    await expect(applyFold(db, bad, 160, T0)).rejects.toThrow();
    expect(await count("launches")).toBe(0);
    expect(await readChainCursor(db)).toBe(0);
  });

  it("reads no pool for a batch of only fee and payout events", async () => {
    const feeEvent: LaunchFeesEvent = { kind: "launchFees", ...base(170), token: LAUNCH_TOKEN, payout: WALLET, tokenFees: 1n, quoteFees: 1n, tokenToPayout: 0n, quoteToPayout: 0n };
    const payoutEvent: PayoutChangedEvent = { kind: "payoutChanged", ...base(171), token: LAUNCH_TOKEN, previous: WALLET, payout: NEW_PAYOUT };
    const spy = vi.spyOn(db, "query");
    const state = await loadFoldState(db, [feeEvent, payoutEvent]);
    expect(state.pools.size).toBe(0);
    expect(spy.mock.calls.some(([sql]) => String(sql).includes("from market.pools where id = any"))).toBe(false);
    spy.mockRestore();
  });

  it("loads the pool a Launched names, so a pool initialised in an earlier batch can be relabelled SV", async () => {
    await applyFold(db, result({ pools: [pool({ id: POOL_B, origin: "Uniswap" })], tokens: [token({ primaryPoolId: POOL_B, origin: "Uniswap" })] }), 1, T0);
    const launchedEvent: LaunchedEvent = {
      kind: "launched", ...base(180), token: TOKEN_A, creator: WALLET, quote: QUOTE, poolId: POOL_B, payout: WALLET, hook: addr(0),
      tokenIsCurrency0: true, openTick: 0, openingValuation: 1n, liquidity: 1n, tokensInPool: 1n, firstBuyIn: 0n, firstBuyTokens: 0n,
      routerFee: 0n, creationFee: 0n, creatorShareBps: 7000, name: "AI", symbol: "AI", metadataUri: "",
    };
    const state = await loadFoldState(db, [launchedEvent]);
    expect(state.pools.get(POOL_B)?.origin).toBe("Uniswap");
    expect(state.tokens.get(TOKEN_A)?.primaryPoolId).toBe(POOL_B);
  });
});
