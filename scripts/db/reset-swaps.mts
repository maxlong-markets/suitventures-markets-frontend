/**
 * Empties market.swaps and rewinds .seed/checkpoint.json to redo the seed's swaps phase (phase "swaps", ranges
 * cleared, "swaps" dropped from done, startedAt kept), only when that file exists. Refuses first if a seed
 * process is still running (.seed/seed.lock names a live pid) — truncating under it would be silently undone by
 * the seed's next checkpoint save (retention-review.md finding I1). Prints the row count before and after and
 * the checkpoint phase. Run: npm run db:reset-swaps
 */
import { createDb } from "@/lib/db/client";
import { assertNoLiveSeed, resetSwapCheckpoint, truncateSwaps } from "@/lib/seed/reset";

const SEED_DIR = ".seed";
const CHECKPOINT = `${SEED_DIR}/checkpoint.json`;

await assertNoLiveSeed(SEED_DIR);

const url = process.env.DATABASE_URL_DIRECT;
if (!url) {
  console.error("DATABASE_URL_DIRECT is not set (see .env.example)");
  process.exit(1);
}
const db = createDb(url, { max: 1 });
try {
  const { before, after } = await truncateSwaps(db);
  console.log(`market.swaps: ${before} -> ${after}`);
  const cp = await resetSwapCheckpoint(CHECKPOINT);
  console.log(cp ? `${CHECKPOINT} phase: ${cp.phase}` : `${CHECKPOINT} not found; nothing to rewind`);
} finally {
  await db.end();
}
