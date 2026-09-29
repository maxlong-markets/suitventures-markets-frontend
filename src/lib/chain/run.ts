import type { PublicClient } from "viem";
import type { Db } from "@/lib/db/client";
import { acquireLease, finishRun, readState, releaseLease } from "@/lib/sync/state";
import { upsertQuotes } from "@/lib/sync/writers";
import { foldEvents, newTokenCandidates } from "./fold";
import { holderDelta } from "./math/holders";
import { balancePairKey, readBalancesBothSides, readQuotePrices, readTokenMetadata, type BalancePair, type QuoteFeedConfig, type ReadDeadline } from "./onchain";
import { applyFold, dueForMetadata, loadFoldState, readChainCursor, refreshTokenMetadata } from "./store";
import type { LogSource, TradeRow } from "./types";

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
 *
 * `orphanedTokens` (summed from `FoldResult.orphanedTokens`; observability review,
 * .superpowers/sdd/2026-09-21-chain-reader/missing-token-review.md, MAJOR-1) counts a Swap or ModifyLiquidity
 * whose pool IS tracked but whose token is missing from the loaded state entirely — structurally unreachable
 * once `loadFoldState` synthesizes a fallback token for every pool it loads, so this should always be 0. A
 * nonzero value here (or the `console.warn` the fold emits alongside it) means that invariant broke somewhere.
 * Deliberately its own counter, not folded into `ignoredPools`: that field's ordinary meaning ("an event
 * naming a pool nothing tracks") is enormous and routine — 62% of all events in one measured run — and would
 * bury this anomaly completely.
 *
 * `holderDeltaApplied`/`holderReadsUnknown` (holder-count upkeep, 2026-09-22 — see
 * .superpowers/sdd/2026-09-21-chain-reader/holder-count-report.md, and its "Fix round 1" section for the
 * review that reshaped this into its current form; the design doc's "What is deliberately not indexed"
 * describes the intended approach): the old indexer derived holders_count by replaying every ERC-20
 * Transfer, which this reader does not index at all (see that section). Instead, `computeHolderDeltas`
 * below runs AFTER `foldEvents` and BEFORE `applyFold`, reads `balanceOf` TWICE per distinct (token,
 * wallet) pair this batch's trades touch — once at the block before the batch, once at its last block —
 * and turns an observed zero-to-non-zero or non-zero-to-zero swing into +/-1 via `holderDelta`
 * (math/holders.ts). Both sides are OBSERVED, never derived from a swap event's emitted amount: a
 * token-denominated router or hook fee, or a payout address other than the transaction sender, would
 * silently break a derivation (fix round 1, MAJOR-3). Skipped entirely — every pair counted unknown,
 * nothing read — during a catch-up replay (BLOCKER-1: the historical state is gone from the public node
 * long before the reader catches up, and the old per-cycle fallback over- and under-counted across
 * cycles) and whenever the cron's window is nearly spent (MAJOR-2). `holderDeltaApplied` counts pairs
 * this actually resolved (whether the resulting delta was +1, -1 or a genuine 0); `holderReadsUnknown`
 * counts pairs skipped for any reason — a failed or timed-out read, the per-cycle cap, a catch-up
 * cycle, or too little window left — never guessed, counted instead.
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
  /** Distinct (token, wallet) pairs read for holder-count upkeep per cycle. Default 600 — see DEFAULT_HOLDER_PAIR_CAP. */
  holderPairCap?: number;
  /**
   * When caught up (the fetch target is at or behind the cursor), stop the loop instead of sleeping and
   * waiting for new blocks. Default false, which is what the cron wants (keep polling for the rest of its
   * window); a one-shot catch-up run wants true instead, so it exits as soon as there is nothing left to
   * replay rather than idling out its whole window.
   */
  stopWhenCaughtUp?: boolean;
  onCycle?: (c: {
    cursor: number;
    target: number;
    blocks: number;
    events: number;
    trades: number;
    orphanedTokens: number;
    holderDeltaApplied: number;
    holderReadsUnknown: number;
    requests: number;
  }) => void;
};

export type ChainRunReport = {
  skipped: "lease" | "nightly" | null;
  cycles: number;
  blocks: number;
  events: number;
  trades: number;
  newTokens: number;
  ignoredPools: number;
  orphanedTokens: number;
  skippedLiquidity: number;
  /** Launchpad events folded this invocation (instant launchpad design, section 13). */
  launchEvents: number;
  holderDeltaApplied: number;
  holderReadsUnknown: number;
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

/**
 * Cap on distinct (token, wallet) pairs read for holder-count upkeep per cycle. The module doc
 * comment's own sizing measurement says a busy cycle has roughly 1,700 trades; at 100 calls per HTTP
 * request (createChainClient's batch size) reading every pair in a cycle that busy costs about 17
 * requests to the plain RPC node — a separate, much less constrained allowance than HyperSync's
 * `maxRequests` above (a public JSON-RPC endpoint, not the Starter-tier-limited HyperSync API), so
 * this cap is a time budget, not a request budget. readBalances reads in sequential batches of
 * BALANCE_READ_CHUNK (40) because the public node answers 429 to a batch above 50, and each batch takes
 * about 400 ms; the upkeep reads every pair twice, before and after the batch. So 600 pairs is 30 batches,
 * roughly 12 s of a 50 s window, leaving room for the fetch, the fold and the write. A live minute of chain
 * carries about 1,000 trades and fewer distinct (token, wallet) pairs, so an ordinary cycle fits; a
 * pathological one (one token's launch drawing far more wallets than usual) has its excess pairs skipped
 * and counted unknown (ChainRunReport.holderReadsUnknown) instead of dropping trades or overrunning the
 * window. Was 2,000 before 22 Sep 2026, which took 40 s at the measured batch size.
 */
const DEFAULT_HOLDER_PAIR_CAP = 600;

/**
 * Timeout for ONE balanceOf read inside computeHolderDeltas below (fix round 1, MAJOR-2 —
 * .superpowers/sdd/2026-09-21-chain-reader/holder-count-review.md). `createChainClient` (onchain.ts)
 * sets no per-call timeout on its `http` transport, so viem's own default (~10s) times its 3 retries
 * can hold ONE call for roughly 40s against a degraded RPC — comfortably longer than a whole cron
 * cycle, and invisible to any budget: `report.requests` only counts HyperSync's `deps.source`, never
 * `deps.client`. 5s is generous next to a healthy eth_call (tens to a few hundred ms) but small next
 * to that ~40s worst case, so a degraded RPC now costs at most ~5s of this cycle's time instead of up
 * to ~40s. A timed-out read is passed through `readBalances`' own `timeoutMs`, which treats it exactly
 * like any other per-pair failure: absent from the map, counted unknown, never guessed.
 */
const HOLDER_READ_TIMEOUT_MS = 8_000;

/**
 * Holder-count upkeep is skipped for the rest of THIS cycle — every pair counted unknown, nothing read
 * — once less than this much of the cron's window remains (fix round 1, MAJOR-2). computeHolderDeltas
 * below reads both sides of each pair chunk by chunk under HOLDER_READ_DEADLINE_MARGIN_MS, each read
 * individually bounded by HOLDER_READ_TIMEOUT_MS, so the upkeep itself never runs past the window;
 * 10,000ms is the least window worth starting those paced reads in, leaving margin for the rest of the cycle's own work
 * (`applyFold`, `finishRun`) to still land inside the window, rather than trading one kind of overrun
 * (an unbounded read) for a smaller one (a bounded read that still eats whatever is left of the
 * window). A cycle skipped for this reason is exactly as safe as one skipped for any other: nothing is
 * guessed, the pairs are simply left for a later cycle once there is enough window in hand.
 */
const HOLDER_MIN_WINDOW_MS = 10_000;

/**
 * How long before the window's end the balance reads stop starting new chunks (23 Sep 2026). The reads
 * are now paced at the public node's 40 calls a second (pacing.ts): a typical minute's 280 distinct
 * pairs is 14 s of reads, a busy one's 520 pairs 26 s, so a cycle that starts late in the window can
 * no longer count on finishing every pair. readBalancesBothSides stops at this deadline and reports
 * the pairs it never started, which are counted unknown — the cycle's other writes still land inside
 * the window, and nothing is guessed. The margin covers `applyFold` and `finishRun` for that cycle.
 */
const HOLDER_READ_DEADLINE_MARGIN_MS = 1_500;

const sec = (ms: number) => Math.floor(ms / 1000);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function emptyReport(): ChainRunReport {
  return {
    skipped: null, cycles: 0, blocks: 0, events: 0, trades: 0, newTokens: 0, ignoredPools: 0, orphanedTokens: 0,
    skippedLiquidity: 0, launchEvents: 0, holderDeltaApplied: 0, holderReadsUnknown: 0, requests: 0, quotesRefreshed: 0,
    metadataRetried: 0, metadataFailed: 0, cursor: 0, error: null,
  };
}

/**
 * Distinct (token, wallet) pairs this batch's trades touch, in first-seen order (fix round 1,
 * holder-count-review.md MAJOR-3): no longer derives or nets a raw token delta at all.
 * computeHolderDeltas below now OBSERVES both sides of the transition with a real `balanceOf` instead
 * of deriving "after" from "before" plus a swap event's emitted amount — the review showed that
 * derivation silently breaks for a token-denominated router or hook fee (our own SVRouter takes 0.5%
 * on the way through) or a payout address other than the transaction sender. So this function only
 * needs to know WHICH pairs to read, not by how much any of them moved; several trades for the same
 * pair in one batch simply collapse to the one pair, exactly as before, but the correctness of that
 * collapse no longer depends on summing anything — the two real balances are the truth regardless of
 * what happened in between.
 */
function collectHolderPairs(trades: readonly TradeRow[]): BalancePair[] {
  const seen = new Map<string, BalancePair>();
  for (const trade of trades) {
    const pair = { token: trade.tokenId, wallet: trade.wallet };
    const key = balancePairKey(pair);
    if (!seen.has(key)) seen.set(key, pair);
  }
  return [...seen.values()];
}

/**
 * Holder-count upkeep for one cycle (holder-count upkeep, 2026-09-22;
 * .superpowers/sdd/2026-09-21-chain-reader/holder-count-report.md and its "Fix round 1" section — read
 * both for the two decisions this still does not re-open: the count drifts forward from its baseline
 * rather than replaying transfer history, and this ships now, alongside the running catch-up replay).
 * Called from the main loop AFTER foldEvents and BEFORE applyFold, so the caller can pass its result
 * straight into that same transaction.
 *
 * Fix round 1 rewrite (holder-count-review.md): reads `balanceOf` TWICE per pair — "before" at
 * `cursor` (the block before this batch) and "after" at `afterBlock` (this batch's own last block,
 * `nextBlock - 1`) — and applies `holderDelta` to the two OBSERVED balances. The previous version read
 * only "before" and derived "after" by adding the batch's own emitted token delta; MAJOR-3 showed that
 * assumption breaks for a token-denominated router/hook fee or a payout address other than the
 * transaction sender. Observing both ends costs one extra read per pair (~34 requests on a busy cycle
 * instead of ~17 — still the chain node's own allowance, not HyperSync's, and still comfortable) and
 * removes the routing assumption entirely, at the same time as deleting the per-pair net-delta
 * bookkeeping the old version needed (collectHolderPairs above).
 *
 * Two reasons this returns immediately with EVERY pair counted unknown and NOTHING read:
 *   - `catchUp` true (BLOCKER-1). During a catch-up replay `cursor` is days or weeks old, and the
 *     public node has long since pruned state that old — a historical `balanceOf` there fails almost
 *     every time. The previous version fell back to reading only the CURRENT balance and decrementing
 *     on a current zero, which turned out to double- and triple-count: nothing tracked which pairs had
 *     already been counted across replay cycles, so a wallet trading the same token in N cycles of the
 *     replay could be decremented N times for a single real exit, or even for a round trip that was
 *     never a holder at the 17 Sep baseline or at the end (see the report's Fix round 1 section for the
 *     worked example). Because the store's clamp (`greatest(0, …)`) is one-directional, that damage does
 *     not self-correct. The only honest behaviour, given catch-up can only ever subtract, is to apply
 *     NOTHING during a replay and let the 17 Sep baseline stand until the cron takes over in normal
 *     mode once caught up — accuracy cost: every holder who newly joined during the five-day backlog is
 *     uncounted until they trade again post-catch-up (unchanged from the previous version's own
 *     accepted trade-off on the buy side); what changes here is that an exit is no longer over-counted
 *     either, because nothing at all is counted during the replay.
 *   - `hasWindowForReads` false (MAJOR-2). Under HOLDER_MIN_WINDOW_MS of the cron's window remains:
 *     even a read bounded by HOLDER_READ_TIMEOUT_MS is not worth starting this late, since running it
 *     out would likely be the last thing this invocation does before its lease-driven window closes.
 *
 * Otherwise: one `balanceOf` read per distinct pair (collectHolderPairs above) at EACH block, capped at
 * `pairCap` (a cycle with more distinct pairs than the cap reads only the first `pairCap`, first-seen
 * order, and counts the rest unknown — never grows the read unboundedly or drops a trade), each read
 * bounded by `readTimeoutMs`. A pair missing either side — a failed read, a timeout, or a cap skip — is
 * counted unknown and never guessed; `holderDelta` is only ever called with two real, observed
 * balances.
 */
async function computeHolderDeltas(
  client: ChainClient,
  trades: readonly TradeRow[],
  cursor: number,
  afterBlock: number,
  catchUp: boolean,
  hasWindowForReads: boolean,
  pairCap: number,
  readTimeoutMs: number,
  deadline?: ReadDeadline,
): Promise<{ deltas: Map<string, number>; applied: number; unknown: number }> {
  const pairs = collectHolderPairs(trades);
  const deltas = new Map<string, number>();

  if (catchUp || !hasWindowForReads) {
    return { deltas, applied: 0, unknown: pairs.length };
  }

  const capped = pairs.slice(0, pairCap);
  let unknown = pairs.length - capped.length;
  let applied = 0;
  const add = (tokenId: string, delta: number): void => {
    if (delta === 0) return;
    deltas.set(tokenId, (deltas.get(tokenId) ?? 0) + delta);
  };

  if (capped.length > 0) {
    // Both sides of each pair in ONE batch, chunk by chunk, under the deadline (readBalancesBothSides):
    // two side-by-side readBalances calls used to merge into 80-call batches the public node refused.
    const { before: beforeMap, after: afterMap } = await readBalancesBothSides(
      client, capped, BigInt(cursor), BigInt(afterBlock), readTimeoutMs, deadline,
    );
    for (const pair of capped) {
      const key = balancePairKey(pair);
      const before = beforeMap.get(key);
      const after = afterMap.get(key);
      if (before === undefined || after === undefined) {
        unknown += 1;
        continue;
      }
      applied += 1;
      add(pair.token, holderDelta(before, after));
    }
    // Fix round 1, MINOR-8: a normal-mode cycle that resolves NONE of a real batch of pairs — as
    // opposed to the catch-up/window-skip branch above, which is EXPECTED to apply nothing — is the
    // signal the review asked to surface: a sustained run of these means the configured RPC most likely
    // is not serving state this old (DEFAULT_SAFETY_BLOCKS + maxSpan blocks back) and the feature is
    // dark. One line, not a metric pipeline; `holderReadsUnknown` itself remains the durable, reported
    // counter to alert on.
    if (applied === 0) {
      console.warn(`computeHolderDeltas: resolved 0 of ${capped.length} balance pair(s) this cycle — check the RPC's archive-state depth`);
    }
  }

  return { deltas, applied, unknown };
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
  const holderPairCap = opts.holderPairCap ?? DEFAULT_HOLDER_PAIR_CAP;
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
      const cycleStartMs = opts.now();
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

        // Holder-count upkeep (fix round 1 — holder-count-review.md): AFTER the fold, BEFORE applyFold,
        // so its deltas land in the very same transaction as everything else this cycle wrote. `cursor`
        // here is still the block BEFORE this batch (it only advances below) — computeHolderDeltas'
        // "before" read; `nextBlock - 1` (about to become the new `cursor`) is this batch's own last
        // block — its "after" read (MAJOR-3: both sides observed, neither derived). The window check
        // (MAJOR-2) is read fresh right here, not once at the top of the invocation, since a busy
        // invocation reaches this point at a different `opts.now()` on every cycle.
        const holderWindowRemainingMs = endMs - opts.now();
        const holderOutcome = await computeHolderDeltas(
          deps.client, result.trades, cursor, nextBlock - 1, opts.stopWhenCaughtUp ?? false,
          holderWindowRemainingMs >= HOLDER_MIN_WINDOW_MS, holderPairCap, HOLDER_READ_TIMEOUT_MS,
          { untilMs: endMs - HOLDER_READ_DEADLINE_MARGIN_MS, now: opts.now },
        );
        await applyFold(db, result, nextBlock - 1, sec(opts.now()), { newTokenSupply, holderDeltas: holderOutcome.deltas });

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
        report.orphanedTokens += result.orphanedTokens;
        report.skippedLiquidity += result.skippedLiquidity;
        report.launchEvents += result.launchEvents;
        report.holderDeltaApplied += holderOutcome.applied;
        report.holderReadsUnknown += holderOutcome.unknown;

        const queries = deps.source.requests - before;
        opts.onCycle?.({
          cursor, target, blocks, events: events.length, trades: result.trades.length,
          orphanedTokens: result.orphanedTokens, holderDeltaApplied: holderOutcome.applied,
          holderReadsUnknown: holderOutcome.unknown, requests: deps.source.requests - requestsStart,
        });

        await finishRun(db, CHAIN_JOB, {
          now: sec(opts.now()), ok: true,
          rows: result.pools.length + result.tokens.length + result.trades.length + result.candles.length,
          queries,
          // The cycle's holder-count upkeep, for /api/health (23 Sep 2026): the one signal that says
          // whether balance reads are getting through, visible without a manual cron call or the logs.
          report: {
            at: sec(opts.now()), cursor, blocks, trades: result.trades.length,
            holderPairs: holderOutcome.applied + holderOutcome.unknown,
            holderDeltaApplied: holderOutcome.applied, holderReadsUnknown: holderOutcome.unknown,
            launchEvents: result.launchEvents,
          },
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

        // Pace the steady state. Measured on the live cron, 22 Sep 2026: with no pause after a successful
        // cycle, a caught-up reader ran 23 cycles in one 50 s window, because the chain adds ~20 blocks in
        // the ~2 s a tiny cycle takes, so there was always "more to do". That cost 47 HyperSync requests a
        // minute against a design of about two, and it hammered the chain node with holder-balance reads
        // in 23 tiny batches, which the node then refused: 416 of 418 reads failed. So when this cycle
        // reached the target — we are caught up — wait until intervalSec after it began, clamped to the
        // window, exactly as the old market job paced itself. A size-capped fetch (cursor < target) means
        // we are behind, and the catch-up path loops straight away as before.
        if (cursor >= target) {
          const nextMs = Math.min(cycleStartMs + opts.intervalSec * 1000, endMs);
          await opts.sleep(Math.max(0, nextMs - opts.now()));
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
