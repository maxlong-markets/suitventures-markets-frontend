import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { NotRoutableError, QuoterUnavailableError, type Quoter, type QuoterCall } from "@/lib/quote/quoter";
import { testDb } from "@/test/db";
import { PAGE_LIMIT } from "./market";
import { PROBE_ACTIVE_SEC, PROBE_CONCURRENCY, probePools } from "./probe";
import { addr, POOL_A, POOL_B, QUOTE, T0, TOKEN_A, poolId, poolRec, priceRec, quoteRec, tokenRec } from "./testRows";
import { upsertPools, upsertQuotes, upsertTokens } from "./writers";

const NOW = T0 + 10 * 86_400;
/** Well inside the 7-day window. */
const RECENT = NOW - 3_600;
/** Just past it: excluded from the candidate set. */
const STALE = NOW - PROBE_ACTIVE_SEC - 3_600;
const FAR_FUTURE_DEADLINE = () => Date.now() + 60_000;

type Verdict = "routable" | "unroutable" | "unavailable" | "zero";

/** A Quoter whose exactIn answers per pool id (default "routable"); exactOut is never called by probePools. */
function fakeQuoter(verdicts: Record<string, Verdict> = {}, onCall?: (call: QuoterCall) => void): Quoter {
  return {
    async exactIn(call) {
      onCall?.(call);
      const v = verdicts[call.poolKey.poolId] ?? "routable";
      if (v === "unroutable") throw new NotRoutableError("the pool cannot be routed");
      if (v === "unavailable") throw new QuoterUnavailableError(new Error("down"));
      if (v === "zero") return 0n;
      return 42n;
    },
    async exactOut() {
      throw new Error("exactOut is not used by probePools");
    },
  };
}

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
beforeEach(async () => {
  await db.exec("delete from market.pools; delete from market.tokens; delete from market.quotes");
  await upsertQuotes(db, [quoteRec()], [priceRec()]);
  await upsertTokens(db, [tokenRec()], NOW);
});

describe("probePools", () => {
  it("writes true for a pool the quoter answers and false for one it reverts on", async () => {
    await upsertPools(db, [poolRec({ id: POOL_A, lastSwapAt: RECENT }), poolRec({ id: POOL_B, lastSwapAt: RECENT })], NOW);
    const quoter = fakeQuoter({ [POOL_A]: "routable", [POOL_B]: "unroutable" });
    const result = await probePools(db, quoter, { now: NOW, deadlineMs: FAR_FUTURE_DEADLINE(), afterId: "" });
    expect(result).toEqual({ probed: 2, routable: 1, unroutable: 1, skipped: 0, lastId: POOL_B, done: true });
    expect(await db.query("select id, routable, probed_at from market.pools order by id")).toEqual([
      { id: POOL_A, routable: true, probed_at: NOW },
      { id: POOL_B, routable: false, probed_at: NOW },
    ]);
  });

  it("leaves both columns null and counts a transport failure as skipped", async () => {
    await upsertPools(db, [poolRec({ id: POOL_A, lastSwapAt: RECENT })], NOW);
    const result = await probePools(db, fakeQuoter({ [POOL_A]: "unavailable" }), { now: NOW, deadlineMs: FAR_FUTURE_DEADLINE(), afterId: "" });
    expect(result).toEqual({ probed: 1, routable: 0, unroutable: 0, skipped: 1, lastId: POOL_A, done: true });
    expect(await db.query("select routable, probed_at from market.pools where id = $1", [POOL_A])).toEqual([{ routable: null, probed_at: null }]);
  });

  it("excludes a pool traded more than PROBE_ACTIVE_SEC ago and one with an insane price", async () => {
    const stalePool = poolId(0x21);
    const insanePool = poolId(0x22);
    await upsertPools(db, [
      poolRec({ id: POOL_A, lastSwapAt: RECENT }), // control: a sane, recently-traded pool
      poolRec({ id: stalePool, lastSwapAt: STALE }),
      poolRec({ id: insanePool, lastSwapAt: RECENT, priceQuote: "0" }),
    ], NOW);
    const calls: string[] = [];
    const result = await probePools(db, fakeQuoter({}, (call) => calls.push(call.poolKey.poolId)), { now: NOW, deadlineMs: FAR_FUTURE_DEADLINE(), afterId: "" });
    expect(result).toEqual({ probed: 1, routable: 1, unroutable: 0, skipped: 0, lastId: POOL_A, done: true });
    expect(calls).toEqual([POOL_A]);
    expect(await db.query("select id, routable from market.pools where id != $1 order by id", [POOL_A]))
      .toEqual([{ id: stalePool, routable: null }, { id: insanePool, routable: null }]);
  });

  it("resumes after the given afterId, skipping pools at or before it", async () => {
    await upsertPools(db, [poolRec({ id: POOL_A, lastSwapAt: RECENT }), poolRec({ id: POOL_B, lastSwapAt: RECENT })], NOW);
    const calls: string[] = [];
    const result = await probePools(db, fakeQuoter({}, (call) => calls.push(call.poolKey.poolId)), { now: NOW, deadlineMs: FAR_FUTURE_DEADLINE(), afterId: POOL_A });
    expect(result).toEqual({ probed: 1, routable: 1, unroutable: 0, skipped: 0, lastId: POOL_B, done: true });
    expect(calls).toEqual([POOL_B]);
    expect(await db.query("select probed_at from market.pools where id = $1", [POOL_A])).toEqual([{ probed_at: null }]);
  });

  it("stops at the cap with done false, reporting where to resume", async () => {
    const third = poolId(0x31); // sorts after POOL_A (…011) and POOL_B (…012)
    await upsertPools(db, [POOL_A, POOL_B, third].map((id) => poolRec({ id, lastSwapAt: RECENT })), NOW);
    const result = await probePools(db, fakeQuoter(), { now: NOW, deadlineMs: FAR_FUTURE_DEADLINE(), afterId: "", cap: 2 });
    expect(result).toEqual({ probed: 2, routable: 2, unroutable: 0, skipped: 0, lastId: POOL_B, done: false });
    expect(await db.query("select probed_at from market.pools where id = $1", [third])).toEqual([{ probed_at: null }]);
  });

  it("stops immediately, probing nothing, when the deadline has already passed", async () => {
    await upsertPools(db, [poolRec({ id: POOL_A, lastSwapAt: RECENT })], NOW);
    const result = await probePools(db, fakeQuoter(), { now: NOW, deadlineMs: Date.now() - 1, afterId: "" });
    expect(result).toEqual({ probed: 0, routable: 0, unroutable: 0, skipped: 0, lastId: "", done: false });
  });

  it("never runs more than PROBE_CONCURRENCY probes at once", async () => {
    const ids = [0x41, 0x42, 0x43, 0x44, 0x45].map(poolId);
    await upsertPools(db, ids.map((id) => poolRec({ id, lastSwapAt: RECENT })), NOW);
    let inFlight = 0;
    let peak = 0;
    const quoter: Quoter = {
      async exactIn() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve(); // yields, so the other queued calls in this batch have already started
        inFlight -= 1;
        return 1n;
      },
      async exactOut() {
        throw new Error("exactOut is not used by probePools");
      },
    };
    const result = await probePools(db, quoter, { now: NOW, deadlineMs: FAR_FUTURE_DEADLINE(), afterId: "" });
    expect(result.probed).toBe(5);
    expect(peak).toBe(PROBE_CONCURRENCY);
  });

  it("asserts the exact QuoterCall — direction and poolKey — for both pool orientations (C1)", async () => {
    const poolTrue = poolId(0x51); // tokenIsCurrency0: true — currency0 is the token
    const poolFalse = poolId(0x52); // tokenIsCurrency0: false — currency0 is the quote
    await upsertPools(db, [
      poolRec({ id: poolTrue, lastSwapAt: RECENT, tokenIsCurrency0: true, fee: 3000, tickSpacing: 60, hooks: addr(0x9) }),
      poolRec({ id: poolFalse, lastSwapAt: RECENT, tokenIsCurrency0: false, fee: 500, tickSpacing: 10, hooks: addr(0xa) }),
    ], NOW);
    const calls: QuoterCall[] = [];
    await probePools(db, fakeQuoter({}, (call) => calls.push(call)), { now: NOW, deadlineMs: FAR_FUTURE_DEADLINE(), afterId: "" });
    expect(calls).toHaveLength(2);
    const byId = Object.fromEntries(calls.map((c) => [c.poolKey.poolId, c]));
    // The probe buys: it pays the quote asset. tokenIsCurrency0 true means the token is currency0, so paying the
    // quote (currency1) is currency1 -> currency0, i.e. zeroForOne: false. A flipped sign here would probe the
    // wrong side of the pool and still "succeed" unless this exact shape is pinned.
    expect(byId[poolTrue]).toEqual({
      zeroForOne: false,
      exactAmount: 10n ** 15n,
      poolKey: {
        poolId: poolTrue, currency0: TOKEN_A, currency1: QUOTE, fee: 3000, tickSpacing: 60, hooks: addr(0x9),
        tokenIsCurrency0: true, priceQuote: 0.000866, tokenAddress: TOKEN_A, tokenDecimals: 18, quoteAddress: QUOTE, quoteDecimals: 18,
      },
    });
    // tokenIsCurrency0 false means the quote is currency0, so paying it is currency0 -> currency1: zeroForOne true.
    expect(byId[poolFalse]).toEqual({
      zeroForOne: true,
      exactAmount: 10n ** 15n,
      poolKey: {
        poolId: poolFalse, currency0: QUOTE, currency1: TOKEN_A, fee: 500, tickSpacing: 10, hooks: addr(0xa),
        tokenIsCurrency0: false, priceQuote: 0.000866, tokenAddress: TOKEN_A, tokenDecimals: 18, quoteAddress: QUOTE, quoteDecimals: 18,
      },
    });
  });

  it("computes exactAmount as 10^(quoteDecimals-3) base units of the quote asset, or 1n under 3 decimals (C1)", async () => {
    const quote6 = addr(0xc6);
    const quote2 = addr(0xc2);
    await upsertQuotes(db, [quoteRec({ id: quote6, address: quote6, decimals: 6 }), quoteRec({ id: quote2, address: quote2, decimals: 2 })],
      [priceRec({ id: quote6 }), priceRec({ id: quote2 })]);
    const pool18 = poolId(0x61);
    const pool6 = poolId(0x62);
    const pool2 = poolId(0x63);
    await upsertPools(db, [
      poolRec({ id: pool18, lastSwapAt: RECENT }), // default quote_id: QUOTE, 18 decimals
      poolRec({ id: pool6, lastSwapAt: RECENT, quote_id: quote6 }),
      poolRec({ id: pool2, lastSwapAt: RECENT, quote_id: quote2 }),
    ], NOW);
    const calls: QuoterCall[] = [];
    await probePools(db, fakeQuoter({}, (call) => calls.push(call)), { now: NOW, deadlineMs: FAR_FUTURE_DEADLINE(), afterId: "" });
    const amountById = Object.fromEntries(calls.map((c) => [c.poolKey.poolId, c.exactAmount]));
    expect(amountById[pool18]).toBe(10n ** 15n); // 18 - 3
    expect(amountById[pool6]).toBe(10n ** 3n); // 6 - 3
    expect(amountById[pool2]).toBe(1n); // under 3: the positive-uint128 floor, not 10^(2-3)
  });

  it("writes routable: true when the quoter answers a real 0n — the honest-zero ruling (I1)", async () => {
    await upsertPools(db, [poolRec({ id: POOL_A, lastSwapAt: RECENT })], NOW);
    const result = await probePools(db, fakeQuoter({ [POOL_A]: "zero" }), { now: NOW, deadlineMs: FAR_FUTURE_DEADLINE(), afterId: "" });
    expect(result).toEqual({ probed: 1, routable: 1, unroutable: 0, skipped: 0, lastId: POOL_A, done: true });
    expect(await db.query("select routable, probed_at from market.pools where id = $1", [POOL_A])).toEqual([{ routable: true, probed_at: NOW }]);
  });

  it(
    "persists the cursor after each page via onPage, and a run resumed from the first page's id does not re-probe it (I3)",
    async () => {
      // PAGE_LIMIT + 1 rows is the minimum that forces probePools to actually fetch a second page: pageSize is
      // capped at PAGE_LIMIT regardless of the default cap (PROBE_RUN_CAP), so a first page always takes exactly
      // min(PAGE_LIMIT, candidates) rows.
      const rows = Array.from({ length: PAGE_LIMIT + 1 }, (_, i) => poolRec({ id: poolId(0x1000 + i), lastSwapAt: RECENT }));
      await upsertPools(db, rows, NOW);
      const pages: string[] = [];
      const result = await probePools(db, fakeQuoter(), {
        now: NOW, deadlineMs: FAR_FUTURE_DEADLINE(), afterId: "",
        onPage: async (lastId) => { pages.push(lastId); },
      });
      expect(pages).toHaveLength(2);
      expect(pages[0] < pages[1]).toBe(true); // ascending, as the fix requires
      expect(result).toMatchObject({ probed: PAGE_LIMIT + 1, done: true, lastId: pages[1] });

      // A run resumed from the first page's saved cursor must not touch any pool the first page already wrote.
      const calls: string[] = [];
      const resumed = await probePools(db, fakeQuoter({}, (call) => calls.push(call.poolKey.poolId)), {
        now: NOW, deadlineMs: FAR_FUTURE_DEADLINE(), afterId: pages[0],
      });
      expect(resumed.probed).toBe(1);
      expect(calls).toEqual([pages[1]]);
    },
    30_000,
  );
});
