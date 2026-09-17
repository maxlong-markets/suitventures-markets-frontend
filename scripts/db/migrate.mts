/** Applies supabase/migrations to the database in DATABASE_URL_DIRECT. Run: npm run db:migrate */
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";

const url = process.env.DATABASE_URL_DIRECT;
if (!url) {
  console.error("DATABASE_URL_DIRECT is not set (see .env.example)");
  process.exit(1);
}
const db = createDb(url, { max: 1 });
try {
  const applied = await migrate(db);
  console.log(applied.length ? `applied ${applied.join(", ")}` : "nothing to apply");
} finally {
  await db.end();
}
