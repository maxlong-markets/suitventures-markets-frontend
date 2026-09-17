import type { Db } from "@/lib/db/client";
import { PAGE_LIMIT, type CycleOpts } from "./market";
import type { EnvioSource } from "./source";
import { readState, saveCursors } from "./state";
import { recomputeListedPools, upsertPools, upsertTokens } from "./writers";

export type NightlyResult = { done: boolean; phase: string; tokens: number; pools: number; listed: number; queries: number };

const PHASES = ["tokens", "pools", "listed"] as const;
type Phase = (typeof PHASES)[number];

/**
 * Phases in order, persisted in sync_state.nightly.phase with cursor_text = last id of the completed page:
 * "tokens" (tokensPage walk, upsertTokens), "pools" (poolsPage walk, upsertPools), "listed" (recomputeListedPools "all"),
 * then phase "" and done = true. Resumes from the stored phase and cursor; stops early (done = false) at the budget or deadline.
 */
export async function runNightly(db: Db, source: EnvioSource, opts: CycleOpts): Promise<NightlyResult> {
  const start = source.queries;
  const state = await readState(db, "nightly");
  const r: NightlyResult = { done: false, phase: state.phase, tokens: 0, pools: 0, listed: 0, queries: 0 };
  const canQuery = () => source.queries - start < opts.queryBudget && Date.now() < opts.deadlineMs;
  const finish = (done: boolean, phase: string) => {
    r.done = done;
    r.phase = phase;
    r.queries = source.queries - start;
    return r;
  };
  // "" is a finished run, so the next one starts over; a known phase resumes after the last id it stored.
  let phase: Phase = (PHASES as readonly string[]).includes(state.phase) ? (state.phase as Phase) : "tokens";
  let afterId = phase === state.phase ? state.cursorText : "";

  /** One id-ordered walk to the end of a table, persisting the last id after every page. False when the budget ran out. */
  const walk = async <T extends { id: string }>(name: "tokens" | "pools", page: (after: string) => Promise<T[]>, write: (rows: T[]) => Promise<number>) => {
    for (;;) {
      if (!canQuery()) return false;
      const rows = await page(afterId);
      if (rows.length > 0) {
        r[name] += await write(rows);
        afterId = rows[rows.length - 1].id;
        await saveCursors(db, "nightly", { phase: name, cursorText: afterId });
      }
      if (rows.length < PAGE_LIMIT) return true;
    }
  };

  if (phase === "tokens") {
    if (!(await walk("tokens", (a) => source.tokensPage(a, PAGE_LIMIT), (rows) => upsertTokens(db, rows, opts.now)))) return finish(false, "tokens");
    phase = "pools";
    afterId = "";
    await saveCursors(db, "nightly", { phase, cursorText: "" });
  }
  if (phase === "pools") {
    if (!(await walk("pools", (a) => source.poolsPage(a, PAGE_LIMIT), (rows) => upsertPools(db, rows, opts.now)))) return finish(false, "pools");
    phase = "listed";
    await saveCursors(db, "nightly", { phase, cursorText: "" });
  }
  // No Envio request in this phase, so no budget check: one statement over the whole table.
  r.listed = await recomputeListedPools(db, "all");
  await saveCursors(db, "nightly", { phase: "", cursorText: "" });
  return finish(true, "");
}
