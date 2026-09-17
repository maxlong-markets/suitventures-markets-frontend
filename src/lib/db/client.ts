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

/**
 * Socket, DNS, TLS and driver codes that mean "the database cannot be reached"; SQLSTATE 08xxx (connection), 53xxx
 * (resources), 57P01 (admin shutdown) and XX000 (how Supavisor reports "max client connections reached") join them below.
 */
const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "ECONNABORTED",
  "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED",
]);

/** The error's code when it means the database is unavailable (the routes answer 503), else null. Exported for its test only. */
export function unavailableCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return null;
  return UNAVAILABLE_CODES.has(code) || code.startsWith("08") || code.startsWith("53") || code === "57P01" || code === "XX000" ? code : null;
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

function wrap(sql: postgres.ISql, begin: Begin, end: () => Promise<void>, copyTimeoutMs: number): Db {
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
      // The driver resolves a COPY when the server accepts the stream and never surfaces a later server error: a
      // rejected page leaves the pipeline pending forever. The bound turns that into DbUnavailableError, and callers
      // redo the page through their idempotent path, which reports the real error.
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          writable.destroy();
          reject(new DbUnavailableError(`copy into ${table} did not complete within ${copyTimeoutMs} ms`));
        }, copyTimeoutMs);
      });
      try {
        await guard(Promise.race([pipeline(Readable.from([rows.map(csvLine).join("")]), writable), expired]));
      } finally {
        clearTimeout(timer);
      }
      return rows.length;
    },
    async tx(fn) {
      return guard(begin((t) => fn(wrap(t, savepoints(t), async () => {}, copyTimeoutMs))));
    },
    end,
  };
}

/**
 * porsager `postgres` with `prepare: false` (Supavisor transaction mode), `max` default 4, `idle_timeout` 20,
 * `connect_timeout` 10; a COPY that has not completed after `copyTimeoutMs` (default 60 s) fails as unavailable.
 */
export function createDb(url: string, opts: { max?: number; copyTimeoutMs?: number } = {}): Db {
  let sql: postgres.Sql;
  try {
    sql = postgres(url, { prepare: false, max: opts.max ?? 4, idle_timeout: 20, connect_timeout: 10 });
  } catch {
    // Node's URL parser attaches the offending string to its TypeError as `input`; nothing from the driver's error may travel, not even as a cause.
    throw new DbUnavailableError("DATABASE_URL is not a valid connection string");
  }
  return wrap(sql, begins(sql), () => sql.end({ timeout: 5 }), opts.copyTimeoutMs ?? 60_000);
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
