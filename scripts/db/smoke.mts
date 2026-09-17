/**
 * Round-trips the Db interface against DATABASE_URL_DIRECT: COPY, query, a rolled-back transaction, and one
 * upsertTokens with a hostile name inside a transaction that rolls back (so market.tokens must exist: run
 * db:migrate first). Prints "ok" only when every round trip matched. Run: npm run db:smoke
 */
import assert from "node:assert/strict";
import { createDb } from "@/lib/db/client";
import type { TokenRec } from "@/lib/sync/source";
import { upsertTokens } from "@/lib/sync/writers";

const url = process.env.DATABASE_URL_DIRECT;
if (!url) {
  console.error("DATABASE_URL_DIRECT is not set (see .env.example)");
  process.exit(1);
}
// max 1: a temp table lives on the connection that created it.
const db = createDb(url, { max: 1 });
try {
  await db.exec("create temp table smoke (id int primary key, label text, flag boolean, big numeric(78,0), price double precision)");
  const big = "1" + "0".repeat(30);
  const sent = await db.copy("smoke", ["id", "label", "flag", "big", "price"], [
    [1, "a,b", true, big, 0.5],
    [2, "", false, "0", 1e21],
    [3, null, null, null, null],
  ]);
  assert.equal(sent, 3);
  type Row = { id: number; label: string | null; flag: boolean | null; big: string | null; price: number | null };
  const rows = await db.query<Row>("select id, label, flag, big, price from smoke order by id");
  assert.deepEqual(rows, [
    { id: 1, label: "a,b", flag: true, big, price: 0.5 },
    { id: 2, label: "", flag: false, big: "0", price: 1e21 },
    { id: 3, label: null, flag: null, big: null, price: null },
  ]);
  await db
    .tx(async (t) => {
      await t.query("insert into smoke (id) values ($1)", [4]);
      throw new Error("rollback on purpose");
    })
    .catch((err: unknown) => {
      if (!(err instanceof Error) || err.message !== "rollback on purpose") throw err;
    });
  const [count] = await db.query<{ n: string | number }>("select count(*) as n from smoke");
  assert.equal(Number(count.n), 3);
  // The array-parameter writers depend on the driver serialising a text[] of names with quotes, braces, a backslash
  // and a comma exactly; prove it through the real upsertTokens (insert, then the on-conflict update) inside a
  // transaction that rolls back, so the smoke leaves market.tokens as it found it.
  const hostile = `Hos"tile {name}, with \\backslash, 'quotes' and \u00e9`;
  const id = "0x" + "5".repeat(40);
  const token: TokenRec = {
    id, address: id, symbol: 'S"y,m{b}ol', name: hostile, decimals: 18, totalSupply: "1" + "0".repeat(27), holdersCount: 0,
    poolCount: 0, origin: "Other", createdAt: 0, primaryPool_id: null, metadataLoaded: true,
  };
  let seen: { name: string; symbol: string } | undefined;
  await db
    .tx(async (t) => {
      await upsertTokens(t, [token], 0);
      await upsertTokens(t, [{ ...token, holdersCount: 1 }], 1);
      seen = (await t.query<{ name: string; symbol: string }>("select name, symbol from market.tokens where id = $1", [id]))[0];
      throw new Error("rollback on purpose");
    })
    .catch((err: unknown) => {
      if (!(err instanceof Error) || err.message !== "rollback on purpose") throw err;
    });
  assert.deepEqual(seen, { name: hostile, symbol: token.symbol });
  const [left] = await db.query<{ n: string | number }>("select count(*) as n from market.tokens where id = $1", [id]);
  assert.equal(Number(left.n), 0);
  console.log("ok");
} finally {
  await db.end();
}
