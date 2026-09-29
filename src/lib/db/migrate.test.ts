import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client";
import { MIGRATIONS_DIR, migrate } from "./migrate";
import { createPgliteDb } from "./pglite";

const MARKET = "20260917000000_market.sql";
const TABLES = [
  "candles", "holder_refresh", "launch_fee_events", "launch_uploads", "launches", "pools", "quotes", "schema_migrations", "swaps",
  "sync_state", "token_balances", "tokens",
];

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

  it("creates the instant launchpad's three tables, their checks and every index spec 5.1 names", async () => {
    await migrate(db); // idempotent, so this case also passes when run alone
    const columns = async (table: string) =>
      db.query<{ column_name: string; data_type: string }>(
        "select column_name, data_type from information_schema.columns where table_schema = 'market' and table_name = $1 order by ordinal_position",
        [table],
      );
    const launches = await columns("launches");
    expect(launches.map((c) => c.column_name)).toEqual([
      "token_id", "pool_id", "quote_id", "creator", "payout", "token_is_currency0", "creator_share_bps", "open_tick",
      "opening_valuation", "liquidity", "tokens_in_pool", "first_buy_in", "first_buy_tokens", "router_fee", "creation_fee",
      "hook", "name", "symbol", "metadata_uri", "metadata_cid", "image_cid", "description", "website", "x", "telegram",
      "launch_block", "launch_log_index", "launch_tx", "launched_at", "payout_block", "payout_log_index", "hidden", "updated_at",
    ]);
    // Raw chain integers are numeric, never int or float, so a uint256 round-trips as its exact digits.
    for (const name of ["opening_valuation", "liquidity", "tokens_in_pool", "first_buy_in", "first_buy_tokens", "router_fee", "creation_fee"]) {
      expect(launches.find((c) => c.column_name === name)?.data_type).toBe("numeric");
    }
    expect((await columns("launch_fee_events")).map((c) => c.column_name)).toEqual([
      "tx_hash", "log_index", "token_id", "payout", "token_payout", "token_platform", "quote_payout", "quote_platform", "block", "ts",
    ]);
    expect((await columns("launch_uploads")).map((c) => c.column_name)).toEqual([
      "id", "wallet", "image_cid", "metadata_cid", "image_key", "metadata_key", "name", "symbol", "description", "website", "x",
      "telegram", "status", "created_at", "used_at", "token_id",
    ]);
    const indexes = await db.query<{ indexname: string }>("select indexname from pg_indexes where schemaname = 'market' order by indexname");
    expect(indexes.map((i) => i.indexname)).toEqual(
      expect.arrayContaining([
        "launches_creator", "launches_metadata_cid", "launch_fee_events_token", "launch_uploads_wallet_created",
        "launch_uploads_metadata_cid", "launch_uploads_image_cid", "launch_uploads_cleanable", "pools_activity", "pools_sv_unswapped",
      ]),
    );
    // The status enumeration and the tick-spacing check are enforced by the database, not only by the code.
    await expect(
      db.query(
        `insert into market.launch_uploads (wallet, image_cid, metadata_cid, image_key, metadata_key, name, symbol, status, created_at)
         values ('0xa', 'i', 'm', 'ik', 'mk', 'N', 'S', 'lost', 1)`,
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `insert into market.launches (token_id, pool_id, quote_id, creator, payout, token_is_currency0, creator_share_bps, open_tick,
           opening_valuation, liquidity, tokens_in_pool, first_buy_in, first_buy_tokens, router_fee, creation_fee, hook, name, symbol,
           metadata_uri, launch_block, launch_log_index, launch_tx, launched_at, payout_block, payout_log_index, updated_at)
         values ('0xt', '0xp', '0xq', '0xc', '0xc', true, 7000, 150, 1, 1, 1, 0, 0, 0, 0, '0x0', 'N', 'S', '', 1, 0, '0xtx', 1, 1, 0, 1)`,
      ),
    ).rejects.toThrow();
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
