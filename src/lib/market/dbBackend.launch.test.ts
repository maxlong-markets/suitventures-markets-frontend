import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LaunchRow } from "@/lib/chain/types";
import type { Db } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import { insertLaunchFees, insertLaunches } from "@/lib/launch/store";
import type { PoolRec, QuotePriceRec, QuoteRec, TokenRec } from "@/lib/sync/source";
import { recomputeListedPools, upsertPools, upsertQuotes, upsertTokens } from "@/lib/sync/writers";
import { testDb } from "@/test/db";
import { createDbBackend } from "./dbBackend";

const NOW = 1_790_000_000;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const addr = (c: string) => `0x${c.repeat(40)}`;
const poolId = (c: string) => `0x${c.repeat(64)}`;
const OLD = addr("a"), SV = addr("b"), TRADED_SV = addr("c"), CREATOR = addr("d"), PAYOUT = addr("e"), OTHER_CREATOR = addr("9");
const P_OLD = poolId("a"), P_SV = poolId("b"), P_TRADED = poolId("c");
const LAUNCH_TX = poolId("f");
const SUPPLY = "1000000000000000000000000000";

const quotes: QuoteRec[] = [{ id: USDG, address: USDG, symbol: "USDG", name: "Global Dollar", decimals: 6, enabled: true }];
const prices: QuotePriceRec[] = [{ id: USDG, usdPrice: "1", updatedAt: NOW - 60, aggregator: "pinned" }];
function poolRec(id: string, token: string, over: Partial<PoolRec>): PoolRec {
  return {
    id, token_id: token, quote_id: USDG, tokenIsCurrency0: false, hooks: addr("0"), fee: 10_000, tickSpacing: 200, origin: "SV",
    createdAt: NOW - 100, priceQuote: "0.000005", tvlToken: "0", tvlQuote: "0", swapCount: 0, lastSwapAt: null,
    volumeQuoteAllTime: "0", sqrtPriceX96: null, ...over,
  };
}
function tokenRec(id: string, symbol: string, origin: string, primary: string): TokenRec {
  return {
    id, address: id, symbol, name: `${symbol} token`, decimals: 18, totalSupply: SUPPLY, holdersCount: 1, poolCount: 1, origin,
    createdAt: NOW - 100, primaryPool_id: primary, metadataLoaded: true,
  };
}
function launchRow(o: Partial<LaunchRow> = {}): LaunchRow {
  return {
    tokenId: SV, poolId: P_SV, quoteId: USDG, creator: CREATOR, payout: PAYOUT, hook: addr("0"), tokenIsCurrency0: false,
    creatorShareBps: 7000, openTick: 398_400, openingValuation: 4_995_430_000n, liquidity: 2_240_000_000_000_000_000n,
    tokensInPool: 10n ** 27n - 300n, firstBuyIn: 99_500_000n, firstBuyTokens: 19_000_000n * 10n ** 18n, routerFee: 500_000n,
    creationFee: 0n, name: "Tailor's Chalk", symbol: "CHALK", metadataUri: "ipfs://bafymeta", metadataCid: "bafymeta",
    block: 100, logIndex: 3, txHash: LAUNCH_TX, timestamp: NOW - 100, ...o,
  };
}

describe("the instant launchpad on the markets table and the token page (spec 5.4 and 5.5)", () => {
  let db: Db;
  let now = NOW;
  const backend = () => createDbBackend(db, { now: () => now });

  beforeAll(async () => {
    db = await testDb();
  });
  afterAll(() => db.end());
  beforeEach(async () => {
    clearTtlCache();
    now = NOW;
    await db.exec("delete from market.quotes; delete from market.tokens; delete from market.pools; delete from market.launches; delete from market.launch_fee_events");
    await upsertQuotes(db, quotes, prices);
    await upsertTokens(db, [tokenRec(OLD, "OLD", "LONG", P_OLD), tokenRec(SV, "CHALK", "SV", P_SV), tokenRec(TRADED_SV, "TRD", "SV", P_TRADED)], NOW);
    await upsertPools(db, [
      poolRec(P_OLD, OLD, { origin: "LONG", createdAt: NOW - 90 * 86_400, swapCount: 5, lastSwapAt: NOW - 500, tvlQuote: "1000000" }),
      poolRec(P_SV, SV, {}),
      poolRec(P_TRADED, TRADED_SV, { createdAt: NOW - 3 * 86_400, swapCount: 1, lastSwapAt: NOW - 2000 }),
    ], NOW);
    await recomputeListedPools(db, "all", NOW);
  });

  it("lists an unswapped launch and sorts it by its launch time ahead of older swapped tokens", async () => {
    expect((await backend().pairs("all")).map((p) => p.id)).toEqual([SV, OLD, TRADED_SV]);
  });

  it("takes it off the table once its 24 hours have passed, and keeps one that traded", async () => {
    now = NOW + 86_400;
    await recomputeListedPools(db, "all", now);
    expect((await backend().pairs("all")).map((p) => p.id)).toEqual([OLD, TRADED_SV]);
  });

  it("returns SV tokens in the launchpad scope", async () => {
    expect((await backend().pairs("launchpad")).map((p) => p.id)).toEqual([SV, OLD, TRADED_SV]);
  });

  it("carries the launch block on pair(id), fees reading all 0 before any collection and summed on read after, unchanged by a re-applied batch", async () => {
    await insertLaunches(db, [launchRow()], NOW);
    await db.query("update market.launches set image_cid = 'bafyimg', description = 'Chalk for tailors.', website = 'https://chalk.test' where token_id = $1", [SV]);
    const before = await backend().pair(SV);
    expect(before?.launch).toEqual({
      creator: CREATOR, payout: PAYOUT, quoteAddress: USDG, quoteDecimals: 6, tokenIsCurrency0: false, openTick: 398_400,
      openingValuation: "4995430000", firstBuyIn: "99500000", firstBuyTokens: "19000000000000000000000000", creatorShareBps: 7000,
      launchedAt: NOW - 100, launchBlock: 100, launchTx: LAUNCH_TX, hidden: false, imageCid: "bafyimg", description: "Chalk for tailors.",
      website: "https://chalk.test", x: "", telegram: "", routerFee: "500000",
      feesCollected: { tokenToPayout: "0", tokenToPlatform: "0", quoteToPayout: "0", quoteToPlatform: "0" }, feesCollectedAt: 0,
    });
    const rows = [
      { txHash: poolId("1"), logIndex: 0, tokenId: SV, payout: PAYOUT, tokenPayout: 700n, tokenPlatform: 300n, quotePayout: 7n, quotePlatform: 3n, timestamp: NOW + 10, block: 110 },
      { txHash: poolId("2"), logIndex: 4, tokenId: SV, payout: PAYOUT, tokenPayout: 70n, tokenPlatform: 30n, quotePayout: 0n, quotePlatform: 0n, timestamp: NOW + 20, block: 120 },
    ];
    await insertLaunchFees(db, rows);
    await insertLaunchFees(db, rows); // a re-applied batch inserts nothing
    const after = await backend().pair(SV);
    expect(after?.launch?.feesCollected).toEqual({ tokenToPayout: "770", tokenToPlatform: "330", quoteToPayout: "7", quoteToPlatform: "3" });
    expect(after?.launch?.feesCollectedAt).toBe(NOW + 20);
  });

  it("answers a delisted launch through its launch pool, launch block included", async () => {
    await insertLaunches(db, [launchRow()], NOW);
    now = NOW + 86_400;
    await recomputeListedPools(db, "all", now);
    const pair = await backend().pair(SV);
    expect(pair).toMatchObject({ id: SV, poolId: P_SV, origin: "SV" });
    expect(pair?.launch?.creator).toBe(CREATOR);
  });

  it("blanks the image, description and links of a hidden launch", async () => {
    await insertLaunches(db, [launchRow()], NOW);
    await db.query(
      "update market.launches set image_cid = 'bafyimg', description = 'd', website = 'https://w.test', x = 'https://x.com/a', telegram = 'https://t.me/abcde', hidden = true where token_id = $1",
      [SV],
    );
    expect((await backend().pair(SV))?.launch).toMatchObject({ hidden: true, imageCid: "", description: "", website: "", x: "", telegram: "" });
  });

  it("gives a token not launched here launch: null, and list rows no launch field at all", async () => {
    expect((await backend().pair(OLD))?.launch).toBeNull();
    expect((await backend().pairs("all")).every((p) => !("launch" in p))).toBe(true);
  });

  // The Suits tab's own list (amended 30 Sep 2026): every launch in market.launches, whether or not it traded and
  // whether or not its listing window closed. The default list's rule is unchanged.
  it("lists every launch in the sv scope newest first, a delisted launch nobody bought through its launch pool, each with its creator", async () => {
    await insertLaunches(db, [
      launchRow(),
      launchRow({ tokenId: TRADED_SV, poolId: P_TRADED, creator: OTHER_CREATOR, name: "Traded", symbol: "TRD", block: 90, txHash: poolId("9"), timestamp: NOW - 3 * 86_400 }),
    ], NOW);
    now = NOW + 86_400;
    // The older launch traded after the newer one opened, so ordering by activity would put it first: launch time must win.
    await db.query("update market.pools set last_swap_at = $1 where id = $2", [now - 400, P_TRADED]);
    await recomputeListedPools(db, "all", now);
    const listed = await db.query<{ listed_pool_id: string | null }>("select listed_pool_id from market.tokens where id = $1", [SV]);
    expect(listed[0]?.listed_pool_id).toBeNull();

    const sv = await backend().pairs("sv");
    expect(sv.map((p) => p.id)).toEqual([SV, TRADED_SV]);
    expect(sv[0]).toMatchObject({ poolId: P_SV, origin: "SV", ticker: "CHALK", launchCreator: CREATOR });
    expect(sv[1]).toMatchObject({ poolId: P_TRADED, origin: "SV", launchCreator: OTHER_CREATOR });

    // Asked second, inside the same 30-second memo: the default list is its own entry and still leaves the delisted launch out.
    const all = await backend().pairs("all");
    expect(all.map((p) => p.id)).toEqual([TRADED_SV, OLD]);
    for (const p of all) expect(p.launchCreator).toBeUndefined();
    for (const p of await backend().pairs("launchpad")) expect(p.launchCreator).toBeUndefined();
  });

  it("keeps a hidden launch in the sv scope: hiding blanks its image and links, not its row", async () => {
    await insertLaunches(db, [launchRow()], NOW);
    await db.query("update market.launches set hidden = true where token_id = $1", [SV]);
    expect((await backend().pairs("sv")).map((p) => p.id)).toEqual([SV]);
  });

  it("answers an empty sv list before anyone has launched", async () => {
    expect(await backend().pairs("sv")).toEqual([]);
  });

  // Fix round 1, 30 Sep 2026: the row must take the token's listed pool while it has one. A coalesce in the other
  // order, or a join on l.pool_id alone, would answer the launch pool here and fail.
  it("shows a launch through its listed pool when that is another pool, a traded Uniswap pool, not its launch pool", async () => {
    const ELSEWHERE = addr("f"), P_ELSE_LAUNCH = poolId("e"), P_ELSE_LISTED = poolId("d");
    // The Uniswap pool is the token's primary, sane and traded, so the listing takes it over the unswapped launch pool.
    await upsertTokens(db, [tokenRec(ELSEWHERE, "ELSE", "SV", P_ELSE_LISTED)], NOW);
    await upsertPools(db, [
      poolRec(P_ELSE_LAUNCH, ELSEWHERE, {}),
      poolRec(P_ELSE_LISTED, ELSEWHERE, { origin: "Uniswap", swapCount: 3, lastSwapAt: NOW - 50, tvlQuote: "5000000" }),
    ], NOW);
    await recomputeListedPools(db, "all", NOW);
    await insertLaunches(db, [
      launchRow({ tokenId: ELSEWHERE, poolId: P_ELSE_LAUNCH, name: "Elsewhere", symbol: "ELSE", block: 95, txHash: poolId("8"), timestamp: NOW - 60 }),
    ], NOW);
    const listed = await db.query<{ listed_pool_id: string | null }>("select listed_pool_id from market.tokens where id = $1", [ELSEWHERE]);
    expect(listed[0]?.listed_pool_id).toBe(P_ELSE_LISTED);

    const sv = await backend().pairs("sv");
    expect(sv.map((p) => p.id)).toEqual([ELSEWHERE]);
    expect(sv[0]).toMatchObject({ poolId: P_ELSE_LISTED, origin: "Uniswap", launchCreator: CREATOR });
  });
});
