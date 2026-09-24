import { QUOTE_ADDRESSES } from "@/lib/chain/math/quotes";
import type { Db } from "@/lib/db/client";
import { coverageSet, pruneHolders } from "@/lib/holders/store";
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
  prunedCandles: number;
  /** Tokens whose top-holder list the holders phase dropped (store.ts's pruneHolders, tokens — not rows); every run, quoter or not. */
  prunedHolders: number; queries: number;
};

const PHASES = ["listed", "prune", "holders", "probe"] as const;
type Phase = (typeof PHASES)[number];

/**
 * Phases in order, persisted in sync_state.nightly.phase: "listed" (recomputeListedPools "all"), "prune"
 * (pruneSwaps over market.swaps, then pruneCandles over market.candles, both retention.ts — neither has a
 * request of its own, so both run whether or not opts.quoter was supplied, sharing one deadline; the phase
 * is done only once both report done), "holders" (the top-holder cleanup of the top-holders design's section
 * 7: pruneHolders over every token the coverage set no longer names and nobody has opened in the last
 * KEEP_REQUESTED_SEC), "probe" (probePools over pools active in the last PROBE_ACTIVE_SEC, cursor_text = its
 * lastId, saved after every page it processes rather than once at the end — I3), then phase "" and done =
 * true. Resumes from the stored phase and cursor — except a stored "probe", which resumes the walk from its
 * cursor while the run still starts at the front (24 Sep 2026; see runNightly's own comment); stops early
 * (done = false) at the deadline.
 *
 * "holders" sits between prune and probe for the same reason prune does: it is the second thing protecting
 * the store from unbounded growth (balances, not swaps), it carries no chain request and no cursor of its
 * own — a plain re-scan, so an interrupted run just finds the same victims next time — and it must never be
 * starved by a probe that can legitimately take weeks. It runs whether or not opts.quoter was supplied, and
 * it stops at the deadline exactly as prune does, leaving its own name stored so the next invocation re-enters
 * it with a full window rather than falling through to probe (fix round 1; see the block itself).
 *
 * Prune runs before probe (reordered from the original listed/probe/prune — final review BLOCKER, fixed
 * before CRON_SECRET is ever set): probe is capped at PROBE_RUN_CAP candidates a run (probe.ts) and, once
 * the catch-up has replayed the chain and last_swap_at is live for tens of thousands of pools, can
 * legitimately take one to three weeks of nightly runs to finish — and a probe that has not finished makes
 * this function return early (below). Prune carries no request and no cursor of its own, so it is cheap and
 * bounded; it is the phase that must never be starved by one that can take weeks, and probe is the one
 * phase safe to leave permanently unfinished — it is not what protects the store from disk growth.
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
 * A stored phase of "probe" or "prune" left over from before THIS reordering is still a name PHASES
 * recognises — the set of names is unchanged, only their order — so the fallback above does not catch it
 * either: the run resumes directly at that phase, by name, like any other resume. A leftover "prune" resumes
 * cleanly (prune has no cursor of its own; it just re-scans for whatever is still outside the retention
 * window) and then proceeds into "holders" and "probe" once done, same as a fresh run. A leftover "probe"
 * resumes the walk from its own stored cursor but, for that one invocation, skips straight past prune and
 * holders — each block below only runs when `phase` is literally its own name on entry — reproducing the
 * BLOCKER above until that one resumed probe finally reports `done`; the run then completes normally (phase
 * "") and every later invocation starts fresh at "listed" with both back in their unstarved place. For the
 * holder cleanup that costs one night at a time and nothing more: the balances a skipped night leaves behind
 * are the next night's victims, unchanged. Not actually reachable at this cutover —
 * the nightly cron is gated behind CRON_SECRET, unset until after this fix ships, so no phase has ever been
 * persisted — but documented here rather than left for a future reordering to rediscover.
 *
 * A run interrupted mid-"prune" (the deadline hit before both pruneSwaps and pruneCandles reported done)
 * resumes the same way: the next invocation reads the stored phase "prune", skips "listed" (already done for
 * this cycle) and re-enters the prune block directly. Neither pruneSwaps nor pruneCandles carries a cursor —
 * each is a plain `ts < cutoff` / `t < cutoff` scan — so resuming just re-issues the same scan, which finds
 * whatever rows the interrupted run had not yet reached and no others; nothing is skipped and nothing is
 * double-deleted. The resumed run then carries on into "holders", which is reached on that next invocation
 * exactly as it would have been on the first.
 *
 * `opts.quoter` is deliberately not folded into CycleOpts (market.ts): runMarketCycle has no use for one, and
 * widening a type both cycle functions share for the sake of this phase alone would be the wrong home for it.
 * Only the probe phase reads it, and only when the caller supplies one — deps.ts's createQuoter() for the real
 * nightly job. Without it (as in every other phase's own tests) probing is a no-op — pruning still runs, and
 * runs first — and the run still finishes.
 */
export async function runNightly(db: Db, opts: CycleOpts & { quoter?: Quoter }): Promise<NightlyResult> {
  const state = await readState(db, "nightly");
  const r: NightlyResult = { done: false, phase: state.phase, listed: 0, probed: 0, routable: 0, unroutable: 0, skipped: 0, pruned: 0, prunedCandles: 0, prunedHolders: 0, queries: 0 };
  const finish = (done: boolean, phase: string) => {
    r.done = done;
    r.phase = phase;
    return r;
  };
  // "" is a finished run, so the next one starts over; a known current phase resumes after its stored cursor;
  // a phase from before Task 6 ("tokens"/"pools") is unknown to the new PHASES list and also lands here.
  //
  // ONE exception, found live on 24 Sep 2026: a stored "probe" is a resume POINT for the probe's own walk,
  // never a starting phase. Probe is deliberately the one phase allowed to end a run not-done, and it stays
  // unfinished for weeks (PROBE_RUN_CAP a night against 263,180 pools was 69 more nights that morning) — so
  // resuming AT it sent every night after the first straight back into probe, and listed, prune and holders
  // never ran again. Production that morning: 980,942 trades a day past the retention window still stored,
  // the database growing about 660 MB a day against windows (D39) whose whole job is to hold it near 3 GB.
  // The reorder that put prune before probe was the right half of this fix; this is the other half.
  const resumingProbe = state.phase === "probe";
  let phase: Phase = !resumingProbe && (PHASES as readonly string[]).includes(state.phase) ? (state.phase as Phase) : "listed";
  // The probe's lastId survives the phases in front of it — they have no cursor of their own and must not
  // discard its walk — and is cleared only where it always was: by the run that finishes the walk, at the
  // end of this function. Every phase transition below therefore carries it rather than writing "".
  let afterId = resumingProbe || phase === state.phase ? state.cursorText : "";

  if (phase === "listed") {
    // No request of its own, so no deadline check: one statement over the whole table.
    r.listed = await recomputeListedPools(db, "all");
    phase = "prune";
    await saveCursors(db, "nightly", { phase, cursorText: afterId });
  }
  if (phase === "prune") {
    // Neither has a request or a cursor of its own (retention.ts) — a deadline stop just leaves rows for the
    // next run's `ts < retentionCutoff(now)` / `t < candleCutoff(interval, now)` scans to find again. Candles
    // run right after swaps, sharing the same deadline; the phase is done only once both report done. Runs
    // BEFORE the probe (reordered; see the module doc comment): cheap and bounded, so it must never be
    // starved by a phase that can legitimately take weeks.
    const swaps = await pruneSwaps(db, { now: opts.now, deadlineMs: opts.deadlineMs });
    r.pruned = swaps.deleted;
    const candles = await pruneCandles(db, { now: opts.now, deadlineMs: opts.deadlineMs });
    r.prunedCandles = candles.deleted;
    if (!swaps.done || !candles.done) return finish(false, "prune");
    phase = "holders";
    await saveCursors(db, "nightly", { phase, cursorText: afterId });
  }
  if (phase === "holders") {
    // Design section 7: keep the table's tokens and anything opened in the last week, drop the rest.
    //
    // What is bounded and what is not. pruneHolders takes each victim token in its own statement pair, so no
    // one victim's delete goes near the pooler's statement timeout however many holders it had — but it then
    // finishes with a single orphan sweep over the whole of market.token_balances (an anti-join against
    // market.holder_refresh, deleting rows whose refresh row is already gone). That last statement is bounded
    // by the size of the balances table, not by the victim count, and coverageSet before it groups over a
    // day of market.swaps — 2.2 s warm and 6.5 s cold on production (COVERAGE_TTL_SEC in holders/run.ts).
    // So the phase as a whole has no per-token bound: it can take real time on a bad night.
    //
    // Hence a deadline check before each of the two halves (fix round 1) AND inside pruneHolders itself
    // (I2: before every victim and before the closing sweep). Neither touches the stored cursor,
    // because the phase has none of its own — it is a plain re-scan, like prune — and the transition into
    // "holders" was already saved above: the next invocation re-enters here with a full window and finds the
    // same victims. Without these checks a run that entered the phase late would be killed by maxDuration
    // with "holders" already stored, and every later night would resume at "holders", silently skipping
    // "listed" and "prune" for good.
    if (Date.now() >= opts.deadlineMs) return finish(false, "holders");
    const kept = await coverageSet(db, opts.now, QUOTE_ADDRESSES);
    if (Date.now() >= opts.deadlineMs) return finish(false, "holders");
    // The pruner carries the same bounded contract as pruneSwaps/pruneCandles now (I2): it stops between
    // victims and before its closing sweep, so a phase entered with only seconds left drops what it can and
    // says so. `prunedHolders` is the victims dropped THIS run, which is what it always meant.
    const pruned = await pruneHolders(db, kept, opts.now, { deadlineMs: opts.deadlineMs });
    r.prunedHolders = pruned.tokens;
    if (!pruned.done) return finish(false, "holders");
    phase = "probe";
    await saveCursors(db, "nightly", { phase, cursorText: afterId });
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
      // Probe is last and deliberately the one phase allowed to end a run "not done": it can take one to
      // three weeks to walk the full post-catch-up candidate set (PROBE_RUN_CAP), and unlike prune it is not
      // what protects the store from disk growth, so nothing after it needs to be starved by it.
      if (!probe.done) return finish(false, "probe");
    }
  }
  await saveCursors(db, "nightly", { phase: "", cursorText: "" });
  return finish(true, "");
}
