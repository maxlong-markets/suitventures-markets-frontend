import type { Db } from "@/lib/db/client";
import { runMarketCycle, type CycleResult } from "./market";
import { runNightly, type NightlyResult } from "./nightly";
import type { EnvioSource } from "./source";
import { acquireLease, finishRun, raiseHeadBlock, readHeadBlock, releaseLease, type SyncJob } from "./state";

export type RunOpts = {
  job: SyncJob; owner: string; now: () => number; sleep: (ms: number) => Promise<void>;
  windowSec: number; intervalSec: number; queryBudget: number; leaseSec: number;
};
export type RunReport = {
  job: SyncJob; skipped: "lease" | "nightly" | "indexer" | null; cycles: number;
  results: (CycleResult | NightlyResult)[]; error: string | null;
};

/** The last_error an invocation records when the indexer reports a block below the store's mark (spec 5.3a). */
export const INDEXER_BEHIND = "indexer behind the store";

const sec = (ms: number) => Math.floor(ms / 1000);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const rowsOf = (r: CycleResult | NightlyResult) =>
  "done" in r ? r.tokens + r.pools + r.listed : r.pools + r.swaps + r.candles + r.tokens + r.newPools;

/**
 * Takes the lease (or reports skipped: "lease"); probes the indexer's head block once and skips ("indexer", with
 * last_error set) while it is below the store's mark, raising the mark otherwise; market: runs cycles until
 * windowSec has elapsed, sleeping so cycles start intervalSec apart, sharing one queryBudget across the invocation
 * (the probe counts); nightly: one runNightly. Every cycle ends with finishRun (ok or error); the first error,
 * the probe's included, ends the invocation. Always releases the lease.
 */
export async function runSync(db: Db, source: EnvioSource, opts: RunOpts): Promise<RunReport> {
  const report: RunReport = { job: opts.job, skipped: null, cycles: 0, results: [], error: null };
  const startMs = opts.now();
  if (!(await acquireLease(db, opts.job, opts.owner, sec(startMs), opts.leaseSec))) return { ...report, skipped: "lease" };
  const endMs = startMs + opts.windowSec * 1000;
  const invocationStart = source.queries;
  /** Records a failed invocation: what the probe or the cycle threw, charged with every request issued so far. */
  const fail = async (error: string, since: number) => {
    report.error = error;
    await finishRun(db, opts.job, { now: sec(opts.now()), ok: false, error, rows: 0, queries: source.queries - since });
  };
  try {
    // Head-block guard (spec 5.3a): a replaying indexer reports a block below the highest one ever seen; nothing from
    // its state may reach the store, so the invocation records the skip and does nothing else.
    let head: number;
    try {
      head = (await source.chainMeta()).latestProcessedBlock;
    } catch (err) {
      await fail(message(err), invocationStart);
      return report;
    }
    if (head < (await readHeadBlock(db))) {
      await fail(INDEXER_BEHIND, invocationStart);
      return { ...report, skipped: "indexer" };
    }
    await raiseHeadBlock(db, head);
    // The probe's request comes out of the budget and is charged to the first cycle's finishRun.
    let pending = source.queries - invocationStart;
    let budget = opts.queryBudget - pending;
    for (;;) {
      const cycleStartMs = opts.now();
      const before = source.queries;
      // The cycle watches the real clock; hand it the window's remainder as measured on the injected one.
      const cycleOpts = { now: sec(cycleStartMs), queryBudget: budget, deadlineMs: Date.now() + Math.max(0, endMs - cycleStartMs) };
      let result: CycleResult | NightlyResult;
      try {
        result = opts.job === "market" ? await runMarketCycle(db, source, cycleOpts) : await runNightly(db, source, cycleOpts);
      } catch (err) {
        await fail(message(err), before - pending);
        break;
      }
      report.results.push(result);
      report.cycles += 1;
      budget -= result.queries;
      await finishRun(db, opts.job, { now: sec(opts.now()), ok: true, rows: rowsOf(result), queries: result.queries + pending });
      pending = 0;
      const nextMs = cycleStartMs + opts.intervalSec * 1000;
      if (opts.job === "nightly" || budget <= 0 || nextMs >= endMs) break;
      await opts.sleep(Math.max(0, nextMs - opts.now()));
    }
  } finally {
    await releaseLease(db, opts.job, opts.owner);
  }
  return report;
}
