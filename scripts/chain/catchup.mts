/**
 * Seeds the `chain` job's cursor and replays the chain forward until the in-house reader has caught
 * up (Task 7, .superpowers/sdd/2026-09-21-chain-reader/task-7-brief.md). This is what makes the
 * cutover possible: runChainSync (Task 6) deliberately refuses to run from a cursor of 0, and the
 * store today has nothing since 18 Sep 2026 16:20 UTC — this script finds the right starting block,
 * clears the stale candle buckets it is about to rebuild from the events themselves, seeds the
 * cursor, then runs the same runChainSync the cron uses (stopWhenCaughtUp: true) until it has no more
 * work.
 *
 * Companion script: `gapfill-candles.mts` backfills h1/d1 candles this script's replay never covers
 * (pools the paused Envio copy never reached). Run the gap-fill FIRST, with `--before` at or below
 * this script's floored `--from-ts` (below) — never above it. A bucket the gap-fill writes above that
 * line is one this replay will fold trades onto a second time (the fold adds to what it loads), so
 * running the gap-fill after, or with a later `--before`, double-counts. Both scripts take the same
 * `chain` lease specifically so they (and the cron) can never overlap; the ordering constraint is a
 * sequencing rule the lease alone does not enforce (stopping the catch-up, running the gap-fill, then
 * resuming is exactly the sequence that needs it).
 *
 * Sizing (measured 21 Sep 2026): about 2,000 blocks and 7,500 events per HyperSync request, roughly
 * 3.7 s each. A catch-up from 17 Sep 2026 00:00 UTC is about 4.1 million blocks in roughly 2,000
 * requests — at that per-request time the wall clock (a couple of hours) is dominated by request
 * latency, not by HyperSync's rate limit.
 *
 * Safe to stop with Ctrl-C and restart: runChainSync only ever advances the stored cursor inside a
 * transaction committed with that cycle's rows (applyFold, Task 6), so a killed process leaves no
 * partial cycle behind, and seedCursor's resume rule (raises a 0 or lower cursor, never lowers one
 * without --force-rewind) means a restart with the same --from-ts continues from wherever the
 * previous run actually got to. SIGINT/SIGTERM are handled explicitly (below) so a deliberate stop
 * also releases the chain lease — Node does not run a pending `finally` on a raw, unhandled SIGINT,
 * so without this a Ctrl-C could strand the lease same as a hard kill.
 *
 * The one step that is NOT idempotent on its own is the candle delete: it removes every candle with
 * t >= the floored --from-ts so the replay can rebuild each bucket exactly from the events, but a
 * restart that deleted them again would erase buckets the previous run already rebuilt (their trades
 * are not replayed a second time, since the cursor resumes past them). It is guarded: skipped whenever
 * the stored cursor is already at or past the found start block, unless --force-rewind says to redo it.
 *
 * --dry-run performs no write that changes anything (review round 2, NIT 13 — `readChainCursor` does
 * issue `insert … on conflict (job) do nothing` through `ensureRow`, a genuine no-op on an existing
 * row, invisible to the self-check below): it finds the start block, COUNTS the candles a real run
 * would delete instead of deleting them, and computes what seedCursor would do instead of calling it
 * for real, then exits. A self-check re-reads the cursor and the candle count right before exiting and
 * throws if either changed, so a regression here fails loudly rather than silently mutating a live
 * database.
 *
 * Review round 2 (task-7-report.md, "Fix round 2") added the safety checks below `--from-ts` now goes
 * through before anything destructive happens: it is floored to the UTC midnight at or before it (a
 * bucket boundary for m1/m5/m15/h1/d1 all at once, so no straddling bucket survives the delete to be
 * folded onto a second time), refused if in the future, refused if earlier than the stored data can
 * rebuild, refused if the block search could not actually find a matching block (findBlockAtOrAfter's
 * "not found" answer and a legitimate one share a return value), and refused if seeding the cursor
 * would leave it at 0. The exact candle count about to be deleted and the floored start block are both
 * printed before the delete, not just under --dry-run.
 *
 * Review round 3 made the lower bound absolute and durable. It is `earliestRebuildableFromTs`
 * (`src/lib/chain/catchup.ts`): the earliest `baseline_at` across `market.pools` that is greater than
 * 0, floored to its own UTC midnight — filtered to `> 0` because `baseline_at` defaults to 0 and the
 * chain reader itself creates every new pool with that default, so an unfiltered `min()` degrades to 0
 * (an unbounded start!) the moment the very first `Initialize` event is replayed; filtering to real
 * baselines reads the one value that never moves, the snapshot copy's own `synced_at`. If NO pool
 * carries a real baseline, this refuses to run rather than fall back to an unbounded start.
 *
 * That bound is now absolute: NO flag on this command line can start earlier than it, --force-rewind
 * included. --force-rewind keeps only its other two meanings — lowering an already-advanced stored
 * cursor, and redoing the candle delete on a restart — and is still checked against the floor like any
 * other run. A genuine full rebuild from the chain's start is a real, if rare, need: it is roughly a
 * ten-hour replay (the chain's whole history, not the ~4.1M blocks since 17 Sep) that deletes daily
 * candle history back to June, which the five-day trade window cannot rebuild — only a full replay can
 * regenerate it, the gap-fill cannot, since it only ever reads from market.swaps. That operation is
 * deliberately not reachable from the command line at all: doing it requires editing this script (temporarily
 * changing or removing the bound check below) so it can never be one mistyped date away from a routine
 * re-run.
 *
 * Run: npm run chain:catchup -- --from-ts <unix> [--force-rewind] [--max-span <n>] [--max-requests <n>] [--dry-run]
 *      npm run chain:catchup -- --release-lease [--yes]
 *   --from-ts <unix>     Required (unless --release-lease). Floored to the UTC midnight at or before
 *                        it; replay starts at the first block at or after that floored timestamp.
 *                        Never accepted earlier than the earliest real pool baseline — see above; no
 *                        flag on this command line lifts that.
 *   --force-rewind       Also seed the cursor backwards if it is already past the found start block,
 *                        and redo the candle delete even on a restart. Only for a deliberate re-run —
 *                        does NOT affect the lower bound above.
 *   --max-span <n>       Widest block span asked per HyperSync request. Default 20_000 (comfortably
 *                        above the ~2,000-block response cap this measures against in practice, so
 *                        the source's own size cap decides the real per-request span, not this).
 *   --max-requests <n>   Stop after this many HyperSync requests. Default 0, meaning no limit.
 *   --dry-run            Find the start block, report what the candle delete and the cursor seed
 *                        would do, and exit. Writes nothing that changes anything (see above).
 *   --release-lease      Prints who holds the chain lease and until when, and exits — or, if it is not
 *                        currently live, clears it right away. Add --yes to force-clear a LIVE lease;
 *                        without it, a live lease is left alone (running this during a healthy
 *                        catch-up would hand the job to the very next cron tick otherwise). Ignores
 *                        every other flag.
 *   --yes                Only meaningful with --release-lease (above); required to clear a live lease.
 *                        Refused if given without --release-lease, since it would otherwise silently
 *                        do nothing and read like it confirmed something.
 *
 * Takes the same `chain` lease the cron takes (src/lib/sync/state.ts's acquireLease), so the two can
 * never run at once: if the lease is held, this exits without doing any destructive work rather than
 * racing it. The lease is renewed periodically from inside the replay loop (renewLease, roughly once a
 * minute) so a run past leaseSec is not silently overtaken by the cron mid-flight — if a renewal ever
 * finds the lease no longer belongs to this process, the run stops immediately rather than keep
 * writing blind.
 *
 * Do NOT run this against the real database — it is for the integrator to run at cutover.
 */
import type { PublicClient } from "viem";
import { earliestRebuildableFromTs, findBlockAtOrAfter, flooredToUtcMidnight, seedCursor } from "@/lib/chain/catchup";
import { runChainSync, type ChainRunOpts } from "@/lib/chain/run";
import { readChainCursor } from "@/lib/chain/store";
import { createDb, type Db } from "@/lib/db/client";
import { chainDeps } from "@/lib/sync/deps";
import { readState, releaseLease, renewLease } from "@/lib/sync/state";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isoUtc = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();
const nowSec = () => Math.floor(Date.now() / 1000);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** market.sync_state job name; matches src/lib/chain/run.ts's, src/lib/chain/store.ts's and src/lib/chain/catchup.ts's own copies of the same constant. */
const CHAIN_JOB = "chain";

// windowSec: effectively unbounded — stopWhenCaughtUp and --max-requests are the real stop
// conditions for the fetch/fold loop, not the window. Kept far below Number.MAX_SAFE_INTEGER so
// windowSec * 1000 and now() + it never approach unsafe-integer arithmetic.
const LONG_WINDOW_SEC = 60 * 60 * 24 * 365;

// leaseSec: the lease is acquired once (run.ts never renews it internally) but IS renewed
// periodically from this script's own onCycle (below), so this is a starting grant and a worst-case
// bound, not the run's real time limit. A measured run takes two to four hours; six hours is
// comfortable margin above that while bounding how long a run that dies WITHOUT renewing again (a
// `kill -9`, a host crash — the SIGINT/SIGTERM handlers below cover a deliberate stop, not those) can
// still strand the chain job. --release-lease clears it sooner by hand.
const CATCHUP_LEASE_SEC = 21_600;

// How often onCycle renews the lease (review round 2, finding 4: "say once a minute").
const LEASE_RENEW_INTERVAL_MS = 60_000;

// How long a signal handler waits for releaseLease before exiting anyway (review round 2, MINOR 10):
// an unreachable database must not turn Ctrl-C into "nothing happens."
const SIGNAL_RELEASE_TIMEOUT_MS = 5_000;

const DEFAULT_MAX_SPAN = 20_000;

type Args =
  | { releaseLease: true; yes: boolean }
  | { releaseLease: false; fromTs: number; forceRewind: boolean; maxSpan: number; maxRequests: number; dryRun: boolean };

function parseIntArg(flag: string, raw: string | undefined): number {
  if (raw === undefined) fail(`${flag} needs a value`);
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) fail(`${flag} must be an integer, got ${JSON.stringify(raw)}`);
  return n;
}

function parseArgs(argv: readonly string[]): Args {
  let fromTs: number | undefined;
  let forceRewind = false;
  let maxSpan = DEFAULT_MAX_SPAN;
  let maxRequests = 0;
  let dryRun = false;
  let releaseLeaseFlag = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--from-ts":
        fromTs = parseIntArg("--from-ts", argv[++i]);
        break;
      case "--force-rewind":
        forceRewind = true;
        break;
      case "--max-span":
        maxSpan = parseIntArg("--max-span", argv[++i]);
        if (maxSpan <= 0) fail("--max-span must be positive");
        break;
      case "--max-requests":
        maxRequests = parseIntArg("--max-requests", argv[++i]);
        if (maxRequests < 0) fail("--max-requests must be 0 (no limit) or positive");
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--release-lease":
        releaseLeaseFlag = true;
        break;
      case "--yes":
        yes = true;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  if (releaseLeaseFlag) return { releaseLease: true, yes };
  // Review round 3, small fix: --yes has no effect at all outside --release-lease — silently dropping
  // it reads like it confirmed something (e.g. "--from-ts X --yes" looks like a green light).
  if (yes) fail("--yes is only meaningful together with --release-lease");
  if (fromTs === undefined) fail("--from-ts <unix> is required (or pass --release-lease on its own)");
  return { releaseLease: false, fromTs, forceRewind, maxSpan, maxRequests, dryRun };
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

const DELETE_BATCH = 5000;

/**
 * Deletes market.candles rows with t >= fromTs, DELETE_BATCH rows at a time (never one unbounded
 * statement: this table can hold far more matching rows than the HyperSync-bounded replay that
 * rebuilds them). Returns the total removed.
 */
async function deleteStaleCandles(db: Db, fromTs: number): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await db.query<{ pool_id: string }>(
      `delete from market.candles
       where ctid in (select ctid from market.candles where t >= $1::int limit $2::int)
       returning pool_id`,
      [fromTs, DELETE_BATCH],
    );
    total += rows.length;
    if (rows.length > 0) console.log(`[chain:catchup] deleting stale candles: ${total} so far…`);
    if (rows.length < DELETE_BATCH) break;
  }
  return total;
}

/** Read-only twin of deleteStaleCandles, for the printed count before any delete and the dry-run self-check. */
async function countStaleCandles(db: Db, fromTs: number): Promise<number> {
  const [row] = await db.query<{ n: unknown }>("select count(*) as n from market.candles where t >= $1::int", [fromTs]);
  return Number(row?.n ?? 0);
}

/**
 * --release-lease: prints the current holder and expiry and changes nothing when the lease is live
 * and --yes was not given (review round 2, finding 5 — the previous version force-cleared
 * unconditionally, which would hand a healthy catch-up's lease to the very next cron tick). An
 * expired or already-empty lease is always cleared, --yes or not: there is nothing live to protect.
 *
 * Review round 3, small fix: on the non---yes path the clearing UPDATE is now conditioned on
 * `lease_until < now` at write time, not unconditional — closing the (millisecond-wide, but real)
 * TOCTOU between the `readState` above and the write, where a lease acquired in that gap would
 * otherwise have been cleared anyway despite --yes never being given. --yes still clears
 * unconditionally, live or not: that IS its purpose.
 */
async function releaseLeaseCommand(db: Db, yes: boolean): Promise<void> {
  const before = await readState(db, CHAIN_JOB);
  const now = nowSec();
  const isLive = before.leaseUntil > now;

  if (isLive && !yes) {
    console.log(
      `[chain:catchup] --release-lease: the chain lease is LIVE, held by ${before.leaseOwner ?? "(unknown owner)"}, ` +
        `due until ${isoUtc(before.leaseUntil)} / ${before.leaseUntil} (${before.leaseUntil - now}s from now). ` +
        "Refusing to clear it without --yes — a healthy catch-up or the cron may be mid-run. " +
        "Re-run with --yes only if you are certain the process holding it is dead.",
    );
    return;
  }

  const rows = yes
    ? await db.query("update market.sync_state set lease_until = 0, lease_owner = null where job = $1 returning job", [CHAIN_JOB])
    : await db.query(
        "update market.sync_state set lease_until = 0, lease_owner = null where job = $1 and lease_until < $2::int returning job",
        [CHAIN_JOB, nowSec()],
      );

  if (rows.length === 0) {
    console.log(
      "[chain:catchup] --release-lease: the lease became live between checking it and clearing it — nothing was changed. Re-run to see its new state.",
    );
    return;
  }
  if (!before.leaseOwner && before.leaseUntil === 0) {
    console.log("[chain:catchup] --release-lease: the chain lease was already clear; nothing to do.");
    return;
  }
  console.log(
    `[chain:catchup] --release-lease: cleared the chain lease (was held by ${before.leaseOwner ?? "(unknown owner)"}, ` +
      `lease_until ${before.leaseUntil} / ${isoUtc(before.leaseUntil)}${isLive ? ", which was still LIVE (--yes given)" : ""}).`,
  );
}

const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143 } as const;

/**
 * A deliberate stop (Ctrl-C, SIGTERM) must release the chain lease itself: runChainSync's own
 * try/finally only runs on a normal return or a thrown JS error, never on a raw, unhandled
 * SIGINT/SIGTERM — Node's default there kills the process immediately, before any pending finally can
 * run. These handlers replace that default: they race releasing the lease against a
 * SIGNAL_RELEASE_TIMEOUT_MS timer and exit with the conventional 128+signal code regardless of which
 * one finishes first (review round 2, MINOR 10 — an unreachable database, often exactly why someone
 * is hitting Ctrl-C, must not hang the release and leave `process.exit` never called; a harmless no-op
 * either way if this process never held the lease, since releaseLease's own WHERE clause only matches
 * its own owner string). Installed unconditionally and early, before the lease is ever acquired, so
 * there is no window where a signal still falls through to Node's default behavior.
 */
function installSignalHandlers(db: Db, owner: string): void {
  for (const signal of Object.keys(SIGNAL_EXIT_CODE) as (keyof typeof SIGNAL_EXIT_CODE)[]) {
    process.on(signal, () => {
      console.error(`[chain:catchup] received ${signal}: releasing the chain lease (up to ${SIGNAL_RELEASE_TIMEOUT_MS}ms) before exiting.`);
      const release = releaseLease(db, CHAIN_JOB, owner).catch((err) => {
        console.error(`[chain:catchup] failed to release the chain lease: ${message(err)}`);
      });
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, SIGNAL_RELEASE_TIMEOUT_MS));
      void Promise.race([release, timeout]).finally(() => process.exit(SIGNAL_EXIT_CODE[signal]));
    });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const deps = chainDeps(); // the real HyperSync source, chain client and quote config — exactly as the cron builds them.
  const { source } = deps;

  // Final review MAJOR: this is a multi-hour bulk job (2-4 hours measured), not the cron's 300 s invocation
  // chainDeps() is built for. deps.db is the process singleton over DATABASE_URL, the transaction-mode pooler
  // (port 6543) that enforces a two-minute statement_timeout and is not meant to hold one logical session for
  // hours. Build a dedicated connection instead, exactly like gapfill-candles.mts's own DATABASE_URL_DIRECT
  // (session port 5432, one connection: max 1) — falling back to DATABASE_URL, with a printed warning, only
  // when DATABASE_URL_DIRECT is absent (chainDeps() above already needed DATABASE_URL to succeed at all, so
  // that fallback can only be reached when it is in fact set). chainDeps() stays the source of
  // source/client/quotes below; only the Db this script reads and writes through changes.
  const directUrl = process.env.DATABASE_URL_DIRECT;
  if (!directUrl) {
    console.warn(
      "[chain:catchup] DATABASE_URL_DIRECT is not set; falling back to DATABASE_URL (the pooler). A multi-hour " +
        "run on the pooler risks its two-minute statement_timeout. Set DATABASE_URL_DIRECT (see .env.example) to avoid this.",
    );
  }
  const url = directUrl ?? process.env.DATABASE_URL;
  if (!url) fail("neither DATABASE_URL_DIRECT nor DATABASE_URL is set (see .env.example).");
  const db = createDb(url, { max: 1 });

  const owner = `catchup-${process.pid}`;
  installSignalHandlers(db, owner);

  try {
    if (args.releaseLease) {
      await releaseLeaseCommand(db, args.yes);
      return;
    }

    // Review round 2, finding 3 (part): a --from-ts in the future is refused up front, against the
    // RAW value and wall-clock time — before flooring, which could otherwise mask "a few hours from
    // now, same UTC day" as a past midnight.
    if (args.fromTs > nowSec()) {
      fail(`--from-ts ${args.fromTs} (${isoUtc(args.fromTs)}) is in the future (now is ${nowSec()} / ${isoUtc(nowSec())}).`);
    }

    // Review round 2, findings 1+2: floor to the UTC midnight at or before --from-ts, and use that
    // floored value for everything from here on — the search, the delete, every message.
    const flooredFromTs = flooredToUtcMidnight(args.fromTs);
    if (flooredFromTs !== args.fromTs) {
      console.log(`[chain:catchup] --from-ts ${args.fromTs} (${isoUtc(args.fromTs)}) floored to the UTC midnight at or before it: ${flooredFromTs} (${isoUtc(flooredFromTs)})`);
    }

    // Review round 3: the lower bound is now absolute — no flag on this command line bypasses it (see
    // the header comment). earliestRebuildableFromTs filters to baseline_at > 0 so the bound cannot
    // decay to 0 once the catch-up's own first cycle creates a pool (which defaults to baseline_at 0).
    // A null result (no pool carries a real baseline at all) refuses too, rather than falling back to
    // an unbounded start.
    const earliestFromTs = await earliestRebuildableFromTs(db);
    if (earliestFromTs === null) {
      fail(
        "no pool in market.pools carries a real baseline_at (every value is 0, or the table is empty) — there is nothing to bound " +
          "--from-ts against. Refusing to run without a lower bound rather than allow an unbounded start.",
      );
    }
    if (flooredFromTs < earliestFromTs) {
      fail(
        `--from-ts floors to ${isoUtc(flooredFromTs)} (${flooredFromTs}), which is earlier than the earliest data this build can ` +
          `rebuild, ${isoUtc(earliestFromTs)} (${earliestFromTs}, floored from the earliest pool's real baseline_at). Candle history ` +
          "before that cannot be rebuilt from trades or replayed, and no flag on this command line lifts this bound — see the header " +
          "comment for what a genuine full rebuild requires.",
      );
    }

    // Step 2: locate the first block at or after the floored --from-ts. head is HyperSync's, the
    // search's own probes go through the chain RPC client's getBlock — chainDeps().client is narrowed
    // to ChainClient (readContract only) for runChainSync's sake, but the object it actually builds
    // (src/lib/sync/deps.ts's chainDeps -> createChainClient) is a full viem PublicClient.
    const rpcClient = deps.client as unknown as Pick<PublicClient, "getBlock">;
    let probes = 0;
    const timestampOf = async (block: number): Promise<number> => {
      probes += 1;
      const b = await rpcClient.getBlock({ blockNumber: BigInt(block) });
      return Number(b.timestamp);
    };

    const head = await source.head();
    const startBlock = await findBlockAtOrAfter(head, timestampOf, flooredFromTs);
    const startBlockTs = await timestampOf(startBlock);
    console.log(
      `[chain:catchup] HyperSync head=${head}; first block at or after ${flooredFromTs} (${isoUtc(flooredFromTs)}) ` +
        `is ${startBlock} at ${isoUtc(startBlockTs)} (${probes} probes)`,
    );

    // Review round 2, finding 3: findBlockAtOrAfter returns `head` both when it found a real match at
    // the head AND when nothing matched at all ("every block is older than ts") — the two are the
    // same return value. The probed timestamp disambiguates: if it is still below the target, nothing
    // matched, and seeding the cursor from it would silently skip everything from there to the head.
    if (startBlockTs < flooredFromTs) {
      fail(
        `no block at or after ${flooredFromTs} (${isoUtc(flooredFromTs)}) was found — HyperSync's head (block ${head}) has ` +
          `timestamp ${startBlockTs} (${isoUtc(startBlockTs)}), which is still earlier. Nothing to catch up to yet.`,
      );
    }

    // Shared by both --dry-run and the real run: whether the candle delete (real or reported) would
    // even happen, given the restart guard (module doc comment).
    const priorCursor = await readChainCursor(db);
    const willDelete = args.forceRewind || priorCursor < startBlock;

    // Review round 2, finding 1 (iv): know before doing anything destructive whether seeding the
    // cursor would actually take — a dry-run probe of seedCursor itself, not a re-derivation of its
    // rule. `to === 0` is the one outcome that can never be valid once startBlock >= 1 unless nothing
    // was actually written (the exact failure mode the blocker described: the table emptied, and
    // runChainSync then refuses to start from an uninitialised cursor).
    const wouldSeed = await seedCursor(db, startBlock - 1, { forceRewind: args.forceRewind, dryRun: true });
    if (wouldSeed.to === 0) {
      fail(
        `seeding the cursor to ${startBlock - 1} would leave it at 0 (from ${wouldSeed.from}) — runChainSync refuses to start from an ` +
          "uninitialised cursor. Refusing before touching any candles.",
      );
    }

    // Review round 2, finding 1: print what the delete WOULD remove, and the floored start block,
    // before deleting anything — true under --dry-run (which never deletes) and now also true for a
    // real run (which used to delete first and only find out afterwards whether it could even proceed).
    let staleCountBefore: number | null = null;
    if (willDelete) {
      staleCountBefore = await countStaleCandles(db, flooredFromTs);
      console.log(
        `[chain:catchup] ${args.dryRun ? "would delete" : "will delete"} ${staleCountBefore} candle row(s) with t >= ${flooredFromTs} (${isoUtc(flooredFromTs)})`,
      );
    } else {
      console.log(
        `[chain:catchup] stored cursor ${priorCursor} is already at or past start block ${startBlock}: this looks like a restart, ` +
          `so the candle delete ${args.dryRun ? "would be" : "is"} skipped (use --force-rewind to redo it anyway).`,
      );
    }
    console.log(`[chain:catchup] ${args.dryRun ? "would seed" : "seeding"} cursor: ${wouldSeed.from} -> ${wouldSeed.to}${wouldSeed.rewound ? " (a rewind)" : ""}`);

    if (args.dryRun) {
      // Self-check: a dry run must have written nothing that changes anything. Re-read the same two
      // things and compare — this fails loudly (a thrown error, non-zero exit) rather than silently
      // mutating a live database if a future change to this branch accidentally reintroduces a write.
      const cursorAfter = await readChainCursor(db);
      if (cursorAfter !== priorCursor) {
        throw new Error(`--dry-run invariant violated: the stored cursor changed from ${priorCursor} to ${cursorAfter}`);
      }
      if (staleCountBefore !== null) {
        const staleCountAfter = await countStaleCandles(db, flooredFromTs);
        if (staleCountAfter !== staleCountBefore) {
          throw new Error(`--dry-run invariant violated: the candle count changed from ${staleCountBefore} to ${staleCountAfter}`);
        }
      }
      console.log("[chain:catchup] --dry-run: confirmed nothing was written. Exiting.");
      return;
    }

    // Review round 2, MINOR 7: check the lease is free before doing anything destructive, rather than
    // deleting candles and seeding the cursor only to discover at step 5 that the cron (or another
    // run) already holds it. Not airtight on its own (the lease can still be taken in the gap between
    // this check and runChainSync's own acquire) — that race is what the renewal loop below and
    // runChainSync's own lease semantics still guard against — but it closes the common case cheaply
    // and avoids the order of failure being "destroy data, then find out."
    const leaseState = await readState(db, CHAIN_JOB);
    if (leaseState.leaseUntil > nowSec()) {
      throw new Error(
        `the chain lease is currently held by ${leaseState.leaseOwner ?? "(unknown owner)"} until ${isoUtc(leaseState.leaseUntil)}; ` +
          "refusing to delete candles or seed the cursor until it is free (see --release-lease).",
      );
    }

    // Step 3, for real: clear stale candles so the replay rebuilds them exactly from the events.
    if (willDelete) {
      const deleted = await deleteStaleCandles(db, flooredFromTs);
      console.log(`[chain:catchup] deleted ${deleted} candle row(s) with t >= ${flooredFromTs} (${isoUtc(flooredFromTs)})`);
    }

    // Step 4.
    const seeded = await seedCursor(db, startBlock - 1, { forceRewind: args.forceRewind });
    console.log(`[chain:catchup] cursor ${seeded.from} -> ${seeded.to}${seeded.rewound ? " (rewound)" : ""}`);

    // Step 5: replay forward with the cron's own runner until it reports caught up.
    const startedAtMs = Date.now();
    const startCursor = seeded.to;
    let cumEvents = 0;
    let cumTrades = 0;

    // Review round 2, finding 4: runChainSync acquires the lease once and never renews it, so a run
    // past leaseSec would otherwise be silently overtaken by the cron. Renewed from onCycle instead
    // (see opts.onCycle below), throttled to roughly once a minute.
    let lastRenewalMs: number | null = null;
    let renewalInFlight = false;
    let leaseLost: string | null = null;

    const opts: ChainRunOpts = {
      owner,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      windowSec: LONG_WINDOW_SEC,
      intervalSec: 5,
      leaseSec: CATCHUP_LEASE_SEC,
      maxSpan: args.maxSpan,
      // --max-requests 0 means "no limit" on the CLI, but runChainSync's own loop stops as soon as
      // (source.requests - requestsStart) >= maxRequests — passed through literally, 0 would stop it
      // before it ever issued a single request. Infinity is the actual "no limit" for that comparison.
      maxRequests: args.maxRequests === 0 ? Number.POSITIVE_INFINITY : args.maxRequests,
      stopWhenCaughtUp: true,
      onCycle: (c) => {
        // Thrown synchronously, this lands inside runChainSync's own per-cycle try/catch (run.ts),
        // which records it as report.error and breaks the loop — the only way to stop the loop from
        // here, since onCycle itself is synchronous and its return value is not consulted.
        if (leaseLost) throw new Error(leaseLost);

        cumEvents += c.events;
        cumTrades += c.trades;
        const elapsedSec = (Date.now() - startedAtMs) / 1000;
        const blocksDone = c.cursor - startCursor;
        const blocksPerSec = elapsedSec > 0 ? blocksDone / elapsedSec : 0;
        const behind = c.target - c.cursor;
        const eta = blocksPerSec > 0 ? formatDuration(behind / blocksPerSec) : "unknown";
        console.log(
          `[chain:catchup] cursor=${c.cursor} behind=${behind} blocks/s=${blocksPerSec.toFixed(1)} ` +
            `events=${cumEvents} trades=${cumTrades} requests=${c.requests} eta=${eta}`,
        );

        const cycleMs = Date.now();
        if (!renewalInFlight && (lastRenewalMs === null || cycleMs - lastRenewalMs >= LEASE_RENEW_INTERVAL_MS)) {
          renewalInFlight = true;
          lastRenewalMs = cycleMs;
          void renewLease(db, CHAIN_JOB, owner, nowSec(), CATCHUP_LEASE_SEC)
            .then((ok) => {
              if (!ok) {
                leaseLost = "chain lease renewal failed: another process now holds it. Stopping rather than keep writing.";
                console.error(`[chain:catchup] ${leaseLost}`);
              }
            })
            .catch((err) => {
              // A renewal error is not proof the lease moved on, but there is no way to be sure it
              // did not — fail safe and stop rather than keep writing blind.
              leaseLost = `chain lease renewal errored: ${message(err)}. Stopping rather than keep writing.`;
              console.error(`[chain:catchup] ${leaseLost}`);
            })
            .finally(() => {
              renewalInFlight = false;
            });
        }
      },
    };

    let report;
    try {
      report = await runChainSync(db, deps, opts);
    } catch (err) {
      console.error(`[chain:catchup] failed: ${message(err)}`);
      process.exitCode = 1;
      return;
    }

    if (report.skipped === "lease") {
      console.error(
        "[chain:catchup] skipped: another process already holds the chain lease (the cron, or another catch-up run). " +
          "Nothing was replayed this invocation — retry once it is free, or use --release-lease if you are certain it is stranded.",
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `[chain:catchup] done: cursor=${report.cursor} cycles=${report.cycles} blocks=${report.blocks} events=${report.events} ` +
        `trades=${report.trades} newTokens=${report.newTokens} ignoredPools=${report.ignoredPools} ` +
        `skippedLiquidity=${report.skippedLiquidity} requests=${report.requests}`,
    );

    // Review round 2, MINOR 11: a run cut short by --max-requests (or anything else) used to print the
    // same "done" line as a genuine catch-up and exit 0. Compare against a fresh head so the operator
    // does not have to infer it from cursor/requests by hand.
    try {
      const finalHead = await source.head();
      const behind = finalHead - report.cursor;
      if (behind <= 0) {
        console.log(`[chain:catchup] caught up: cursor ${report.cursor} is at or past the current HyperSync head ${finalHead}.`);
      } else {
        console.log(`[chain:catchup] NOT caught up: still ${behind} block(s) behind head ${finalHead} — re-run the same command to continue.`);
      }
    } catch (err) {
      console.error(`[chain:catchup] could not confirm final catch-up status: ${message(err)}`);
    }

    if (report.error) {
      console.error(`[chain:catchup] finished with an error: ${report.error}`);
      process.exitCode = 1;
    } else if (leaseLost) {
      // Review round 3, small fix: leaseLost is only thrown at the top of the NEXT onCycle (above), so
      // if the loop instead ended for an unrelated reason first — caught up, --max-requests, the
      // window — that throw never happens, report.error stays null, and this would otherwise print
      // "done"/"caught up" and exit 0 despite a renewal having failed or errored somewhere in the run.
      console.error(`[chain:catchup] a lease renewal failed or errored during this run, but the loop ended before that could be recorded: ${leaseLost}`);
      process.exitCode = 1;
    }
  } finally {
    await db.end();
  }
}

try {
  await main();
} catch (err) {
  console.error(`[chain:catchup] failed: ${message(err)}`);
  process.exitCode = 1;
}
