import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { testDb } from "@/test/db";
import {
  COVERAGE_LIMIT,
  DELTA_CHUNK,
  FULL_PASS_SEC,
  GIANT_HOLDERS,
  KEEP_REQUESTED_SEC,
  MissingRowError,
  REQUEST_STAMP_MIN_SEC,
  STALE_SEC,
  applySlice,
  coverageSet,
  dueTokens,
  ensureRows,
  markReady,
  markSkipped,
  pruneHolders,
  refreshRow,
  requestBuild,
  MAX_TRANSFERS_PER_TOKEN,
} from "./store";

// Ids in the shape the reader writes them: lowercase hex, tokens 40 digits, pools and tx hashes 64.
const hex = (n: number, digits: number) => "0x" + n.toString(16).padStart(digits, "0");
const addr = (n: number) => hex(n, 40);

const NOW = 1_789_000_000;
const T1 = addr(0xb1), T2 = addr(0xb2), T3 = addr(0xb3), T4 = addr(0xb4);
const T5 = addr(0xb5), T6 = addr(0xb6), T7 = addr(0xb7), T8 = addr(0xb8), T9 = addr(0xb9);
const POOL = hex(0x11, 64);
const W1 = addr(0xc1), W2 = addr(0xc2), W3 = addr(0xc3);

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(() =>
  db.exec("delete from market.token_balances; delete from market.holder_refresh; delete from market.swaps; delete from market.tokens"),
);
afterEach(() => vi.restoreAllMocks());

/** A deadline no test's own work can reach, for the pruner's bounded contract (I2). */
const FAR = () => ({ deadlineMs: Date.now() + 600_000 });

/** The minimal token row the chain store writes (src/lib/chain/store.ts upsertTokensFromFold); only id and holders_count matter here. */
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

/** A refresh row in an arbitrary state — the store's own writers only ever reach a few of them. */
const refresh = (
  tokenId: string,
  o: { refreshedAt?: number; cursorBlock?: number; requestedAt?: number; status?: string; transfers?: number } = {},
) =>
  db.query(
    `insert into market.holder_refresh (token_id, refreshed_at, cursor_block, requested_at, status, transfers)
     values ($1, $2, $3, $4, $5, $6)`,
    [tokenId, o.refreshedAt ?? 0, o.cursorBlock ?? 0, o.requestedAt ?? 0, o.status ?? "building", o.transfers ?? 0],
  );

const balance = (tokenId: string, holder: string, amount: string) =>
  db.query("insert into market.token_balances (token_id, holder, balance, updated_at) values ($1, $2, $3::numeric, $4)", [
    tokenId,
    holder,
    amount,
    NOW,
  ]);

const balancesOf = (tokenId: string) =>
  db.query<{ holder: string; balance: string }>(
    "select holder, balance from market.token_balances where token_id = $1 order by holder",
    [tokenId],
  );
const countBalances = async (tokenId: string) =>
  (await db.query<{ n: number }>("select count(*)::int as n from market.token_balances where token_id = $1", [tokenId]))[0].n;
const holdersCountOf = async (tokenId: string) =>
  (await db.query<{ holders_count: number }>("select holders_count from market.tokens where id = $1", [tokenId]))[0].holders_count;

it("coverageSet ranks the last day's trades, skipping excluded ids and giants, and honours the limit", async () => {
  expect(COVERAGE_LIMIT).toBe(500);
  await seedToken(T1);
  await seedToken(T2);
  await seedToken(T3);
  await seedToken(T4, GIANT_HOLDERS + 1);
  for (let i = 0; i < 3; i++) await swap(T1, NOW - 100);
  for (let i = 0; i < 2; i++) await swap(T2, NOW - 100);
  await swap(T3, NOW - 100);
  // T3 traded heavily yesterday and T4 heavily today, but neither counts: the window is 24 h, and T4 is a giant.
  for (let i = 0; i < 5; i++) await swap(T3, NOW - 90_000);
  for (let i = 0; i < 9; i++) await swap(T4, NOW - 100);

  expect(await coverageSet(db, NOW, [])).toEqual([T1, T2, T3]);
  expect(await coverageSet(db, NOW, [T2])).toEqual([T1, T3]);
  // The quote list the builder passes may be checksummed; the store lowercases it before comparing.
  expect(await coverageSet(db, NOW, [T2.toUpperCase()])).toEqual([T1, T3]);
  expect(await coverageSet(db, NOW, [], 2)).toEqual([T1, T2]);
});

it("ensureRows inserts building rows for missing ids and leaves an existing row alone", async () => {
  await refresh(T1, { status: "ready", refreshedAt: NOW - 50, cursorBlock: 42, transfers: 7 });

  await ensureRows(db, []); // nothing to do, and no statement to fail on an empty array
  await ensureRows(db, [T1, T2, T3]);

  expect(await refreshRow(db, T1)).toEqual({
    tokenId: T1, refreshedAt: NOW - 50, cursorBlock: 42, requestedAt: 0, status: "ready", transfers: 7,
  });
  expect(await refreshRow(db, T2)).toEqual({
    tokenId: T2, refreshedAt: 0, cursorBlock: 0, requestedAt: 0, status: "building", transfers: 0,
  });
  expect(await refreshRow(db, T3)).toEqual({
    tokenId: T3, refreshedAt: 0, cursorBlock: 0, requestedAt: 0, status: "building", transfers: 0,
  });
  expect(await refreshRow(db, T4)).toBeNull();
});

it("applySlice adds deltas, drops wallets that reach zero, and moves the cursor in one transaction", async () => {
  expect(DELTA_CHUNK).toBe(5_000);
  await refresh(T1);
  await balance(T1, W1, "100");
  await balance(T1, W2, "5");
  await balance(T2, W1, "9"); // another token's map must not move

  await applySlice(db, T1, new Map([[W1, 50n], [W2, -5n], [W3, 7n]]), 900, 3, NOW);

  expect(await balancesOf(T1)).toEqual([{ holder: W1, balance: "150" }, { holder: W3, balance: "7" }]);
  expect(await balancesOf(T2)).toEqual([{ holder: W1, balance: "9" }]);
  expect(await refreshRow(db, T1)).toMatchObject({ cursorBlock: 900, transfers: 3 });

  // One slice wider than DELTA_CHUNK: it is written in two statements inside one transaction, and must land whole.
  const many = new Map<string, bigint>();
  for (let i = 0; i < DELTA_CHUNK + 1; i++) many.set(addr(1_000_000 + i), 1n);
  await applySlice(db, T1, many, 1_800, DELTA_CHUNK + 1, NOW + 1);

  expect(await countBalances(T1)).toBe(DELTA_CHUNK + 1 + 2); // the 5 001 new wallets plus W1 and W3
  expect(await balancesOf(T1)).toEqual(
    expect.arrayContaining([
      { holder: addr(1_000_000), balance: "1" }, // first wallet of the first chunk
      { holder: addr(1_000_000 + DELTA_CHUNK), balance: "1" }, // the only wallet of the second
    ]),
  );
  expect(await refreshRow(db, T1)).toMatchObject({ cursorBlock: 1_800, transfers: 3 + DELTA_CHUNK + 1 });
});

// Review round 1: the three writers of market.holder_refresh used to update `where token_id = $1` and ignore that
// nothing matched. applySlice was the dangerous one — the balances committed while the cursor did not, so the next
// pass re-folded the same range and doubled every delta. All three now throw, inside their transaction, so the rest
// of the statement group rolls back with them.
it("applySlice throws and rolls its deltas back when the token has no refresh row", async () => {
  await balance(T1, W1, "100");

  await expect(applySlice(db, T1, new Map([[W1, 50n], [W2, 7n]]), 900, 3, NOW)).rejects.toThrow(
    `applySlice: no market.holder_refresh row for token ${T1}`,
  );

  expect(await balancesOf(T1)).toEqual([{ holder: W1, balance: "100" }]); // neither the upsert nor W2's insert survived
});

it("markReady stamps the row and sets the token's exact holder count", async () => {
  await seedToken(T1, 999); // whatever the reader's ±1 deltas left behind
  await refresh(T1, { status: "building", cursorBlock: 4_000 });
  await balance(T1, W1, "100");
  await balance(T1, W2, "7");
  await balance(T1, W3, "-5"); // a non-standard token can leave a negative; only balance > 0 is a holder

  expect(await markReady(db, T1, NOW)).toBe(2);

  expect(await refreshRow(db, T1)).toMatchObject({ status: "ready", refreshedAt: NOW, cursorBlock: 4_000 });
  expect(await holdersCountOf(T1)).toBe(2);
});

it("markReady throws and leaves the holder count alone when there is no refresh row", async () => {
  await seedToken(T1, 999);
  await balance(T1, W1, "100");

  await expect(markReady(db, T1, NOW)).rejects.toThrow(`markReady: no market.holder_refresh row for token ${T1}`);

  expect(await holdersCountOf(T1)).toBe(999); // the exact-count update never ran
});

/** requestBuild can insert a refresh row for a token market.tokens has never heard of; setting no count is worse than failing. */
it("markReady throws and rolls its stamp back when the token has no market.tokens row", async () => {
  await refresh(T1, { status: "building" });
  await balance(T1, W1, "100");

  await expect(markReady(db, T1, NOW)).rejects.toThrow(`markReady: no market.tokens row for token ${T1}`);

  expect(await refreshRow(db, T1)).toMatchObject({ status: "building", refreshedAt: 0 }); // the ready stamp rolled back
});

/**
 * Fix round 1: the builder tells a missing market.tokens row (a terminal per-token state it skips) from a
 * missing holder_refresh row (a broken invariant that ends the invocation) by the TYPE and its `table`,
 * never by matching the message text — so the three fields are part of the contract, not just the wording.
 */
it("requireRow throws a MissingRowError carrying the function, the table and the token", async () => {
  const thrown = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (err: unknown) => err);
  await refresh(T1, { status: "building" }); // a refresh row for a token market.tokens has never seen

  const missingToken = await thrown(markReady(db, T1, NOW));
  expect(missingToken).toBeInstanceOf(MissingRowError);
  const a = missingToken as MissingRowError;
  expect(a.name).toBe("MissingRowError");
  expect(a.fn).toBe("markReady");
  expect(a.table).toBe("market.tokens");
  expect(a.tokenId).toBe(T1);
  expect(a.message).toBe(`markReady: no market.tokens row for token ${T1}`); // unchanged by the new type

  const missingRefresh = await thrown(applySlice(db, T2, new Map([[W1, 5n]]), 900, 1, NOW));
  expect(missingRefresh).toBeInstanceOf(MissingRowError);
  const b = missingRefresh as MissingRowError;
  expect(b.fn).toBe("applySlice");
  expect(b.table).toBe("market.holder_refresh");
  expect(b.tokenId).toBe(T2);
});

it("markSkipped throws and keeps the balances when there is no refresh row", async () => {
  await balance(T1, W1, "100");
  await balance(T1, W2, "7");

  await expect(markSkipped(db, T1)).rejects.toThrow(`markSkipped: no market.holder_refresh row for token ${T1}`);

  expect(await countBalances(T1)).toBe(2); // the delete that ran first rolled back
});

it("markSkipped drops the token's rows and rewinds its cursor", async () => {
  await refresh(T1, { status: "building", cursorBlock: 5_000, transfers: MAX_TRANSFERS_PER_TOKEN });
  await balance(T1, W1, "100");
  await balance(T1, W2, "7");
  await balance(T2, W1, "9");

  await markSkipped(db, T1);

  expect(await countBalances(T1)).toBe(0);
  expect(await countBalances(T2)).toBe(1);
  expect(await refreshRow(db, T1)).toMatchObject({ status: "skipped", cursorBlock: 0 });
});

it("requestBuild stamps an absent, building or ready row at most once a minute, never a skipped one", async () => {
  expect(REQUEST_STAMP_MIN_SEC).toBe(60);

  expect(await requestBuild(db, T1, NOW)).toBe(true); // absent: inserted as building
  expect(await refreshRow(db, T1)).toEqual({
    tokenId: T1, refreshedAt: 0, cursorBlock: 0, requestedAt: NOW, status: "building", transfers: 0,
  });
  expect(await requestBuild(db, T1, NOW + 30)).toBe(false); // inside the window
  expect(await requestBuild(db, T1, NOW + REQUEST_STAMP_MIN_SEC)).toBe(false); // exactly at it is still inside
  expect(await refreshRow(db, T1)).toMatchObject({ requestedAt: NOW });
  expect(await requestBuild(db, T1, NOW + REQUEST_STAMP_MIN_SEC + 1)).toBe(true);
  expect(await refreshRow(db, T1)).toMatchObject({ requestedAt: NOW + REQUEST_STAMP_MIN_SEC + 1 });

  // A ready list that someone opened is stamped too, so an opened stale list gets refreshed.
  await refresh(T2, { status: "ready", refreshedAt: NOW - 1_000 });
  expect(await requestBuild(db, T2, NOW)).toBe(true);
  expect(await refreshRow(db, T2)).toMatchObject({ status: "ready", requestedAt: NOW });

  // A skipped token stays skipped and unstamped however often it is opened.
  await refresh(T3, { status: "skipped" });
  expect(await requestBuild(db, T3, NOW)).toBe(false);
  expect(await refreshRow(db, T3)).toMatchObject({ status: "skipped", requestedAt: 0 });
});

it("dueTokens lists opened, then traded-since, then full-pass tokens, each once", async () => {
  expect([STALE_SEC, FULL_PASS_SEC]).toEqual([900, 3_600]);
  const coverage = [T1, T2, T3, T4, T5, T6, T7]; // coverage order: most traded first

  await refresh(T1, { status: "ready", refreshedAt: NOW - 1_000, requestedAt: NOW - 20 }); // opened AND stale-and-traded
  await refresh(T2, { status: "ready", refreshedAt: NOW - 1_000 }); // stale, but its last trade predates the list
  await refresh(T3, { status: "ready", refreshedAt: NOW - 1_000 }); // stale and traded since
  await refresh(T4, { status: "building" }); // never folded: refreshed_at 0, requested_at 0
  await refresh(T5, { status: "ready", refreshedAt: NOW - 5_000 }); // its only trade predates the full pass: tier 3, not tier 2
  await refresh(T6, { status: "ready", refreshedAt: NOW - 300 }); // fresh
  await refresh(T7, { status: "skipped", requestedAt: NOW - 50 }); // never, whatever else is true of it
  await refresh(T8, { status: "building", requestedAt: NOW - 5 }); // off-table, opened a moment ago
  await refresh(T9, { status: "building", requestedAt: NOW - 100 }); // off-table, opened earlier

  await swap(T1, NOW - 500);
  await swap(T2, NOW - 2_000); // older than T2's refreshed_at
  await swap(T3, NOW - 400);
  // Newer than T5's refreshed_at but older than FULL_PASS_SEC, so the traded-since probe's time bound excludes
  // it: T5 reaches the list through tier 3 (oldest refreshed_at first), behind T4, not through tier 2.
  await swap(T5, NOW - 4_000);
  await swap(T6, NOW - 100);
  await swap(T7, NOW - 100);

  const due = await dueTokens(db, coverage, NOW);
  const ids = due.map((r) => r.tokenId);
  expect(ids).toEqual([T8, T1, T9, T3, T4, T5]);
  expect(ids).not.toContain(T2); // stale but no trade since, and inside the full pass
  expect(ids).not.toContain(T6); // refreshed five minutes ago
  expect(ids).not.toContain(T7); // skipped
  expect(due[0]).toEqual({
    tokenId: T8, refreshedAt: 0, cursorBlock: 0, requestedAt: NOW - 5, status: "building", transfers: 0,
  });

  // With no coverage set at all, only the opened tokens are due.
  expect((await dueTokens(db, [], NOW)).map((r) => r.tokenId)).toEqual([T8, T1, T9]);
});

it("pruneHolders drops tokens neither covered nor recently opened, and orphan balance rows", async () => {
  expect(KEEP_REQUESTED_SEC).toBe(7 * 86_400);

  await refresh(T1); // kept: in keepIds
  await balance(T1, W1, "1");
  await balance(T1, W2, "2");
  await refresh(T2, { requestedAt: NOW - KEEP_REQUESTED_SEC }); // kept: requested exactly at the edge of the window
  await balance(T2, W1, "3");
  await refresh(T3, { status: "ready", requestedAt: NOW - KEEP_REQUESTED_SEC - 1 }); // one second too old
  await balance(T3, W1, "4");
  await balance(T3, W2, "5");
  await balance(T3, W3, "6");
  await refresh(T4); // never requested at all
  await balance(T4, W1, "7");
  await balance(T5, W1, "8"); // orphan: balances with no refresh row
  await balance(T5, W2, "9");

  expect(await pruneHolders(db, [T1], NOW, FAR())).toEqual({ tokens: 2, rows: 6, done: true });

  expect(await db.query("select token_id from market.holder_refresh order by token_id")).toEqual([{ token_id: T1 }, { token_id: T2 }]);
  expect(await countBalances(T1)).toBe(2);
  expect(await countBalances(T2)).toBe(1);
  for (const gone of [T3, T4, T5]) expect(await countBalances(gone)).toBe(0);
});

it("pruneHolders stops at the deadline, keeping what it dropped and leaving the rest for the next run", async () => {
  // I2: the same bounded contract pruneSwaps/pruneCandles have (src/lib/sync/retention.ts). Two victims and
  // one orphan, so the stop can land between the victims and short of the closing anti-join.
  await refresh(T2, { requestedAt: NOW - KEEP_REQUESTED_SEC - 1 });
  await balance(T2, W1, "1");
  await refresh(T3, { requestedAt: NOW - KEEP_REQUESTED_SEC - 1 });
  await balance(T3, W1, "2");
  await balance(T4, W1, "3"); // orphan: only the closing sweep can reach it

  // A frozen clock pushed past the deadline the moment the first victim's refresh row is gone: the stop is
  // a fact of the test, not a wall-clock race.
  const clock = { t: 1_700_000_000_000 };
  vi.spyOn(Date, "now").mockImplementation(() => clock.t);
  const deadlineMs = clock.t + 1;
  let dropped = 0;
  const gated: Db = {
    ...db,
    async query<T extends Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]> {
      const rows = await db.query<T>(text, params);
      if (text.startsWith("delete from market.holder_refresh") && ++dropped === 1) clock.t = deadlineMs;
      return rows;
    },
  };

  expect(await pruneHolders(gated, [], NOW, { deadlineMs })).toEqual({ tokens: 1, rows: 1, done: false });
  // Exactly one victim went; the other is untouched, and the orphan survives because the sweep never ran.
  const left = await db.query<{ token_id: string }>("select token_id from market.holder_refresh");
  expect(left).toHaveLength(1);
  expect(await countBalances(left[0]!.token_id)).toBe(1);
  expect(await countBalances(T4)).toBe(1);

  // The pruner carries no cursor: a full window simply re-scans and finds the same work waiting.
  vi.restoreAllMocks();
  expect(await pruneHolders(db, [], NOW, FAR())).toEqual({ tokens: 1, rows: 2, done: true });
  expect(await db.query("select token_id from market.holder_refresh")).toEqual([]);
  expect(await countBalances(T4)).toBe(0);
});
