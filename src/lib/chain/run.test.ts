import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { acquireLease, readState, saveCursors } from "@/lib/sync/state";
import { testDb } from "@/test/db";
import type { QuoteFeedConfig } from "./onchain";
import { runChainSync, type ChainClient, type ChainRunDeps, type ChainRunOpts } from "./run";
import { applyFold, readChainCursor } from "./store";
import type { ChainEvent, InitializeEvent, PayoutChangedEvent, SwapEvent, TransferEvent } from "./types";

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
      pools: [], candles: [], trades: [], newTokens: [id], ignoredPools: 0, orphanedTokens: 0, skippedLiquidity: 0,
      launches: [], launchFees: [], payouts: [], launchEvents: 0,
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

  async transfers(): Promise<{ transfers: TransferEvent[]; nextBlock: number }> {
    throw new Error("FakeLogSource.transfers: not used by the reader's tests");
  }

  get requests(): number {
    return this._requests;
  }
}

type TokenFixture = { symbol: string; name: string; decimals: number; totalSupply?: bigint };
type QuoteFixture = readonly [bigint, bigint, bigint, bigint, bigint]; // roundId, answer, startedAt, updatedAt, answeredInRound

/**
 * A ChainClient (readContract only) keyed by lowercase address, for readTokenMetadata,
 * readQuotePrices, AND readBalances — an address (or, for balances, a token-wallet pair) with no
 * fixture throws, which all three already treat as a normal per-item failure (their own tests cover
 * that; this file is about run.ts's orchestration, not their decode logic). `balances` is keyed
 * `${token}-${wallet}`, both lowercase, matching readBalances' own map convention; a fixture is either
 * a plain `bigint` (returned regardless of `blockNumber` — fine when a test does not care which of the
 * now-two reads, before or after, it is answering) or a function of `blockNumber` returning a `bigint`
 * (a real balance at that block) or `undefined` (no fixture at that block — a per-pair failure, same as
 * an absent key). `onBalanceCall` (if given) is invoked with each call's `blockNumber` so a test can
 * assert exactly which blocks were asked for.
 */
function fakeChainClient(
  opts: {
    tokens?: Record<string, TokenFixture>;
    quotes?: Record<string, QuoteFixture>;
    balances?: Record<string, bigint | ((blockNumber: bigint | undefined) => bigint | undefined)>;
    onBalanceCall?: (blockNumber: bigint | undefined) => void;
  } = {},
): ChainClient & { calls: { address: string; functionName: string }[] } {
  const tokens = opts.tokens ?? {};
  const quotes = opts.quotes ?? {};
  const balances = opts.balances ?? {};
  const calls: { address: string; functionName: string }[] = [];
  return {
    calls,
    readContract: (async (args: { address: string; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      const address = args.address.toLowerCase();
      calls.push({ address, functionName: args.functionName });
      if (args.functionName === "latestRoundData") {
        const q = quotes[address];
        if (!q) throw new Error(`fakeChainClient: no quote fixture for ${address}`);
        return q;
      }
      if (args.functionName === "balanceOf") {
        opts.onBalanceCall?.(args.blockNumber);
        const wallet = String(args.args?.[0]).toLowerCase();
        const key = `${address}-${wallet}`;
        const entry = balances[key];
        const balance = typeof entry === "function" ? entry(args.blockNumber) : entry;
        if (balance === undefined) throw new Error(`fakeChainClient: no balance fixture for ${key} at block ${String(args.blockNumber)}`);
        return balance;
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
      skipped: "lease", cycles: 0, blocks: 0, events: 0, trades: 0, newTokens: 0, ignoredPools: 0, orphanedTokens: 0,
      skippedLiquidity: 0, launchEvents: 0, holderDeltaApplied: 0, holderReadsUnknown: 0, requests: 0, quotesRefreshed: 0,
      metadataRetried: 0, metadataFailed: 0, cursor: 0, error: null,
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

describe("runChainSync: yields to the nightly (final review MAJOR)", () => {
  it('returns { skipped: "nightly" } and touches nothing else while the nightly holds its lease, releasing its own lease again', async () => {
    await seedCursor(db, 1000);
    const nowSec = Math.floor(NOW_MS / 1000);
    await acquireLease(db, "nightly", "night", nowSec, 300); // leaseUntil = nowSec + 300, well past startMs
    const source = new FakeLogSource({ head: 1030 });
    const report = await runChainSync(db, chainDeps({ source }), baseOpts());
    expect(report).toEqual({
      skipped: "nightly", cycles: 0, blocks: 0, events: 0, trades: 0, newTokens: 0, ignoredPools: 0, orphanedTokens: 0,
      skippedLiquidity: 0, launchEvents: 0, holderDeltaApplied: 0, holderReadsUnknown: 0, requests: 0, quotesRefreshed: 0,
      metadataRetried: 0, metadataFailed: 0, cursor: 1000, error: null,
    });
    expect(source.requests).toBe(0); // never asked the source for anything, not even head()
    // Its own chain lease was taken and then given straight back, not left held for the nightly's duration.
    expect((await readState(db, "chain")).leaseOwner).toBeNull();
    expect((await readState(db, "nightly")).leaseOwner).toBe("night"); // untouched
  });

  it("does not yield once the nightly's lease has lapsed: it acquires normally and asks the source", async () => {
    await seedCursor(db, 1000);
    const nowSec = Math.floor(NOW_MS / 1000);
    await acquireLease(db, "nightly", "night", nowSec - 1000, 300); // leaseUntil = nowSec - 700, already expired
    const source = new FakeLogSource({ head: 1000 }); // caught up either way; only the yield-or-not is under test
    const report = await runChainSync(db, chainDeps({ source }), baseOpts({ maxRequests: 1 }));
    expect(report.skipped).toBeNull();
    expect(source.requests).toBe(1); // proceeded to call head(), proving it did not yield
    expect((await readState(db, "chain")).leaseOwner).toBeNull(); // released normally at the end
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

describe("runChainSync: holder-count upkeep (fix round 1 — observe both balances, derive nothing)", () => {
  const WALLET_2 = addr(0xc2);
  const holdersOf = async (id: string) =>
    (await db.query<{ holders_count: number }>("select holders_count from market.tokens where id = $1", [id]))[0]!.holders_count;
  const tokenFixture = { [AI]: { symbol: "AI", name: "AI Token", decimals: 18, totalSupply: 1_000_000n } };
  const balanceOfCalls = (client: { calls: { functionName: string }[] }) => client.calls.filter((c) => c.functionName === "balanceOf");
  const sortedBlocks = (arr: (bigint | undefined)[]) =>
    [...arr].sort((a, b) => (a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1));

  it("normal mode: a buy from a wallet with a zero balance before the trade is a new holder (+1), reading BOTH before (cursor 99) and after (this batch's last block, 101)", async () => {
    await seedCursor(db, 99);
    const events = [initEvent(), swapEvent()]; // amount0 2_000_000n > 0 -> a buy of AI (currency0) by WALLET
    const source = new FakeLogSource({ head: 200, batches: { 100: { events, nextBlock: 102 } } });
    const blockNumbers: (bigint | undefined)[] = [];
    const client = fakeChainClient({
      tokens: tokenFixture,
      balances: { [`${AI}-${WALLET}`]: (b) => (b === 99n ? 0n : b === 101n ? 2_000_000n : undefined) },
      onBalanceCall: (b) => blockNumbers.push(b),
    });
    const opts = baseOpts({ maxSpan: 150, maxRequests: 2 });

    const report = await runChainSync(db, chainDeps({ source, client }), opts);

    expect(report.error).toBeNull();
    expect(report.holderDeltaApplied).toBe(1);
    expect(report.holderReadsUnknown).toBe(0);
    // brand-new token inserted at 0, then this cycle's own +1 delta applied on top (store.test.ts pins the ordering).
    expect(await holdersOf(AI)).toBe(1);
    // TEST-3 (review): both sides pinned exactly, not just "some call happened".
    expect(sortedBlocks(blockNumbers)).toEqual(sortedBlocks([99n, 101n]));
  });

  it("normal mode: a full sell to zero is one fewer holder (-1), from an OBSERVED after balance", async () => {
    await seedToken(db, AI, 1_700_000_000); // AI already exists before this cycle, so its baseline below survives the fold
    await db.query("update market.tokens set holders_count = 3 where id = $1", [AI]);
    await seedCursor(db, 99);

    const events = [initEvent(), swapEvent({ txHash: hex(2, 64), amount0: -500n, amount1: 300n })];
    const source = new FakeLogSource({ head: 200, batches: { 100: { events, nextBlock: 102 } } });
    const client = fakeChainClient({
      tokens: tokenFixture,
      balances: { [`${AI}-${WALLET}`]: (b) => (b === 99n ? 500n : b === 101n ? 0n : undefined) },
    });
    const opts = baseOpts({ maxSpan: 150, maxRequests: 2 });

    const report = await runChainSync(db, chainDeps({ source, client }), opts);

    expect(report.error).toBeNull();
    expect(report.holderDeltaApplied).toBe(1);
    expect(await holdersOf(AI)).toBe(2); // 3 - 1
  });

  it("MAJOR-3 regression: a router/hook fee taken in the token still resolves correctly, because 'after' is OBSERVED rather than derived from the pool's emitted amount", async () => {
    await seedToken(db, AI, 1_700_000_000);
    await db.query("update market.tokens set holders_count = 1 where id = $1", [AI]);
    await seedCursor(db, 99);

    // The wallet hands the router 500 tokens; the router (or a hook, e.g. our own SVRouter's 0.5% fee)
    // keeps a cut and the POOL only ever sees 495 leave. The deleted derivation (before + the pool's own
    // emitted delta) would have computed after = 500 + (-495) = 5n — nonzero, missing the exit entirely.
    // The wallet's REAL balance is 0: all 500 left it, fee included.
    const events = [initEvent(), swapEvent({ txHash: hex(2, 64), amount0: -495n, amount1: 300n })];
    const source = new FakeLogSource({ head: 200, batches: { 100: { events, nextBlock: 102 } } });
    const client = fakeChainClient({
      tokens: tokenFixture,
      balances: { [`${AI}-${WALLET}`]: (b) => (b === 99n ? 500n : b === 101n ? 0n : undefined) },
    });
    const opts = baseOpts({ maxSpan: 150, maxRequests: 2 });

    const report = await runChainSync(db, chainDeps({ source, client }), opts);

    expect(report.error).toBeNull();
    expect(report.holderDeltaApplied).toBe(1);
    expect(await holdersOf(AI)).toBe(0); // 1 - 1: the exit is caught, unlike the deleted derivation
  });

  it("a pair whose balance could not be read on EITHER side contributes 0 and is counted unknown, never guessed", async () => {
    await seedCursor(db, 99);
    const events = [initEvent(), swapEvent()];
    const source = new FakeLogSource({ head: 200, batches: { 100: { events, nextBlock: 102 } } });
    const client = fakeChainClient({ tokens: tokenFixture }); // no balances fixture at all: both reads fail
    const opts = baseOpts({ maxSpan: 150, maxRequests: 2 });

    const report = await runChainSync(db, chainDeps({ source, client }), opts);

    expect(report.error).toBeNull();
    expect(report.holderDeltaApplied).toBe(0);
    expect(report.holderReadsUnknown).toBe(1);
    expect(await holdersOf(AI)).toBe(0); // never guessed: stays at the brand-new-token default
  });

  it("a pair whose AFTER balance could not be read is still unknown even though BEFORE succeeded (never guessed off one side alone)", async () => {
    await seedCursor(db, 99);
    const events = [initEvent(), swapEvent()];
    const source = new FakeLogSource({ head: 200, batches: { 100: { events, nextBlock: 102 } } });
    const client = fakeChainClient({
      tokens: tokenFixture,
      balances: { [`${AI}-${WALLET}`]: (b) => (b === 99n ? 0n : undefined) }, // "before" (99) resolves; "after" (101) does not
    });
    const opts = baseOpts({ maxSpan: 150, maxRequests: 2 });

    const report = await runChainSync(db, chainDeps({ source, client }), opts);

    expect(report.error).toBeNull();
    expect(report.holderDeltaApplied).toBe(0);
    expect(report.holderReadsUnknown).toBe(1);
    expect(await holdersOf(AI)).toBe(0);
  });

  describe("MINOR-8: a one-line warn when a normal-mode cycle resolves none of a real batch of pairs", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("warns when every pair in the cycle goes unresolved", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await seedCursor(db, 99);
      const events = [initEvent(), swapEvent()];
      const source = new FakeLogSource({ head: 200, batches: { 100: { events, nextBlock: 102 } } });
      const client = fakeChainClient({ tokens: tokenFixture }); // no balances fixture: nothing resolves
      const opts = baseOpts({ maxSpan: 150, maxRequests: 2 });

      await runChainSync(db, chainDeps({ source, client }), opts);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("resolved 0 of 1 balance pair"));
    });

    it("does not warn when at least one pair resolves", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await seedCursor(db, 99);
      const events = [initEvent(), swapEvent()];
      const source = new FakeLogSource({ head: 200, batches: { 100: { events, nextBlock: 102 } } });
      const client = fakeChainClient({ tokens: tokenFixture, balances: { [`${AI}-${WALLET}`]: 0n } });
      const opts = baseOpts({ maxSpan: 150, maxRequests: 2 });

      await runChainSync(db, chainDeps({ source, client }), opts);

      expect(warn).not.toHaveBeenCalled();
    });

    it("does not warn on a catch-up or window-skip cycle, where applied 0 is expected rather than a signal", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await seedCursor(db, 99);
      const events = [initEvent(), swapEvent()];
      const source = new FakeLogSource({ head: 200, batches: { 100: { events, nextBlock: 102 } } });
      const client = fakeChainClient({ tokens: tokenFixture }); // would fail even if attempted, but must not be attempted at all
      const opts = baseOpts({ maxSpan: 150, maxRequests: 2, stopWhenCaughtUp: true });

      await runChainSync(db, chainDeps({ source, client }), opts);

      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("several trades for the same wallet and token in one batch still cost exactly one read each way, and the delta reflects only the two OBSERVED ends", async () => {
    await seedCursor(db, 99);
    // Buy, sell to zero, buy again — the old netting logic (deleted this round) would have had to get this
    // right by summing; now it is trivially right, because only the two real balances are ever consulted.
    const events = [
      initEvent(),
      swapEvent({ txHash: hex(2, 64), amount0: 300n, amount1: -150n }),
      swapEvent({ txHash: hex(3, 64), amount0: -300n, amount1: 150n }),
      swapEvent({ txHash: hex(4, 64), amount0: 500n, amount1: -250n }),
    ];
    const source = new FakeLogSource({ head: 200, batches: { 100: { events, nextBlock: 102 } } });
    const client = fakeChainClient({
      tokens: tokenFixture,
      balances: { [`${AI}-${WALLET}`]: (b) => (b === 99n ? 0n : b === 101n ? 500n : undefined) },
    });
    const opts = baseOpts({ maxSpan: 150, maxRequests: 2 });

    const report = await runChainSync(db, chainDeps({ source, client }), opts);

    expect(report.error).toBeNull();
    expect(report.trades).toBe(3); // all three trades still recorded
    expect(report.holderDeltaApplied).toBe(1); // one PAIR, not one per trade
    expect(await holdersOf(AI)).toBe(1); // 0 -> 1
    expect(balanceOfCalls(client)).toHaveLength(2); // exactly one before + one after, never three of either
  });

  it("stops the balance reads 1.5 s before the window ends: pairs no chunk was started for are counted unknown, never guessed, and the cycle's trades still land (23 Sep 2026)", async () => {
    await seedCursor(db, 99);
    // 25 distinct wallets = 25 pairs = two chunks of 20 pairs; each readContract call costs 100 ms of clock.
    const wallets = Array.from({ length: 25 }, (_, i) => `0x${(i + 0x100).toString(16).padStart(40, "0")}`);
    const events = [initEvent(), ...wallets.map((w, i) => swapEvent({ txHash: hex(10 + i, 64), txFrom: w, amount0: 300n, amount1: -150n }))];
    const source = new FakeLogSource({ head: 200, batches: { 100: { events, nextBlock: 102 } } });
    const balances = Object.fromEntries(wallets.map((w) => [`${AI}-${w}`, (b: bigint | undefined) => (b === 99n ? 0n : b === 101n ? 500n : undefined)]));
    const opts = baseOpts({ maxSpan: 150, maxRequests: 2, windowSec: 20 }); // deadline at +18.5 s
    const client = fakeChainClient({ tokens: tokenFixture, balances });
    // The clock: 100 ms per chain read, and the 40th balance read (the end of the first chunk) costs
    // 15 s, so the second chunk finds the deadline (+18.5 s of a 20 s window) already passed.
    let t = NOW_MS;
    let balanceReads = 0;
    const inner = client.readContract;
    client.readContract = (async (args) => {
      t += 100;
      if ((args as { functionName: string }).functionName === "balanceOf" && ++balanceReads === 40) t += 15_000;
      return inner(args);
    }) as typeof client.readContract;
    opts.now = () => t;
    opts.sleep = async (ms) => { t += ms; };

    const report = await runChainSync(db, chainDeps({ source, client }), opts);

    expect(report.error).toBeNull();
    expect(report.trades).toBe(25);
    expect(report.holderDeltaApplied).toBe(20); // the first chunk, both sides read
    expect(report.holderReadsUnknown).toBe(5); // the second chunk was never started
    expect(await holdersOf(AI)).toBe(20); // 0 -> 20, the five unread pairs left for a later day, never guessed
    expect(balanceOfCalls(client)).toHaveLength(40); // 20 before + 20 after; the remaining 10 never issued
  });

  it("BLOCKER-1 fix: catch-up mode (stopWhenCaughtUp) applies NO holder deltas at all — every pair unknown, nothing read", async () => {
    await seedToken(db, AI, 1);
    await db.query("update market.tokens set holders_count = 5 where id = $1", [AI]);
    await seedCursor(db, 99);

    const events = [
      initEvent(),
      swapEvent({ txHash: hex(2, 64), txFrom: WALLET, amount0: -500n, amount1: 300n }),
      swapEvent({ txHash: hex(3, 64), txFrom: WALLET_2, amount0: 200n, amount1: -100n }),
    ];
    const source = new FakeLogSource({ head: 200, batches: { 100: { events, nextBlock: 102 } } });
    // Fixtures exist for both pairs, resolvable at any block: the point is catch-up must never even ask,
    // not merely that asking would fail.
    const client = fakeChainClient({ tokens: tokenFixture, balances: { [`${AI}-${WALLET}`]: 0n, [`${AI}-${WALLET_2}`]: 999n } });
    // stopWhenCaughtUp: true is exactly scripts/chain/catchup.mts's own configuration; this batch is not
    // caught up yet (target 200 > cursor 99), so the loop still runs this one cycle before stopping.
    const opts = baseOpts({ maxSpan: 150, maxRequests: 2, stopWhenCaughtUp: true });

    const report = await runChainSync(db, chainDeps({ source, client }), opts);

    expect(report.error).toBeNull();
    expect(report.holderDeltaApplied).toBe(0);
    expect(report.holderReadsUnknown).toBe(2); // both distinct pairs, uncounted rather than guessed
    expect(await holdersOf(AI)).toBe(5); // untouched — the 17 Sep baseline stands until the cron takes over
    expect(balanceOfCalls(client)).toHaveLength(0); // never attempted, not attempted-and-failed
  });

  it("TEST-4 (BLOCKER-1 regression): the same wallet trading the same token across TWO catch-up cycles is never decremented at all, let alone once per cycle", async () => {
    await seedToken(db, AI, 1);
    await db.query("update market.tokens set holders_count = 5 where id = $1", [AI]);
    await seedCursor(db, 99);

    // Two replay cycles, the same wallet trading the same token in both (the review's own worked example:
    // a buy in one cycle, a sell in another). The old per-cycle fallback would have produced -1 or worse
    // here; the fix applies nothing in either cycle.
    const source = new FakeLogSource({
      head: 300,
      batches: {
        100: { events: [initEvent(), swapEvent({ txHash: hex(2, 64), txFrom: WALLET, amount0: 500n, amount1: -300n })], nextBlock: 102 },
        102: { events: [swapEvent({ block: 103, txHash: hex(3, 64), txFrom: WALLET, amount0: -500n, amount1: 300n })], nextBlock: 104 },
      },
    });
    const client = fakeChainClient({ tokens: tokenFixture, balances: { [`${AI}-${WALLET}`]: 0n } });
    const opts = baseOpts({ maxSpan: 2, maxRequests: 4, stopWhenCaughtUp: true }); // exactly 2 cycles (head+fetch each)

    const report = await runChainSync(db, chainDeps({ source, client }), opts);

    expect(report.error).toBeNull();
    expect(report.cycles).toBe(2);
    expect(report.holderDeltaApplied).toBe(0);
    expect(report.holderReadsUnknown).toBe(2); // one pair per cycle, both unknown
    expect(await holdersOf(AI)).toBe(5); // never touched across either cycle
    expect(balanceOfCalls(client)).toHaveLength(0);
  });

  it("MAJOR-2 fix: skips the upkeep entirely once the cron's window is nearly spent — no reads, everything unknown", async () => {
    await seedCursor(db, 99);
    const events = [initEvent(), swapEvent()];
    const source = new FakeLogSource({ head: 200, batches: { 100: { events, nextBlock: 102 } } });
    const client = fakeChainClient({ tokens: tokenFixture, balances: { [`${AI}-${WALLET}`]: 0n } });
    // windowSec 8: from the very first cycle, endMs - now() is 8000ms, already under HOLDER_MIN_WINDOW_MS (10s).
    const opts = baseOpts({ windowSec: 8, maxSpan: 150, maxRequests: 2 });

    const report = await runChainSync(db, chainDeps({ source, client }), opts);

    expect(report.error).toBeNull();
    expect(report.trades).toBe(1); // the fold itself is unaffected — only the upkeep is skipped
    expect(report.holderDeltaApplied).toBe(0);
    expect(report.holderReadsUnknown).toBe(1);
    expect(await holdersOf(AI)).toBe(0);
    expect(balanceOfCalls(client)).toHaveLength(0); // never attempted
  });

  it("respects the per-cycle pair cap: reads only the first pairCap pairs (both ways), counts the rest unknown, and never drops a trade", async () => {
    await seedCursor(db, 99);
    const events = [
      initEvent(),
      swapEvent({ txHash: hex(2, 64), txFrom: WALLET, logIndex: 0 }),
      swapEvent({ txHash: hex(3, 64), txFrom: WALLET_2, logIndex: 1 }),
    ];
    const source = new FakeLogSource({ head: 200, batches: { 100: { events, nextBlock: 102 } } });
    const client = fakeChainClient({
      tokens: tokenFixture,
      balances: { [`${AI}-${WALLET}`]: 0n, [`${AI}-${WALLET_2}`]: 0n }, // flat: both fixtures resolve either way; the cap alone decides
    });
    const opts = baseOpts({ maxSpan: 150, maxRequests: 2, holderPairCap: 1 });

    const report = await runChainSync(db, chainDeps({ source, client }), opts);

    expect(report.error).toBeNull();
    expect(report.trades).toBe(2); // the cap never drops a trade
    expect(report.holderDeltaApplied).toBe(1);
    expect(report.holderReadsUnknown).toBe(1);
    expect(balanceOfCalls(client)).toHaveLength(2); // 1 pair x 2 reads (before + after), not 2 pairs x 2
  });

  it("surfaces holderDeltaApplied and holderReadsUnknown on the onCycle callback, alongside orphanedTokens", async () => {
    await seedCursor(db, 99);
    const events = [initEvent(), swapEvent()];
    const source = new FakeLogSource({ head: 200, batches: { 100: { events, nextBlock: 102 } } });
    const client = fakeChainClient({ tokens: tokenFixture, balances: { [`${AI}-${WALLET}`]: 0n } });
    const cycles: { holderDeltaApplied: number; holderReadsUnknown: number; orphanedTokens: number }[] = [];
    const opts = baseOpts({
      maxSpan: 150, maxRequests: 2,
      onCycle: (c) => cycles.push({ holderDeltaApplied: c.holderDeltaApplied, holderReadsUnknown: c.holderReadsUnknown, orphanedTokens: c.orphanedTokens }),
    });

    await runChainSync(db, chainDeps({ source, client }), opts);

    expect(cycles).toEqual([{ holderDeltaApplied: 1, holderReadsUnknown: 0, orphanedTokens: 0 }]);
  });
});

describe("runChainSync: launchpad events in the report (instant launchpad design, section 5.2)", () => {
  it("counts the launchpad events a cycle folded, in the report and in the stored last_report", async () => {
    await seedCursor(db, 99);
    const payout: PayoutChangedEvent = {
      kind: "payoutChanged", block: 100, logIndex: 0, timestamp: 1_700_000_100, txHash: txHash(9), txFrom: WALLET,
      token: AI, previous: WALLET, payout: addr(0xd1),
    };
    const source = new FakeLogSource({ head: 200, batches: { 100: { events: [payout], nextBlock: 102 } } });
    const report = await runChainSync(db, chainDeps({ source }), baseOpts({ maxSpan: 150, maxRequests: 2 }));
    expect(report.error).toBeNull();
    expect(report.launchEvents).toBe(1);
    const [row] = await db.query<{ last_report: unknown }>("select last_report from market.sync_state where job = 'chain'");
    const stored = typeof row!.last_report === "string" ? JSON.parse(row!.last_report) : row!.last_report;
    expect(stored).toMatchObject({ launchEvents: 1 });
  });
});
