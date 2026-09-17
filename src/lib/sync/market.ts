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

/**
 * Where a batch that the budget or the deadline cut short had got to, kept as JSON in sync_state.cursor_text of the
 * market job until the batch is drained. For swaps and for candles: null is not started, a cursor is continue
 * strictly after it, "done" is finished.
 */
type ResumeRecord = { since: number; poolIds: string[]; swaps: SwapCursor | null | "done"; candles: CandleCursor | null | "done" };

/** One POOL_BATCH of pools: its record, the tokens to refresh once its activity is in, and the lastSwapAt the cursor reaches. */
type Batch = { rec: ResumeRecord; tokenIds: readonly string[]; lastSwapAt: number | null };

const CORRUPT = 'sync_state.cursor_text of job "market" is not a resume record';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isSwapCursor = (v: unknown): v is SwapCursor => isObj(v) && typeof v.timestamp === "number" && typeof v.id === "string";
const isCandleCursor = (v: unknown): v is CandleCursor => isObj(v) && typeof v.t === "number" && typeof v.id === "string";

/** null, "done" or a cursor of the given shape. */
function slot<T>(v: unknown, isCursor: (v: unknown) => v is T): T | null | "done" {
  if (v === null || v === "done" || isCursor(v)) return v;
  throw new Error(CORRUPT);
}

/** Only this module writes the market job's cursor_text, and never without a pool, so anything else is corruption: loud. */
function parseResume(text: string): ResumeRecord {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(CORRUPT);
  }
  if (!isObj(v)) throw new Error(CORRUPT);
  const { since, poolIds, swaps, candles } = v;
  if (typeof since !== "number" || !isStrings(poolIds) || poolIds.length === 0) throw new Error(CORRUPT);
  return { since, poolIds, swaps: slot(swaps, isSwapCursor), candles: slot(candles, isCandleCursor) };
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const lastOf = <T>(items: readonly T[]): T => items[items.length - 1];

/** The largest non-null value, or null when there is none. */
function maxOf(values: readonly (number | null)[]): number | null {
  let max: number | null = null;
  for (const v of values) if (v !== null && (max === null || v > max)) max = v;
  return max;
}

/** A batch of a page's pools, not started. */
function batchOf(pools: readonly PoolRec[], since: number): Batch {
  return {
    rec: { since, poolIds: pools.map((p) => p.id), swaps: null, candles: null },
    tokenIds: pools.map((p) => p.token_id),
    lastSwapAt: maxOf(pools.map((p) => p.lastSwapAt)),
  };
}

/**
 * One market cycle (spec 5.2, progressing per batch): quotes; the batch a previous cycle cut short, drained from where
 * its record says; then pages of pools with lastSwapAt >= cursor − OVERLAP_SEC, each page's pools upserted and then
 * worked POOL_BATCH pools at a time (swaps keyset-paged until a short page, candles likewise, the batch's tokens and
 * recomputeListedPools) with saveCursors({cursor: the batch's greatest lastSwapAt}) after every batch; then new pools
 * by cursor2, tokens per page. Stops with exhausted = true when source.queries − start reaches queryBudget or
 * Date.now() passes deadlineMs: between batches or pages the cursor simply stays; inside a batch the batch's keyset
 * state goes to sync_state.cursor_text so the next cycle continues there. Throws after persisting the batches
 * completed before a source or database failure, and before anything when cursor_text is not a record.
 */
export async function runMarketCycle(db: Db, source: EnvioSource, opts: CycleOpts): Promise<CycleResult> {
  const start = source.queries;
  const state = await readState(db, "market");
  // Parsed before the first write, so a corrupt record stops the cycle before it touches anything.
  const resume = state.cursorText === "" ? null : parseResume(state.cursorText);
  const r: CycleResult = { pages: 0, pools: 0, swaps: 0, candles: 0, tokens: 0, newPools: 0, queries: 0, cursor: state.cursor, cursor2: state.cursor2, exhausted: false };
  /** Checked before every request, never after one: the cycle does not issue the request that would go over. */
  const canQuery = () => source.queries - start < opts.queryBudget && Date.now() < opts.deadlineMs;
  const finish = (exhausted: boolean) => {
    r.exhausted = exhausted;
    r.queries = source.queries - start;
    return r;
  };

  /** The tokens with these ids, TOKEN_BATCH per lookup, each lookup followed by the listed-pool recompute. */
  const writeTokens = async (tokenIds: readonly string[]): Promise<boolean> => {
    for (const ids of batches([...new Set(tokenIds)], TOKEN_BATCH)) {
      if (!canQuery()) return false;
      r.tokens += await upsertTokens(db, await source.tokensById(ids), opts.now);
      await recomputeListedPools(db, ids);
    }
    return true;
  };

  /**
   * One batch from where its record says: swaps keyset-paged until a short page, then candles the same way, then its
   * tokens, then the cursor advance with the record cleared. False when the budget or the deadline stops it: a batch
   * that has issued a request keeps its place in cursor_text, one that has not is simply seen again next cycle.
   */
  const runBatch = async ({ rec, tokenIds, lastSwapAt }: Batch): Promise<boolean> => {
    const stop = async () => {
      if (rec.swaps !== null) await saveCursors(db, "market", { cursorText: JSON.stringify(rec) });
      return false;
    };
    while (rec.swaps !== "done") {
      if (!canQuery()) return stop();
      const swaps = await source.swapsFor(rec.poolIds, rec.since, rec.swaps, PAGE_LIMIT);
      if (swaps.length > 0) r.swaps += await insertSwaps(db, swaps);
      const last = swaps.length < PAGE_LIMIT ? null : lastOf(swaps);
      rec.swaps = last ? { timestamp: last.timestamp, id: last.id } : "done";
    }
    // `recent` catches every m1, m5 and m15 bucket that could have changed; `open` looks up the h1 and d1 buckets
    // containing since and now by id, on the first page only. The two overlap; the writer deduplicates.
    const openIds = openBucketIds(rec.poolIds, rec.since, opts.now);
    while (rec.candles !== "done") {
      if (!canQuery()) return stop();
      const { recent, open } = await source.candlesFor(rec.poolIds, rec.since - CANDLE_LOOKBACK_SEC, openIds, rec.candles, PAGE_LIMIT);
      if (recent.length + open.length > 0) r.candles += await upsertCandles(db, [...recent, ...open]);
      const last = recent.length < PAGE_LIMIT ? null : lastOf(recent);
      rec.candles = last ? { t: last.t, id: last.id } : "done";
    }
    if (!(await writeTokens(tokenIds))) return stop();
    if (lastSwapAt !== null) r.cursor = Math.max(r.cursor, lastSwapAt);
    await saveCursors(db, "market", { cursor: r.cursor, cursorText: "" });
    r.pools += rec.poolIds.length;
    return true;
  };

  // 1. Quotes: one request, upserted whole.
  if (!canQuery()) return finish(true);
  const { quotes, prices } = await source.quotes();
  await upsertQuotes(db, quotes, prices);

  // 2. The batch cut short last cycle, if any, before any new page. Its pools were upserted before it started, so
  //    their rows supply the tokens to refresh and the lastSwapAt the cursor reaches once it completes.
  if (resume) {
    const pools = await db.query<{ token_id: string; last_swap_at: number | null }>(
      "select token_id, last_swap_at from market.pools where id = any($1::text[])",
      [resume.poolIds],
    );
    const batch: Batch = { rec: resume, tokenIds: pools.map((p) => p.token_id), lastSwapAt: maxOf(pools.map((p) => p.last_swap_at)) };
    if (!(await runBatch(batch))) return finish(true);
  }

  // 3. Pools that traded since the cursor minus the overlap, a page at a time: the page's pools first, then its
  //    batches. The cursor moves after every batch, so a cycle that stops mid-page keeps the batches it completed
  //    and the next one sees the rest again; every write is idempotent.
  const since = Math.max(0, r.cursor - OVERLAP_SEC);
  let after: PoolCursor | null = null;
  for (;;) {
    if (!canQuery()) return finish(true);
    const page = await source.poolsSince(since, after, PAGE_LIMIT);
    if (page.length === 0) break;
    await upsertPools(db, page, opts.now);
    for (const pools of batches(page, POOL_BATCH)) {
      if (!(await runBatch(batchOf(pools, since)))) return finish(true);
    }
    r.pages += 1;
    if (page.length < PAGE_LIMIT) break;
    const last = lastOf(page);
    after = { lastSwapAt: last.lastSwapAt ?? since, id: last.id };
  }

  // 4. Pools created since cursor2 that never traded: their rows and tokens; there are no swaps or candles under them.
  const since2 = Math.max(0, r.cursor2 - OVERLAP_SEC);
  let after2: CreatedCursor | null = null;
  for (;;) {
    if (!canQuery()) return finish(true);
    const page = await source.poolsCreatedSince(since2, after2, PAGE_LIMIT);
    if (page.length === 0) break;
    await upsertPools(db, page, opts.now);
    if (!(await writeTokens(page.map((p) => p.token_id)))) return finish(true);
    const last = lastOf(page);
    r.cursor2 = Math.max(r.cursor2, last.createdAt);
    await saveCursors(db, "market", { cursor2: r.cursor2 });
    r.pages += 1;
    r.newPools += page.length;
    if (page.length < PAGE_LIMIT) break;
    after2 = { createdAt: last.createdAt, id: last.id };
  }
  return finish(false);
}
