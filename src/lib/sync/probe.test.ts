import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { NotRoutableError, QuoterUnavailableError, type Quoter, type QuoterCall } from "@/lib/quote/quoter";
import { testDb } from "@/test/db";
import { PROBE_ACTIVE_SEC, PROBE_CONCURRENCY, probePools } from "./probe";
import { POOL_A, POOL_B, T0, poolId, poolRec, priceRec, quoteRec, tokenRec } from "./testRows";
import { upsertPools, upsertQuotes, upsertTokens } from "./writers";

const NOW = T0 + 10 * 86_400;
/** Well inside the 7-day window. */
const RECENT = NOW - 3_600;
/** Just past it: excluded from the candidate set. */
const STALE = NOW - PROBE_ACTIVE_SEC - 3_600;
const FAR_FUTURE_DEADLINE = () => Date.now() + 60_000;

type Verdict = "routable" | "unroutable" | "unavailable";

/** A Quoter whose exactIn answers per pool id (default "routable"); exactOut is never called by probePools. */
function fakeQuoter(verdicts: Record<string, Verdict> = {}, onCall?: (call: QuoterCall) => void): Quoter {
  return {
    async exactIn(call) {
      onCall?.(call);
      const v = verdicts[call.poolKey.poolId] ?? "routable";
      if (v === "unroutable") throw new NotRoutableError("the pool cannot be routed");
      if (v === "unavailable") throw new QuoterUnavailableError(new Error("down"));
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
});
