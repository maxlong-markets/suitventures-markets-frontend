/**
 * Builds h1 and d1 candles from the trades already in market.swaps, for the roughly three quarters
 * of pools whose candles the paused Envio copy never reached (Task 7,
 * .superpowers/sdd/2026-09-21-chain-reader/task-7-brief.md). A precedent one-off script did exactly
 * this for d1 alone on 21 Sep 2026 and inserted 60,704 rows; this is that logic, made repeatable and
 * covering h1 too.
 *
 * Fills only buckets that lie WHOLLY inside the stored trade window (select min(ts), max(ts) from
 * market.swaps) and WHOLLY before --before, so a half-covered bucket is never written from partial
 * data — a bucket whose first or last second falls outside that range is skipped entirely, not
 * written with whatever partial data happens to be there. Existing candles (copied from the old
 * indexer, built from the events themselves and more accurate) are never overwritten: each interval
 * is one `insert ... on conflict (pool_id, interval, t) do nothing`.
 *
 * Run: npm run chain:gapfill -- --before <unix> [--interval h1|d1]
 * Needs DATABASE_URL_DIRECT (see .env.example), like the other scripts/db/*.mts scripts.
 *
 * Safe to re-run: every insert is on-conflict-do-nothing, so running this again (the same or a later
 * --before) only ever adds rows for buckets it has not already filled.
 */
import { createDb, type Db } from "@/lib/db/client";
import { bucketStart, INTERVAL_SECONDS } from "@/lib/sync/ids";

type GapfillInterval = "h1" | "d1";
const GAPFILL_INTERVALS: readonly GapfillInterval[] = ["h1", "d1"];

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isoUtc = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

type Args = { before: number; intervals: readonly GapfillInterval[] };

function parseArgs(argv: readonly string[]): Args {
  let before: number | undefined;
  let interval: GapfillInterval | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--before") {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) fail(`--before must be a unix-seconds integer, got ${JSON.stringify(raw)}`);
      before = n;
    } else if (arg === "--interval") {
      const raw = argv[++i];
      if (raw !== "h1" && raw !== "d1") fail(`--interval must be h1 or d1, got ${JSON.stringify(raw)}`);
      interval = raw;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (before === undefined) fail("--before <unix> is required");
  return { before, intervals: interval ? [interval] : GAPFILL_INTERVALS };
}

/** The stored trade window (inclusive), or null when market.swaps is empty. */
async function tradeWindow(db: Db): Promise<{ min: number; max: number } | null> {
  const [row] = await db.query<{ min: number | null; max: number | null }>("select min(ts) as min, max(ts) as max from market.swaps");
  if (!row || row.min === null || row.max === null) return null;
  return { min: row.min, max: row.max };
}

type FillResult = { interval: GapfillInterval; inserted: number; firstBucket: number | null; lastBucket: number | null };

/**
 * One `insert ... select ... on conflict do nothing` for `interval`, over trades in
 * [firstWholeBucket, lastWholeBucket + size): the first bucket entirely at or after windowMin and the
 * last entirely before both windowMax's exclusive end and `before` — see the module doc comment for
 * why partial edge buckets must never be written. open/close are the first/last trade's price_quote
 * ordered by (ts, log_index); high/low the max/min of price_quote; volume_quote/volume_token the sums
 * of amount_quote/amount_token; trades the row count (Task 7 brief, section 2).
 */
async function fillInterval(db: Db, interval: GapfillInterval, windowMin: number, windowMax: number, before: number): Promise<FillResult> {
  const size = INTERVAL_SECONDS[interval];
  // First bucket whose start is >= windowMin: bucketStart(windowMin) itself only qualifies when
  // windowMin already sits exactly on a boundary; windowMin + size - 1 is the standard
  // ceiling-division-by-bucket trick that gives the right answer either way, without a branch.
  const firstBucket = bucketStart(windowMin + size - 1, interval);
  // Exclusive upper bound from whichever constrains it more: one past the last recorded trade, or
  // --before itself ("wholly before --before" reads as an exclusive bound, consistent with treating
  // windowMax the same way one line up).
  const exclusiveEnd = Math.min(windowMax + 1, before);
  const lastBucket = bucketStart(exclusiveEnd, interval) - size;
  if (lastBucket < firstBucket) return { interval, inserted: 0, firstBucket: null, lastBucket: null };
  const coveredEnd = lastBucket + size; // exclusive

  const rows = await db.query<{ pool_id: string }>(
    `with bucketed as (
       select pool_id, (ts / $3::int) * $3::int as t, ts, log_index, price_quote, amount_quote, amount_token
       from market.swaps
       where ts >= $1::int and ts < $2::int
     ),
     agg as (
       select pool_id, t,
         max(price_quote) as high, min(price_quote) as low,
         sum(amount_quote) as volume_quote, sum(amount_token) as volume_token,
         count(*)::int as trades
       from bucketed
       group by pool_id, t
     ),
     opens as (
       select distinct on (pool_id, t) pool_id, t, price_quote as open
       from bucketed
       order by pool_id, t, ts, log_index
     ),
     closes as (
       select distinct on (pool_id, t) pool_id, t, price_quote as close
       from bucketed
       order by pool_id, t, ts desc, log_index desc
     )
     insert into market.candles (pool_id, interval, t, open, high, low, close, volume_quote, volume_token, trades)
     select agg.pool_id, $4::text, agg.t, opens.open, agg.high, agg.low, closes.close, agg.volume_quote, agg.volume_token, agg.trades
     from agg
     join opens on opens.pool_id = agg.pool_id and opens.t = agg.t
     join closes on closes.pool_id = agg.pool_id and closes.t = agg.t
     on conflict (pool_id, interval, t) do nothing
     returning pool_id`,
    [firstBucket, coveredEnd, size, interval],
  );
  return { interval, inserted: rows.length, firstBucket, lastBucket };
}

async function main(): Promise<void> {
  const { before, intervals } = parseArgs(process.argv.slice(2));

  const url = process.env.DATABASE_URL_DIRECT;
  if (!url) fail("DATABASE_URL_DIRECT is not set (see .env.example)");
  const db = createDb(url, { max: 1 });

  try {
    const window = await tradeWindow(db);
    if (!window) {
      console.log("[chain:gapfill] market.swaps is empty: nothing to fill.");
      return;
    }
    console.log(
      `[chain:gapfill] trade window ${isoUtc(window.min)} .. ${isoUtc(window.max)} (ts ${window.min}..${window.max}); ` +
        `--before ${isoUtc(before)} (${before})`,
    );

    for (const interval of intervals) {
      const result = await fillInterval(db, interval, window.min, window.max, before);
      if (result.firstBucket === null || result.lastBucket === null) {
        console.log(`[chain:gapfill] ${interval}: no whole bucket fits inside the trade window and before --before; nothing to do`);
        continue;
      }
      const size = INTERVAL_SECONDS[interval];
      console.log(
        `[chain:gapfill] ${interval}: inserted ${result.inserted} row(s), buckets ${isoUtc(result.firstBucket)} .. ` +
          `${isoUtc(result.lastBucket + size)} (t ${result.firstBucket}..${result.lastBucket})`,
      );
    }
  } finally {
    await db.end();
  }
}

try {
  await main();
} catch (err) {
  console.error(`[chain:gapfill] failed: ${message(err)}`);
  process.exitCode = 1;
}
