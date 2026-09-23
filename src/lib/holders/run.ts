import type { LogSource, TransferEvent } from "@/lib/chain/types";
import type { Db } from "@/lib/db/client";
import { acquireLease, finishRun, readState, releaseLease, renewLease, saveCursors } from "@/lib/sync/state";
import { foldTransfers } from "./fold";
import {
  applySlice, coverageSet, dueTokens, ensureRows, markReady, markSkipped, refreshRow,
  COVERAGE_LIMIT, MAX_TRANSFERS_PER_TOKEN, type RefreshRow,
} from "./store";

/**
 * The top-holder builder (docs/superpowers/specs/2026-09-23-top-holders-design.md, section 4): one invocation
 * per cron minute under the `holders` lease, at most `windowSec` of work, one HyperSync request every
 * `requestSpacingMs` (80 a minute against the key's 100, the reader's 4 alongside). Per due token: slice from
 * the stored cursor until ready or the window ends. A thrown head() or coverage error ends the invocation
 * through finishRun(ok: false); a per-token failure is counted and skipped over.
 */
export const HOLDERS_JOB = "holders";
export const DEFAULT_REQUEST_SPACING_MS = 750;
export const DEFAULT_SAFETY_BLOCKS = 30;
/**
 * How long a computed coverage set is reused before the query behind it runs again. Measured on production
 * 23 Sep 2026: coverageSet's group-by over a day of market.swaps takes 2.2 s warm and 6.5 s cold — it scans
 * the day's trades — which is too much to pay on each of the 1,440 daily invocations for a top-500 list that
 * barely moves between them. Five minutes bounds how long a token that starts trading waits for a place on
 * that list; a token someone actually opened does not wait at all, since `requested_at` puts it in the due
 * list's first tier without ever consulting the coverage set.
 */
export const COVERAGE_TTL_SEC = 300;

export type HoldersRunDeps = { source: Pick<LogSource, "head" | "transfers" | "requests"> };
export type HoldersRunOpts = {
  owner: string; now: () => number; sleep: (ms: number) => Promise<void>; windowSec: number; leaseSec: number;
  excludedIds: readonly string[]; requestSpacingMs?: number; safetyBlocks?: number; coverageLimit?: number; maxTransfersPerToken?: number;
};
export type HoldersRunReport = {
  skipped: "lease" | "nightly" | null; coverage: number; coverageRecomputed: boolean; due: number;
  tokensTouched: number; tokensReady: number; tokensSkipped: number;
  slices: number; requests: number; transfers: number; errors: number; error: string | null;
};

const sec = (ms: number) => Math.floor(ms / 1000);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** A stored coverage set, or null when the row has never held one (`cursor_text` defaults to ''), or holds something else. */
function parseCoverage(text: string): string[] | null {
  if (text === "") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && parsed.every((id) => typeof id === "string") ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

export async function runHoldersBuild(db: Db, deps: HoldersRunDeps, opts: HoldersRunOpts): Promise<HoldersRunReport> {
  const report: HoldersRunReport = {
    skipped: null, coverage: 0, coverageRecomputed: false, due: 0, tokensTouched: 0, tokensReady: 0, tokensSkipped: 0,
    slices: 0, requests: 0, transfers: 0, errors: 0, error: null,
  };
  const startMs = opts.now();
  if (!(await acquireLease(db, HOLDERS_JOB, opts.owner, sec(startMs), opts.leaseSec))) return { ...report, skipped: "lease" };
  // Mirrors the reader's own yield (src/lib/chain/run.ts): the nightly's unbatched full-table writes and this
  // builder's token/balance writes against each other are a real deadlock cycle, not just contention. Give the
  // lease just taken straight back and let the nightly's window bound the delay — a minute costs nothing here,
  // since every token's cursor is durable and the next invocation resumes exactly where this one would have.
  if ((await readState(db, "nightly")).leaseUntil > sec(startMs)) {
    await releaseLease(db, HOLDERS_JOB, opts.owner);
    return { ...report, skipped: "nightly" };
  }
  const endMs = startMs + opts.windowSec * 1000;
  const spacing = opts.requestSpacingMs ?? DEFAULT_REQUEST_SPACING_MS;
  const safety = opts.safetyBlocks ?? DEFAULT_SAFETY_BLOCKS;
  const maxTransfers = opts.maxTransfersPerToken ?? MAX_TRANSFERS_PER_TOKEN;
  const requestsStart = deps.source.requests;
  let lastRequestMs = -Infinity;
  let head = 0;
  const pace = async (): Promise<void> => {
    const wait = lastRequestMs + spacing - opts.now();
    if (wait > 0) await opts.sleep(wait);
    lastRequestMs = opts.now();
  };
  try {
    await pace();
    head = await deps.source.head();
    const coverage = await resolveCoverage();
    report.coverage = coverage.length;
    await ensureRows(db, coverage);
    const due = await dueTokens(db, coverage, sec(opts.now()));
    report.due = due.length;
    for (const row of due) {
      if (opts.now() >= endMs) break;
      report.tokensTouched += 1;
      await buildToken(row);
      await renewLease(db, HOLDERS_JOB, opts.owner, sec(opts.now()), opts.leaseSec);
    }
    await finishRun(db, HOLDERS_JOB, { now: sec(opts.now()), ok: true, rows: report.transfers, queries: deps.source.requests - requestsStart, report: cycleReport() });
  } catch (err) {
    report.error = message(err);
    await finishRun(db, HOLDERS_JOB, { now: sec(opts.now()), ok: false, error: report.error, rows: 0, queries: deps.source.requests - requestsStart });
  } finally {
    report.requests = deps.source.requests - requestsStart;
    await releaseLease(db, HOLDERS_JOB, opts.owner);
  }
  return report;

  function cycleReport(): Record<string, number> {
    return {
      at: sec(opts.now()), coverage: report.coverage, coverageRecomputed: report.coverageRecomputed ? 1 : 0, due: report.due,
      tokensTouched: report.tokensTouched, tokensReady: report.tokensReady, tokensSkipped: report.tokensSkipped,
      slices: report.slices, requests: deps.source.requests - requestsStart, transfers: report.transfers, errors: report.errors,
    };
  }

  /**
   * The coverage set, reused from the job's own sync_state row while it is younger than COVERAGE_TTL_SEC (see
   * that constant for the measurement this exists for). `cursor` holds the unix second the list was computed
   * and `cursor_text` the ids as a JSON array, so the cache needs no schema of its own; a row that is stale,
   * empty or holding anything but an array of strings recomputes and stores the fresh list.
   */
  async function resolveCoverage(): Promise<string[]> {
    const nowSec = sec(opts.now());
    const state = await readState(db, HOLDERS_JOB);
    const cached = state.cursor > nowSec - COVERAGE_TTL_SEC ? parseCoverage(state.cursorText) : null;
    if (cached) return cached;
    const ids = await coverageSet(db, nowSec, opts.excludedIds, opts.coverageLimit ?? COVERAGE_LIMIT);
    report.coverageRecomputed = true;
    await saveCursors(db, HOLDERS_JOB, { cursor: nowSec, cursorText: JSON.stringify(ids) });
    return ids;
  }

  /** Slices one token from its stored cursor until ready, skipped, a failure, or the window's end. */
  async function buildToken(start: RefreshRow): Promise<void> {
    let row: RefreshRow | null = start;
    while (row && opts.now() < endMs) {
      // The source is handed `head - safety` as an inclusive ceiling, so it never returns an event past it and
      // clamps `nextBlock` to `ceiling + 1`: this fires exactly after the slice that reached the line. A slice
      // that stops one block short of it (`nextBlock === head - safety`) also passes, one block early — that
      // block is simply folded by the next refresh, which resumes from this same untouched cursor.
      if (row.cursorBlock >= head - safety) {
        await markReady(db, row.tokenId, sec(opts.now()));
        report.tokensReady += 1;
        return;
      }
      if (row.transfers > maxTransfers) {
        await markSkipped(db, row.tokenId);
        report.tokensSkipped += 1;
        return;
      }
      await pace();
      let slice: { transfers: TransferEvent[]; nextBlock: number };
      try {
        // Only the source call is caught here: a throw out of applySlice/markReady/refreshRow below is the
        // store refusing to write (its requireRow guards), which is a broken invariant rather than one flaky
        // HyperSync response — it belongs in the invocation-level catch (finishRun ok: false), not in `errors`.
        slice = await deps.source.transfers(row.tokenId, row.cursorBlock, head - safety);
      } catch (err) {
        report.errors += 1;
        console.warn(`holders: slice failed for ${row.tokenId} from ${row.cursorBlock}: ${message(err)}`);
        return;
      }
      await applySlice(db, row.tokenId, foldTransfers(slice.transfers), slice.nextBlock, slice.transfers.length, sec(opts.now()));
      report.slices += 1;
      report.transfers += slice.transfers.length;
      row = await refreshRow(db, row.tokenId);
    }
  }
}
