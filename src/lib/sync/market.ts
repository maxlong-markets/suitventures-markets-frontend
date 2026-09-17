import type { Db } from "@/lib/db/client";
import { openBucketIds } from "./ids";
import type { CandleCursor, CreatedCursor, EnvioSource, PoolCursor, PoolRec, SwapCursor } from "./source";
import { readState, saveCursors } from "./state";
import { insertSwaps, recomputeListedPools, upsertCandles, upsertPools, upsertQuotes, upsertTokens } from "./writers";

export const OVERLAP_SEC = 120;
export const CANDLE_LOOKBACK_SEC = 900;
export const PAGE_LIMIT = 1000;
export const POOL_BATCH = 50;
export const TOKEN_BATCH = 100;
export type CycleOpts = { now: number; queryBudget: number; deadlineMs: number };
export type CycleResult = {
  pages: number; pools: number; swaps: number; candles: number; tokens: number; newPools: number;
  queries: number; cursor: number; cursor2: number; exhausted: boolean;
};

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * One market cycle (spec 5.2): quotes; pages of pools with lastSwapAt >= cursor − OVERLAP_SEC, each page written
 * (pools, then swaps and candles in POOL_BATCH batches, then tokens in TOKEN_BATCH batches and recomputeListedPools)
 * before saveCursors({cursor: page's last lastSwapAt}); then new pools by cursor2 the same way. Stops with
 * exhausted = true, cursors untouched for the unfinished page, when source.queries − start reaches queryBudget or
 * Date.now() passes deadlineMs. Throws after persisting completed pages when the source or the database fails.
 */
export async function runMarketCycle(db: Db, source: EnvioSource, opts: CycleOpts): Promise<CycleResult> {
  const start = source.queries;
  const state = await readState(db, "market");
  const r: CycleResult = { pages: 0, pools: 0, swaps: 0, candles: 0, tokens: 0, newPools: 0, queries: 0, cursor: state.cursor, cursor2: state.cursor2, exhausted: false };
  /** Checked before every request, never after one: the cycle does not issue the request that would go over. */
  const canQuery = () => source.queries - start < opts.queryBudget && Date.now() < opts.deadlineMs;
  const finish = (exhausted: boolean) => {
    r.exhausted = exhausted;
    r.queries = source.queries - start;
    return r;
  };

  /** The tokens behind `pools`, TOKEN_BATCH ids per lookup, each batch followed by the listed-pool recompute. */
  const writeTokens = async (pools: readonly PoolRec[]): Promise<boolean> => {
    for (const ids of batches([...new Set(pools.map((p) => p.token_id))], TOKEN_BATCH)) {
      if (!canQuery()) return false;
      r.tokens += await upsertTokens(db, await source.tokensById(ids), opts.now);
      await recomputeListedPools(db, ids);
    }
    return true;
  };

  /** Swaps and candles of `pools` since `since`, POOL_BATCH pools per request, each keyset-paged until a short page. */
  const writeActivity = async (pools: readonly PoolRec[], since: number): Promise<boolean> => {
    for (const ids of batches(pools.map((p) => p.id), POOL_BATCH)) {
      let sAfter: SwapCursor | null = null;
      for (;;) {
        if (!canQuery()) return false;
        const swaps = await source.swapsFor(ids, since, sAfter, PAGE_LIMIT);
        if (swaps.length > 0) r.swaps += await insertSwaps(db, swaps);
        if (swaps.length < PAGE_LIMIT) break;
        const last = swaps[swaps.length - 1];
        sAfter = { timestamp: last.timestamp, id: last.id };
      }
      // `recent` catches every m1, m5 and m15 bucket that could have changed; `open` looks up the h1 and d1
      // buckets containing since and now by id, on the first page only. The two overlap; the writer deduplicates.
      const openIds = openBucketIds(ids, since, opts.now);
      let cAfter: CandleCursor | null = null;
      for (;;) {
        if (!canQuery()) return false;
        const { recent, open } = await source.candlesFor(ids, since - CANDLE_LOOKBACK_SEC, openIds, cAfter, PAGE_LIMIT);
        if (recent.length + open.length > 0) r.candles += await upsertCandles(db, [...recent, ...open]);
        if (recent.length < PAGE_LIMIT) break;
        const last = recent[recent.length - 1];
        cAfter = { t: last.t, id: last.id };
      }
    }
    return true;
  };

  // 1. Quotes: one request, upserted whole.
  if (!canQuery()) return finish(true);
  const { quotes, prices } = await source.quotes();
  await upsertQuotes(db, quotes, prices);

  // 2. Pools that traded since the cursor minus the overlap. A page is fully written before the cursor moves,
  //    so a cycle that stops mid-page repeats that page next time; every write is idempotent.
  const since = Math.max(0, r.cursor - OVERLAP_SEC);
  let after: PoolCursor | null = null;
  for (;;) {
    if (!canQuery()) return finish(true);
    const page = await source.poolsSince(since, after, PAGE_LIMIT);
    if (page.length === 0) break;
    await upsertPools(db, page, opts.now);
    if (!(await writeActivity(page, since)) || !(await writeTokens(page))) return finish(true);
    const last = page[page.length - 1];
    r.cursor = Math.max(r.cursor, last.lastSwapAt ?? r.cursor);
    await saveCursors(db, "market", { cursor: r.cursor });
    r.pages += 1;
    r.pools += page.length;
    if (page.length < PAGE_LIMIT) break;
    after = { lastSwapAt: last.lastSwapAt ?? since, id: last.id };
  }

  // 3. Pools created since cursor2 that never traded: their rows and tokens; there are no swaps or candles under them.
  const since2 = Math.max(0, r.cursor2 - OVERLAP_SEC);
  let after2: CreatedCursor | null = null;
  for (;;) {
    if (!canQuery()) return finish(true);
    const page = await source.poolsCreatedSince(since2, after2, PAGE_LIMIT);
    if (page.length === 0) break;
    await upsertPools(db, page, opts.now);
    if (!(await writeTokens(page))) return finish(true);
    const last = page[page.length - 1];
    r.cursor2 = Math.max(r.cursor2, last.createdAt);
    await saveCursors(db, "market", { cursor2: r.cursor2 });
    r.pages += 1;
    r.newPools += page.length;
    if (page.length < PAGE_LIMIT) break;
    after2 = { createdAt: last.createdAt, id: last.id };
  }
  return finish(false);
}
