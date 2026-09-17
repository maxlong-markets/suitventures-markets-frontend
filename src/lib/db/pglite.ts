import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Db } from "./client";
import { csvLine } from "./csv";

/** What PGlite and its Transaction share: one statement with parameters, or several without. */
type Runner = Pick<Transaction, "query" | "exec">;
type Begin = <T>(fn: (db: Db) => Promise<T>) => Promise<T>;

function wrap(run: Runner, tx: Begin, end: () => Promise<void>): Db {
  return {
    async query<T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      return (await run.query<T>(text, [...params])).rows;
    },
    async exec(text) {
      await run.exec(text);
    },
    async copy(table, columns, rows) {
      if (rows.length === 0) return 0;
      const blob = new Blob([rows.map(csvLine).join("")], { type: "text/csv" });
      await run.query(`copy ${table} (${columns.join(",")}) from '/dev/blob' with (format csv)`, [], { blob });
      return rows.length;
    },
    tx,
    end,
  };
}

/** A tx inside a PGlite transaction: a savepoint, released on success and rolled back to on failure. */
function savepoint(t: Transaction): Begin {
  return async (fn) => {
    await t.exec("savepoint db_tx");
    try {
      const result = await fn(wrap(t, savepoint(t), async () => {}));
      await t.exec("release savepoint db_tx");
      return result;
    } catch (err) {
      await t.exec("rollback to savepoint db_tx");
      throw err;
    }
  };
}

/** In-memory PGlite behind the Db interface. `copy` uses COPY … FROM '/dev/blob' WITH (FORMAT csv) with the same csvLine output; `tx` uses pglite.transaction. Not imported by app code. */
export async function createPgliteDb(): Promise<Db> {
  const pg = new PGlite();
  await pg.waitReady;
  return wrap(
    pg,
    (fn) => pg.transaction((t) => fn(wrap(t, savepoint(t), async () => {}))),
    () => pg.close(),
  );
}
