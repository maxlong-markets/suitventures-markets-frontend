import "server-only";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import postgres from "postgres";
import { csvLine } from "./csv";

export class DbUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbUnavailableError";
  }
}

export interface Db {
  /** Parameterised query ($1, $2 …). Rows are plain objects; int4 and float8 arrive as numbers, numeric as strings, bool as booleans. */
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Multi-statement SQL without parameters (DDL, migrations). */
  exec(text: string): Promise<void>;
  /** Bulk load: rows are arrays in `columns` order, sent as COPY … FROM STDIN WITH (FORMAT csv). Returns rows written. */
  copy(table: string, columns: readonly string[], rows: readonly (readonly unknown[])[]): Promise<number>;
  /** Runs fn on one connection between BEGIN and COMMIT; ROLLBACK and rethrow on failure. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/** Socket and driver codes that mean "the database cannot be reached"; SQLSTATE 08xxx (connection), 53xxx (resources) and 57P01 (admin shutdown) join them below. */
const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE",
  "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED",
]);

function unavailableCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return null;
  return UNAVAILABLE_CODES.has(code) || code.startsWith("08") || code.startsWith("53") || code === "57P01" ? code : null;
}

/** Rethrows connection failures as DbUnavailableError. Only the code travels: driver messages can carry the host. */
async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    const code = unavailableCode(err);
    if (code) throw new DbUnavailableError(`database unavailable (${code})`);
    throw err;
  }
}

type Begin = <T>(cb: (t: postgres.TransactionSql) => Promise<T>) => Promise<T>;

/** BEGIN … COMMIT on a pooled connection. The driver's return type unwraps arrays of queries; ours never are, so the cast is exact. */
function begins(sql: postgres.Sql): Begin {
  return <T>(cb: (t: postgres.TransactionSql) => Promise<T>) => sql.begin(cb) as unknown as Promise<T>;
}

/** SAVEPOINT … RELEASE inside a running transaction. */
function savepoints(t: postgres.TransactionSql): Begin {
  return <T>(cb: (s: postgres.TransactionSql) => Promise<T>) => t.savepoint(cb) as unknown as Promise<T>;
}

function wrap(sql: postgres.ISql, begin: Begin, end: () => Promise<void>): Db {
  return {
    async query<T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      // Every value we pass is a string, number, boolean, null or an array of those; the driver's parameter type is just narrower than unknown.
      return Array.from<T>(await guard(sql.unsafe<T[]>(text, params as never[])));
    },
    async exec(text) {
      // No parameters: the driver uses the simple protocol, which allows several statements.
      await guard(sql.unsafe(text));
    },
    async copy(table, columns, rows) {
      if (rows.length === 0) return 0;
      // Identifiers are constants from our own code, never user input.
      const writable = await guard(sql.unsafe(`copy ${table} (${columns.join(",")}) from stdin with (format csv)`).writable());
      await guard(pipeline(Readable.from([rows.map(csvLine).join("")]), writable));
      return rows.length;
    },
    async tx(fn) {
      return guard(begin((t) => fn(wrap(t, savepoints(t), async () => {}))));
    },
    end,
  };
}

/** porsager `postgres` with `prepare: false` (Supavisor transaction mode), `max` default 4, `idle_timeout` 20, `connect_timeout` 10. */
export function createDb(url: string, opts: { max?: number } = {}): Db {
  const sql = postgres(url, { prepare: false, max: opts.max ?? 4, idle_timeout: 20, connect_timeout: 10 });
  return wrap(sql, begins(sql), () => sql.end({ timeout: 5 }));
}

let singleton: Db | null = null;

export function hasDb(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/** Process singleton over process.env.DATABASE_URL; throws DbUnavailableError when unset. */
export function getDb(): Db {
  if (!singleton) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new DbUnavailableError("DATABASE_URL is not set");
    singleton = createDb(url);
  }
  return singleton;
}

/** Tests only: drop the singleton. */
export function resetDb(): void {
  const old = singleton;
  singleton = null;
  if (old) void old.end().catch(() => undefined);
}
