import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { FakeSource } from "@/lib/sync/fakeSource";
import type { BalanceRec, CandleRec, PoolRec, SwapRec, TokenRec } from "@/lib/sync/source";
import { readState } from "@/lib/sync/state";
import { insertSwaps, markSynced, upsertPools } from "@/lib/sync/writers";
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
});
const swap = (tx: string): SwapRec => ({
  id: `${tx}-0`, pool_id: POOL_A, token_id: TOKEN_A, timestamp: NOW, side: "buy", amountToken: "1", amountQuote: "1", priceQuote: "1", wallet: hex("5", 40), txHash: tx,
});
const candle = (poolId: string, t: number): CandleRec => ({ id: `${poolId}-m1-${t}`, pool_id: poolId, t, open: "1", high: "1", low: "1", close: "1", volumeQuote: "1", volumeToken: "1", trades: 1 });
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
    // Every pool's history is stored up to the seed's start; the first cycles fetch from 600 s before it.
    expect(await db.query("select id, synced_to from market.pools order by id")).toEqual([{ id: POOL_A, synced_to: NOW - 600 }, { id: POOL_B, synced_to: NOW - 600 }]);
    const market = await readState(db, "market");
    expect([market.cursor, market.cursor2]).toEqual([NOW - 600, NOW - 600]);
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

  it("finish stamps every pool's watermark at the start minus 600 s and never lowers one", async () => {
    const fresh = await testDb();
    await upsertPools(fresh, data.pools, NOW);
    await markSynced(fresh, [POOL_B], NOW + 5);
    const checkpoint: Checkpoint = { startedAt: NOW, phase: "finish", ranges: {}, done: ["quotes", "tokens", "pools", "swaps", "candles", "balances"] };
    await runSeed(fresh, new FakeSource(data), seedOpts(checkpoint, []));
    expect(await fresh.query("select id, synced_to from market.pools order by id")).toEqual([{ id: POOL_A, synced_to: NOW - 600 }, { id: POOL_B, synced_to: NOW + 5 }]);
    await fresh.end();
  });
});
