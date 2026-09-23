import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import { gql } from "@/lib/envio/client";
import { AI, NOW as ENVIO_NOW, NVDA as ENVIO_NVDA, POOL as ENVIO_POOL, aiToken } from "@/lib/envio/fixtures";
import { TOKEN_QUERY, type CandleRow, type PoolRow, type QuotePriceRow, type QuoteRow, type SwapRow, type TokenRow, type WindowRow } from "@/lib/envio/queries";
import { shapeCandles, shapeHolders, shapePairs, shapeQuotes, shapeTrades, usdMap, windowStats } from "@/lib/envio/shape";
import { STALE_SEC } from "@/lib/holders/store";
import { NotRoutableError, type Quoter } from "@/lib/quote/quoter";
import type { BalanceRec, CandleRec, PoolRec, QuotePriceRec, QuoteRec, SwapRec, TokenRec } from "@/lib/sync/source";
import { finishRun, readState, saveCursors } from "@/lib/sync/state";
import { insertSwaps, recomputeListedPools, upsertCandles, upsertPools, upsertQuotes, upsertTokens } from "@/lib/sync/writers";
import { testDb } from "@/test/db";
import { createDbBackend } from "./dbBackend";
import { createEnvioBackend } from "./envioBackend";

// Only this file's new tradeability-parity test needs the indexer side; every other test here is
// pure PGlite and never touches this mock.
vi.mock("@/lib/envio/client", () => ({ gql: vi.fn() }));
const gqlMock = vi.mocked(gql);

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
    swapCount: 10, lastSwapAt: NOW - 100, volumeQuoteAllTime: "1", sqrtPriceX96: null, ...over,
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
  let now = NOW;
  const backend = () => createDbBackend(db, { now: () => now });

  /**
   * Stands in for the builder (`src/lib/holders/run.ts`), which is the only writer of these two tables
   * since 23 Sep 2026 — `replaceHolders` is gone. `holders()` reads them and never writes a balance, so a
   * plain insert is the whole fixture it needs.
   */
  async function seedBalances(tokenId: string, rows: readonly BalanceRec[]) {
    await db.query("delete from market.token_balances where token_id = $1", [tokenId]);
    for (const b of rows) {
      await db.query(
        "insert into market.token_balances (token_id, holder, balance, updated_at) values ($1, $2, $3::numeric, $4)",
        [tokenId, b.holder, b.balance, b.updatedAt],
      );
    }
  }
  async function seedRefresh(tokenId: string, row: { refreshedAt?: number; requestedAt?: number; status?: string } = {}) {
    await db.query(
      `insert into market.holder_refresh (token_id, refreshed_at, requested_at, status) values ($1, $2, $3, $4)
       on conflict (token_id) do update set refreshed_at = excluded.refreshed_at, requested_at = excluded.requested_at, status = excluded.status`,
      [tokenId, row.refreshedAt ?? 0, row.requestedAt ?? 0, row.status ?? "building"],
    );
  }
  const refreshState = async (tokenId: string) =>
    (await db.query("select refreshed_at, requested_at, status from market.holder_refresh where token_id = $1", [tokenId]))[0] ?? null;

  beforeAll(async () => {
    db = await testDb();
    await upsertQuotes(db, quotes, prices);
    await upsertTokens(db, tokens, NOW);
    await upsertPools(db, pools, NOW);
    await insertSwaps(db, swaps);
    await upsertCandles(db, candles);
    await seedBalances(A, stored);
    await recomputeListedPools(db, "all");
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

  // Design section 5: the tab's open is the only thing this method writes — a `requested_at` stamp that puts
  // the token in the builder's first priority. It never touches a balance and never refreshes a list itself.
  it("holders() opens a build for a token with no refresh row, answering building and nothing yet", async () => {
    await db.query("delete from market.holder_refresh where token_id = $1", [A]);
    expect(await backend().holders(A)).toEqual({ holders: [], count: 42, status: "building", asOf: null });
    expect(await refreshState(A)).toEqual({ refreshed_at: 0, requested_at: NOW, status: "building" });
  });

  it("holders() serves a ready list with its as-of stamp, and queues nothing while it is fresh", async () => {
    await seedRefresh(A, { refreshedAt: NOW - 10, requestedAt: NOW - 600, status: "ready" });
    expect(await backend().holders(A)).toEqual({
      holders: shapeHolders(stored.map(balanceRow), 18, BigInt(SUPPLY)),
      count: 42, // market.tokens.holders_count, exact once a list is ready (design section 6)
      status: "ready",
      asOf: NOW - 10,
    });
    expect(await refreshState(A)).toMatchObject({ requested_at: NOW - 600 }); // untouched
  });

  it("holders() queues an opened ready list once it is older than STALE_SEC, re-stamping at most once a minute", async () => {
    await seedRefresh(A, { refreshedAt: NOW - STALE_SEC - 1, requestedAt: NOW - 600, status: "ready" });
    // Still served from the stored rows: the stamp is a request for a rebuild, not a rebuild.
    expect(await backend().holders(A)).toEqual({
      holders: shapeHolders(stored.map(balanceRow), 18, BigInt(SUPPLY)), count: 42, status: "ready", asOf: NOW - STALE_SEC - 1,
    });
    expect(await refreshState(A)).toMatchObject({ requested_at: NOW });

    now = NOW + 30; // re-opened inside the minute: requestBuild throttles the re-stamp
    await backend().holders(A);
    expect(await refreshState(A)).toMatchObject({ requested_at: NOW });

    now = NOW + 61; // past it, so a list nobody has rebuilt yet keeps its place at the front of the queue
    await backend().holders(A);
    expect(await refreshState(A)).toMatchObject({ requested_at: NOW + 61 });
  });

  it("holders() reports a skipped token with no rows, and never queues it again", async () => {
    // The balances stay in the table on purpose: what keeps them off the wire is the status, not an empty table.
    await seedRefresh(A, { refreshedAt: 0, requestedAt: NOW - 86_400, status: "skipped" });
    expect(await backend().holders(A)).toEqual({ holders: [], count: 42, status: "skipped", asOf: null });
    expect(await refreshState(A)).toMatchObject({ requested_at: NOW - 86_400, status: "skipped" });
  });

  it("holders() answers an unknown token building and empty, without opening a row for it", async () => {
    expect(await backend().holders(addr("f"))).toEqual({ holders: [], count: 0, status: "building", asOf: null });
    expect(await refreshState(addr("f"))).toBeNull();
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
    const backend = createDbBackend(db, { now: () => NOW });
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
  let now = NOW;
  // Task 6: lag is an injected `chainHead` callback (the node's own head) minus the stored chain cursor, not
  // an EnvioSource's chainMeta(). `chainHeadFailOnce` mirrors FakeSource's old one-shot failOn.
  let chainHeadFailOnce: Error | null = null;
  async function fakeChainHead(): Promise<number> {
    if (chainHeadFailOnce) {
      const err = chainHeadFailOnce;
      chainHeadFailOnce = null;
      throw err;
    }
    return 1000;
  }
  const backend = () => createDbBackend(db, { chainHead: fakeChainHead, now: () => now });

  beforeAll(async () => {
    db = await testDb();
    await upsertQuotes(db, [quotes[0]!, quotes[3]!], [prices[0]!]); // one fed quote, one without a feed
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
      // No chain row yet (the job has never run): cursor reads as 0, so lag is the full node head.
      ok: false, backend: "db", lag: 1000, quotes: [{ id: NVDA, ageSec: 60, stale: false }],
      sync: { lastOkAgeSec: null, lastError: null }, nightly: { lastOkAgeSec: null, lastError: null, phase: "" },
    });
    expect(h.db!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("is ok once the chain sync succeeded within 300 s", async () => {
    await readState(db, "chain");
    await readState(db, "nightly");
    await saveCursors(db, "chain", { cursor: 995 }); // node head (1000) - 995 = 5
    await finishRun(db, "chain", { now: NOW - 30, ok: true, rows: 10, queries: 4 });
    await finishRun(db, "nightly", { now: NOW - 3600, ok: true, rows: 0, queries: 0 });
    expect(await backend().health()).toMatchObject({
      ok: true, lag: 5, sync: { lastOkAgeSec: 30, lastError: null }, nightly: { lastOkAgeSec: 3600, lastError: null, phase: "" },
    });
  });

  it("carries the last error, and turns not ok when the last success is older than 300 s", async () => {
    await finishRun(db, "chain", { now: NOW, ok: false, error: "HyperSync responded 429", rows: 0, queries: 1 });
    expect(await backend().health()).toMatchObject({ ok: true, sync: { lastOkAgeSec: 30, lastError: "HyperSync responded 429" } });
    now = NOW + 400;
    expect((await backend().health()).ok).toBe(false);
  });

  it("keeps serving with lag null when the chain head cannot be asked", async () => {
    chainHeadFailOnce = new Error("rpc unreachable: fetch failed");
    expect(await backend().health()).toMatchObject({ ok: true, lag: null });
  });

  it("surfaces the chain job's last cycle (holder-count reads) and the RPC hosts, and neither when absent (23 Sep 2026)", async () => {
    await finishRun(db, "chain", { now: NOW - 20, ok: true, rows: 10, queries: 4 });
    const plain = await backend().health();
    expect(plain.sync).not.toHaveProperty("lastCycle"); // an empty default report is not "zero pairs resolved"
    expect(plain).not.toHaveProperty("rpc");
    await finishRun(db, "chain", {
      now: NOW - 20, ok: true, rows: 10, queries: 4,
      report: { at: NOW - 20, cursor: 990, blocks: 30, trades: 280, holderPairs: 190, holderDeltaApplied: 150, holderReadsUnknown: 40 },
    });
    const withRpc = createDbBackend(db, { chainHead: async () => 1000, now: () => now, rpc: { primary: "rpc.mainnet.chain.robinhood.com", backup: null } });
    expect(await withRpc.health()).toMatchObject({
      sync: { lastOkAgeSec: 20, lastCycle: { ageSec: 20, blocks: 30, trades: 280, holderPairs: 190, holderDeltaApplied: 150, holderReadsUnknown: 40 } },
      rpc: { primary: "rpc.mainnet.chain.robinhood.com", backup: null },
    });
  });

  it("reports lag null when no chainHead callback is supplied at all (Task 6: absent by default)", async () => {
    const noCallback = createDbBackend(db, { now: () => now });
    expect(await noCallback.health()).toMatchObject({ ok: true, lag: null });
  });

  it("answers not ok with no report when the database does not answer", async () => {
    const broken: Db = { ...db, query: async () => { throw new Error("connection refused"); } };
    expect(await createDbBackend(broken, { chainHead: fakeChainHead, now: () => now }).health()).toEqual({ ok: false, backend: "db", lag: null, quotes: [], error: "database unavailable" });
  });

  it("surfaces the nightly's phase, so a budget-stopped re-pull does not read as finished", async () => {
    await saveCursors(db, "nightly", { phase: "pools", cursorText: PA });
    expect((await backend().health()).nightly).toMatchObject({ lastOkAgeSec: 3600, phase: "pools" });
    // "probe" (spec section 2 / 6 task 2) is a phase name like any other here: health() only ever
    // echoes whatever sync_state.phase carries, so /api/health shows "probe" while that phase runs
    // with no code of its own — this is what closes that requirement's coverage.
    await saveCursors(db, "nightly", { phase: "probe", cursorText: PA });
    expect((await backend().health()).nightly).toMatchObject({ lastOkAgeSec: 3600, phase: "probe" });
    await saveCursors(db, "nightly", { phase: "", cursorText: "" });
    expect((await backend().health()).nightly).toMatchObject({ phase: "" });
  });

  it("cuts a long last_error to 120 characters on the public route and keeps the full text in the log", async () => {
    const long = `relation "market.pools" does not exist; ${"x".repeat(200)}`;
    await finishRun(db, "chain", { now: NOW, ok: false, error: long, rows: 0, queries: 1 });
    await finishRun(db, "nightly", { now: NOW, ok: false, error: long, rows: 0, queries: 1 });
    const h = await backend().health();
    expect(h.sync!.lastError).toBe(long.slice(0, 120));
    expect(h.sync!.lastError).toHaveLength(120);
    expect(h.nightly!.lastError).toBe(long.slice(0, 120));
    expect(console.warn).toHaveBeenCalledWith(`chain last_error: ${long}`);
    expect(console.warn).toHaveBeenCalledWith(`nightly last_error: ${long}`);
    // A short error travels whole, and is not logged again by the health check.
    vi.mocked(console.warn).mockClear();
    await finishRun(db, "chain", { now: NOW, ok: false, error: "HyperSync responded 429", rows: 0, queries: 1 });
    expect((await backend().health()).sync!.lastError).toBe("HyperSync responded 429");
    expect(console.warn).toHaveBeenCalledTimes(1); // the nightly's long one
  });
});

describe("createDbBackend poolKey", () => {
  let db: Db;
  const backend = () => createDbBackend(db, { now: () => NOW });
  // One more token whose pool was created with the quote as currency0; the fixtures above are all token-first.
  const F = addr("8");
  const PF = poolId("8");
  // A token whose only pool prices insanely: the fallback must not treat it as routable either.
  const G = addr("g");
  const PG = poolId("g");
  // H: primary parked at a tick boundary (not sane) and two sane candidate pools with different
  // swap counts — the fallback's ordering, the part Fix D depends on most, decides between them.
  const H = addr("h");
  const PH0 = poolId("h");
  const PH_LOW = poolId("3");
  const PH_HIGH = poolId("4");
  // J: the same shape as H, but the two sane candidates tie on swap count — only the id tie-break
  // (lowest wins) can decide.
  const J = addr("j");
  const PJ0 = poolId("j");
  const PJ_LOW_ID = poolId("5");
  const PJ_HIGH_ID = poolId("6");
  // K: the primary is sane but has never swapped, and a different pool has traded heavily. Rule 1
  // (the primary, if sane) must still win over rule 2's more-traded candidate.
  const K = addr("k");
  const PK_PRIMARY = poolId("k");
  const PK_TRADED = poolId("7");
  // M (C2): the sane primary is quoted NVDA; its only other pool, also sane, is quoted USDG. A
  // quote-blind rule (or one that only checks the row it already picked, rather than restricting
  // the candidate set itself) would hand back the NVDA primary — or null — no matter which quote
  // asset the caller actually asked for.
  const M = addr("m");
  const PM_PRIMARY = poolId("m");
  const PM_OTHER = poolId("n");

  beforeAll(async () => {
    db = await testDb();
    await upsertQuotes(db, quotes, prices);
    await upsertTokens(
      db,
      [
        ...tokens,
        tokenRec(F, "FFF", "LONG", PF),
        tokenRec(G, "GGG", "LONG", PG),
        tokenRec(H, "HHH", "LONG", PH0),
        tokenRec(J, "JJJ", "LONG", PJ0),
        tokenRec(K, "KKK", "LONG", PK_PRIMARY),
        tokenRec(M, "MMM", "LONG", PM_PRIMARY),
      ],
      NOW,
    );
    await upsertPools(
      db,
      [
        ...pools,
        poolRec(PF, F, USDG, { tokenIsCurrency0: false, fee: 500, tickSpacing: 10, lastSwapAt: NOW - 3000 }),
        poolRec(PG, G, NVDA, { priceQuote: "3.4e50" }), // parked at a tick boundary, like PB_BROKEN
        poolRec(PH0, H, NVDA, { priceQuote: "3.4e50" }),
        poolRec(PH_LOW, H, NVDA, { swapCount: 4 }),
        poolRec(PH_HIGH, H, NVDA, { swapCount: 9 }),
        poolRec(PJ0, J, NVDA, { priceQuote: "3.4e50" }),
        poolRec(PJ_LOW_ID, J, NVDA, { swapCount: 6 }),
        poolRec(PJ_HIGH_ID, J, NVDA, { swapCount: 6 }),
        poolRec(PK_PRIMARY, K, NVDA, { swapCount: 0, lastSwapAt: null }),
        poolRec(PK_TRADED, K, NVDA, { swapCount: 50 }),
        poolRec(PM_PRIMARY, M, NVDA, { swapCount: 20 }),
        poolRec(PM_OTHER, M, USDG, { swapCount: 3 }),
      ],
      NOW,
    );
    await recomputeListedPools(db, "all");
  });
  afterAll(() => db.end());

  it("builds the listed pool's key, with the token as currency0", async () => {
    expect(await backend().poolKey(A, NVDA)).toEqual({
      poolId: PA,
      currency0: A,
      currency1: NVDA,
      fee: 3000,
      tickSpacing: 60,
      hooks: addr("9"),
      tokenIsCurrency0: true,
      priceQuote: 0.000866,
      tokenAddress: A,
      tokenDecimals: 18,
      quoteAddress: NVDA,
      quoteDecimals: 18,
    });
  });

  it("puts the quote first when the pool was created that way", async () => {
    expect(await backend().poolKey(F, USDG)).toMatchObject({
      poolId: PF,
      currency0: USDG,
      currency1: F,
      tokenIsCurrency0: false,
      fee: 500,
      tickSpacing: 10,
      tokenAddress: F,
      quoteAddress: USDG,
      quoteDecimals: 6,
    });
  });

  it("reads the recovered pool, not the broken primary, exactly as the listing does", async () => {
    expect(await backend().poolKey(B, USDG)).toMatchObject({ poolId: PB, currency1: USDG, priceQuote: 0.5, quoteDecimals: 6 });
  });

  it("is null for a token that does not exist", async () => {
    expect(await backend().poolKey(addr("0"), NVDA)).toBeNull();
  });

  it("falls back to the token's best sane pool when nothing is listed for market data: a fresh launch with liquidity but no trades yet is still routable", async () => {
    // D's only pool never swapped (poolRec above: swapCount: 0), so LISTED_POOL leaves
    // listed_pool_id null and D is absent from pairs('all') — but trading does not depend on a
    // pool having already traded (Fix D).
    expect(await backend().poolKey(D, NVDA)).toEqual({
      poolId: PD,
      currency0: D,
      currency1: NVDA,
      fee: 3000,
      tickSpacing: 60,
      hooks: addr("9"),
      tokenIsCurrency0: true,
      priceQuote: 0.000866,
      tokenAddress: D,
      tokenDecimals: 18,
      quoteAddress: NVDA,
      quoteDecimals: 18,
    });
  });

  it("still answers null when the token's only pool prices insanely, fallback included", async () => {
    expect(await backend().poolKey(G, NVDA)).toBeNull();
  });

  it("falls back to the sane candidate pool with the highest swap count when the primary is not sane", async () => {
    expect(await backend().poolKey(H, NVDA)).toMatchObject({ poolId: PH_HIGH });
  });

  it("breaks a swap-count tie in the fallback by the lowest pool id", async () => {
    expect(await backend().poolKey(J, NVDA)).toMatchObject({ poolId: PJ_LOW_ID });
  });

  it("prefers a sane, never-swapped primary over a different pool that has traded heavily (rule 1 beats rule 2)", async () => {
    expect(await backend().poolKey(K, NVDA)).toMatchObject({ poolId: PK_PRIMARY });
  });

  it("returns the pool quoted in the requested asset when the sane primary is quoted in a different one, and null for a third asset (C2)", async () => {
    expect(await backend().poolKey(M, USDG)).toMatchObject({ poolId: PM_OTHER, quoteAddress: USDG });
    expect(await backend().poolKey(M, NVDA)).toMatchObject({ poolId: PM_PRIMARY, quoteAddress: NVDA });
    expect(await backend().poolKey(M, DEAD)).toBeNull();
  });
});

describe("tradeability parity: db reads the column, envio probes the quoter", () => {
  beforeEach(() => {
    clearTtlCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("the same pool, unroutable on both, reads tradeable: false from both backends", async () => {
    // DB side: envio/fixtures.ts's AI/NVDA/POOL identity, seeded fresh and marked unroutable.
    const db = await testDb();
    await upsertQuotes(db, [{ id: ENVIO_NVDA, address: ENVIO_NVDA, symbol: "NVDA", name: "NVIDIA", decimals: 18, enabled: true }], []);
    await upsertTokens(db, [tokenRec(AI, "AI", "LONG", ENVIO_POOL)], ENVIO_NOW);
    await upsertPools(
      db,
      [poolRec(ENVIO_POOL, AI, ENVIO_NVDA, {
        hooks: aiToken.primaryPool!.hooks, fee: aiToken.primaryPool!.fee, tickSpacing: aiToken.primaryPool!.tickSpacing,
        priceQuote: String(aiToken.primaryPool!.priceQuote),
      })],
      ENVIO_NOW,
    );
    await recomputeListedPools(db, "all");
    await db.query("update market.pools set routable = false where id = $1", [ENVIO_POOL]);
    const dbPair = await createDbBackend(db, { now: () => ENVIO_NOW }).pair(AI);
    expect(dbPair?.tradeable).toBe(false);
    await db.end();

    // Envio side: the same pool through TOKEN_QUERY, unroutable through a quoter that refuses it.
    gqlMock.mockImplementation(async (query) => {
      if (query === TOKEN_QUERY) return { Token: [aiToken], QuotePrice: [] } as never;
      if (query.startsWith("query Window")) return {} as never;
      throw new Error("unexpected query");
    });
    const refusingQuoter: Quoter = {
      exactIn: async () => { throw new NotRoutableError("the pool cannot be routed"); },
      exactOut: async () => { throw new Error("exactOut is not used by pair()"); },
    };
    const envioPair = await createEnvioBackend({ quoter: refusingQuoter }).pair(AI);
    expect(envioPair?.tradeable).toBe(false);

    // The point of this test: both backends reach the same verdict for the same pool.
    expect(envioPair?.tradeable).toBe(dbPair?.tradeable);
  });
});
