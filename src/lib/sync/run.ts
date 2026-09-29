import type { Db } from "@/lib/db/client";
import type { Quoter } from "@/lib/quote/quoter";
import type { UploadCleaner } from "@/lib/launch/cleanup";
import { runMarketCycle, type CycleResult } from "./market";
import { runNightly, type NightlyResult } from "./nightly";
import type { EnvioSource } from "./source";
import { acquireLease, finishRun, raiseHeadBlock, readHeadBlock, readState, releaseLease, type SyncJob } from "./state";

export type RunOpts = {
  job: SyncJob; owner: string; now: () => number; sleep: (ms: number) => Promise<void>;
  windowSec: number; intervalSec: number; queryBudget: number; leaseSec: number;
  /** Forwarded into runNightly's own opts (nightly.ts); deps.ts supplies it for "nightly", the market job ignores it. */
  quoter?: Quoter;
  /** Forwarded into runNightly's "uploads" phase; deps.ts supplies it for "nightly" when the Filebase names are set. */
  uploads?: UploadCleaner;
};
export type RunReport = {
  job: SyncJob; skipped: "lease" | "nightly" | "indexer" | null; cycles: number;
  results: (CycleResult | NightlyResult)[]; error: string | null;
};

/** The last_error an invocation records when the indexer reports a block below the store's mark (spec 5.3a). */
export const INDEXER_BEHIND = "indexer behind the store";
/** The last_error an invocation records when the nightly's probe phase had candidates but the quoter answered
 * not one of them (I2b): every candidate came back "skipped", which otherwise looks byte-identical to a clean
 * sweep — this is what makes a dead RPC visible instead of a nightly report that quietly does nothing. */
export const PROBE_UNREACHABLE = "probe: quoter unreachable";

const sec = (ms: number) => Math.floor(ms / 1000);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** "done" only appears on a NightlyResult (Task 6 dropped its tokens/pools counts along with the phases that produced them). */
const rowsOf = (r: CycleResult | NightlyResult) => ("done" in r ? r.listed + r.pruned : r.pools + r.swaps + r.candles + r.tokens + r.newPools);
/** True exactly when a nightly result's probe phase ran against candidates and got zero verdicts back — every one
 * skipped (I2b). Always false for a market CycleResult, which carries none of these fields. */
const probeUnreachable = (r: CycleResult | NightlyResult) => "routable" in r && r.routable === 0 && r.unroutable === 0 && r.skipped > 0;

/**
 * Takes the lease (or reports skipped: "lease"); market: yields (skipped: "nightly") while the nightly holds its
 * lease, then probes the indexer's head block once and skips ("indexer", with last_error set) while it is below
 * the store's mark, raising the mark otherwise. That yield and head-block guard are both Envio-only and market-only
 * (Task 6): the nightly carries no Envio phases anymore, so it no longer waits for the market or gets probed
 * against an indexer head, and runs straight into its cycle. market: runs cycles until windowSec has elapsed,
 * sleeping so cycles start intervalSec apart, sharing one queryBudget across the invocation (the head-block probe
 * counts); nightly: one runNightly. Every cycle ends with finishRun (ok or error); the first thrown error, the
 * head-block probe's included, ends the invocation. A nightly cycle whose own routable-pool probe phase got zero
 * verdicts back is a different case (I2b): it is not thrown, so the cycle's result and cursor stand, but finishRun
 * still records it as an error (PROBE_UNREACHABLE) rather than a clean run. Always releases the lease.
 *
 * The market job has no production caller left — src/app/api/internal/sync/route.ts runs the chain job
 * (src/lib/chain/run.ts) instead since Task 6 — and survives here only because it costs nothing to: nothing
 * builds a real EnvioSource for it anymore (src/lib/sync/deps.ts), so keeping this branch does not put Envio
 * back on a production path, and it keeps this function's generic lease/budget/cycle machinery under test via
 * a FakeSource (run.test.ts) without duplicating that coverage against the nightly job alone.
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
    if (opts.job === "market") {
      // The two jobs never run together (spec 5.1): the market invocation yields while the nightly holds its
      // lease, so their requests never add up against the endpoint's cap. The nightly's own window bounds the delay.
      if ((await readState(db, "nightly")).leaseUntil > sec(startMs)) return { ...report, skipped: "nightly" };
      // Head-block guard (spec 5.3a): a replaying indexer reports a block below the highest one ever seen; nothing
      // from its state may reach the store, so the invocation records the skip and does nothing else.
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
    }
    // The probe's request (market only) comes out of the budget and is charged to the first cycle's finishRun.
    let pending = source.queries - invocationStart;
    let budget = opts.queryBudget - pending;
    for (;;) {
      const cycleStartMs = opts.now();
      const before = source.queries;
      // The cycle watches the real clock; hand it the window's remainder as measured on the injected one.
      const cycleOpts = { now: sec(cycleStartMs), queryBudget: budget, deadlineMs: Date.now() + Math.max(0, endMs - cycleStartMs), quoter: opts.quoter, uploads: opts.uploads };
      let result: CycleResult | NightlyResult;
      try {
        result = opts.job === "market" ? await runMarketCycle(db, source, cycleOpts) : await runNightly(db, cycleOpts);
      } catch (err) {
        await fail(message(err), before - pending);
        break;
      }
      report.results.push(result);
      report.cycles += 1;
      budget -= result.queries;
      // A severed probe (I2b) still finishes normally — its own cursor and phase are already persisted by the
      // time we get here — but must not be recorded as a clean run: finishRun sees it exactly like a thrown
      // error, so /api/health's lastError shows a dead RPC instead of a report indistinguishable from success.
      const severed = probeUnreachable(result);
      if (severed) report.error = PROBE_UNREACHABLE;
      await finishRun(db, opts.job, {
        now: sec(opts.now()), ok: !severed, error: severed ? PROBE_UNREACHABLE : undefined,
        rows: rowsOf(result), queries: result.queries + pending,
      });
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
