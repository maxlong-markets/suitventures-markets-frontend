import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Db } from "./client";

export const MIGRATIONS_DIR = "supabase/migrations";

/** Created before the table is read, so the first migration's own `create … if not exists` statements are no-ops. */
const BOOTSTRAP = `
create schema if not exists market;
create table if not exists market.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);`;

/** Creates schema and schema_migrations if missing, applies every *.sql in `dir` (default MIGRATIONS_DIR under process.cwd()) not yet recorded, in filename order, each inside one transaction, recording its name. Returns the names applied this run. */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const root = resolve(process.cwd(), dir);
  await db.exec(BOOTSTRAP);
  const done = new Set((await db.query<{ name: string }>("select name from market.schema_migrations")).map((r) => r.name));
  const files = (await readdir(root)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const sql = await readFile(join(root, name), "utf8");
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query("insert into market.schema_migrations (name) values ($1)", [name]);
    });
    applied.push(name);
  }
  return applied;
}
