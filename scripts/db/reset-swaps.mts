/**
 * Empties market.swaps and rewinds .seed/checkpoint.json to redo the seed's swaps phase (phase "swaps", ranges
 * cleared, "swaps" dropped from done, startedAt kept), only when that file exists. Prints the row count before
 * and after and the checkpoint phase. Run: npm run db:reset-swaps
 */
import { createDb } from "@/lib/db/client";
import { resetSwapCheckpoint, truncateSwaps } from "@/lib/seed/reset";

const CHECKPOINT = ".seed/checkpoint.json";

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
