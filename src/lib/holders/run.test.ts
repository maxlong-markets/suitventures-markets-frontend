import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferEvent } from "@/lib/chain/types";
import type { Db } from "@/lib/db/client";
import { acquireLease, readState, saveCursors } from "@/lib/sync/state";
import { testDb } from "@/test/db";
import {
  COVERAGE_TTL_SEC,
  DEFAULT_REQUEST_SPACING_MS,
  DEFAULT_SAFETY_BLOCKS,
  HOLDERS_JOB,
  runHoldersBuild,
  type HoldersRunOpts,
  type HoldersRunReport,
} from "./run";
import { refreshRow } from "./store";

// Ids in the shape the reader writes them: lowercase hex, tokens 40 digits, pools and tx hashes 64.
const hex = (n: number, digits: number) => "0x" + n.toString(16).padStart(digits, "0");
const addr = (n: number) => hex(n, 40);

const T1 = addr(0xb1), T2 = addr(0xb2), T3 = addr(0xb3);
const W1 = addr(0xc1), W2 = addr(0xc2), W3 = addr(0xc3);
const POOL = hex(0x11, 64);
const ZERO = "0x0000000000000000000000000000000000000000";

const NOW_MS = 1_789_000_000_000;
const NOW = Math.floor(NOW_MS / 1000);
const OWNER = "holders-runner";
/** The fake chain's head, and the line the runner must stop at: head - safetyBlocks, inclusive. */
const HEAD = 10_000;
const CEILING = HEAD - DEFAULT_SAFETY_BLOCKS;
/** The first block past the ceiling — what a source that reached it reports as `nextBlock`. */
const PAST_CEILING = CEILING + 1;

const mint = (block: number, to: string, value: bigint, logIndex = 0): TransferEvent => ({ block, logIndex, from: ZERO, to, value });
const move = (block: number, from: string, to: string, value: bigint, logIndex = 0): TransferEvent => ({ block, logIndex, from, to, value });
/** `n` mints to `n` distinct wallets, for the transfer-count safety valve (which only counts them). */
const mints = (block: number, n: number, offset: number): TransferEvent[] =>
  Array.from({ length: n }, (_, i) => mint(block, addr(0xd000 + offset + i), 10n, i));

type Slice = { transfers: TransferEvent[]; nextBlock: number };
/** token id -> the exact `fromBlock` asked for -> what one response covers. */
type SliceMap = Record<string, Record<number, Slice>>;

/**
 * A LogSource serving `transfers()` from a per-token map keyed by the exact `fromBlock` asked for —
 * deterministic given a test's known cursor progression, never a fragile call counter (the same shape
 * src/lib/chain/run.test.ts's FakeLogSource uses for `fetch`). It honours the inclusive `toBlock`
 * ceiling exactly as hypersyncSource does: nothing past it comes back and `nextBlock` is clamped to
 * `toBlock + 1`, so a test cannot accidentally prove a clamp the runner no longer performs itself.
 */
class FakeTransferSource {
  private _requests = 0;
  /** Every request's moment on the test's fake clock, head() included, in order — for the pacing test. */
  readonly requestTimes: number[] = [];
  /** transfers() calls only, in order. */
  readonly calls: { token: string; fromBlock: number; toBlock: number | undefined }[] = [];
  headThrows: Error | null = null;
  /** Overridable so a test can serve a head no chain would report (fix round 1, the head guard). */
  headValue = HEAD;
  /** Runs just before a slice is returned, for a test that changes the database mid-invocation. */
  onTransfers: ((token: string, fromBlock: number) => Promise<void>) | null = null;

  constructor(
    private readonly clock: () => number,
    private readonly slices: SliceMap = {},
    private readonly throwOn: ReadonlySet<string> = new Set(),
  ) {}

  async head(): Promise<number> {
    this._requests += 1;
    this.requestTimes.push(this.clock());
    if (this.headThrows) throw this.headThrows;
    return this.headValue;
  }

  async transfers(token: string, fromBlock: number, toBlock?: number): Promise<Slice> {
    this._requests += 1;
    this.requestTimes.push(this.clock());
    this.calls.push({ token, fromBlock, toBlock });
    if (this.throwOn.has(token)) throw new Error(`HyperSync request failed with status 500 (${token})`);
    await this.onTransfers?.(token, fromBlock);
    const slice = this.slices[token]?.[fromBlock];
    if (!slice) throw new Error(`FakeTransferSource: no slice configured for ${token} from block ${fromBlock}`);
    if (toBlock === undefined) return { transfers: [...slice.transfers], nextBlock: slice.nextBlock };
    return { transfers: slice.transfers.filter((t) => t.block <= toBlock), nextBlock: Math.min(slice.nextBlock, toBlock + 1) };
  }

  get requests(): number {
    return this._requests;
  }
}

/**
 * The fake clock of src/lib/chain/run.test.ts's baseOpts: `now` only moves when the runner sleeps, so a
 * test's wall clock never enters the assertions. Pacing is left unset here on purpose — the tests that do
 * not measure it use `frozenOpts` (spacing 0, clock never moves), and the one that does omits it so the
 * DEFAULT_REQUEST_SPACING_MS path is the one under test.
 */
function baseOpts(over: Partial<HoldersRunOpts> = {}): HoldersRunOpts & { slept: number[] } {
  let t = NOW_MS;
  const slept: number[] = [];
  return {
    owner: OWNER, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; },
    windowSec: 50, leaseSec: 300, excludedIds: [], safetyBlocks: DEFAULT_SAFETY_BLOCKS, slept, ...over,
  };
}
/** baseOpts with pacing off, so every timestamp a test asserts is exactly NOW. */
const frozenOpts = (over: Partial<HoldersRunOpts> = {}) => baseOpts({ requestSpacingMs: 0, ...over });

const EMPTY_REPORT: HoldersRunReport = {
  skipped: null, coverage: 0, coverageRecomputed: false, due: 0, tokensTouched: 0, tokensReady: 0, tokensSkipped: 0,
  slices: 0, requests: 0, transfers: 0, errors: 0, error: null,
};

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(() =>
  db.exec(
    "delete from market.token_balances; delete from market.holder_refresh; delete from market.swaps; delete from market.tokens; delete from market.sync_state",
  ),
);
afterEach(() => {
  vi.restoreAllMocks();
});

/** The minimal token row the chain store writes (src/lib/chain/store.ts); only id and holders_count matter here. */
const seedToken = (id: string, holdersCount = 0) =>
  db.query(
    `insert into market.tokens (id, address, symbol, name, decimals, total_supply, holders_count, pool_count, origin,
       created_at, metadata_loaded, synced_at)
     values ($1, $1, 'AI', 'Artificial Inu', 18, 0, $2, 1, 'LONG', $3, true, $3)`,
    [id, holdersCount, NOW - 100_000],
  );

let txSeq = 0; // unique across the file: (tx_hash, log_index) is the swaps primary key.
const swap = (tokenId: string, ts: number) =>
  db.query(
    `insert into market.swaps (tx_hash, log_index, pool_id, token_id, ts, side, amount_token, amount_quote, price_quote, wallet)
     values ($1, 0, $2, $3, $4, 'buy', 1, 1, 1, $5)`,
    [hex(++txSeq, 64), POOL, tokenId, ts, W1],
  );

const refresh = (
  tokenId: string,
  o: { refreshedAt?: number; cursorBlock?: number; requestedAt?: number; status?: string; transfers?: number } = {},
) =>
  db.query(
    `insert into market.holder_refresh (token_id, refreshed_at, cursor_block, requested_at, status, transfers)
     values ($1, $2, $3, $4, $5, $6)`,
    [tokenId, o.refreshedAt ?? 0, o.cursorBlock ?? 0, o.requestedAt ?? 0, o.status ?? "building", o.transfers ?? 0],
  );

const balancesOf = (tokenId: string) =>
  db.query<{ holder: string; balance: string }>(
    "select holder, balance from market.token_balances where token_id = $1 order by holder",
    [tokenId],
  );
const holdersCountOf = async (tokenId: string) =>
  (await db.query<{ holders_count: number }>("select holders_count from market.tokens where id = $1", [tokenId]))[0].holders_count;
const lastReport = async () =>
  (await db.query<{ last_report: Record<string, unknown> }>("select last_report from market.sync_state where job = $1", [HOLDERS_JOB]))[0]
    .last_report;

describe("runHoldersBuild: the due list and one token's slices", () => {
  it("builds a requested token before a covered stale one, in slice order, and marks it ready with an exact count", async () => {
    await seedToken(T1);
    await seedToken(T2);
    await swap(T2, NOW - 100); // only T2 traded today, so only T2 is in the coverage set
    await refresh(T1, { requestedAt: NOW - 5 }); // due list 1: opened, still building, never refreshed
    await refresh(T2, { status: "ready", refreshedAt: NOW - 1000 }); // due list 2: covered, stale, traded since

    const source = new FakeTransferSource(() => NOW_MS, {
      [T1]: {
        0: { transfers: [mint(100, W1, 100n), move(100, W1, W2, 40n, 1)], nextBlock: 5000 },
        5000: { transfers: [move(6000, W2, W3, 40n)], nextBlock: PAST_CEILING },
      },
      [T2]: { 0: { transfers: [mint(200, W1, 50n)], nextBlock: PAST_CEILING } },
    });

    const report = await runHoldersBuild(db, { source }, frozenOpts());

    expect(report).toEqual({
      ...EMPTY_REPORT, coverage: 1, coverageRecomputed: true, due: 2, tokensTouched: 2, tokensReady: 2,
      slices: 3, requests: 4, transfers: 4,
    });
    // The requested token first, its slices in cursor order, and every request carrying the head - safety ceiling.
    expect(source.calls).toEqual([
      { token: T1, fromBlock: 0, toBlock: CEILING },
      { token: T1, fromBlock: 5000, toBlock: CEILING },
      { token: T2, fromBlock: 0, toBlock: CEILING },
    ]);
    // W2 received 40 and sent all 40 on: a wallet back at zero is not a holder.
    expect(await balancesOf(T1)).toEqual([{ holder: W1, balance: "60" }, { holder: W3, balance: "40" }]);
    expect(await holdersCountOf(T1)).toBe(2);
    expect(await refreshRow(db, T1)).toMatchObject({ status: "ready", refreshedAt: NOW, cursorBlock: PAST_CEILING });
    expect(await balancesOf(T2)).toEqual([{ holder: W1, balance: "50" }]);
    expect(await holdersCountOf(T2)).toBe(1);
    expect(await refreshRow(db, T2)).toMatchObject({ status: "ready", refreshedAt: NOW, cursorBlock: PAST_CEILING });
  });

  it("inserts building rows for covered tokens that have none, and builds them in coverage order", async () => {
    for (const t of [T1, T2, T3]) await seedToken(t);
    for (let i = 0; i < 3; i++) await swap(T1, NOW - 100);
    for (let i = 0; i < 2; i++) await swap(T2, NOW - 100);
    await swap(T3, NOW - 100);

    const oneSlice = { 0: { transfers: [mint(10, W1, 7n)], nextBlock: PAST_CEILING } };
    const source = new FakeTransferSource(() => NOW_MS, { [T1]: oneSlice, [T2]: oneSlice, [T3]: oneSlice });

    const report = await runHoldersBuild(db, { source }, frozenOpts());

    expect(report).toMatchObject({ coverage: 3, due: 3, tokensTouched: 3, tokensReady: 3, slices: 3, requests: 4, transfers: 3 });
    // Never-seen tokens are all `refreshed_at = 0`, so they arrive as due list 3 in the coverage order: most traded first.
    expect(source.calls.map((c) => c.token)).toEqual([T1, T2, T3]);
    for (const t of [T1, T2, T3]) expect(await refreshRow(db, t)).toMatchObject({ status: "ready", cursorBlock: PAST_CEILING });
  });
});

describe("runHoldersBuild: pacing and the window", () => {
  it("spaces every request, the head read included, by DEFAULT_REQUEST_SPACING_MS", async () => {
    expect(DEFAULT_REQUEST_SPACING_MS).toBe(750);
    await seedToken(T1);
    await refresh(T1, { requestedAt: NOW });
    const opts = baseOpts(); // no requestSpacingMs: the default is what is under test
    const source = new FakeTransferSource(opts.now, {
      [T1]: {
        0: { transfers: [mint(10, W1, 5n)], nextBlock: 3000 },
        3000: { transfers: [], nextBlock: 6000 },
        6000: { transfers: [], nextBlock: PAST_CEILING },
      },
    });

    const report = await runHoldersBuild(db, { source }, opts);

    expect(report).toMatchObject({ tokensReady: 1, slices: 3, requests: 4 });
    expect(source.requestTimes).toEqual([NOW_MS, NOW_MS + 750, NOW_MS + 1500, NOW_MS + 2250]);
    for (let i = 1; i < source.requestTimes.length; i++) {
      expect(source.requestTimes[i] - source.requestTimes[i - 1]).toBeGreaterThanOrEqual(DEFAULT_REQUEST_SPACING_MS);
    }
    // The head read is paced but not delayed: nothing has been requested yet when it goes out.
    expect(opts.slept).toEqual([750, 750, 750]);
  });

  it("stops at the window's end with the cursor stored, and the next invocation resumes without folding twice", async () => {
    await seedToken(T1);
    await refresh(T1, { requestedAt: NOW });
    const slices: SliceMap = {
      [T1]: {
        0: { transfers: [mint(10, W1, 100n)], nextBlock: 3000 },
        3000: { transfers: [move(4000, W1, W2, 30n)], nextBlock: 6000 },
        6000: { transfers: [move(7000, W1, W3, 20n)], nextBlock: PAST_CEILING },
      },
    };

    // windowSec 2 against a 750 ms spacing: two slices fit, and the third's wait lands past the window's end.
    const first = baseOpts({ windowSec: 2 });
    const sourceA = new FakeTransferSource(first.now, slices);
    const reportA = await runHoldersBuild(db, { source: sourceA }, first);

    expect(reportA).toMatchObject({ tokensTouched: 1, tokensReady: 0, slices: 2, requests: 3, error: null });
    // The third wait was paid and then the window check stopped it: a request must never START outside the
    // window, however long pacing made the caller wait for its turn (fix round 1, item 3c).
    expect(first.slept).toEqual([750, 750, 750]); // three waits paid...
    expect(sourceA.calls).toHaveLength(2); // ...two requests issued
    expect(await refreshRow(db, T1)).toMatchObject({ status: "building", cursorBlock: 6000 });
    expect(await balancesOf(T1)).toEqual([{ holder: W1, balance: "70" }, { holder: W2, balance: "30" }]);

    const second = baseOpts({ windowSec: 2 });
    const sourceB = new FakeTransferSource(second.now, slices);
    const reportB = await runHoldersBuild(db, { source: sourceB }, second);

    expect(reportB).toMatchObject({ tokensTouched: 1, tokensReady: 1, slices: 1, requests: 2, error: null });
    expect(sourceB.calls[0]).toEqual({ token: T1, fromBlock: 6000, toBlock: CEILING }); // resumed from the stored cursor
    // 100 minted, 30 and 20 sent on: a slice folded a second time would show 170/20 or 100/60/20 here.
    expect(await balancesOf(T1)).toEqual([
      { holder: W1, balance: "50" }, { holder: W2, balance: "30" }, { holder: W3, balance: "20" },
    ]);
    expect(await refreshRow(db, T1)).toMatchObject({ status: "ready", cursorBlock: PAST_CEILING });
  });
});

describe("runHoldersBuild: failures and the safety valve", () => {
  it("counts a source failure, leaves that token's cursor alone and carries on with the next due token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedToken(T1);
    await seedToken(T2);
    await refresh(T1, { requestedAt: NOW, cursorBlock: 4242 }); // newest request: first in the due list
    await refresh(T2, { requestedAt: NOW - 10 });

    const source = new FakeTransferSource(
      () => NOW_MS,
      { [T2]: { 0: { transfers: [mint(10, W1, 9n)], nextBlock: PAST_CEILING } } },
      new Set([T1]),
    );

    const report = await runHoldersBuild(db, { source }, frozenOpts());

    expect(report).toMatchObject({ due: 2, tokensTouched: 2, tokensReady: 1, slices: 1, requests: 3, transfers: 1, errors: 1, error: null });
    expect(await refreshRow(db, T1)).toMatchObject({ status: "building", cursorBlock: 4242, transfers: 0 });
    expect(await balancesOf(T1)).toEqual([]);
    expect(await refreshRow(db, T2)).toMatchObject({ status: "ready", cursorBlock: PAST_CEILING });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(T1));
  });

  it("skips a token whose fold passes maxTransfersPerToken without reaching the head, and deletes its rows", async () => {
    await seedToken(T1);
    await refresh(T1, { requestedAt: NOW });
    const source = new FakeTransferSource(() => NOW_MS, {
      [T1]: {
        0: { transfers: mints(10, 6, 0), nextBlock: 3000 },
        3000: { transfers: mints(20, 6, 6), nextBlock: 6000 },
      },
    });

    const report = await runHoldersBuild(db, { source }, frozenOpts({ maxTransfersPerToken: 10 }));

    expect(report).toMatchObject({ tokensTouched: 1, tokensReady: 0, tokensSkipped: 1, slices: 2, transfers: 12, errors: 0 });
    expect(await refreshRow(db, T1)).toMatchObject({ status: "skipped", cursorBlock: 0, transfers: 12 });
    expect(await balancesOf(T1)).toEqual([]);
    expect(await holdersCountOf(T1)).toBe(0); // never made ready, so its count was never claimed to be exact
  });

  it("skips a token whose refresh row names an id market.tokens has never seen, and carries on down the list", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // requestBuild opens a refresh row for any id the holders route is asked about, token row or not. Left
    // building, its refreshed_at never moves, so it would sit first in the due list and abort every minute.
    await refresh(T1, { requestedAt: NOW, cursorBlock: PAST_CEILING }); // already at the ceiling: markReady is next
    await seedToken(T2);
    await refresh(T2, { requestedAt: NOW - 10 });
    const source = new FakeTransferSource(() => NOW_MS, { [T2]: { 0: { transfers: [mint(10, W1, 8n)], nextBlock: PAST_CEILING } } });

    const report = await runHoldersBuild(db, { source }, frozenOpts());

    expect(report).toMatchObject({ due: 2, tokensTouched: 2, tokensReady: 1, tokensSkipped: 1, errors: 0, error: null });
    expect(await refreshRow(db, T1)).toMatchObject({ status: "skipped", cursorBlock: 0 });
    expect(await refreshRow(db, T2)).toMatchObject({ status: "ready" }); // the token behind it was still built
    expect((await readState(db, HOLDERS_JOB)).lastError).toBeNull(); // a terminal per-token state, not an abort
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(T1));
  });

  it("lets a store refusal inside a slice end the invocation through finishRun(ok: false), uncounted as an error", async () => {
    await seedToken(T1);
    await refresh(T1, { requestedAt: NOW });
    const source = new FakeTransferSource(() => NOW_MS, { [T1]: { 0: { transfers: [mint(10, W1, 5n)], nextBlock: 3000 } } });
    // The refresh row vanishes between dueTokens and applySlice: the store then refuses to move a cursor it
    // cannot find, which is a broken invariant rather than one flaky HyperSync response.
    source.onTransfers = async () => {
      await db.query("delete from market.holder_refresh where token_id = $1", [T1]);
    };

    const report = await runHoldersBuild(db, { source }, frozenOpts());

    expect(report.error).toBe(`applySlice: no market.holder_refresh row for token ${T1}`);
    expect(report).toMatchObject({ errors: 0, slices: 0, tokensReady: 0, tokensSkipped: 0, transfers: 0 });
    const state = await readState(db, HOLDERS_JOB);
    expect(state.lastError).toBe(report.error);
    expect(state.lastOkAt).toBeNull();
    expect(state.leaseOwner).toBeNull();
  });

  it("refuses a head that is not a positive integer rather than let every due token look ready", async () => {
    await seedToken(T1);
    for (const bad of [0, Number.NaN]) {
      await db.query("delete from market.holder_refresh");
      await refresh(T1, { requestedAt: NOW });
      const source = new FakeTransferSource(() => NOW_MS);
      source.headValue = bad;

      const report = await runHoldersBuild(db, { source }, frozenOpts());

      expect(report.error).toBe(`holders: HyperSync head is not a positive integer: ${bad}`);
      expect(report).toMatchObject({ tokensTouched: 0, tokensReady: 0, slices: 0, requests: 1, errors: 0 });
      expect(source.calls).toEqual([]); // the coverage query and every slice are past the guard
      expect((await readState(db, HOLDERS_JOB)).lastError).toBe(report.error);
      expect(await refreshRow(db, T1)).toMatchObject({ status: "building", refreshedAt: 0, cursorBlock: 0 });
    }
  });

  it("marks a token whose cursor already stands at the ceiling ready without asking for a slice", async () => {
    await seedToken(T1, 999);
    await refresh(T1, { requestedAt: NOW, cursorBlock: CEILING }); // exactly head - safety
    await db.query("insert into market.token_balances (token_id, holder, balance, updated_at) values ($1, $2, 3, $3)", [T1, W1, NOW]);
    const source = new FakeTransferSource(() => NOW_MS);

    const report = await runHoldersBuild(db, { source }, frozenOpts());

    expect(report).toMatchObject({ tokensTouched: 1, tokensReady: 1, slices: 0, requests: 1, transfers: 0, error: null });
    expect(source.calls).toEqual([]);
    expect(await refreshRow(db, T1)).toMatchObject({ status: "ready", refreshedAt: NOW, cursorBlock: CEILING });
    expect(await holdersCountOf(T1)).toBe(1);
  });
});

describe("runHoldersBuild: the lease and the nightly", () => {
  it('returns { skipped: "lease" } and reads nothing while another owner holds the holders lease', async () => {
    await acquireLease(db, HOLDERS_JOB, "other", NOW, 300);
    const source = new FakeTransferSource(() => NOW_MS);

    const report = await runHoldersBuild(db, { source }, frozenOpts());

    expect(report).toEqual({ ...EMPTY_REPORT, skipped: "lease" });
    expect(source.requests).toBe(0);
    expect((await readState(db, HOLDERS_JOB)).leaseOwner).toBe("other");
  });

  it('returns { skipped: "nightly" } while the nightly holds its lease, giving its own lease straight back', async () => {
    await acquireLease(db, "nightly", "night", NOW, 300);
    const source = new FakeTransferSource(() => NOW_MS);

    const report = await runHoldersBuild(db, { source }, frozenOpts());

    expect(report).toEqual({ ...EMPTY_REPORT, skipped: "nightly" });
    expect(source.requests).toBe(0); // never asked the source for anything, not even head()
    expect((await readState(db, HOLDERS_JOB)).leaseOwner).toBeNull();
    expect((await readState(db, "nightly")).leaseOwner).toBe("night"); // untouched
  });
});

describe("runHoldersBuild: what it records through finishRun", () => {
  it("writes the cycle's counters to last_report for the holders job", async () => {
    await seedToken(T1);
    await refresh(T1, { requestedAt: NOW });
    const source = new FakeTransferSource(() => NOW_MS, {
      [T1]: { 0: { transfers: [mint(10, W1, 4n), mint(11, W2, 6n, 1)], nextBlock: PAST_CEILING } },
    });

    await runHoldersBuild(db, { source }, frozenOpts());

    expect(await lastReport()).toEqual({
      at: NOW, coverage: 0, coverageRecomputed: 1, due: 1, tokensTouched: 1, tokensReady: 1, tokensSkipped: 0,
      slices: 1, requests: 2, transfers: 2, errors: 0,
    });
    const state = await readState(db, HOLDERS_JOB);
    expect(state).toMatchObject({ lastError: null, lastOkAt: NOW, lastRunAt: NOW, rowsWritten: 2, queriesUsed: 2, leaseOwner: null });
  });

  it("records a thrown head() error as last_error, reports it and still releases the lease", async () => {
    await seedToken(T1);
    await refresh(T1, { requestedAt: NOW });
    const source = new FakeTransferSource(() => NOW_MS);
    source.headThrows = new Error("HyperSync rejected the API token");

    const report = await runHoldersBuild(db, { source }, frozenOpts());

    expect(report).toEqual({ ...EMPTY_REPORT, requests: 1, error: "HyperSync rejected the API token" });
    const state = await readState(db, HOLDERS_JOB);
    expect(state.lastError).toBe("HyperSync rejected the API token");
    expect(state.lastOkAt).toBeNull();
    expect(state.leaseOwner).toBeNull();
    expect(await lastReport()).toEqual({}); // no cycle happened, so the stored report is left as it was
    expect(await refreshRow(db, T1)).toMatchObject({ status: "building", cursorBlock: 0 });
  });
});

describe("runHoldersBuild: the cached coverage set", () => {
  /** The three tokens the real query would rank T1, T2, T3 — so a cached [T3] is visibly not that list. */
  const seedCoverageFixture = async () => {
    for (const t of [T1, T2, T3]) await seedToken(t);
    for (let i = 0; i < 3; i++) await swap(T1, NOW - 100);
    for (let i = 0; i < 2; i++) await swap(T2, NOW - 100);
    await swap(T3, NOW - 100);
  };
  const oneSlice = { 0: { transfers: [mint(10, W1, 3n)], nextBlock: PAST_CEILING } };
  const allSlices: SliceMap = { [T1]: oneSlice, [T2]: oneSlice, [T3]: oneSlice };
  const storedCoverage = async () => {
    const state = await readState(db, HOLDERS_JOB);
    return { cursor: state.cursor, ids: state.cursorText };
  };

  it("uses a fresh cached set from its own sync_state row instead of re-running the query", async () => {
    expect(COVERAGE_TTL_SEC).toBe(300);
    await seedCoverageFixture();
    await saveCursors(db, HOLDERS_JOB, { cursor: NOW - 10, cursorText: JSON.stringify([T3]) });
    const source = new FakeTransferSource(() => NOW_MS, allSlices);

    const report = await runHoldersBuild(db, { source }, frozenOpts());

    expect(report).toMatchObject({ coverage: 1, coverageRecomputed: false, due: 1, tokensTouched: 1, tokensReady: 1 });
    // The cached list, not the query's [T1, T2, T3]: only T3 was ever asked for or given a row.
    expect(source.calls.map((c) => c.token)).toEqual([T3]);
    expect(await refreshRow(db, T1)).toBeNull();
    expect(await refreshRow(db, T2)).toBeNull();
    expect(await storedCoverage()).toEqual({ cursor: NOW - 10, ids: JSON.stringify([T3]) }); // untouched
  });

  it("recomputes and stores the coverage set once the cached one is older than COVERAGE_TTL_SEC", async () => {
    await seedCoverageFixture();
    await saveCursors(db, HOLDERS_JOB, { cursor: NOW - COVERAGE_TTL_SEC - 1, cursorText: JSON.stringify([T3]) });
    const source = new FakeTransferSource(() => NOW_MS, allSlices);

    const report = await runHoldersBuild(db, { source }, frozenOpts());

    expect(report).toMatchObject({ coverage: 3, coverageRecomputed: true, due: 3, tokensTouched: 3 });
    expect(source.calls.map((c) => c.token)).toEqual([T1, T2, T3]);
    expect(await storedCoverage()).toEqual({ cursor: NOW, ids: JSON.stringify([T1, T2, T3]) });
  });

  it("recomputes when the stored coverage text is not a JSON array of ids", async () => {
    await seedCoverageFixture();
    await saveCursors(db, HOLDERS_JOB, { cursor: NOW, cursorText: "{not json" });
    const source = new FakeTransferSource(() => NOW_MS, allSlices);

    const report = await runHoldersBuild(db, { source }, frozenOpts());

    expect(report).toMatchObject({ coverage: 3, coverageRecomputed: true, due: 3 });
    expect(await storedCoverage()).toEqual({ cursor: NOW, ids: JSON.stringify([T1, T2, T3]) });
  });
});
