/**
 * Seeds the `chain` job's cursor and replays the chain forward until the in-house reader has caught
 * up (Task 7, .superpowers/sdd/2026-09-21-chain-reader/task-7-brief.md). This is what makes the
 * cutover possible: runChainSync (Task 6) deliberately refuses to run from a cursor of 0, and the
 * store today has nothing since 18 Sep 2026 16:20 UTC — this script finds the right starting block,
 * clears the stale candle buckets it is about to rebuild from the events themselves, seeds the
 * cursor, then runs the same runChainSync the cron uses (stopWhenCaughtUp: true) until it has no more
 * work.
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
 * t >= --from-ts so the replay can rebuild each bucket exactly from the events, but a restart that
 * deleted them again would erase buckets the previous run already rebuilt (their trades are not
 * replayed a second time, since the cursor resumes past them). It is guarded: skipped whenever the
 * stored cursor is already at or past the found start block, unless --force-rewind says to redo it.
 *
 * --dry-run performs no writes at all (fix round 1, task-7-report.md — the first version of this
 * script deleted candles and seeded the cursor for real even under --dry-run, which is exactly what a
 * dry run must never do): it finds the start block, COUNTS the candles a real run would delete instead
 * of deleting them, and computes what seedCursor would do instead of calling it for real, then exits.
 * A self-check re-reads the cursor and the candle count right before exiting and throws if either
 * changed, so a regression here fails loudly rather than silently mutating a live database.
 *
 * Run: npm run chain:catchup -- --from-ts <unix> [--force-rewind] [--max-span <n>] [--max-requests <n>] [--dry-run]
 *      npm run chain:catchup -- --release-lease
 *   --from-ts <unix>     Required (unless --release-lease). Replay starts at the first block at or
 *                        after this unix timestamp.
 *   --force-rewind       Also seed the cursor backwards if it is already past the found start block,
 *                        and redo the candle delete even on a restart. Only for a deliberate re-run.
 *   --max-span <n>       Widest block span asked per HyperSync request. Default 20_000 (comfortably
 *                        above the ~2,000-block response cap this measures against in practice, so
 *                        the source's own size cap decides the real per-request span, not this).
 *   --max-requests <n>   Stop after this many HyperSync requests. Default 0, meaning no limit.
 *   --dry-run            Find the start block, report what the candle delete and the cursor seed
 *                        would do, and exit. Writes nothing (see above).
 *   --release-lease      Force-clears the chain job's lease and exits immediately, ignoring every
 *                        other flag. The documented escape hatch for a run that died without
 *                        releasing it itself (a `kill -9`, a host crash — anything the SIGINT/SIGTERM
 *                        handlers below could not catch).
 *
 * Takes the same `chain` lease the cron takes (src/lib/sync/state.ts's acquireLease), so the two can
 * never run at once: if the lease is held, this exits without doing any work rather than racing it.
 * The lease is held for up to leaseSec (below) regardless of how long the run actually takes, since
 * runChainSync acquires it once and never renews it mid-loop.
 *
 * Do NOT run this against the real database — it is for the integrator to run at cutover.
 */
import type { PublicClient } from "viem";
import { findBlockAtOrAfter, seedCursor } from "@/lib/chain/catchup";
import { runChainSync, type ChainRunOpts } from "@/lib/chain/run";
import { readChainCursor } from "@/lib/chain/store";
import type { Db } from "@/lib/db/client";
import { chainDeps } from "@/lib/sync/deps";
import { readState, releaseLease } from "@/lib/sync/state";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isoUtc = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

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

// leaseSec (fix round 1, task-7-report.md): the lease is acquired once for the whole run — run.ts
// never renews it mid-loop — so it has to outlive the run, but it must NOT be able to strand the
// cron forever if this process dies without releasing it (a `kill -9`, a host crash; the
// SIGINT/SIGTERM handlers below cover a deliberate stop, not those). A measured run takes two to
// four hours; six hours is comfortable margin above that while bounding the worst case to six hours
// of a stranded chain job, not the year the first version of this script used. --release-lease
// clears it sooner by hand.
const CATCHUP_LEASE_SEC = 21_600;

const DEFAULT_MAX_SPAN = 20_000;

type Args =
  | { releaseLease: true }
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
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  if (releaseLeaseFlag) return { releaseLease: true };
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

/** Read-only twin of deleteStaleCandles, for --dry-run's report and its own after-the-fact self-check. */
async function countStaleCandles(db: Db, fromTs: number): Promise<number> {
  const [row] = await db.query<{ n: unknown }>("select count(*) as n from market.candles where t >= $1::int", [fromTs]);
  return Number(row?.n ?? 0);
}

/** --release-lease: force-clears the chain job's lease regardless of who (or what, or nothing) currently holds it, and prints what it cleared. */
async function releaseLeaseCommand(db: Db): Promise<void> {
  const before = await readState(db, CHAIN_JOB);
  await db.query("update market.sync_state set lease_until = 0, lease_owner = null where job = $1", [CHAIN_JOB]);
  if (!before.leaseOwner && before.leaseUntil === 0) {
    console.log("[chain:catchup] --release-lease: the chain lease was already clear; nothing to do.");
    return;
  }
  console.log(
    `[chain:catchup] --release-lease: cleared the chain lease (was held by ${before.leaseOwner ?? "(unknown owner)"}, ` +
      `lease_until ${before.leaseUntil} / ${isoUtc(before.leaseUntil)}).`,
  );
}

const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143 } as const;

/**
 * A deliberate stop (Ctrl-C, SIGTERM) must release the chain lease itself: runChainSync's own
 * try/finally only runs on a normal return or a thrown JS error, never on a raw, unhandled
 * SIGINT/SIGTERM — Node's default there kills the process immediately, before any pending finally can
 * run (fix round 1, task-7-report.md). These handlers replace that default: they attempt to release
 * the lease — a harmless no-op if this process never held it, since releaseLease's own WHERE clause
 * only matches its own owner string — then exit with the conventional 128+signal code. Installed
 * unconditionally and early (before the lease is ever acquired), since a no-op release is cheap and
 * this way there is no window where a signal is still handled by Node's own default.
 */
function installSignalHandlers(db: Db, owner: string): void {
  for (const signal of Object.keys(SIGNAL_EXIT_CODE) as (keyof typeof SIGNAL_EXIT_CODE)[]) {
    process.on(signal, () => {
      console.error(`[chain:catchup] received ${signal}: releasing the chain lease before exiting.`);
      void releaseLease(db, CHAIN_JOB, owner)
        .catch((err) => console.error(`[chain:catchup] failed to release the chain lease: ${message(err)}`))
        .finally(() => process.exit(SIGNAL_EXIT_CODE[signal]));
    });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const deps = chainDeps(); // the real HyperSync source, chain client and quote config — exactly as the cron builds them.
  const { db, source } = deps;
  const owner = `catchup-${process.pid}`;
  installSignalHandlers(db, owner);

  try {
    if (args.releaseLease) {
      await releaseLeaseCommand(db);
      return;
    }

    // Step 2: locate the first block at or after --from-ts. head is HyperSync's, the search's own
    // probes go through the chain RPC client's getBlock — chainDeps().client is narrowed to
    // ChainClient (readContract only) for runChainSync's sake, but the object it actually builds
    // (src/lib/sync/deps.ts's chainDeps -> createChainClient) is a full viem PublicClient.
    const rpcClient = deps.client as unknown as Pick<PublicClient, "getBlock">;
    let probes = 0;
    const timestampOf = async (block: number): Promise<number> => {
      probes += 1;
      const b = await rpcClient.getBlock({ blockNumber: BigInt(block) });
      return Number(b.timestamp);
    };

    const head = await source.head();
    const startBlock = await findBlockAtOrAfter(head, timestampOf, args.fromTs);
    const startBlockTs = await timestampOf(startBlock);
    console.log(
      `[chain:catchup] HyperSync head=${head}; first block at or after --from-ts ${args.fromTs} (${isoUtc(args.fromTs)}) ` +
        `is ${startBlock} at ${isoUtc(startBlockTs)} (${probes} probes)`,
    );

    // Shared by both --dry-run and the real run: whether the candle delete (real or reported) would
    // even happen, given the restart guard (module doc comment).
    const priorCursor = await readChainCursor(db);
    const willDelete = args.forceRewind || priorCursor < startBlock;

    if (args.dryRun) {
      let staleCountBefore: number | null = null;
      if (willDelete) {
        staleCountBefore = await countStaleCandles(db, args.fromTs);
        console.log(
          `[chain:catchup] --dry-run: would delete ${staleCountBefore} candle row(s) with t >= ${args.fromTs} (${isoUtc(args.fromTs)})`,
        );
      } else {
        console.log(
          `[chain:catchup] --dry-run: stored cursor ${priorCursor} is already at or past start block ${startBlock}: ` +
            `the candle delete would be skipped (restart guard) unless --force-rewind is given`,
        );
      }

      const would = await seedCursor(db, startBlock - 1, { forceRewind: args.forceRewind, dryRun: true });
      console.log(
        `[chain:catchup] --dry-run: cursor is ${would.from}, would become ${would.to}${would.rewound ? " (a rewind)" : ""}`,
      );

      // Self-check: a dry run must have written nothing. Re-read the same two things and compare —
      // this fails loudly (a thrown error, non-zero exit) rather than silently mutating a live
      // database if a future change to this branch accidentally reintroduces a real write.
      const cursorAfter = await readChainCursor(db);
      if (cursorAfter !== priorCursor) {
        throw new Error(`--dry-run invariant violated: the stored cursor changed from ${priorCursor} to ${cursorAfter}`);
      }
      if (staleCountBefore !== null) {
        const staleCountAfter = await countStaleCandles(db, args.fromTs);
        if (staleCountAfter !== staleCountBefore) {
          throw new Error(`--dry-run invariant violated: the candle count changed from ${staleCountBefore} to ${staleCountAfter}`);
        }
      }
      console.log("[chain:catchup] --dry-run: confirmed nothing was written. Exiting.");
      return;
    }

    // Step 3, for real: clear stale candles so the replay rebuilds them exactly from the events.
    if (willDelete) {
      const deleted = await deleteStaleCandles(db, args.fromTs);
      console.log(`[chain:catchup] deleted ${deleted} candle row(s) with t >= ${args.fromTs} (${isoUtc(args.fromTs)})`);
    } else {
      console.log(
        `[chain:catchup] stored cursor ${priorCursor} is already at or past start block ${startBlock}: ` +
          `this looks like a restart, so the candle delete is skipped (use --force-rewind to redo it anyway).`,
      );
    }

    // Step 4.
    const seeded = await seedCursor(db, startBlock - 1, { forceRewind: args.forceRewind });
    console.log(`[chain:catchup] cursor ${seeded.from} -> ${seeded.to}${seeded.rewound ? " (rewound)" : ""}`);

    // Step 5: replay forward with the cron's own runner until it reports caught up.
    const startedAtMs = Date.now();
    const startCursor = seeded.to;
    let cumEvents = 0;
    let cumTrades = 0;

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
    if (report.error) {
      console.error(`[chain:catchup] finished with an error: ${report.error}`);
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
