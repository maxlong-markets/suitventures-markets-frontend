import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client";
import { MIGRATIONS_DIR, migrate } from "./migrate";
import { createPgliteDb } from "./pglite";

const MARKET = "20260917000000_market.sql";
const TABLES = ["candles", "holder_refresh", "pools", "quotes", "schema_migrations", "swaps", "sync_state", "token_balances", "tokens"];

describe("migrate", () => {
  let db: Db;
  beforeAll(async () => {
    db = await createPgliteDb();
  });
  afterAll(async () => {
    await db.end();
  });

  it("applies the repo migrations once, in name order, and records them", async () => {
    expect(MIGRATIONS_DIR).toBe("supabase/migrations");
    const applied = await migrate(db);
    expect(applied[0]).toBe(MARKET);
    expect([...applied].sort()).toEqual(applied);
    const recorded = await db.query<{ name: string }>("select name from market.schema_migrations order by name");
    expect(recorded.map((r) => r.name)).toEqual(applied);
    expect(await migrate(db)).toEqual([]);
    const tables = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'market' order by table_name",
    );
    expect(tables.map((t) => t.table_name)).toEqual(expect.arrayContaining(TABLES));
  });

  it("round-trips a COPY and reads numeric as text, int8 through Number()", async () => {
    await migrate(db); // idempotent, so this case also passes when run alone
    const sent = await db.copy("market.holder_refresh", ["token_id", "refreshed_at"], [["0xa", 1], ["0xb", 2]]);
    expect(sent).toBe(2);
    await db.copy("market.token_balances", ["token_id", "holder", "balance", "updated_at"], [["0xa", "0xh", "1" + "0".repeat(30), 5]]);
    const rows = await db.query<{ balance: string }>("select balance from market.token_balances where token_id = $1", ["0xa"]);
    expect(rows).toEqual([{ balance: "1" + "0".repeat(30) }]);
    const [count] = await db.query<{ n: number | string }>("select count(*) as n from market.holder_refresh");
    expect(Number(count.n)).toBe(2);
  });

  it("rolls a failing file back and records nothing for it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migrate-"));
    try {
      await writeFile(join(dir, "20990101000000_bad.sql"), "create table market.half (id int);\ncreate table market.broken (id int, id int);\n");
      await expect(migrate(db, dir)).rejects.toThrow();
      const half = await db.query<{ n: number | string }>(
        "select count(*) as n from information_schema.tables where table_schema = 'market' and table_name = 'half'",
      );
      expect(Number(half[0].n)).toBe(0);
      expect(await db.query("select name from market.schema_migrations where name like '%bad%'")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
