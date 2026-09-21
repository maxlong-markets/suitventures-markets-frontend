import type { PublicClient } from "viem";
import type { Db } from "@/lib/db/client";
import { acquireLease, finishRun, readState, releaseLease } from "@/lib/sync/state";
import { upsertQuotes } from "@/lib/sync/writers";
import { foldEvents, newTokenCandidates } from "./fold";
import { readQuotePrices, readTokenMetadata, type QuoteFeedConfig } from "./onchain";
import { applyFold, dueForMetadata, loadFoldState, readChainCursor, refreshTokenMetadata } from "./store";
import type { LogSource } from "./types";

/**
 * The one-minute cron's chain job (Task 6, `docs/superpowers/plans/2026-09-21-chain-reader.md`; brief:
 * `.superpowers/sdd/2026-09-21-chain-reader/task-6-brief.md`): reads the PoolManager's own events through
 * `LogSource`, folds them with `foldEvents`, and writes `market.*` with the block cursor in one transaction
 * per batch, in place of the hosted indexer cancelled 21 Sep 2026.
 *
 * Sized against the real service (measured 21 Sep 2026): one HyperSync request covers about 2,000 blocks and
 * 7,500 events in about 3.7 s, and a response is capped at 6-8 MB — so `maxSpan` above about 2,500 buys
 * nothing, and a 50 s cron window (the caller's `windowSec`) fits roughly a dozen cycles. `maxRequests`
 * defaults to 80 to keep one minute's work under HyperSync's 100-requests-a-minute Starter tier with headroom
 * for a local catch-up running at the same time.
 *
 * Metadata is always read BEFORE the fold (ruled by the brief, not re-opened here): `newTokenCandidates`
 * names every token this batch would need metadata for — a token an Initialize in this same batch creates,
 * or an already-known token whose earlier metadata read failed and this batch touches again — and those
 * reads happen first, so a token created and traded in one batch never prices its first trades, candles and
 * pool state at the fallback 18 decimals. `foldEvents`/`applyFold` do the rest; see their own doc comments.
 *
 * `skippedLiquidity` (summed from `FoldResult.skippedLiquidity`) counts ModifyLiquidity events the fold could
 * not apply because their pool has no usable price to derive a sqrt from — about 2,881 pools copied from the
 * old indexer carry a garbage price that makes the derivation throw. The fold counts and skips these rather
 * than aborting the batch; a large and growing number here means many pools are stuck without a real
 * `sqrt_price_x96`, which their first swap heals. This runner only reports the count; it never fails on it.
 */

/** The minimal slice of a viem `PublicClient` the chain reader ever calls (see `onchain.ts`). */
export type ChainClient = Pick<PublicClient, "readContract">;

export type ChainRunDeps = {
  source: LogSource;
  client: ChainClient;
  quotes: readonly QuoteFeedConfig[];
};

export type ChainRunOpts = {
  owner: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  windowSec: number;
  intervalSec: number;
  leaseSec: number;
  /** Blocks held back from the chain's own head so a reorganised block is never read. Default 30. */
  safetyBlocks?: number;
  /** Widest span fetched in one request. Default 2_000 — see the module doc comment's measurement. */
  maxSpan?: number;
  /** Stop fetching once `deps.source.requests` has grown by this many since the invocation began. Default 80. */
  maxRequests?: number;
  /** Quote prices refresh at most this often within one invocation. Default 60. */
  quoteRefreshSec?: number;
  /** Token ids read per invocation's metadata retry sweep. Default 50. */
  metadataRetryLimit?: number;
  /**
   * When caught up (the fetch target is at or behind the cursor), stop the loop instead of sleeping and
   * waiting for new blocks. Default false, which is what the cron wants (keep polling for the rest of its
   * window); a one-shot catch-up run wants true instead, so it exits as soon as there is nothing left to
   * replay rather than idling out its whole window.
   */
  stopWhenCaughtUp?: boolean;
  onCycle?: (c: { cursor: number; target: number; blocks: number; events: number; trades: number; requests: number }) => void;
};

export type ChainRunReport = {
  skipped: "lease" | "nightly" | null;
  cycles: number;
  blocks: number;
  events: number;
  trades: number;
  newTokens: number;
  ignoredPools: number;
  skippedLiquidity: number;
  requests: number;
  quotesRefreshed: number;
  metadataRetried: number;
  metadataFailed: number;
  cursor: number;
  error: string | null;
};

/** market.sync_state job name for this runner; matches src/lib/chain/store.ts's CHAIN_JOB. */
const CHAIN_JOB = "chain";

const DEFAULT_SAFETY_BLOCKS = 30;
const DEFAULT_MAX_SPAN = 2_000;
const DEFAULT_MAX_REQUESTS = 80;
const DEFAULT_QUOTE_REFRESH_SEC = 60;
const DEFAULT_METADATA_RETRY_LIMIT = 50;

const sec = (ms: number) => Math.floor(ms / 1000);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function emptyReport(): ChainRunReport {
  return {
    skipped: null, cycles: 0, blocks: 0, events: 0, trades: 0, newTokens: 0, ignoredPools: 0,
    skippedLiquidity: 0, requests: 0, quotesRefreshed: 0, metadataRetried: 0, metadataFailed: 0, cursor: 0, error: null,
  };
}

/**
 * Runs the chain job until `opts.now()` passes the window's end or the request budget is spent, refreshes
 * quote prices at most once per `quoteRefreshSec`, and sweeps the metadata retry queue once, all under one
 * `chain` lease. See the module doc comment for the sizing this is built against.
 *
 * Order of operations (brief, exact, with two review fix-round-1 amendments and one final-review amendment
 * noted inline below): acquire the lease (`{ skipped: "lease" }` and the cursor read back for the report —
 * fix round 1, item 5 — but nothing else touched, if held); yield to the nightly while its own lease is live
 * (`{ skipped: "nightly" }`, this chain lease released first — final review MAJOR, mirroring the old market
 * job's spec-5.1 guard); read the cursor, throwing if it is 0 (starting from genesis by accident must be
 * impossible — run the catch-up script first); loop fetch/fold/apply cycles against the chain head minus
 * `safetyBlocks`, sleeping at most until the window ends when there is nothing to do (fix round 1, item 2),
 * calling `finishRun` after every real cycle; refresh quotes and sweep metadata retries once the loop ends;
 * release the lease in a `finally` no matter what happened above. The first thrown error (from a cycle, the
 * quote refresh or the metadata sweep) ends the invocation: it is recorded through `finishRun` with
 * `ok: false`, its message lands in the report's `error`, and nothing after it runs.
 */
export async function runChainSync(db: Db, deps: ChainRunDeps, opts: ChainRunOpts): Promise<ChainRunReport> {
  const report = emptyReport();
  const startMs = opts.now();
  if (!(await acquireLease(db, CHAIN_JOB, opts.owner, sec(startMs), opts.leaseSec))) {
    // Fix round 1, item 5: report the cursor as it actually stands, not the zeroed template's default — 0
    // here would read exactly like step 2's genesis refusal to anyone watching this report, and a lease skip
    // is a routine overlap, not that. One extra read, only on this rare path.
    return { ...report, skipped: "lease", cursor: await readChainCursor(db) };
  }

  // Final review MAJOR: mirrors the old market job's yield to the nightly (src/lib/sync/run.ts's
  // `opts.job === "market"` check, spec 5.1) — Task 6 replaced that job with this one without carrying the
  // guard over. The nightly's "listed" phase is a single unbatched full-table UPDATE of market.tokens
  // (writers.ts's recomputeListedPools) and its "prune" phase deletes from market.candles; applyFold's own
  // token and candle writes against either while both run is a real deadlock cycle, not just contention. Give
  // up the lease just taken and let the nightly's own window (up to 280 s) bound the delay — this reader
  // recovers the lost minute in a cycle or two once it is free again.
  if ((await readState(db, "nightly")).leaseUntil > sec(startMs)) {
    await releaseLease(db, CHAIN_JOB, opts.owner);
    return { ...report, skipped: "nightly", cursor: await readChainCursor(db) };
  }

  const safetyBlocks = opts.safetyBlocks ?? DEFAULT_SAFETY_BLOCKS;
  const maxSpan = opts.maxSpan ?? DEFAULT_MAX_SPAN;
  const maxRequests = opts.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const quoteRefreshSec = opts.quoteRefreshSec ?? DEFAULT_QUOTE_REFRESH_SEC;
  const metadataRetryLimit = opts.metadataRetryLimit ?? DEFAULT_METADATA_RETRY_LIMIT;
  const endMs = startMs + opts.windowSec * 1000;
  const requestsStart = deps.source.requests;

  try {
    // Starting from genesis by accident must be impossible: a never-run job reads 0 here, and this throws
    // rather than folding from block 1 — the catch-up script (not this task) is what seeds a real cursor.
    let cursor = await readChainCursor(db);
    if (cursor === 0) {
      throw new Error("chain cursor not initialised: run the catch-up script");
    }
    report.cursor = cursor;

    let lastQuoteRefreshMs: number | null = null;
    let errored = false;

    for (;;) {
      if (opts.now() >= endMs) break;
      if (deps.source.requests - requestsStart >= maxRequests) break;

      const before = deps.source.requests;
      try {
        const target = (await deps.source.head()) - safetyBlocks;
        if (target <= cursor) {
          if (opts.stopWhenCaughtUp) break;
          // Fix round 1, item 2: clamped to what is left of the window, not a bare intervalSec — a full
          // intervalSec sleep near the window's end overruns it (e.g. two 30 s idle sleeps inside a 50 s
          // window run to ~68 s of wall clock), and the lease (leaseSec) can still be held when the next
          // minute's cron fires, which then returns skipped: "lease" and does nothing that minute.
          await opts.sleep(Math.max(0, Math.min(opts.intervalSec * 1000, endMs - opts.now())));
          continue; // re-checks the window/budget at the top before asking the head again
        }

        const to = Math.min(target, cursor + maxSpan);
        const { events, nextBlock } = await deps.source.fetch(cursor + 1, to);
        const state = await loadFoldState(db, events);

        // Metadata BEFORE the fold (ruled, not re-opened): a token created and traded in this same batch
        // must not compute its first trades, price and candles at the fallback 18 decimals.
        const candidates = newTokenCandidates(events, state);
        let tokenMetadata: Map<string, { symbol: string; name: string; decimals: number }> | undefined;
        let newTokenSupply: Map<string, bigint> | undefined;
        if (candidates.length > 0) {
          const readings = await readTokenMetadata(deps.client, candidates);
          tokenMetadata = new Map();
          newTokenSupply = new Map();
          for (const [address, reading] of readings) {
            if (reading.ok) tokenMetadata.set(address, { symbol: reading.symbol, name: reading.name, decimals: reading.decimals });
            if (reading.totalSupply !== null) newTokenSupply.set(address, reading.totalSupply);
          }
        }

        const result = foldEvents(events, state, { tokenMetadata });
        await applyFold(db, result, nextBlock - 1, sec(opts.now()), { newTokenSupply });

        const prevCursor = cursor;
        cursor = nextBlock - 1;
        const blocks = cursor - prevCursor;
        report.cursor = cursor;
        report.cycles += 1;
        report.blocks += blocks;
        report.events += events.length;
        report.trades += result.trades.length;
        report.newTokens += result.newTokens.length;
        report.ignoredPools += result.ignoredPools;
        report.skippedLiquidity += result.skippedLiquidity;

        const queries = deps.source.requests - before;
        opts.onCycle?.({ cursor, target, blocks, events: events.length, trades: result.trades.length, requests: deps.source.requests - requestsStart });

        await finishRun(db, CHAIN_JOB, {
          now: sec(opts.now()), ok: true,
          rows: result.pools.length + result.tokens.length + result.trades.length + result.candles.length,
          queries,
        });

        // Quote prices: after this cycle's own work, not inside it, and gated to at most once per
        // quoteRefreshSec — a 50 s cron window fits roughly a dozen cycles (module doc comment), and asking
        // Chainlink once per cycle would be wasteful; a long catch-up-scale invocation instead refreshes
        // periodically rather than only once at the very end.
        if (lastQuoteRefreshMs === null || opts.now() - lastQuoteRefreshMs >= quoteRefreshSec * 1000) {
          const prices = await readQuotePrices(deps.client, deps.quotes, sec(opts.now()));
          // Empty quote list: every one of the 54 rows already exists (Task 6 brief, measurement 2), so this
          // only ever moves the price columns — upsertQuotes's own second statement.
          await upsertQuotes(db, [], prices);
          report.quotesRefreshed += prices.length;
          lastQuoteRefreshMs = opts.now();
        }
      } catch (err) {
        report.error = message(err);
        await finishRun(db, CHAIN_JOB, { now: sec(opts.now()), ok: false, error: report.error, rows: 0, queries: deps.source.requests - before });
        errored = true;
        break;
      }
    }

    if (!errored) {
      try {
        // Once per invocation, after the loop: the metadata retry queue starts tiny (21 of 132,004 tokens
        // carry metadata_loaded = false — measurement 3), so this is a small, bounded sweep, never a scan of
        // the whole table (dueForMetadata's own where clause and limit).
        const dueIds = await dueForMetadata(db, sec(opts.now()), metadataRetryLimit);
        if (dueIds.length > 0) {
          const readings = await readTokenMetadata(deps.client, dueIds);
          await refreshTokenMetadata(db, readings, sec(opts.now()));
          for (const reading of readings.values()) {
            if (reading.ok) report.metadataRetried += 1;
            else report.metadataFailed += 1;
          }
        }
      } catch (err) {
        report.error = message(err);
        await finishRun(db, CHAIN_JOB, { now: sec(opts.now()), ok: false, error: report.error, rows: 0, queries: 0 });
      }
    }

    report.requests = deps.source.requests - requestsStart;
  } finally {
    await releaseLease(db, CHAIN_JOB, opts.owner);
  }

  return report;
}
