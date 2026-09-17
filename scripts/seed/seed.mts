import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createDb } from "@/lib/db/client";
import { newCheckpoint, runSeed, type Checkpoint } from "@/lib/seed/seed";
import { createEnvioSource } from "@/lib/sync/envioSource";
import { createLimiter } from "@/lib/sync/limiter";

const CHECKPOINT = ".seed/checkpoint.json"; // git-ignored; starting over: see scripts/README.md
const CHECKPOINT_TMP = `${CHECKPOINT}.tmp`;
const url = process.env.DATABASE_URL_DIRECT;
if (!url) {
  console.error("DATABASE_URL_DIRECT is not set in .env.local");
  process.exit(1);
}

/** Only the message travels to the log, never the error object. */
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

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

const db = createDb(url, { max: 4 });
const source = createEnvioSource({ limiter: createLimiter(200) });
try {
  const cp = await runSeed(db, source, {
    checkpoint: await loadCheckpoint(),
    save: async (c) => {
      await mkdir(".seed", { recursive: true });
      // Written next to the file and renamed over it, so a kill mid-write can never leave a truncated checkpoint.
      await writeFile(CHECKPOINT_TMP, JSON.stringify(c, null, 2));
      await rename(CHECKPOINT_TMP, CHECKPOINT);
    },
    workers: 3,
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
}
