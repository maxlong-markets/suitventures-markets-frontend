import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { acquireLease, readState, saveCursors } from "@/lib/sync/state";
import { testDb } from "@/test/db";
import type { QuoteFeedConfig } from "./onchain";
import { runChainSync, type ChainClient, type ChainRunDeps, type ChainRunOpts } from "./run";
import { applyFold, readChainCursor } from "./store";
import type { ChainEvent, InitializeEvent, SwapEvent } from "./types";

// Real addresses (config/quotes.json), the same ones src/lib/chain/fold.test.ts uses, so the one test below
// that runs an Initialize+Swap through the real fold (not a fake) classifies and prices exactly as production
// would: AI is a real memestock token used by that file's fixtures, NVDA a real quote row.
const AI = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const DOPPLER = "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544";
const POOL = "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27";
const WALLET = "0x3f8a7c21e9b4d0a6f15c8e2b7d9a4c0e1f6b9a2c";
const Q96 = 2n ** 96n;
// Same AAPL quote/proxy pair src/lib/chain/onchain.test.ts uses for readQuotePrices.
const QUOTE_A = "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9";
const PROXY_A = "0x6b22a786baa607d76728168703a39ea9c99f2cd0";

const hex = (n: number, digits: number) => "0x" + n.toString(16).padStart(digits, "0");
const addr = (n: number) => hex(n, 40);
const txHash = (n: number) => hex(n, 64);

const NOW_MS = 1_789_000_000_000;
const OWNER = "runner";

function baseOpts(over: Partial<ChainRunOpts> = {}): ChainRunOpts & { slept: number[] } {
  let t = NOW_MS;
  const slept: number[] = [];
  return {
    owner: OWNER, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; },
    windowSec: 60, intervalSec: 5, leaseSec: 120, safetyBlocks: 0, maxRequests: 80, slept, ...over,
  };
}

const seedCursor = (db: Db, cursor: number) => saveCursors(db, "chain", { cursor });

/** A token-only fold result, for seeding market.tokens directly through the well-tested applyFold path rather than a hand-written INSERT. */
async function seedToken(db: Db, id: string, now: number): Promise<void> {
  await applyFold(
    db,
    {
      pools: [], candles: [], trades: [], newTokens: [id], ignoredPools: 0, skippedLiquidity: 0,
      tokens: [{ id, address: id, symbol: id.slice(0, 6), name: id, decimals: 18, poolCount: 0, origin: "Other", primaryPoolId: null, createdAt: now, metadataLoaded: false }],
    },
    1,
    now,
  );
}

type Batch = { events: ChainEvent[]; nextBlock: number } | { throws: Error };

/** A LogSource whose fetch() responses are keyed by the exact fromBlock requested — deterministic given a test's known cursor progression, never a fragile call counter. Unregistered blocks default to an empty, fully-covering response. */
class FakeLogSource {
  private _requests = 0;
  headValue: number;
  headThrows: Error | null = null;
  private batches: Map<number, Batch>;

  constructor(opts: { head: number; batches?: Record<number, Batch> }) {
    this.headValue = opts.head;
    this.batches = new Map(Object.entries(opts.batches ?? {}).map(([k, v]) => [Number(k), v]));
  }

  async head(): Promise<number> {
    this._requests += 1;
    if (this.headThrows) throw this.headThrows;
    return this.headValue;
  }

  async fetch(fromBlock: number, toBlock: number): Promise<{ events: ChainEvent[]; nextBlock: number }> {
    this._requests += 1;
    const batch = this.batches.get(fromBlock);
    if (batch && "throws" in batch) throw batch.throws;
    if (batch) return batch;
    return { events: [], nextBlock: toBlock + 1 };
  }

  get requests(): number {
    return this._requests;
  }
}

type TokenFixture = { symbol: string; name: string; decimals: number; totalSupply?: bigint };
type QuoteFixture = readonly [bigint, bigint, bigint, bigint, bigint]; // roundId, answer, startedAt, updatedAt, answeredInRound

/** A ChainClient (readContract only) keyed by lowercase address, for both readTokenMetadata and readQuotePrices — an address with no fixture throws, which readTokenMetadata/readQuotePrices both already treat as a normal per-item failure (their own tests cover that; this file is about run.ts's orchestration, not their decode logic). */
function fakeChainClient(opts: { tokens?: Record<string, TokenFixture>; quotes?: Record<string, QuoteFixture> } = {}): ChainClient & { calls: { address: string; functionName: string }[] } {
  const tokens = opts.tokens ?? {};
  const quotes = opts.quotes ?? {};
  const calls: { address: string; functionName: string }[] = [];
  return {
    calls,
    readContract: (async (args: { address: string; functionName: string }) => {
      const address = args.address.toLowerCase();
      calls.push({ address, functionName: args.functionName });
      if (args.functionName === "latestRoundData") {
        const q = quotes[address];
        if (!q) throw new Error(`fakeChainClient: no quote fixture for ${address}`);
        return q;
      }
      const t = tokens[address];
      if (!t) throw new Error(`fakeChainClient: no token fixture for ${address}`);
      switch (args.functionName) {
        case "symbol":
          return t.symbol;
        case "name":
          return t.name;
        case "decimals":
          return t.decimals;
        case "totalSupply":
          if (t.totalSupply === undefined) throw new Error(`fakeChainClient: no totalSupply fixture for ${address}`);
          return t.totalSupply;
        default:
          throw new Error(`fakeChainClient: unexpected functionName ${args.functionName}`);
      }
    }) as unknown as ChainClient["readContract"],
  };
}

function chainDeps(over: Partial<ChainRunDeps> & { source: FakeLogSource }): ChainRunDeps {
  return { client: fakeChainClient(), quotes: [], ...over };
}

function initEvent(over: Partial<InitializeEvent> = {}): InitializeEvent {
  return {
    kind: "initialize", block: 100, logIndex: 0, timestamp: 1_700_000_100, txHash: hex(0, 64), txFrom: null,
    poolId: POOL, currency0: AI, currency1: NVDA, fee: 8_388_608, tickSpacing: 8, hooks: DOPPLER, sqrtPriceX96: Q96, tick: 0,
    ...over,
  };
}
function swapEvent(over: Partial<SwapEvent> = {}): SwapEvent {
  return {
    kind: "swap", block: 101, logIndex: 0, timestamp: 1_700_000_160, txHash: txHash(1), txFrom: WALLET,
    poolId: POOL, amount0: 2_000_000n, amount1: -(10n ** 18n), sqrtPriceX96: 2n * Q96, liquidity: 10n ** 18n, tick: 0, fee: 3000,
    ...over,
  };
}

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(() =>
  db.exec(
    "delete from market.quotes; delete from market.tokens; delete from market.pools; delete from market.swaps; delete from market.candles; delete from market.sync_state",
  ),
);

describe("runChainSync: lease and cursor guards", () => {
  it("returns { skipped: \"lease\" } and touches nothing else when another owner holds the chain lease", async () => {
    await acquireLease(db, "chain", "other", 1_789_000_000, 120);
    const source = new FakeLogSource({ head: 1000 });
    const report = await runChainSync(db, chainDeps({ source }), baseOpts());
    expect(report).toEqual({
      skipped: "lease", cycles: 0, blocks: 0, events: 0, trades: 0, newTokens: 0, ignoredPools: 0,
      skippedLiquidity: 0, requests: 0, quotesRefreshed: 0, metadataRetried: 0, metadataFailed: 0, cursor: 0, error: null,
    });
    expect(source.requests).toBe(0);
    expect((await readState(db, "chain")).leaseOwner).toBe("other");
  });

  it("reports the real stored cursor on a lease skip, not the zeroed report's default (review fix round 1, item 5)", async () => {
    await seedCursor(db, 6500); // a real, already-advanced cursor — distinct from "never initialised"
    await acquireLease(db, "chain", "other", 1_789_000_000, 120);
    const source = new FakeLogSource({ head: 1000 });
    const report = await runChainSync(db, chainDeps({ source }), baseOpts());
    // 0 here would read exactly like the genesis refusal (a different, thrown condition entirely) rather
    // than a routine overlap with another invocation.
    expect(report).toMatchObject({ skipped: "lease", cursor: 6500 });
    expect(source.requests).toBe(0); // still touches nothing on the source itself
  });

  it("refuses a never-initialised cursor (0) rather than fold from genesis, and still releases the lease", async () => {
    const source = new FakeLogSource({ head: 1000 });
    await expect(runChainSync(db, chainDeps({ source }), baseOpts())).rejects.toThrow(
      "chain cursor not initialised: run the catch-up script",
    );
    expect((await readState(db, "chain")).leaseOwner).toBeNull();
  });
});

describe("runChainSync: the fetch/fold/apply loop", () => {
  it("runs a clean multi-cycle invocation, advancing the cursor exactly to nextBlock - 1 each time (including a response that covers fewer blocks than asked)", async () => {
    await seedCursor(db, 1000);
    const source = new FakeLogSource({
      head: 1030,
      batches: {
        1001: { events: [], nextBlock: 1008 }, // covers only up to 1007: fewer blocks than the 1001-1010 asked
      },
    });
    const opts = baseOpts({ maxSpan: 10, maxRequests: 6 }); // 3 cycles x (head + fetch) = 6
    const report = await runChainSync(db, chainDeps({ source }), opts);

    expect(report.error).toBeNull();
    expect(report.cycles).toBe(3);
    // cycle 1: 1001-1010 asked, capped at nextBlock 1008 -> cursor 1007 (not 1010).
    // cycle 2: 1008-1017 (maxSpan 10) -> default full coverage -> cursor 1017.
    // cycle 3: 1018-1027 -> cursor 1027.
    expect(report.cursor).toBe(1027);
    expect(report.blocks).toBe(1027 - 1000);
    expect(await readChainCursor(db)).toBe(1027);
    expect(source.requests).toBe(6);
    expect(opts.slept).toEqual([]); // never idle: always real work to do
  });

  it("does nothing and sleeps, instead of fetching, when the fetch target is not past the cursor — clamped to what is left of the window (review fix round 1, item 2)", async () => {
    await seedCursor(db, 500);
    const source = new FakeLogSource({ head: 500 }); // target (safetyBlocks 0) == cursor: nothing to do
    // intervalSec (10s) alone would sleep past the 5s window; the clamp caps it at what's left (5s) instead,
    // so the very next top-of-loop check ends the invocation on the window rather than overrunning it.
    const opts = baseOpts({ windowSec: 5, intervalSec: 10 });
    const report = await runChainSync(db, chainDeps({ source }), opts);

    expect(report.cycles).toBe(0);
    expect(report.cursor).toBe(500);
    expect(opts.slept).toEqual([5_000]);
    expect(source.requests).toBe(1); // head() only, never fetch()
    expect(await readChainCursor(db)).toBe(500);
  });

  it("does not clamp the idle sleep when the window has plenty of room left", async () => {
    await seedCursor(db, 700);
    const source = new FakeLogSource({ head: 700 });
    // A budget of 1 stops the loop right after the single head() this idle pass costs (checked at the top of
    // the next iteration), so this exercises exactly one sleep without the test waiting out a 60 s window.
    const opts = baseOpts({ windowSec: 60, intervalSec: 10, maxRequests: 1 });
    await runChainSync(db, chainDeps({ source }), opts);
    expect(opts.slept).toEqual([10_000]); // the full intervalSec: 50 s was left, well more than 10 s
  });

  it("stops fetching once the request budget is spent, short of the chain head", async () => {
    await seedCursor(db, 2000);
    const source = new FakeLogSource({ head: 2100 }); // far more work available than the budget allows
    const opts = baseOpts({ maxSpan: 10, maxRequests: 4 }); // 2 cycles x (head + fetch) = 4
    const report = await runChainSync(db, chainDeps({ source }), opts);

    expect(report.cycles).toBe(2);
    expect(report.cursor).toBe(2020); // 2000 + 10 + 10, well short of the 2100 head
    expect(report.requests).toBe(4);
    expect(source.requests).toBe(4); // never attempted a 3rd cycle's head() call
    expect(await readChainCursor(db)).toBe(2020);
  });

  it("on a throw mid-cycle, leaves the cursor at the last successful cycle's and records the error, still releasing the lease", async () => {
    await seedCursor(db, 3000);
    const boom = new Error("HyperSync request failed with status 500");
    const source = new FakeLogSource({
      head: 3050,
      batches: { 3011: { throws: boom } }, // cycle 2's fetch(3011, 3020) fails; cycle 1 succeeds
    });
    const opts = baseOpts({ maxSpan: 10 });
    const report = await runChainSync(db, chainDeps({ source }), opts);

    expect(report.error).toBe("HyperSync request failed with status 500");
    expect(report.cycles).toBe(1);
    expect(report.cursor).toBe(3010); // cycle 1's progress stands; cycle 2 never wrote anything
    expect(await readChainCursor(db)).toBe(3010);
    const state = await readState(db, "chain");
    expect(state.lastError).toBe("HyperSync request failed with status 500");
    expect(state.leaseOwner).toBeNull();
  });

  it("a thrown head() error is recorded the same way, with the cursor untouched", async () => {
    await seedCursor(db, 4000);
    const source = new FakeLogSource({ head: 4050 });
    source.headThrows = new Error("HyperSync rejected the API token");
    const report = await runChainSync(db, chainDeps({ source }), baseOpts());

    expect(report.error).toBe("HyperSync rejected the API token");
    expect(report.cycles).toBe(0);
    expect(report.cursor).toBe(4000);
    expect(await readChainCursor(db)).toBe(4000);
  });
});

describe("runChainSync: metadata read before the fold", () => {
  it("a token created and swapped in the same batch is priced with the read decimals, not the 18-decimals fallback", async () => {
    await seedCursor(db, 99);
    const events = [initEvent(), swapEvent()];
    const source = new FakeLogSource({ head: 200, batches: { 100: { events, nextBlock: 102 } } });
    const client = fakeChainClient({ tokens: { [AI]: { symbol: "AI", name: "AI Token", decimals: 6, totalSupply: 500_000n } } });
    const opts = baseOpts({ maxSpan: 150, maxRequests: 2 }); // exactly the one cycle this needs

    const report = await runChainSync(db, chainDeps({ source, client }), opts);

    expect(report.error).toBeNull();
    expect(report.newTokens).toBe(1);
    expect(report.trades).toBe(1);
    // readTokenMetadata was actually called for AI before the fold produced a trade at all.
    expect(client.calls.some((c) => c.address === AI && c.functionName === "decimals")).toBe(true);

    const tokenRow = (await db.query<{ decimals: number; symbol: string; metadata_loaded: boolean; total_supply: string }>(
      "select decimals, symbol, metadata_loaded, total_supply from market.tokens where id = $1",
      [AI],
    ))[0]!;
    expect(tokenRow).toEqual({ decimals: 6, symbol: "AI", metadata_loaded: true, total_supply: "500000" });

    // raw amount0 = 2_000_000n: 2 tokens at 6 decimals; 2e-12 at the fallback 18 decimals this must NOT use.
    const tradeRow = (await db.query<{ amount_token: number }>("select amount_token from market.swaps where tx_hash = $1", [txHash(1)]))[0]!;
    expect(tradeRow.amount_token).toBeCloseTo(2, 9);
  });
});

describe("runChainSync: quote refresh", () => {
  it("refreshes quote prices once per invocation, not once per cycle", async () => {
    await seedCursor(db, 5000);
    await db.query(
      `insert into market.quotes (id, address, symbol, name, decimals, enabled) values ($1, $1, 'AAPL', 'Apple', 18, true)`,
      [QUOTE_A],
    );
    const source = new FakeLogSource({ head: 5030 });
    const client = fakeChainClient({ quotes: { [PROXY_A]: [1n, 22_440_000_000n, 1_700_000_000n, 1_700_000_005n, 1n] } });
    const quotes: QuoteFeedConfig[] = [{ address: QUOTE_A, chainlinkProxy: PROXY_A, chainlinkDecimals: 8 }];
    const opts = baseOpts({ maxSpan: 10, maxRequests: 6, quoteRefreshSec: 60 }); // 3 cycles, all at the same opts.now()

    const report = await runChainSync(db, chainDeps({ source, client, quotes }), opts);

    expect(report.cycles).toBe(3);
    expect(report.quotesRefreshed).toBe(1);
    const latestRoundDataCalls = client.calls.filter((c) => c.functionName === "latestRoundData");
    expect(latestRoundDataCalls).toHaveLength(1); // not once per cycle
    const row = (await db.query<{ usd_price: number }>("select usd_price from market.quotes where id = $1", [QUOTE_A]))[0]!;
    expect(row.usd_price).toBeCloseTo(224.4, 6);
  });
});

describe("runChainSync: metadata retry sweep", () => {
  it("stamps an hour ahead on a failed read and clears the retry on a successful one", async () => {
    const FAILS = addr(0xf1);
    const OK = addr(0xf2);
    await seedToken(db, FAILS, 1_700_000_000);
    await seedToken(db, OK, 1_700_000_000);
    await seedCursor(db, 9000);

    const source = new FakeLogSource({ head: 9000 }); // target == cursor: the main loop does nothing
    const client = fakeChainClient({ tokens: { [OK]: { symbol: "XYZ", name: "XYZ Token", decimals: 8, totalSupply: 12_345n } } });
    const opts = baseOpts({ stopWhenCaughtUp: true, metadataRetryLimit: 50 });

    const report = await runChainSync(db, chainDeps({ source, client }), opts);

    expect(report.error).toBeNull();
    expect(report.cycles).toBe(0);
    // Review fix round 1, item 4: proves stopWhenCaughtUp actually broke the loop rather than idling it away —
    // without this, a mutation that ignored the flag would still land on cycles: 0 (twelve 5 s sleeps inside
    // the 60 s window looks identical from that field alone) and this test would not catch it.
    expect(opts.slept).toEqual([]);
    expect(report.metadataRetried).toBe(1);
    expect(report.metadataFailed).toBe(1);

    const nowSec = Math.floor(NOW_MS / 1000);
    const failedRow = (await db.query<{ metadata_loaded: boolean; metadata_retry_at: number }>(
      "select metadata_loaded, metadata_retry_at from market.tokens where id = $1",
      [FAILS],
    ))[0]!;
    expect(failedRow).toEqual({ metadata_loaded: false, metadata_retry_at: nowSec + 3600 });

    const okRow = (await db.query<{ metadata_loaded: boolean; metadata_retry_at: number; symbol: string; decimals: number; total_supply: string }>(
      "select metadata_loaded, metadata_retry_at, symbol, decimals, total_supply from market.tokens where id = $1",
      [OK],
    ))[0]!;
    expect(okRow).toEqual({ metadata_loaded: true, metadata_retry_at: 0, symbol: "XYZ", decimals: 8, total_supply: "12345" });
  });
});
