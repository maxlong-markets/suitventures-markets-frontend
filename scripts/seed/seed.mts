import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createDb } from "@/lib/db/client";
import { newCheckpoint, runSeed, type Checkpoint } from "@/lib/seed/seed";
import { createEnvioSource } from "@/lib/sync/envioSource";
import { createLimiter } from "@/lib/sync/limiter";

const SEED_DIR = ".seed"; // git-ignored; starting over: see scripts/README.md
const CHECKPOINT = `${SEED_DIR}/checkpoint.json`;
const CHECKPOINT_TMP = `${CHECKPOINT}.tmp`;
// This process's pid, so db:reset-swaps (assertNoLiveSeed, src/lib/seed/reset.ts) can refuse to truncate
// market.swaps out from under a seed that is still writing to it.
const LOCK = `${SEED_DIR}/seed.lock`;
const url = process.env.DATABASE_URL_DIRECT;
if (!url) {
  console.error("DATABASE_URL_DIRECT is not set in .env.local");
  process.exit(1);
}

/** Only the message travels to the log, never the error object. */
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Idempotent and safe to call more than once (a signal during the normal-exit release races nothing harmful). */
let releasingLock: Promise<void> | null = null;
function releaseLock(): Promise<void> {
  return (releasingLock ??= rm(LOCK, { force: true }));
}

// Signal 0 in reset.ts's assertNoLiveSeed only ever finds this pid alive while the process is actually running, so
// every way out — including a kill — must clear the lock. Node does not run pending try/finally blocks for an
// unhandled SIGTERM/SIGINT, hence the explicit handlers; a normal return or thrown error is covered by the
// try/finally around the run below.
const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143 } as const;
for (const signal of Object.keys(SIGNAL_EXIT_CODE) as (keyof typeof SIGNAL_EXIT_CODE)[]) {
  process.on(signal, () => {
    void releaseLock().finally(() => process.exit(SIGNAL_EXIT_CODE[signal]));
  });
}

await mkdir(SEED_DIR, { recursive: true });
await writeFile(LOCK, String(process.pid));

async function loadCheckpoint(): Promise<Checkpoint> {
  let text: string;
  try {
    text = await readFile(CHECKPOINT, "utf8");
  } catch (err) {
    // Only a missing file is a fresh start: a torn or unreadable checkpoint must never restart the seed onto populated tables.
    if ((err as { code?: unknown } | null)?.code === "ENOENT") return newCheckpoint(Math.floor(Date.now() / 1000));
    console.error(`cannot read ${CHECKPOINT}: ${message(err)}`);
    process.exit(1);
  }
  try {
    const cp = JSON.parse(text) as Checkpoint;
    console.log(`resuming: phase ${cp.phase}, done ${cp.done.join(",") || "-"}`);
    return cp;
  } catch (err) {
    console.error(`${CHECKPOINT} is not a checkpoint: ${message(err)}`);
    process.exit(1);
  }
}

const db = createDb(url, { max: 4 }); // four writers keep up with 16 fetchers: a page copies in well under a second
const source = createEnvioSource({ limiter: createLimiter(200) });
try {
  const cp = await runSeed(db, source, {
    checkpoint: await loadCheckpoint(),
    save: async (c) => {
      await mkdir(SEED_DIR, { recursive: true });
      // Written next to the file and renamed over it, so a kill mid-write can never leave a truncated checkpoint.
      await writeFile(CHECKPOINT_TMP, JSON.stringify(c, null, 2));
      await rename(CHECKPOINT_TMP, CHECKPOINT);
    },
    // The indexer answers at most 1000 rows a page whatever limit is asked and serves parallel pages at the speed of
    // one, so the limiter (200 a minute) is the ceiling and 16 ranges (one per hex digit) keep it busy.
    workers: 16,
    pageLimit: 1000,
    log: (line) => console.log(line),
    now: () => Math.floor(Date.now() / 1000),
  });
  console.log(`seed complete: ${cp.done.join(", ")}`);
  for (const table of ["quotes", "tokens", "pools", "swaps", "candles", "token_balances"]) {
    const [row] = await db.query<{ n: unknown }>(`select count(*) as n from market.${table}`);
    console.log(`${table}: ${Number(row?.n ?? 0)}`);
  }
} finally {
  await db.end();
  await releaseLock();
}
