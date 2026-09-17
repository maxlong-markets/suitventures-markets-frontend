import type { Db } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { createPgliteDb } from "@/lib/db/pglite";

/** A fresh PGlite with all migrations applied. Call in beforeAll / beforeEach; `await db.end()` in afterAll. */
export async function testDb(): Promise<Db> {
  const db = await createPgliteDb();
  await migrate(db);
  return db;
}
