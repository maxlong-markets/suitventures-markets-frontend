import type { Db } from "@/lib/db/client";
import { parseCandleId, parseSwapId } from "@/lib/sync/ids";
import type { BalanceRec, CandleRec, EnvioSource, PoolRec, SwapRec, TokenRec } from "@/lib/sync/source";
import { finishRun, readState, saveCursors } from "@/lib/sync/state";
import { insertSwaps, recomputeListedPools, upsertCandles, upsertPools, upsertQuotes, upsertTokens } from "@/lib/sync/writers";

export type SeedPhase = "quotes" | "tokens" | "pools" | "swaps" | "candles" | "balances" | "finish";
export const SEED_PHASES: readonly SeedPhase[] = ["quotes", "tokens", "pools", "swaps", "candles", "balances", "finish"];
export const HOLDERS_KEPT = 100;
/** The market cursors and every watermark start this far before the seed began, so the first cycles replay what moved during it, with an hour of slack for the indexer's own lag at seed start. */
const CURSOR_BACKDATE_SEC = 3600;
/** A range's checkpoint value once its walk has ended; never a valid id, so a resume skips it outright. */
const RANGE_DONE = "done";
const HEX = "0123456789abcdef";

export type Checkpoint = { startedAt: number; phase: SeedPhase; ranges: Record<string, string>; done: SeedPhase[] };

export function newCheckpoint(startedAt: number): Checkpoint {
  return { startedAt, phase: "quotes", ranges: {}, done: [] };
}

/**
 * n hex-prefix ranges over ids starting with "0x": from "0x0"-style exclusive lower bounds to exclusive
 * upper bounds, the last open-ended. Split on the first hex digit, so n is clamped to 1..16.
 */
export function idRanges(n: number): { key: string; from: string; to: string | null }[] {
  const count = Math.min(16, Math.max(1, Math.floor(n)));
  const out: { key: string; from: string; to: string | null }[] = [];
  for (let i = 0; i < count; i++) {
    const to = i === count - 1 ? null : `0x${HEX[Math.floor(((i + 1) * 16) / count)]}`;
    out.push({ key: `r${i}`, from: `0x${HEX[Math.floor((i * 16) / count)]}`, to });
  }
  return out;
}

export type SeedOpts = {
  checkpoint: Checkpoint; save: (c: Checkpoint) => Promise<void>; workers: number; pageLimit: number;
  holdersKept?: number; log: (line: string) => void; now: () => number;
};

type Range = { key: string; from: string; to: string | null };
type PageFn<R> = (afterId: string, beforeId: string | null, limit: number) => Promise<R[]>;
type WriteFn<R> = (rows: R[], idempotent: boolean) => Promise<number>;

const SWAP_COLS = ["tx_hash", "log_index", "pool_id", "token_id", "ts", "side", "amount_token", "amount_quote", "price_quote", "wallet"];
const swapRow = (s: SwapRec) => {
  const { txHash, logIndex } = parseSwapId(s.id);
  return [txHash, logIndex, s.pool_id, s.token_id, s.timestamp, s.side, Number(s.amountToken), Number(s.amountQuote), Number(s.priceQuote), s.wallet];
};
const CANDLE_COLS = ["pool_id", "interval", "t", "open", "high", "low", "close", "volume_quote", "volume_token", "trades"];
const candleRow = (c: CandleRec) => [c.pool_id, parseCandleId(c.id).interval, c.t, Number(c.open), Number(c.high), Number(c.low), Number(c.close), Number(c.volumeQuote), Number(c.volumeToken), c.trades];
const BALANCE_COLS = ["token_id", "holder", "balance", "updated_at"];
const balanceRow = (b: BalanceRec) => [b.token_id, b.holder, b.balance, b.updatedAt];

/** The one balance writer the sync does not need: an upsert for a page re-read after a resume. */
async function upsertBalances(db: Db, rows: readonly BalanceRec[]): Promise<number> {
  if (rows.length === 0) return 0;
  await db.query(
    `insert into market.token_balances (token_id, holder, balance, updated_at)
     select * from unnest($1::text[], $2::text[], $3::numeric[], $4::int[])
     on conflict (token_id, holder) do update set balance = excluded.balance, updated_at = excluded.updated_at`,
    [rows.map((b) => b.token_id), rows.map((b) => b.holder), rows.map((b) => b.balance), rows.map((b) => b.updatedAt)],
  );
  return rows.length;
}

/**
 * Runs the phases from checkpoint.phase, saving the checkpoint at each phase start; big tables walk
 * `idRanges(workers)` concurrently with COPY per page and save the last id per range after each page; "finish"
 * trims balances to holdersKept per token, recomputes
 * every listed pool, raises every pool's synced_to and sync_state.market cursor and cursor2 to startedAt − 3600 (none
 * of them is ever lowered), and marks nightly ok.
 */
export async function runSeed(db: Db, source: EnvioSource, opts: SeedOpts): Promise<Checkpoint> {
  const cp: Checkpoint = { ...opts.checkpoint, ranges: { ...opts.checkpoint.ranges }, done: [...opts.checkpoint.done] };
  const kept = opts.holdersKept ?? HOLDERS_KEPT;
  const t0 = opts.now();
  let pages = 0;
  let rows = 0;
  // Saves are serialised: concurrent range workers must never interleave writes of the checkpoint file.
  let saving: Promise<void> = Promise.resolve();
  const save = () => (saving = saving.then(() => opts.save({ ...cp, ranges: { ...cp.ranges }, done: [...cp.done] })));
  const log = (phase: SeedPhase, key: string) => opts.log(`${phase} ${key} pages=${pages} rows=${rows} queries=${source.queries} elapsed=${opts.now() - t0}s`);

  async function walk<R extends { id: string }>(phase: SeedPhase, range: Range, page: PageFn<R>, write: WriteFn<R>) {
    const start = cp.ranges[range.key];
    if (start === RANGE_DONE) return;
    let after = start ?? range.from;
    // A resumed range re-reads the page whose COPY landed before its checkpoint was saved; a range without a
    // stored cursor in a phase the checkpoint had already entered may have copied its first page the same way.
    let idempotent = start !== undefined || opts.checkpoint.phase === phase;
    for (;;) {
      const batch = await page(after, range.to, opts.pageLimit);
      if (batch.length > 0) {
        rows += await write(batch, idempotent);
        idempotent = false;
        after = batch[batch.length - 1]!.id;
        cp.ranges[range.key] = after;
        pages += 1;
        await save();
        log(phase, range.key);
      }
      if (batch.length < opts.pageLimit) break;
    }
    cp.ranges[range.key] = RANGE_DONE;
    await save();
  }
  const single: Range = { key: "all", from: "0x0", to: null };
  const ranged = <R extends { id: string }>(phase: SeedPhase, page: PageFn<R>, copy: (batch: R[]) => Promise<number>, upsert: (batch: R[]) => Promise<number>) =>
    Promise.all(idRanges(opts.workers).map((r) => walk(phase, r, page, (batch, idempotent) => (idempotent ? upsert(batch) : copy(batch)))));

  for (const phase of SEED_PHASES.slice(SEED_PHASES.indexOf(cp.phase))) {
    if (cp.done.includes(phase)) continue;
    cp.phase = phase;
    // Saved before any page lands, so a resume knows the phase had begun and treats every first page as a replay.
    await save();
    switch (phase) {
      case "quotes": {
        const { quotes, prices } = await source.quotes();
        rows += await upsertQuotes(db, quotes, prices);
        pages += 1;
        log(phase, single.key);
        break;
      }
      case "tokens":
        await walk<TokenRec>(phase, single, (after, _before, limit) => source.tokensPage(after, limit), (batch) => upsertTokens(db, batch, opts.now()));
        break;
      case "pools":
        await walk<PoolRec>(phase, single, (after, _before, limit) => source.poolsPage(after, limit), (batch) => upsertPools(db, batch, opts.now()));
        break;
      case "swaps":
        await ranged<SwapRec>(phase, (a, b, l) => source.swapsPage(a, b, l), (batch) => db.copy("market.swaps", SWAP_COLS, batch.map(swapRow)), (batch) => insertSwaps(db, batch));
        break;
      case "candles":
        await ranged<CandleRec>(phase, (a, b, l) => source.candlesPage(a, b, l), (batch) => db.copy("market.candles", CANDLE_COLS, batch.map(candleRow)), (batch) => upsertCandles(db, batch));
        break;
      case "balances":
        await ranged<BalanceRec>(phase, (a, b, l) => source.balancesPage(a, b, l), (batch) => db.copy("market.token_balances", BALANCE_COLS, batch.map(balanceRow)), (batch) => upsertBalances(db, batch));
        break;
      case "finish": {
        // The trim and the recompute scan whole tables, and Supabase's session pooler starts every session with a
        // two-minute statement_timeout; `set local` lifts it for these two statements only, on the one connection.
        await db.tx(async (t) => {
          await t.exec("set local statement_timeout = 0");
          await t.query(
            `delete from market.token_balances b using (
               select token_id, holder, row_number() over (partition by token_id order by balance desc, holder) as rn
               from market.token_balances) r
             where r.token_id = b.token_id and r.holder = b.holder and r.rn > $1`,
            [kept],
          );
          await recomputeListedPools(t, "all");
        });
        // Every pool's swaps and candles are stored up to the seed's start (the id walks are complete), so the first
        // cycles fetch from an hour before it for the pools that traded since; a higher watermark is never lowered.
        await db.query("update market.pools set synced_to = greatest(synced_to, $1::int)", [cp.startedAt - CURSOR_BACKDATE_SEC]);
        await readState(db, "market"); // inserts the default row when missing
        await saveCursors(db, "market", { cursor: cp.startedAt - CURSOR_BACKDATE_SEC, cursor2: cp.startedAt - CURSOR_BACKDATE_SEC });
        await readState(db, "nightly");
        await finishRun(db, "nightly", { now: opts.now(), ok: true, rows: 0, queries: 0 });
        log(phase, single.key);
        break;
      }
    }
    cp.done.push(phase);
    cp.ranges = {};
    await save();
  }
  await saving;
  return cp;
}
