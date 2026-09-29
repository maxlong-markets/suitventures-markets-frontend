import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { KEEP_REQUESTED_SEC } from "@/lib/holders/store";
import { QuoterUnavailableError, type Quoter } from "@/lib/quote/quoter";
import { testDb } from "@/test/db";
import { runNightly } from "./nightly";
import { candleCutoff, retentionCutoff } from "./retention";
import { finishRun, readState, saveCursors } from "./state";
import type { UploadCleaner } from "@/lib/launch/cleanup";
import { addr, candleRec, POOL_A, POOL_B, T0, TOKEN_A, TOKEN_B, poolRec, priceRec, quoteRec, swapRec, tokenRec, txHash } from "./testRows";
import { insertSwaps, upsertCandles, upsertPools, upsertQuotes, upsertTokens } from "./writers";

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
beforeEach(() => db.exec("delete from market.token_balances; delete from market.holder_refresh; delete from market.tokens; delete from market.pools; delete from market.quotes; delete from market.sync_state; delete from market.swaps; delete from market.candles"));
afterEach(() => vi.restoreAllMocks());

/**
 * Seeds market.tokens/market.pools directly, the way the chain reader (src/lib/chain/run.ts) now writes them:
 * Task 6 dropped the "tokens"/"pools" phases that used to walk this data in from Envio through a FakeSource,
 * so this job's own tests no longer build one either.
 */
async function seedTokensAndPools(): Promise<void> {
  await upsertTokens(db, [tokenRec(), tokenRec({ id: TOKEN_B, address: TOKEN_B, primaryPool_id: POOL_B })], T0);
  await upsertPools(db, [poolRec(), poolRec({ id: POOL_B, token_id: TOKEN_B })], T0);
}

const nightly = (queryBudget = 240) => runNightly(db, { now: T0 + 1000, queryBudget, deadlineMs: Date.now() + 60_000 });
const listed = () => db.query("select id, listed_pool_id from market.tokens order by id");

/** Off the markets table (no swap of their own), so only their request stamp keeps them (design section 7). */
const TOKEN_C = addr(0xb3), TOKEN_D = addr(0xb4), TOKEN_E = addr(0xb6);
const WALLET_H = addr(0xc9);

/** One top-holder list per token: a refresh row with its request stamp, and one balance row to delete with it. */
async function seedHolderList(tokenId: string, requestedAt: number): Promise<void> {
  await db.query("insert into market.holder_refresh (token_id, refreshed_at, requested_at, status) values ($1, $2, $3, 'ready')", [tokenId, T0, requestedAt]);
  await seedOrphanBalance(tokenId);
}
/** A balance row on its own. Without a refresh row beside it, only pruneHolders's closing anti-join reaches it. */
const seedOrphanBalance = (tokenId: string) =>
  db.query("insert into market.token_balances (token_id, holder, balance, updated_at) values ($1, $2, 7, $3)", [tokenId, WALLET_H, T0]);
const holderTokens = () => db.query("select token_id from market.holder_refresh order by token_id");
const balanceTokens = () => db.query("select distinct token_id from market.token_balances order by token_id");

/**
 * The three cases design section 7 separates: TOKEN_A is in the coverage set (it traded inside the last 24 h),
 * TOKEN_C is off the table but was opened two days ago, TOKEN_D is off the table and was last opened ten days
 * ago — past KEEP_REQUESTED_SEC, so it is the only one the phase may drop.
 */
async function seedHolderCleanupCase(): Promise<void> {
  await seedTokensAndPools();
  await insertSwaps(db, [swapRec({ txHash: txHash(0xf1), timestamp: T0 + 900 })]); // TOKEN_A, inside both the retention and the coverage window
  await seedHolderList(TOKEN_A, 0);
  await seedHolderList(TOKEN_C, T0 + 1000 - 2 * 86_400);
  await seedHolderList(TOKEN_D, T0 + 1000 - KEEP_REQUESTED_SEC - 86_400);
}

describe("runNightly", () => {
  it("recomputes every listed pool, probes nothing without a quoter, prunes, and ends with an empty phase", async () => {
    await seedTokensAndPools();
    // No quoter supplied: the probe phase is a no-op and the run still finishes (nightly.ts's own doc comment).
    expect(await nightly()).toEqual({ done: true, phase: "", listed: 2, probed: 0, routable: 0, unroutable: 0, skipped: 0, pruned: 0, prunedCandles: 0, prunedHolders: 0, uploadsDeleted: 0, queries: 0 });
    expect(await listed()).toEqual([{ id: TOKEN_A, listed_pool_id: POOL_A }, { id: TOKEN_B, listed_pool_id: POOL_B }]);
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "" });
  });

  it('a stored phase of "tokens" or "pools" from before Task 6 resumes at "listed" instead of crashing', async () => {
    await seedTokensAndPools();
    await saveCursors(db, "nightly", { phase: "pools", cursorText: POOL_A });
    expect(await nightly()).toMatchObject({ done: true, phase: "", listed: 2 });
    await seedTokensAndPools();
    await saveCursors(db, "nightly", { phase: "tokens", cursorText: "" });
    expect(await nightly()).toMatchObject({ done: true, phase: "", listed: 2 });
  });

  it('treats a stored "probe" phase as a resume POINT, not a starting phase: "listed", "prune" and "holders" all still run, and the walk keeps its place (24 Sep 2026, found live)', async () => {
    // Probe is deliberately the one phase allowed to end a run not-done, and it stays unfinished for weeks.
    // Until this was fixed, resuming AT it skipped the three cheap phases on every night after the first:
    // production that morning held 980,942 trades a day past the retention window, with about 69 nights of
    // probe still to walk, so the prune that protects the disk would not have run again until December.
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    await seedTokensAndPools();
    await db.query("update market.tokens set listed_pool_id = null"); // "listed" must re-run and fill these in
    const cutoff = retentionCutoff(T0 + 1000);
    await insertSwaps(db, [swapRec({ txHash: txHash(0xe9), timestamp: cutoff - 10 })]); // "prune" must take this
    await seedHolderList(TOKEN_D, T0 + 1000 - KEEP_REQUESTED_SEC - 86_400); // "holders" must drop this
    await saveCursors(db, "nightly", { phase: "probe", cursorText: POOL_A });
    const quoter: Quoter = { exactIn: async () => 1n, exactOut: async () => { throw new Error("unused by probePools"); } };

    const result = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });

    // Every cheap phase ran ...
    expect(result).toMatchObject({ done: true, phase: "", listed: 2, pruned: 1, prunedHolders: 1 });
    expect(await db.query("select tx_hash from market.swaps")).toEqual([]);
    expect(await holderTokens()).toEqual([]);
    expect(await listed()).toEqual([{ id: TOKEN_A, listed_pool_id: POOL_A }, { id: TOKEN_B, listed_pool_id: POOL_B }]);
    // ... and the walk resumed rather than restarting: POOL_A is behind the cursor, so only POOL_B is probed.
    expect(result).toMatchObject({ probed: 1, routable: 1 });
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "" });
  });

  it('resumes a stored "prune" phase directly, skipping "listed" again, then continues into "probe" in the same invocation (a run interrupted mid-prune, and a leftover phase from the pre-reorder order too)', async () => {
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    await seedTokensAndPools();
    await db.query("update market.tokens set listed_pool_id = null"); // proves "listed" really did not re-run below
    const cutoff = retentionCutoff(T0 + 1000);
    await insertSwaps(db, [swapRec({ txHash: txHash(0xe8), timestamp: cutoff - 10 })]);
    await saveCursors(db, "nightly", { phase: "prune", cursorText: "" });
    const quoter: Quoter = { exactIn: async () => 1n, exactOut: async () => { throw new Error("unused by probePools"); } };
    const result = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });
    // pruneSwaps/pruneCandles carry no cursor of their own (a plain ts/t < cutoff scan), so resuming straight
    // into "prune" finds exactly the stale row above and removes it, same as a fresh run would.
    expect(result).toMatchObject({ done: true, phase: "", listed: 0, pruned: 1, prunedCandles: 0, prunedHolders: 0, probed: 2, routable: 2 });
    expect(await db.query("select tx_hash from market.swaps")).toEqual([]);
    expect(await listed()).toEqual([{ id: TOKEN_A, listed_pool_id: null }, { id: TOKEN_B, listed_pool_id: null }]);
  });

  it('stops at the deadline with done false, landing on "prune" now that it runs first, and the next call resumes the stored phase', async () => {
    await seedTokensAndPools();
    // Already past: pruneSwaps's own first deadline check bails before it queries anything, same as
    // pruneCandles right after it. "listed" still ran (it has no deadline check of its own — one statement
    // over the whole table). No quoter needed here: "prune" now runs before "probe" (this fix's reorder), so
    // the shared deadline bites at "prune" regardless of whether a quoter was even supplied.
    const result = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() - 1 });
    expect(result).toMatchObject({ done: false, phase: "prune", listed: 2, pruned: 0, prunedCandles: 0 });
    expect(await readState(db, "nightly")).toMatchObject({ phase: "prune" });
  });

  it('runs the probe phase when a quoter is supplied, writing routable and landing on phase "" with probed counted', async () => {
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    await seedTokensAndPools();
    const quoter: Quoter = { exactIn: async () => 1n, exactOut: async () => { throw new Error("unused by probePools"); } };
    const result = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });
    expect(result).toEqual({ done: true, phase: "", listed: 2, probed: 2, routable: 2, unroutable: 0, skipped: 0, pruned: 0, prunedCandles: 0, prunedHolders: 0, uploadsDeleted: 0, queries: 0 });
    expect(await db.query("select id, routable, probed_at from market.pools order by id")).toEqual([
      { id: POOL_A, routable: true, probed_at: T0 + 1000 },
      { id: POOL_B, routable: true, probed_at: T0 + 1000 },
    ]);
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "" });
  });

  it("counts every skipped candidate when the quoter cannot answer, and still finishes the phase (I2b, I4)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    await seedTokensAndPools();
    const quoter: Quoter = {
      exactIn: async () => { throw new QuoterUnavailableError(new Error("down")); },
      exactOut: async () => { throw new Error("unused by probePools"); },
    };
    const result = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });
    expect(result).toEqual({ done: true, phase: "", listed: 2, probed: 2, routable: 0, unroutable: 0, skipped: 2, pruned: 0, prunedCandles: 0, prunedHolders: 0, uploadsDeleted: 0, queries: 0 });
    // The partial-outage band is observable in the log too (I4): counts only, no address, no URL.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/2 of 2 candidates skipped/);
    expect(String(warn.mock.calls[0]?.[0])).not.toMatch(/0x[0-9a-f]{40}|https?:/i);
    warn.mockRestore();
    expect(await db.query("select routable, probed_at from market.pools order by id")).toEqual([
      { routable: null, probed_at: null },
      { routable: null, probed_at: null },
    ]);
    // runNightly's own job — finishing the phase and persisting the cursor — is unaffected by every candidate
    // being skipped; it is run.ts's finishRun that must separately turn this into a recorded error (run.test.ts).
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "" });
  });

  it("persists the probe cursor through saveCursors as it walks, not only once at the end (I3 wiring)", async () => {
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    await seedTokensAndPools();
    const quoter: Quoter = { exactIn: async () => 1n, exactOut: async () => { throw new Error("unused by probePools"); } };
    const spy = vi.spyOn(db, "query");
    await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });
    const probeCursorCalls = spy.mock.calls
      .map(([, params]) => params)
      .filter((params): params is unknown[] => Array.isArray(params) && params[0] === "nightly" && params.includes("probe"));
    // The first is the "holders" -> "probe" phase transition (cursorText: ""); POOL_A and POOL_B then land in the
    // same (only) page and the same PROBE_CONCURRENCY batch, so onPage fires once more — wired to
    // saveCursors(db, "nightly", { phase: "probe", cursorText: lastId }) exactly as nightly.ts promises — with
    // the real last id, proving the callback nightly.ts hands to probePools actually ran (I3).
    expect(probeCursorCalls).toEqual([
      ["nightly", "", "probe"],
      ["nightly", POOL_B, "probe"],
    ]);
  });

  it("prunes swaps and candles past their retention windows before the probe phase, reporting both counts", async () => {
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    await seedTokensAndPools();
    const cutoff = retentionCutoff(T0 + 1000);
    const candleStale = candleCutoff("m1", T0 + 1000);
    await insertSwaps(db, [
      swapRec({ txHash: txHash(0xe1), timestamp: cutoff - 10 }),
      swapRec({ txHash: txHash(0xe2), timestamp: cutoff + 10 }),
    ]);
    await upsertCandles(db, [
      candleRec({ interval: "m1", t: candleStale - 10 }),
      candleRec({ interval: "m1", t: candleStale + 10 }),
    ]);
    const quoter: Quoter = { exactIn: async () => 1n, exactOut: async () => { throw new Error("unused by probePools"); } };
    const result = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });
    expect(result).toEqual({ done: true, phase: "", listed: 2, probed: 2, routable: 2, unroutable: 0, skipped: 0, pruned: 1, prunedCandles: 1, prunedHolders: 0, uploadsDeleted: 0, queries: 0 });
    expect(await db.query("select tx_hash from market.swaps")).toEqual([{ tx_hash: txHash(0xe2) }]);
    expect(await db.query("select t from market.candles")).toEqual([{ t: candleStale + 10 }]);
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "" });
  });

  it("still prunes when no quoter is supplied, even though the probe phase is then a no-op", async () => {
    await seedTokensAndPools();
    const cutoff = retentionCutoff(T0 + 1000);
    await insertSwaps(db, [swapRec({ txHash: txHash(0xe3), timestamp: cutoff - 10 })]);
    expect(await nightly()).toEqual({ done: true, phase: "", listed: 2, probed: 0, routable: 0, unroutable: 0, skipped: 0, pruned: 1, prunedCandles: 0, prunedHolders: 0, uploadsDeleted: 0, queries: 0 });
    expect(await db.query("select tx_hash from market.swaps")).toEqual([]);
  });

  it("reports the phase not done when the swap prune runs out of time, leaving the candle prune with none either", async () => {
    await seedTokensAndPools();
    const cutoff = retentionCutoff(T0 + 1000);
    const candleStale = candleCutoff("m1", T0 + 1000);
    await insertSwaps(db, [swapRec({ txHash: txHash(0xe4), timestamp: cutoff - 10 })]);
    await upsertCandles(db, [candleRec({ interval: "m1", t: candleStale - 10 })]);
    // Already past by the time the prune phase is reached: pruneSwaps's own first deadline check bails
    // immediately (deleted 0, done false), and pruneCandles — called right after, sharing the same deadline —
    // bails the same way on its own first check. Neither row is touched; the phase itself must not read done.
    const result = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() - 1 });
    expect(result).toMatchObject({ done: false, phase: "prune", pruned: 0, prunedCandles: 0 });
    expect(await db.query("select tx_hash from market.swaps")).toEqual([{ tx_hash: txHash(0xe4) }]);
    expect(await db.query("select t from market.candles")).toEqual([{ t: candleStale - 10 }]);
    expect(await readState(db, "nightly")).toMatchObject({ phase: "prune" });
  });

  it("drops the holder lists of tokens neither covered nor opened inside the keep window, and keeps the other two (design section 7)", async () => {
    await seedHolderCleanupCase();
    expect(await nightly()).toMatchObject({ done: true, phase: "", prunedHolders: 1 });
    // TOKEN_A is in the coverage set (it traded in the last 24 h) and TOKEN_C was opened two days ago; only
    // TOKEN_D — off the table and untouched for ten — loses both its refresh row and its balances.
    expect(await holderTokens()).toEqual([{ token_id: TOKEN_A }, { token_id: TOKEN_C }]);
    expect(await balanceTokens()).toEqual([{ token_id: TOKEN_A }, { token_id: TOKEN_C }]);
  });

  it('stores the phase sequence "prune" then "holders" then "probe", so a crash mid-cleanup resumes at the cleanup', async () => {
    await seedHolderCleanupCase();
    const spy = vi.spyOn(db, "query");
    await nightly();
    // saveCursors binds [job, ...values] in patch order (cursor, cursor2, cursor_text, phase), so every phase
    // transition this job writes is a three-parameter call [job, cursorText, phase] — the last entry is its name.
    const phases = spy.mock.calls
      .map(([, params]) => params)
      .filter((params): params is unknown[] => Array.isArray(params) && params[0] === "nightly" && params.length === 3)
      .map((params) => params[2]);
    expect(phases).toEqual(["prune", "holders", "uploads", "probe", ""]);
  });

  it("sweeps balance rows whose refresh row is already gone, leaving the covered and recently opened lists alone", async () => {
    await seedHolderCleanupCase();
    // No refresh row of their own, so neither is a victim of the per-token deletes: pruneHolders's closing
    // anti-join over the whole balances table is the only thing that can reach them (TOKEN_B is a real token
    // with no list, addr(0xb5) a token the store has never seen at all).
    await seedOrphanBalance(TOKEN_B);
    await seedOrphanBalance(addr(0xb5));
    // prunedHolders counts victim TOKENS — only TOKEN_D — and never the swept rows: an orphan has no refresh
    // row to lose, so it was never on anybody's list to begin with.
    expect(await nightly()).toMatchObject({ done: true, phase: "", prunedHolders: 1 });
    expect(await balanceTokens()).toEqual([{ token_id: TOKEN_A }, { token_id: TOKEN_C }]);
    expect(await holderTokens()).toEqual([{ token_id: TOKEN_A }, { token_id: TOKEN_C }]);
  });

  it('resumes a stored "holders" phase directly, skipping "listed" and "prune", then continues into "probe"', async () => {
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    await seedHolderCleanupCase();
    await db.query("update market.tokens set listed_pool_id = null"); // proves "listed" really did not re-run below
    const cutoff = retentionCutoff(T0 + 1000);
    await insertSwaps(db, [swapRec({ txHash: txHash(0xf2), timestamp: cutoff - 10 })]); // stale, but "prune" is skipped this cycle
    await saveCursors(db, "nightly", { phase: "holders", cursorText: "" });
    const quoter: Quoter = { exactIn: async () => 1n, exactOut: async () => { throw new Error("unused by probePools"); } };
    const result = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });
    expect(result).toMatchObject({ done: true, phase: "", listed: 0, pruned: 0, prunedCandles: 0, prunedHolders: 1, probed: 2, routable: 2 });
    expect(await holderTokens()).toEqual([{ token_id: TOKEN_A }, { token_id: TOKEN_C }]);
    // The stale swap survives (prune skipped this cycle), and the run still finishes through probe.
    expect(await db.query("select tx_hash from market.swaps order by tx_hash")).toEqual([{ tx_hash: txHash(0xf1) }, { tx_hash: txHash(0xf2) }]);
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "" });
  });

  it('stops in "holders" when the deadline has already passed, deletes nothing, and the next run finishes the cleanup', async () => {
    await seedHolderCleanupCase();
    await saveCursors(db, "nightly", { phase: "holders", cursorText: "" });
    // Already past on entry. The phase must not start work it cannot finish, and must leave its OWN name
    // stored: falling through to "probe" here would store "probe", and every later night would resume there —
    // skipping listed, prune and this cleanup for good (fix round 1).
    const stopped = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() - 1 });
    expect(stopped).toMatchObject({ done: false, phase: "holders", listed: 0, pruned: 0, prunedCandles: 0, prunedHolders: 0 });
    expect(await readState(db, "nightly")).toMatchObject({ phase: "holders", cursorText: "" });
    expect(await holderTokens()).toEqual([{ token_id: TOKEN_A }, { token_id: TOKEN_C }, { token_id: TOKEN_D }]);
    // A full window re-enters the phase and finds exactly the same victim.
    expect(await nightly()).toMatchObject({ done: true, phase: "", prunedHolders: 1 });
    expect(await holderTokens()).toEqual([{ token_id: TOKEN_A }, { token_id: TOKEN_C }]);
  });

  it('stops in "holders" when the deadline passes BETWEEN victims, keeps the phase and finishes the cleanup next run', async () => {
    // I2: pruneHolders used to loop every victim with no deadline of its own, so a cleanup that entered the
    // phase in time could still run past maxDuration and be killed mid-list. It now reports `done` like
    // pruneSwaps/pruneCandles, and this phase must return finish(false, "holders") on it.
    await seedHolderCleanupCase();
    await seedHolderList(TOKEN_E, T0 + 1000 - KEEP_REQUESTED_SEC - 86_400); // a second victim beside TOKEN_D
    await saveCursors(db, "nightly", { phase: "holders", cursorText: "" });

    const clock = { t: 1_700_000_000_000 };
    vi.spyOn(Date, "now").mockImplementation(() => clock.t);
    const deadlineMs = clock.t + 60_000;
    let dropped = 0;
    const gated: Db = {
      ...db,
      async query<T extends Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]> {
        const rows = await db.query<T>(text, params);
        if (text.startsWith("delete from market.holder_refresh") && ++dropped === 1) clock.t = deadlineMs;
        return rows;
      },
    };

    const stopped = await runNightly(gated, { now: T0 + 1000, queryBudget: 240, deadlineMs });
    expect(stopped).toMatchObject({ done: false, phase: "holders", prunedHolders: 1 });
    expect(await readState(db, "nightly")).toMatchObject({ phase: "holders", cursorText: "" });
    expect(await holderTokens()).toHaveLength(3); // the two kept lists and one of the two victims

    vi.restoreAllMocks();
    expect(await nightly()).toMatchObject({ done: true, phase: "", prunedHolders: 1 });
    expect(await holderTokens()).toEqual([{ token_id: TOKEN_A }, { token_id: TOKEN_C }]);
  });

  it('resumes into "holders" on the next run when the deadline stopped the previous one inside "prune"', async () => {
    await seedHolderCleanupCase();
    // Deadline already past: the run stops inside "prune" without ever reaching the cleanup.
    const stopped = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() - 1 });
    expect(stopped).toMatchObject({ done: false, phase: "prune", prunedHolders: 0 });
    expect(await holderTokens()).toEqual([{ token_id: TOKEN_A }, { token_id: TOKEN_C }, { token_id: TOKEN_D }]);
    // The next run re-enters "prune" (no cursor of its own) and carries straight on into "holders".
    expect(await nightly()).toMatchObject({ done: true, phase: "", prunedHolders: 1 });
    expect(await holderTokens()).toEqual([{ token_id: TOKEN_A }, { token_id: TOKEN_C }]);
  });

  it('runs the "uploads" phase between "holders" and "probe" when a cleaner is supplied, and skips it without one (instant launchpad, section 6)', async () => {
    await seedTokensAndPools();
    await db.exec("delete from market.launch_uploads");
    await saveCursors(db, "chain", { cursor: 5_000 });
    await finishRun(db, "chain", { now: T0 + 1000 - 60, ok: true, rows: 0, queries: 0 });
    await db.query(
      `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, status, created_at)
       values ('0xc1', 'i1', 'm1', 'launch/img/i1.webp', 'launch/meta/m1.json', 'N', 'S', 'pending', $1)`,
      [T0 + 1000 - 200_000],
    );
    const withoutCleaner = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000 });
    expect(withoutCleaner).toMatchObject({ done: true, uploadsDeleted: 0 });
    const uploads = {
      blockTimestamp: vi.fn<UploadCleaner["blockTimestamp"]>(async () => T0 + 1000),
      deleteObject: vi.fn<UploadCleaner["deleteObject"]>(async () => {}),
    };
    const result = await runNightly(db, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, uploads });
    expect(result).toMatchObject({ done: true, phase: "", uploadsDeleted: 1 });
    expect(uploads.deleteObject.mock.calls.map(([key]) => key)).toEqual(["launch/meta/m1.json", "launch/img/i1.webp"]);
  });
});
