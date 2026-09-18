import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import type { Quoter } from "@/lib/quote/quoter";
import { testDb } from "@/test/db";
import { FakeSource } from "./fakeSource";
import { runNightly } from "./nightly";
import { readState, saveCursors } from "./state";
import { POOL_A, POOL_B, T0, TOKEN_A, TOKEN_B, poolRec, priceRec, quoteRec, tokenRec } from "./testRows";
import { upsertQuotes } from "./writers";

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
beforeEach(() => db.exec("delete from market.tokens; delete from market.pools; delete from market.quotes; delete from market.sync_state"));

const source = () => new FakeSource({
  tokens: [tokenRec(), tokenRec({ id: TOKEN_B, address: TOKEN_B, primaryPool_id: POOL_B })],
  pools: [poolRec(), poolRec({ id: POOL_B, token_id: TOKEN_B })],
});
const nightly = (src: FakeSource, queryBudget = 240) => runNightly(db, src, { now: T0 + 1000, queryBudget, deadlineMs: Date.now() + 60_000 });
const listed = () => db.query("select id, listed_pool_id from market.tokens order by id");

describe("runNightly", () => {
  it("walks tokens, then pools, recomputes every listed pool and ends with an empty phase", async () => {
    const src = source();
    // No quoter supplied: the probe phase is a no-op and the run still finishes (nightly.ts's own doc comment).
    expect(await nightly(src)).toEqual({ done: true, phase: "", tokens: 2, pools: 2, listed: 2, probed: 0, queries: 2 });
    expect(src.calls).toEqual(["tokensPage", "poolsPage"]);
    expect(await listed()).toEqual([{ id: TOKEN_A, listed_pool_id: POOL_A }, { id: TOKEN_B, listed_pool_id: POOL_B }]);
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "" });
  });
  it("stops at the budget with done false and the next call continues from the stored phase", async () => {
    const src = source();
    expect(await nightly(src, 1)).toEqual({ done: false, phase: "pools", tokens: 2, pools: 0, listed: 0, probed: 0, queries: 1 });
    expect(await readState(db, "nightly")).toMatchObject({ phase: "pools", cursorText: "" });
    expect(await nightly(src, 1)).toEqual({ done: true, phase: "", tokens: 0, pools: 2, listed: 2, probed: 0, queries: 1 });
  });
  it("resumes a phase after the stored cursor id", async () => {
    await saveCursors(db, "nightly", { phase: "pools", cursorText: POOL_A });
    const src = source();
    expect(await nightly(src)).toMatchObject({ done: true, tokens: 0, pools: 1 });
    expect(src.calls).toEqual(["poolsPage"]);
    expect(await db.query("select id from market.pools")).toEqual([{ id: POOL_B }]);
  });
  it("runs the probe phase when a quoter is supplied, writing routable and landing on phase \"\" with probed counted", async () => {
    await upsertQuotes(db, [quoteRec()], [priceRec()]);
    const src = source();
    const quoter: Quoter = { exactIn: async () => 1n, exactOut: async () => { throw new Error("unused by probePools"); } };
    const result = await runNightly(db, src, { now: T0 + 1000, queryBudget: 240, deadlineMs: Date.now() + 60_000, quoter });
    // The probe phase makes no Envio request, so queries is unchanged from the no-quoter run above.
    expect(result).toEqual({ done: true, phase: "", tokens: 2, pools: 2, listed: 2, probed: 2, queries: 2 });
    expect(await db.query("select id, routable, probed_at from market.pools order by id")).toEqual([
      { id: POOL_A, routable: true, probed_at: T0 + 1000 },
      { id: POOL_B, routable: true, probed_at: T0 + 1000 },
    ]);
    expect(await readState(db, "nightly")).toMatchObject({ phase: "", cursorText: "" });
  });
});
