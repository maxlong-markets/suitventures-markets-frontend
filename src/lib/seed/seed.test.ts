import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbUnavailableError, type Db } from "@/lib/db/client";
import { FakeSource } from "@/lib/sync/fakeSource";
import type { IndexerInterval } from "@/lib/sync/ids";
import { candleCutoff, retentionCutoff } from "@/lib/sync/retention";
import type { BalanceRec, CandleRec, PoolRec, SwapRec, TokenRec } from "@/lib/sync/source";
import { readState } from "@/lib/sync/state";
import { insertSwaps, markSynced, upsertPools, upsertTokens } from "@/lib/sync/writers";
import { testDb } from "@/test/db";
import { idRanges, newCheckpoint, runSeed, SEED_PHASES, type Checkpoint } from "./seed";

const NOW = 1_789_547_000;
const hex = (c: string, len: number) => `0x${c.repeat(len)}`;
const count = async (db: Db, table: string) => Number((await db.query<{ n: unknown }>(`select count(*) as n from market.${table}`))[0]!.n);

describe("idRanges", () => {
  it("splits the hex space into contiguous prefix ranges, the last open-ended", () => {
    expect(idRanges(3)).toEqual([
      { key: "r0", from: "0x0", to: "0x5" }, { key: "r1", from: "0x5", to: "0xa" }, { key: "r2", from: "0xa", to: null },
    ]);
  });
  it("places every 0x id in exactly one range for any worker count", () => {
    const ids = ["0x0000", "0x4fff", "0x5000", "0x9abc", "0xa000", "0xffff"];
    for (const n of [1, 2, 3, 5, 16, 40]) {
      const ranges = idRanges(n);
      expect(ranges).toHaveLength(Math.min(n, 16));
      expect(ranges[0]!.from).toBe("0x0");
      expect(ranges[ranges.length - 1]!.to).toBeNull();
      for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.from).toBe(ranges[i - 1]!.to);
      for (const id of ids) expect(ranges.filter((r) => id > r.from && (r.to === null || id < r.to))).toHaveLength(1);
    }
  });
});

const TOKEN_A = hex("1", 40), TOKEN_B = hex("c", 40), POOL_A = hex("1", 64), POOL_B = hex("c", 64), QUOTE = hex("9", 40);
const token = (id: string, pool: string): TokenRec => ({
  id, address: id, symbol: "T", name: "T", decimals: 18, totalSupply: "1000", holdersCount: 3, poolCount: 1, origin: "LONG",
  createdAt: NOW - 100, primaryPool_id: pool, metadataLoaded: true,
});
const pool = (id: string, tokenId: string): PoolRec => ({
  id, token_id: tokenId, quote_id: QUOTE, tokenIsCurrency0: true, hooks: hex("0", 40), fee: 3000, tickSpacing: 60, origin: "LONG",
  createdAt: NOW - 100, priceQuote: "1", tvlToken: null, tvlQuote: null, swapCount: 2, lastSwapAt: NOW - 50, volumeQuoteAllTime: "1",
  sqrtPriceX96: null,
});
const swap = (tx: string, timestamp = NOW): SwapRec => ({
  id: `${tx}-0`, pool_id: POOL_A, token_id: TOKEN_A, timestamp, side: "buy", amountToken: "1", amountQuote: "1", priceQuote: "1", wallet: hex("5", 40), txHash: tx,
});
/** interval defaults to "m1" so every existing call site keeps its id shape. */
const candle = (poolId: string, t: number, interval: IndexerInterval = "m1"): CandleRec => ({
  id: `${poolId}-${interval}-${t}`, pool_id: poolId, t, open: "1", high: "1", low: "1", close: "1", volumeQuote: "1", volumeToken: "1", trades: 1,
});
const balance = (tokenId: string, holder: string, bal: string): BalanceRec => ({ id: `${tokenId}-${holder}`, token_id: tokenId, holder, balance: bal, updatedAt: NOW });
// Ids spread over the three ranges of idRanges(3): 0x0-0x4, 0x5-0x9, 0xa-0xf. Page limit 2 forces multi-page ranges.
const data = {
  quotes: [{ id: QUOTE, address: QUOTE, symbol: "Q", name: "Q", decimals: 18, enabled: true }],
  prices: [{ id: QUOTE, usdPrice: "1", updatedAt: NOW, aggregator: "pinned" }],
  tokens: [token(TOKEN_A, POOL_A), token(TOKEN_B, POOL_B)],
  pools: [pool(POOL_A, TOKEN_A), pool(POOL_B, TOKEN_B)],
  swaps: [swap(hex("1", 64)), swap(hex("7", 64)), swap(hex("c", 64)), swap(hex("d", 64)), swap(hex("e", 64))],
  candles: [candle(POOL_A, NOW - 60), candle(POOL_A, NOW), candle(POOL_B, NOW - 60), candle(POOL_B, NOW)],
  balances: [balance(TOKEN_A, hex("a", 40), "300"), balance(TOKEN_A, hex("b", 40), "200"), balance(TOKEN_A, hex("c", 40), "100"), balance(TOKEN_B, hex("d", 40), "50")],
  chain: { latestProcessedBlock: 1, blockHeight: 1 },
};
const seedOpts = (checkpoint: Checkpoint, saves: Checkpoint[]) => ({
  checkpoint, save: async (c: Checkpoint) => { saves.push(c); }, workers: 3, pageLimit: 2, holdersKept: 2, log: () => {}, now: () => NOW + 1000,
});

describe("runSeed", () => {
  let db: Db;
  beforeAll(async () => { db = await testDb(); });
  afterAll(() => db.end());

  it("runs every phase, saves the checkpoint after each page, and finishes the store", async () => {
    const saves: Checkpoint[] = [];
    const cp = await runSeed(db, new FakeSource(data), seedOpts(newCheckpoint(NOW), saves));
    expect(cp.done).toEqual([...SEED_PHASES]);
    expect(cp.phase).toBe("finish");
    for (const [table, n] of [["quotes", 1], ["tokens", 2], ["pools", 2], ["swaps", 5], ["candles", 4]] as const) expect(await count(db, table)).toBe(n);
    // Trimmed to holdersKept per token: A keeps its two largest, B its one.
    expect(await db.query("select holder from market.token_balances where token_id = $1 order by balance desc", [TOKEN_A])).toEqual([{ holder: hex("a", 40) }, { holder: hex("b", 40) }]);
    expect(await count(db, "token_balances")).toBe(3);
    expect(await db.query("select id, listed_pool_id from market.tokens order by id")).toEqual([{ id: TOKEN_A, listed_pool_id: POOL_A }, { id: TOKEN_B, listed_pool_id: POOL_B }]);
    // Every pool's history is stored up to the seed's start; the first cycles fetch from an hour before it.
    expect(await db.query("select id, synced_to from market.pools order by id")).toEqual([{ id: POOL_A, synced_to: NOW - 3600 }, { id: POOL_B, synced_to: NOW - 3600 }]);
    const market = await readState(db, "market");
    expect([market.cursor, market.cursor2]).toEqual([NOW - 3600, NOW - 3600]);
    expect((await readState(db, "nightly")).lastOkAt).toBe(NOW + 1000);
    // Swaps walk: r0 one page, r1 one page, r2 two pages (0xc,0xd then 0xe); each page saved with its last id.
    const swapSaves = saves.filter((c) => c.phase === "swaps");
    expect(swapSaves.some((c) => c.ranges.r2 === `${hex("d", 64)}-0`)).toBe(true);
    expect(swapSaves.some((c) => c.ranges.r0 === "done" && c.ranges.r1 === "done" && c.ranges.r2 === "done")).toBe(true);
  });

  it("resumes from a mid-phase checkpoint without re-reading completed phases or ranges", async () => {
    const fresh = await testDb();
    const source = new FakeSource(data);
    const checkpoint: Checkpoint = { startedAt: NOW, phase: "swaps", ranges: { r0: "done", r1: "done", r2: `${hex("c", 64)}-0` }, done: ["quotes", "tokens", "pools"] };
    const cp = await runSeed(fresh, source, seedOpts(checkpoint, []));
    expect(source.calls.filter((c) => c === "quotes" || c === "tokensPage" || c === "poolsPage")).toEqual([]);
    // r2 after 0xc…: one full page (0xd, 0xe), then the short page that ends it.
    expect(source.calls.filter((c) => c === "swapsPage")).toHaveLength(2);
    expect(await fresh.query("select tx_hash from market.swaps order by tx_hash")).toEqual([{ tx_hash: hex("d", 64) }, { tx_hash: hex("e", 64) }]);
    expect(cp.done).toEqual([...SEED_PHASES]);
    expect(await count(fresh, "candles")).toBe(4);
    await fresh.end();
  });

  it("writes only swaps inside the retention window, still advancing the cursor and checkpointing over the old ones", async () => {
    const fresh = await testDb();
    const cutoff = retentionCutoff(NOW);
    const oldTx = hex("5", 64), recentTx = hex("6", 64); // both land in idRanges(3)'s r1 (0x5-0xa)
    const source = new FakeSource({ ...data, swaps: [swap(oldTx, cutoff - 10), swap(recentTx, cutoff + 10)] });
    const checkpoint: Checkpoint = { startedAt: NOW, phase: "swaps", ranges: {}, done: ["quotes", "tokens", "pools"] };
    const cp = await runSeed(fresh, source, seedOpts(checkpoint, []));
    expect(cp.done).toEqual([...SEED_PHASES]);
    expect(await fresh.query("select tx_hash from market.swaps")).toEqual([{ tx_hash: recentTx }]);
    await fresh.end();
  });

  it("a full page of only-old swaps still advances the cursor, and the range ends only when a page comes back short — the phase then completes", async () => {
    const fresh = await testDb();
    const cutoff = retentionCutoff(NOW);
    // All three land in idRanges(3)'s r1 (0x5-0xa); page limit 2 makes [old1, old2] a full, entirely-stale first
    // page. A mutant that filters before pagination sees that page come back empty (0 < 2) and ends the range
    // right there, never reaching the second page `recent` is actually on — asserted directly below via the
    // saved checkpoints, and via the final table, which would then be empty instead of holding `recent`.
    const old1 = hex("6", 64), old2 = hex("7", 64), recent = hex("8", 64);
    const source = new FakeSource({ ...data, swaps: [swap(old1, cutoff - 20), swap(old2, cutoff - 10), swap(recent, cutoff + 10)] });
    const checkpoint: Checkpoint = { startedAt: NOW, phase: "swaps", ranges: {}, done: ["quotes", "tokens", "pools"] };
    const saves: Checkpoint[] = [];
    const cp = await runSeed(fresh, source, seedOpts(checkpoint, saves));
    const swapSaves = saves.filter((c) => c.phase === "swaps");
    // The all-old first page still moved r1's cursor to its own (unfiltered) last id, though it wrote 0 rows.
    expect(swapSaves.some((c) => c.ranges.r1 === `${old2}-0`)).toBe(true);
    // Only the shorter second page ended the range, and the phase — and the whole seed — completed.
    expect(swapSaves.some((c) => c.ranges.r1 === "done")).toBe(true);
    expect(cp.done).toEqual([...SEED_PHASES]);
    expect(await fresh.query("select tx_hash from market.swaps")).toEqual([{ tx_hash: recent }]);
    await fresh.end();
  });

  it("on a checkpoint before the swaps phase has begun, the COPY path's first page writes only the in-window swap of an old-and-in-window mix", async () => {
    const fresh = await testDb();
    const cutoff = retentionCutoff(NOW);
    const oldTx = hex("6", 64), recentTx = hex("7", 64); // both land in idRanges(3)'s r1 (0x5-0xa), same page (limit 2)
    const source = new FakeSource({ ...data, swaps: [swap(oldTx, cutoff - 10), swap(recentTx, cutoff + 10)] });
    // walkRange's `idempotent` on a range's first page is `start !== undefined || opts.checkpoint.phase === phase`,
    // reading the checkpoint runSeed was called with — never reassigned as the run's own `cp.phase` advances. Phase
    // "pools" here (not "swaps", and no stored range cursor) keeps that false, so swaps' first page takes the
    // non-idempotent COPY branch, unlike the retention test above, whose checkpoint is already stamped phase
    // "swaps" and so takes the upsert branch instead (I2's second gap: the COPY path's filter was guarded only by
    // accident).
    const checkpoint: Checkpoint = { startedAt: NOW, phase: "pools", ranges: {}, done: ["quotes", "tokens"] };
    let swapCopyCalls = 0;
    const spied: Db = {
      ...fresh,
      copy: async (table, columns, rows) => {
        if (table === "market.swaps") swapCopyCalls += 1;
        return fresh.copy(table, columns, rows);
      },
    };
    const cp = await runSeed(spied, source, seedOpts(checkpoint, []));
    expect(cp.done).toEqual([...SEED_PHASES]);
    // Confirms the COPY branch actually ran for swaps: ranged()'s write callback is a strict copy-xor-upsert
    // ternary on `idempotent`, so a copy call against market.swaps rules out insertSwaps having run this page.
    expect(swapCopyCalls).toBeGreaterThan(0);
    const rows = await fresh.query<{ tx_hash: string }>("select tx_hash from market.swaps");
    expect(rows).toHaveLength(1);
    expect(rows).toEqual([{ tx_hash: recentTx }]);
    await fresh.end();
  });

  it("writes only candles inside each interval's own retention window, still advancing the cursor and checkpointing over the old ones", async () => {
    const fresh = await testDb();
    const intervals: IndexerInterval[] = ["m1", "m5", "m15", "h1", "d1"];
    // One old (just before its own interval's cutoff) and one recent (just after) candle per interval, all on
    // POOL_A: proves the cutoff is per-row's-own-interval, not one flat cutoff for every candle.
    const oldCandles = intervals.map((iv) => candle(POOL_A, candleCutoff(iv, NOW) - 10, iv));
    const recentCandles = intervals.map((iv) => candle(POOL_A, candleCutoff(iv, NOW) + 10, iv));
    const source = new FakeSource({ ...data, candles: [...oldCandles, ...recentCandles] });
    // checkpoint.phase is already "candles": walkRange's idempotent is true for the first page, so this exercises
    // the upsert path (mirrors the swaps retention test above).
    const checkpoint: Checkpoint = { startedAt: NOW, phase: "candles", ranges: {}, done: ["quotes", "tokens", "pools", "swaps"] };
    const cp = await runSeed(fresh, source, seedOpts(checkpoint, []));
    expect(cp.done).toEqual([...SEED_PHASES]);
    const expected = intervals.map((iv) => ({ interval: iv, t: candleCutoff(iv, NOW) + 10 })).sort((a, b) => a.t - b.t);
    expect(await fresh.query("select interval, t from market.candles order by t")).toEqual(expected);
    await fresh.end();
  });

  it("on a checkpoint before the candles phase has begun, the COPY path's first page writes only the in-window candle of an old-and-in-window mix", async () => {
    const fresh = await testDb();
    const intervals: IndexerInterval[] = ["m1", "m5", "m15", "h1", "d1"];
    const oldCandles = intervals.map((iv) => candle(POOL_A, candleCutoff(iv, NOW) - 10, iv));
    const recentCandles = intervals.map((iv) => candle(POOL_A, candleCutoff(iv, NOW) + 10, iv));
    const source = new FakeSource({ ...data, candles: [...oldCandles, ...recentCandles] });
    // Same mechanism as the swaps COPY-path test above: checkpoint.phase "pools" (not "candles"), no stored range
    // cursor, keeps walkRange's idempotent false once the run reaches candles' first page.
    const checkpoint: Checkpoint = { startedAt: NOW, phase: "pools", ranges: {}, done: ["quotes", "tokens"] };
    let candleCopyCalls = 0;
    const spied: Db = {
      ...fresh,
      copy: async (table, columns, rows) => {
        if (table === "market.candles") candleCopyCalls += 1;
        return fresh.copy(table, columns, rows);
      },
    };
    const cp = await runSeed(spied, source, seedOpts(checkpoint, []));
    expect(cp.done).toEqual([...SEED_PHASES]);
    // Confirms the COPY branch actually ran for candles, the same way the swaps test above confirms it for swaps.
    expect(candleCopyCalls).toBeGreaterThan(0);
    const expected = intervals.map((iv) => ({ interval: iv, t: candleCutoff(iv, NOW) + 10 })).sort((a, b) => a.t - b.t);
    expect(await fresh.query("select interval, t from market.candles order by t")).toEqual(expected);
    await fresh.end();
  });

  it("resumes a phase whose ranges have no stored cursor without copying a landed page twice", async () => {
    const fresh = await testDb();
    // The crash: r1's only page and r2's first page were COPYed, then the process died before either range saved
    // its cursor; the file holds the phase-start checkpoint plus r0's "done".
    await insertSwaps(fresh, [swap(hex("7", 64)), swap(hex("c", 64)), swap(hex("d", 64))]);
    const checkpoint: Checkpoint = { startedAt: NOW, phase: "swaps", ranges: { r0: "done" }, done: ["quotes", "tokens", "pools"] };
    const saves: Checkpoint[] = [];
    const cp = await runSeed(fresh, new FakeSource(data), seedOpts(checkpoint, saves));
    expect(cp.done).toEqual([...SEED_PHASES]);
    // Each landed row once, r2's second page (0xe…) copied fresh, r0 untouched.
    expect(await fresh.query("select tx_hash from market.swaps order by tx_hash")).toEqual([hex("7", 64), hex("c", 64), hex("d", 64), hex("e", 64)].map((tx_hash) => ({ tx_hash })));
    // The checkpoint is saved at phase start, before any page lands, so the next run knows the phase had begun.
    expect(saves[0]).toEqual(checkpoint);
    expect(saves.find((c) => c.phase === "candles")).toEqual({ startedAt: NOW, phase: "candles", ranges: {}, done: ["quotes", "tokens", "pools", "swaps"] });
    await fresh.end();
  });

  it("finish stamps every pool's watermark at the start minus 3600 s and never lowers one", async () => {
    const fresh = await testDb();
    await upsertPools(fresh, data.pools, NOW);
    await markSynced(fresh, [POOL_B], NOW + 5);
    const checkpoint: Checkpoint = { startedAt: NOW, phase: "finish", ranges: {}, done: ["quotes", "tokens", "pools", "swaps", "candles", "balances"] };
    await runSeed(fresh, new FakeSource(data), seedOpts(checkpoint, []));
    expect(await fresh.query("select id, synced_to from market.pools order by id")).toEqual([{ id: POOL_A, synced_to: NOW - 3600 }, { id: POOL_B, synced_to: NOW + 5 }]);
    await fresh.end();
  });

  it("balances phase resumes from the stored token id cursor, fetching top holders only for the tokens after it", async () => {
    const fresh = await testDb();
    // As the (already-"done") tokens phase would have left them: both qualify (holders_count > 0).
    await upsertTokens(fresh, data.tokens, NOW);
    const source = new FakeSource(data);
    // Mid-balances checkpoint: a previous run's batch already completed through TOKEN_A.
    const checkpoint: Checkpoint = { startedAt: NOW, phase: "balances", ranges: { all: TOKEN_A }, done: ["quotes", "tokens", "pools", "swaps", "candles"] };
    await runSeed(fresh, source, seedOpts(checkpoint, []));
    // One batch only, and only for the token after the stored cursor: TOKEN_A's own holders are never fetched.
    expect(source.calls.filter((c) => c === "topHoldersBatch")).toHaveLength(1);
    expect(await fresh.query("select distinct token_id from market.token_balances")).toEqual([{ token_id: TOKEN_B }]);
    await fresh.end();
  });

  it("a checkpoint whose done already lists a later phase skips it outright, even though checkpoint.phase itself is earlier", async () => {
    const fresh = await testDb();
    const source = new FakeSource(data);
    // The operator's snapshot-run shape (task brief item 6): phase "quotes" (the very first phase) with "swaps"
    // already in done, so the whole run must skip swaps wherever the loop reaches it, never fetching a page.
    const checkpoint: Checkpoint = { startedAt: NOW, phase: "quotes", ranges: {}, done: ["swaps"] };
    const cp = await runSeed(fresh, source, seedOpts(checkpoint, []));
    expect(source.calls).not.toContain("swapsPage");
    expect(await count(fresh, "swaps")).toBe(0);
    // Every phase ran exactly once — same seven phases as SEED_PHASES, "swaps" included (it was already done),
    // order aside: the loop never re-appends a phase that started in `done`.
    expect(cp.done).toHaveLength(SEED_PHASES.length);
    expect([...cp.done].sort()).toEqual([...SEED_PHASES].sort());
    // Every other phase still ran normally, immediately before and after the skipped one.
    for (const [table, n] of [["quotes", 1], ["tokens", 2], ["pools", 2], ["candles", 4]] as const) expect(await count(fresh, table)).toBe(n);
    await fresh.end();
  });
});

describe("runSeed on a dropped connection", () => {
  it("retries the page through the idempotent path and logs the retry", async () => {
    const fresh = await testDb();
    try {
      let dropped = 0;
      const flaky: Db = {
        ...fresh,
        copy: async (table, columns, rows) => {
          if (dropped++ === 0) throw new DbUnavailableError("database unavailable (CONNECTION_CLOSED)");
          return fresh.copy(table, columns, rows);
        },
      };
      const logs: string[] = [];
      const cp = await runSeed(flaky, new FakeSource(data), { ...seedOpts(newCheckpoint(NOW), []), retryDelayMs: 0, log: (line) => logs.push(line) });
      expect(cp.done).toEqual([...SEED_PHASES]);
      expect(await count(fresh, "swaps")).toBe(5);
      expect(logs.filter((l) => l.includes("retry 1 of 3"))).toHaveLength(1);
    } finally {
      await fresh.end();
    }
  });
  it("gives up after the last attempt", async () => {
    const fresh = await testDb();
    try {
      // A dead copy alone is survivable (the retry moves to the upsert path); a dead query is not.
      const dead: Db = { ...fresh, query: async () => { throw new DbUnavailableError("database unavailable (CONNECTION_CLOSED)"); } };
      const logs: string[] = [];
      await expect(runSeed(dead, new FakeSource(data), { ...seedOpts(newCheckpoint(NOW), []), retryDelayMs: 0, log: (line) => logs.push(line) })).rejects.toThrow("CONNECTION_CLOSED");
      expect(logs.filter((l) => l.includes("; retry "))).toHaveLength(3);
    } finally {
      await fresh.end();
    }
  });
});

describe("runSeed when one range fails for good", () => {
  it("stops the other ranges and surfaces the failure once they have stopped", async () => {
    const fresh = await testDb();
    try {
      let copies = 0;
      const broken: Db = {
        ...fresh,
        copy: async (table, columns, rows) => {
          copies += 1;
          if (table === "market.swaps") throw new Error("boom");
          return fresh.copy(table, columns, rows);
        },
      };
      await expect(runSeed(broken, new FakeSource(data), seedOpts(newCheckpoint(NOW), []))).rejects.toThrow("boom");
      // Every range tried at most one page: the first failure stops the rest before their next page.
      expect(copies).toBeLessThanOrEqual(3);
      expect(await count(fresh, "swaps")).toBe(0);
    } finally {
      await fresh.end();
    }
  });
});
