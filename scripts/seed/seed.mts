import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createDb } from "../../src/lib/db/client";
import { newCheckpoint, runSeed, type Checkpoint } from "../../src/lib/seed/seed";
import { createEnvioSource } from "../../src/lib/sync/envioSource";
import { createLimiter } from "../../src/lib/sync/limiter";

const CHECKPOINT = ".seed/checkpoint.json"; // git-ignored; delete it to start over
const url = process.env.DATABASE_URL_DIRECT;
if (!url) {
  console.error("DATABASE_URL_DIRECT is not set in .env.local");
  process.exit(1);
}

async function loadCheckpoint(): Promise<Checkpoint> {
  try {
    const cp = JSON.parse(await readFile(CHECKPOINT, "utf8")) as Checkpoint;
    console.log(`resuming: phase ${cp.phase}, done ${cp.done.join(",") || "-"}`);
    return cp;
  } catch {
    return newCheckpoint(Math.floor(Date.now() / 1000));
  }
}

const db = createDb(url, { max: 4 });
const source = createEnvioSource({ limiter: createLimiter(200) });
try {
  const cp = await runSeed(db, source, {
    checkpoint: await loadCheckpoint(),
    save: async (c) => {
      await mkdir(".seed", { recursive: true });
      await writeFile(CHECKPOINT, JSON.stringify(c, null, 2));
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
