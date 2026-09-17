import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import type { CandleRow, PoolRow, QuotePriceRow, QuoteRow, SwapRow, TokenRow, WindowRow } from "@/lib/envio/queries";
import { shapeCandles, shapeHolders, shapePairs, shapeQuotes, shapeTrades, usdMap, windowStats } from "@/lib/envio/shape";
import { FakeSource } from "@/lib/sync/fakeSource";
import type { BalanceRec, CandleRec, PoolRec, QuotePriceRec, QuoteRec, SwapRec, TokenRec } from "@/lib/sync/source";
import { finishRun, readState, saveCursors } from "@/lib/sync/state";
import { insertSwaps, recomputeListedPools, replaceHolders, upsertCandles, upsertPools, upsertQuotes, upsertTokens } from "@/lib/sync/writers";
import { testDb } from "@/test/db";
import { createDbBackend } from "./dbBackend";

const NOW = 1_789_547_000; // not on an hour boundary, like real life
const H = (t: number) => Math.floor(t / 3600) * 3600;
const addr = (c: string) => `0x${c.repeat(40)}`;
const poolId = (c: string) => `0x${c.repeat(64)}`;
const NVDA = addr("1"), USDG = addr("2"), DEAD = addr("3"), NOFEED = addr("4");
const A = addr("a"), B = addr("b"), C = addr("c"), D = addr("d"), E = addr("e");
const PA = poolId("a"), PB_BROKEN = poolId("1"), PB = poolId("b"), PC = poolId("c"), PD = poolId("d"), PE = poolId("e");
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const SUPPLY = "1000000000000000000000000000";

const quotes: QuoteRec[] = [
  { id: NVDA, address: NVDA, symbol: "NVDA", name: "NVIDIA", decimals: 18, enabled: true },
  { id: USDG, address: USDG, symbol: "USDG", name: "Global Dollar", decimals: 6, enabled: true },
  { id: DEAD, address: DEAD, symbol: "DEAD", name: "Dead feed", decimals: 18, enabled: true },
  { id: NOFEED, address: NOFEED, symbol: "GLD", name: "No feed", decimals: 18, enabled: true },
];
// Hasura sends every Float as a string; the writers convert, the M1 shaping does too.
const prices: QuotePriceRec[] = [
  { id: NVDA, usdPrice: "120.5", updatedAt: NOW - 60, aggregator: "0xfeed" },
  { id: USDG, usdPrice: "1", updatedAt: NOW - 8_500_000, aggregator: "pinned" }, // 99 days old, never stale
  { id: DEAD, usdPrice: "50", updatedAt: NOW - 400_000, aggregator: "0xfeed" }, // 4 days old: stale
];
function poolRec(id: string, token: string, quote: string, over: Partial<PoolRec> = {}): PoolRec {
  return {
    id, token_id: token, quote_id: quote, tokenIsCurrency0: true, hooks: addr("9"), fee: 3000, tickSpacing: 60, origin: "LONG",
    createdAt: NOW - 5_000_000, priceQuote: "0.000866", tvlToken: "1000000000000000000000000", tvlQuote: "10000000000000000000000",
    swapCount: 10, lastSwapAt: NOW - 100, volumeQuoteAllTime: "1", ...over,
  };
}
const pools: PoolRec[] = [
  poolRec(PA, A, NVDA),
  // B: the primary is parked at a tick boundary and traded most recently; the sane fallback decides both listing and order.
  poolRec(PB_BROKEN, B, USDG, { origin: "Pons", priceQuote: "3.4e50", swapCount: 5, lastSwapAt: NOW - 10 }),
  poolRec(PB, B, USDG, { origin: "Pons", priceQuote: "0.5", swapCount: 3, lastSwapAt: NOW - 200, tvlQuote: "5000000" }),
  poolRec(PC, C, DEAD, { origin: "Uniswap", lastSwapAt: NOW - 1000, tvlToken: null, tvlQuote: null }),
  poolRec(PD, D, NVDA, { origin: "Other", swapCount: 0, lastSwapAt: null }), // never traded: not listed
  poolRec(PE, E, NOFEED, { fee: 8388608, lastSwapAt: NOW - 2000 }),
];
function tokenRec(id: string, symbol: string, origin: string, primary: string, over: Partial<TokenRec> = {}): TokenRec {
  return {
    id, address: id, symbol, name: `${symbol} token`, decimals: 18, totalSupply: SUPPLY, holdersCount: 42, poolCount: 1,
    origin, createdAt: NOW - 5_000_000, primaryPool_id: primary, metadataLoaded: true, ...over,
  };
}
const tokens: TokenRec[] = [
  tokenRec(A, "AAA", "LONG", PA), tokenRec(B, "BBB", "Pons", PB_BROKEN, { poolCount: 2 }), tokenRec(C, "CCC", "Uniswap", PC),
  tokenRec(D, "DDD", "Other", PD), tokenRec(E, "EEE", "LONG", PE),
];
const candle = (pool: string, interval: string, t: number, open: number, close: number, vol: number): CandleRec => ({
  id: `${pool}-${interval}-${t}`, pool_id: pool, t, open: String(open), high: String(Math.max(open, close)), low: String(Math.min(open, close)),
  close: String(close), volumeQuote: String(vol), volumeToken: "1", trades: 1,
});
const candles: CandleRec[] = [
  candle(PA, "h1", H(NOW), 0.0009, 0.00087, 10), candle(PA, "h1", H(NOW - 3600), 0.00088, 0.0009, 8.6),
  candle(PA, "h1", H(NOW - 86400), 0.001, 0.00095, 0), candle(PA, "h1", H(NOW - 30 * 3600), 0.0011, 0.001, 999),
  candle(PA, "m5", Math.floor(NOW / 300) * 300, 5, 5, 5), // must never reach the window stats
  candle(PB, "h1", H(NOW - 3600), 0.4, 0.5, 2),
  candle(PA, "m15", NOW - 1800, 0.00095, 0.0009, 4), candle(PA, "m15", NOW - 900, 0.0009, 0.0009, 3),
];
const swap = (n: number, ts: number, side: "buy" | "sell"): SwapRec => ({
  id: `${poolId(String(n))}-${n}`, pool_id: PA, token_id: A, timestamp: ts, side, amountToken: "15749", amountQuote: "13.6",
  priceQuote: "0.000865", wallet: addr("5"), txHash: poolId(String(n)),
});
const swaps = [swap(1, NOW - 90, "buy"), swap(2, NOW - 30, "sell"), swap(3, NOW - 60, "buy")];
const bal = (holder: string, balance: string): BalanceRec => ({ id: `${A}-${holder}`, token_id: A, holder, balance, updatedAt: NOW - 100 });
const stored = [bal(addr("6"), "500000000000000000000000000"), bal(POOL_MANAGER, "100000000000000000000000000")];
const pulled = [bal(addr("7"), "900000000000000000000000000"), bal(addr("6"), "400000000000000000000000000")];

// The same fixtures as M1 receives them from Hasura, so shapePairs() can be the oracle.
const quoteOf = new Map(quotes.map((q) => [q.id, { symbol: q.symbol, decimals: q.decimals }]));
const poolById = new Map(pools.map((p) => [p.id, p]));
const poolRow = (p: PoolRec): PoolRow => ({
  id: p.id, quote_id: p.quote_id, tokenIsCurrency0: p.tokenIsCurrency0, hooks: p.hooks, fee: p.fee, tickSpacing: p.tickSpacing, origin: p.origin,
  createdAt: p.createdAt, priceQuote: p.priceQuote, tvlToken: p.tvlToken, tvlQuote: p.tvlQuote, swapCount: p.swapCount, lastSwapAt: p.lastSwapAt,
  quote: quoteOf.get(p.quote_id)!,
});
const tokenRow = (t: TokenRec, fallback?: string): TokenRow => ({
  id: t.id, address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, totalSupply: t.totalSupply, holdersCount: t.holdersCount,
  origin: t.origin, createdAt: t.createdAt, primaryPool: poolRow(poolById.get(t.primaryPool_id!)!),
  fallbackPool: fallback ? [poolRow(poolById.get(fallback)!)] : undefined,
});
const m1Prices: QuotePriceRow[] = prices;
const m1Window: WindowRow[] = candles.filter((c) => c.id.includes("-h1-")).map((c) => ({ pool_id: c.pool_id, t: c.t, open: c.open, close: c.close, volumeQuote: c.volumeQuote }));
const candleRow = (c: CandleRec): CandleRow => ({ t: c.t, open: c.open, high: c.high, low: c.low, close: c.close, volumeQuote: c.volumeQuote });
const swapRow = (s: SwapRec): SwapRow => ({ timestamp: s.timestamp, side: s.side, amountToken: s.amountToken, priceQuote: s.priceQuote, wallet: s.wallet, txHash: s.txHash });
const balanceRow = (b: BalanceRec) => ({ holder: b.holder, balance: b.balance });
/** What M1 lists, in M1's order: the listed pool's last swap, newest first. D never traded and is absent. */
const expected = shapePairs([tokenRow(tokens[0]!), tokenRow(tokens[1]!, PB), tokenRow(tokens[2]!), tokenRow(tokens[4]!)], usdMap(m1Prices, NOW), windowStats(m1Window, NOW));

describe("createDbBackend reads", () => {
  let db: Db;
  let source: FakeSource;
  let now = NOW;
  const backend = () => createDbBackend(db, source, () => now);
  const topHolderCalls = () => source.calls.filter((c) => c === "topHolders").length;

  beforeAll(async () => {
    db = await testDb();
    await upsertQuotes(db, quotes, prices);
    await upsertTokens(db, tokens, NOW);
    await upsertPools(db, pools, NOW);
    await insertSwaps(db, swaps);
    await upsertCandles(db, candles);
    await replaceHolders(db, A, stored, NOW - 10); // refreshed just now
    await recomputeListedPools(db, "all");
    source = new FakeSource({ balances: pulled, chain: { latestProcessedBlock: 995, blockHeight: 1000 } });
  });
  afterAll(() => db.end());
  beforeEach(() => {
    clearTtlCache(); // pairs() memoises per scope, like loadPairs
    now = NOW;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("pairs('all') equals shapePairs() over the same rows, field for field, ordered by the listed pool's last swap", async () => {
    const out = await backend().pairs("all");
    expect(out.map((p) => p.id)).toEqual([A, B, C, E]);
    expect(out).toEqual(expected);
    // Spot checks so a wrong oracle cannot hide a wrong reader.
    expect(out[0]!.priceUsd).toBeCloseTo(0.000866 * 120.5, 12);
    expect(out[0]!.change1h).toBeCloseTo((0.000866 / 0.00088 - 1) * 100, 9);
    expect(out[0]!.vol24h).toBeCloseTo(18.6 * 120.5, 6);
    expect(out[1]).toMatchObject({ poolId: PB, origin: "Pons", quote: "USDG", stale: false, liquidity: 5 + 1_000_000 * 0.5 });
    expect(out[2]).toMatchObject({ stale: true, priceUsd: 0, liquidity: null, change1h: null, hook: "None" });
    expect(out[3]).toMatchObject({ stale: true, feeTier: "Dynamic", createdAt: (NOW - 5_000_000) * 1000 });
  });

  it("pairs('launchpad') keeps LONG and Pons tokens only", async () => {
    expect((await backend().pairs("launchpad")).map((p) => p.id)).toEqual([A, B, E]);
  });

  it("pair() answers one listed token and null for an unlisted or unknown one", async () => {
    expect(await backend().pair(B)).toEqual(expected[1]);
    expect(await backend().pair(D)).toBeNull();
    expect(await backend().pair(addr("f"))).toBeNull();
  });

  it("quotes() equals shapeQuotes() over the store's quotes, counting the pairs of pairs('all')", async () => {
    const m1Quotes: QuoteRow[] = quotes.map((q) => ({ id: q.id, symbol: q.symbol, name: q.name, decimals: q.decimals, address: q.address }));
    const out = await backend().quotes();
    expect(out).toEqual(shapeQuotes(m1Quotes, expected, usdMap(m1Prices, NOW), m1Prices, NOW));
    expect(out.map((q) => q.symbol).sort()).toEqual(["DEAD", "GLD", "NVDA", "USDG"]);
    expect(out.find((q) => q.symbol === "USDG")).toMatchObject({ usdPrice: 1, stale: false }); // pinned: never stale
    expect(out.find((q) => q.symbol === "GLD")).toMatchObject({ usdPrice: 0, stale: true }); // no feed row at all
  });

  it("candles() serves the listed pool's interval oldest-first in USD and ms, empty without a usable USD price", async () => {
    const m15 = candles.filter((c) => c.id.includes("-m15-"));
    expect(await backend().candles(A, "m15")).toEqual(shapeCandles(m15.map(candleRow), () => 120.5));
    expect(await backend().candles(C, "m15")).toEqual([]); // stale quote: an empty chart beats a chart on the floor
    expect(await backend().candles(D, "m15")).toEqual([]); // no listed pool
  });

  it("trades() serves the 50 newest swaps priced in USD", async () => {
    expect(await backend().trades(A)).toEqual(shapeTrades([swaps[1]!, swaps[2]!, swaps[0]!].map(swapRow), 120.5, "AAA"));
    expect(await backend().trades(D)).toEqual([]);
  });

  it("holders() serves stored rows without asking Envio while the refresh is fresh", async () => {
    const before = topHolderCalls();
    expect(await backend().holders(A)).toEqual({ holders: shapeHolders(stored.map(balanceRow), 18, BigInt(SUPPLY)), count: 42 });
    expect(topHolderCalls()).toBe(before);
    expect(await backend().holders(addr("f"))).toEqual({ holders: [], count: 0 });
  });

  it("holders() re-pulls the top 100 and replaces the rows once the refresh is older than 300 s", async () => {
    now = NOW + 301; // refreshed at NOW - 10: 311 s ago
    const before = topHolderCalls();
    expect(await backend().holders(A)).toEqual({ holders: shapeHolders(pulled.map(balanceRow), 18, BigInt(SUPPLY)), count: 42 });
    expect(topHolderCalls()).toBe(before + 1);
    expect(await db.query("select refreshed_at from market.holder_refresh where token_id = $1", [A])).toEqual([{ refreshed_at: NOW + 301 }]);
  });

  it("holders() serves the stored rows when Envio fails, without stamping a refresh", async () => {
    now = NOW + 700; // stale again
    source.failOn = { method: "topHolders", error: new Error("indexer unreachable: fetch failed") };
    expect(await backend().holders(A)).toEqual({ holders: shapeHolders(pulled.map(balanceRow), 18, BigInt(SUPPLY)), count: 42 });
    expect(await db.query("select refreshed_at from market.holder_refresh where token_id = $1", [A])).toEqual([{ refreshed_at: NOW + 301 }]);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe("createDbBackend limits", () => {
  it("caps pairs at 500, candles at the 300 newest and trades at 50", async () => {
    const db = await testDb();
    clearTtlCache();
    const hex = (i: number, len: number) => `0x${i.toString(16).padStart(len, "0")}`;
    const n = 505;
    await upsertQuotes(db, [quotes[0]!], [prices[0]!]);
    await upsertTokens(db, Array.from({ length: n }, (_, i) => tokenRec(hex(i + 1, 40), `T${i}`, "LONG", hex(i + 1, 64))), NOW);
    await upsertPools(db, Array.from({ length: n }, (_, i) => poolRec(hex(i + 1, 64), hex(i + 1, 40), NVDA, { lastSwapAt: NOW - i })), NOW);
    await recomputeListedPools(db, "all");
    await upsertCandles(db, Array.from({ length: 310 }, (_, i) => candle(hex(1, 64), "m1", NOW - 60 * i, 1, 1, 1)));
    await insertSwaps(db, Array.from({ length: 60 }, (_, i) => ({ ...swap(1, NOW - i, "buy"), id: `${hex(1, 64)}-${i}`, pool_id: hex(1, 64), token_id: hex(1, 40), txHash: hex(1, 64) })));
    const backend = createDbBackend(db, new FakeSource({}), () => NOW);
    const pairs = await backend.pairs("all");
    expect(pairs).toHaveLength(500);
    expect(pairs[0]!.id).toBe(hex(1, 40)); // newest swap first
    const c = await backend.candles(hex(1, 40), "m1");
    expect(c).toHaveLength(300);
    expect(c[0]!.t).toBe((NOW - 60 * 299) * 1000); // the 300 newest, then oldest first
    expect(await backend.trades(hex(1, 40))).toHaveLength(50);
    await db.end();
  });
});

describe("createDbBackend health", () => {
  let db: Db;
  let source: FakeSource;
  let now = NOW;
  const backend = () => createDbBackend(db, source, () => now);

  beforeAll(async () => {
    db = await testDb();
    await upsertQuotes(db, [quotes[0]!, quotes[3]!], [prices[0]!]); // one fed quote, one without a feed
    source = new FakeSource({ chain: { latestProcessedBlock: 995, blockHeight: 1000 } });
  });
  afterAll(() => db.end());
  beforeEach(() => {
    now = NOW;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("is not ok before the sync has ever succeeded, and still reports everything it knows", async () => {
    const h = await backend().health();
    expect(h).toMatchObject({
      ok: false, backend: "db", lag: 5, quotes: [{ id: NVDA, ageSec: 60, stale: false }],
      sync: { lastOkAgeSec: null, cursorAgeSec: null, lastError: null }, nightly: { lastOkAgeSec: null, lastError: null, phase: "" },
    });
    expect(h.db!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("is ok once the market sync succeeded within 300 s", async () => {
    await readState(db, "market");
    await readState(db, "nightly");
    await saveCursors(db, "market", { cursor: NOW - 120 });
    await finishRun(db, "market", { now: NOW - 30, ok: true, rows: 10, queries: 4 });
    await finishRun(db, "nightly", { now: NOW - 3600, ok: true, rows: 0, queries: 0 });
    expect(await backend().health()).toMatchObject({
      ok: true, sync: { lastOkAgeSec: 30, cursorAgeSec: 120, lastError: null }, nightly: { lastOkAgeSec: 3600, lastError: null, phase: "" },
    });
  });

  it("carries the last error, and turns not ok when the last success is older than 300 s", async () => {
    await finishRun(db, "market", { now: NOW, ok: false, error: "indexer responded 429", rows: 0, queries: 1 });
    expect(await backend().health()).toMatchObject({ ok: true, sync: { lastOkAgeSec: 30, lastError: "indexer responded 429" } });
    now = NOW + 400;
    expect((await backend().health()).ok).toBe(false);
  });

  it("keeps serving with lag null when the indexer cannot be asked", async () => {
    source.failOn = { method: "chainMeta", error: new Error("indexer unreachable: fetch failed") };
    expect(await backend().health()).toMatchObject({ ok: true, lag: null });
  });

  it("answers not ok with no report when the database does not answer", async () => {
    const broken: Db = { ...db, query: async () => { throw new Error("connection refused"); } };
    expect(await createDbBackend(broken, source, () => now).health()).toEqual({ ok: false, backend: "db", lag: null, quotes: [], error: "database unavailable" });
  });

  it("surfaces the nightly's phase, so a budget-stopped re-pull does not read as finished", async () => {
    await saveCursors(db, "nightly", { phase: "pools", cursorText: PA });
    expect((await backend().health()).nightly).toMatchObject({ lastOkAgeSec: 3600, phase: "pools" });
    await saveCursors(db, "nightly", { phase: "", cursorText: "" });
    expect((await backend().health()).nightly).toMatchObject({ phase: "" });
  });

  it("cuts a long last_error to 120 characters on the public route and keeps the full text in the log", async () => {
    const long = `relation "market.pools" does not exist; ${"x".repeat(200)}`;
    await finishRun(db, "market", { now: NOW, ok: false, error: long, rows: 0, queries: 1 });
    await finishRun(db, "nightly", { now: NOW, ok: false, error: long, rows: 0, queries: 1 });
    const h = await backend().health();
    expect(h.sync!.lastError).toBe(long.slice(0, 120));
    expect(h.sync!.lastError).toHaveLength(120);
    expect(h.nightly!.lastError).toBe(long.slice(0, 120));
    expect(console.warn).toHaveBeenCalledWith(`market last_error: ${long}`);
    expect(console.warn).toHaveBeenCalledWith(`nightly last_error: ${long}`);
    // A short error travels whole, and is not logged again by the health check.
    vi.mocked(console.warn).mockClear();
    await finishRun(db, "market", { now: NOW, ok: false, error: "indexer responded 429", rows: 0, queries: 1 });
    expect((await backend().health()).sync!.lastError).toBe("indexer responded 429");
    expect(console.warn).toHaveBeenCalledTimes(1); // the nightly's long one
  });
});
