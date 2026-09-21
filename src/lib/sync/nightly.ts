import type { Db } from "@/lib/db/client";
import type { Quoter } from "@/lib/quote/quoter";
import type { CycleOpts } from "./market";
import { probePools } from "./probe";
import { pruneCandles, pruneSwaps } from "./retention";
import { readState, saveCursors } from "./state";
import { recomputeListedPools } from "./writers";

export type NightlyResult = {
  done: boolean; phase: string; listed: number;
  /** probed counts every candidate the probe phase attempted, skips included; routable/unroutable/skipped (I4) split it three ways. */
  probed: number; routable: number; unroutable: number; skipped: number;
  /** Swaps the prune phase deleted for being outside the retention window (retention.ts); every run, quoter or not. */
  pruned: number;
  /** Candles the prune phase deleted for being outside their interval's own retention window (retention.ts's CANDLE_RETENTION_SEC), run right after pruned; every run, quoter or not. */
  prunedCandles: number; queries: number;
};

const PHASES = ["listed", "probe", "prune"] as const;
type Phase = (typeof PHASES)[number];

/**
 * Phases in order, persisted in sync_state.nightly.phase: "listed" (recomputeListedPools "all"), "probe"
 * (probePools over pools active in the last PROBE_ACTIVE_SEC, cursor_text = its lastId, saved after every
 * page it processes rather than once at the end — I3), "prune" (pruneSwaps over market.swaps, then
 * pruneCandles over market.candles, both retention.ts — neither has a request of its own, so both run
 * whether or not opts.quoter was supplied, sharing one deadline; the phase is done only once both report
 * done), then phase "" and done = true. Resumes from the stored phase and cursor; stops early (done = false)
 * at the deadline.
 *
 * Before Task 6 (`.superpowers/sdd/2026-09-21-chain-reader/task-6-brief.md`) this job opened with two more
 * phases, "tokens" and "pools", that re-copied market.tokens/market.pools from Envio's GraphQL API. Envio was
 * decommissioned 21 Sep 2026; the chain reader (src/lib/chain/run.ts) is now the only writer of those two
 * tables, fed straight from the chain, so re-running those phases against nothing would overwrite good data
 * with nothing — they and the EnvioSource parameter they existed for are gone. A stored phase of "tokens" or
 * "pools" left over from before that cutover resumes at "listed" instead of crashing (the `phase` fallback
 * below), and `queries` stays in the result shape at 0: nothing this job does costs a request anymore, but
 * removing the field would ripple into every caller that still reads a NightlyResult next to a CycleResult
 * (src/lib/sync/run.ts's rowsOf, in particular) for no benefit.
 *
 * `opts.quoter` is deliberately not folded into CycleOpts (market.ts): runMarketCycle has no use for one, and
 * widening a type both cycle functions share for the sake of this phase alone would be the wrong home for it.
 * Only the probe phase reads it, and only when the caller supplies one — deps.ts's createQuoter() for the real
 * nightly job. Without it (as in every other phase's own tests) probing is a no-op — pruning still runs — and
 * the run still finishes.
 */
export async function runNightly(db: Db, opts: CycleOpts & { quoter?: Quoter }): Promise<NightlyResult> {
  const state = await readState(db, "nightly");
  const r: NightlyResult = { done: false, phase: state.phase, listed: 0, probed: 0, routable: 0, unroutable: 0, skipped: 0, pruned: 0, prunedCandles: 0, queries: 0 };
  const finish = (done: boolean, phase: string) => {
    r.done = done;
    r.phase = phase;
    return r;
  };
  // "" is a finished run, so the next one starts over; a known current phase resumes after its stored cursor;
  // a phase from before Task 6 ("tokens"/"pools") is unknown to the new PHASES list and also lands here.
  let phase: Phase = (PHASES as readonly string[]).includes(state.phase) ? (state.phase as Phase) : "listed";
  let afterId = phase === state.phase ? state.cursorText : "";

  if (phase === "listed") {
    // No request of its own, so no deadline check: one statement over the whole table.
    r.listed = await recomputeListedPools(db, "all");
    phase = "probe";
    afterId = "";
    await saveCursors(db, "nightly", { phase, cursorText: "" });
  }
  if (phase === "probe") {
    if (opts.quoter) {
      // Local eth_calls against the chain: probePools stops on its own deadline, one call is the whole
      // phase's work for this invocation; it pages, batches and stops on its own, persisting the cursor
      // itself after every page (onPage, I3) rather than once when the whole call returns, so a crash
      // mid-walk loses at most one page's progress instead of the run's entire probe budget.
      const probe = await probePools(db, opts.quoter, {
        now: opts.now, deadlineMs: opts.deadlineMs, afterId,
        onPage: (lastId) => saveCursors(db, "nightly", { phase: "probe", cursorText: lastId }),
      });
      r.probed = probe.probed;
      r.routable = probe.routable;
      r.unroutable = probe.unroutable;
      r.skipped = probe.skipped;
      // A partial outage (some pools answered, some could not be reached) is not an error for the run and
      // must not read as one in health, but it should not be silent either: counts only, never an address.
      if (probe.skipped > 0) console.warn(`nightly probe: ${probe.skipped} of ${probe.probed} candidates skipped (quoter unreachable)`);
      afterId = probe.lastId;
      if (!probe.done) return finish(false, "probe");
    }
    phase = "prune";
    await saveCursors(db, "nightly", { phase, cursorText: "" });
  }
  if (phase === "prune") {
    // Neither has a request or a cursor of its own (retention.ts) — a deadline stop just leaves rows for the
    // next run's `ts < retentionCutoff(now)` / `t < candleCutoff(interval, now)` scans to find again. Candles
    // run right after swaps, sharing the same deadline; the phase is done only once both report done.
    const swaps = await pruneSwaps(db, { now: opts.now, deadlineMs: opts.deadlineMs });
    r.pruned = swaps.deleted;
    const candles = await pruneCandles(db, { now: opts.now, deadlineMs: opts.deadlineMs });
    r.prunedCandles = candles.deleted;
    if (!swaps.done || !candles.done) return finish(false, "prune");
  }
  await saveCursors(db, "nightly", { phase: "", cursorText: "" });
  return finish(true, "");
}
