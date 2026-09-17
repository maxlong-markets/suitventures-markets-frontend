/** Round-trips the Db interface against DATABASE_URL_DIRECT: COPY, query, a rolled-back transaction. Prints "ok". Run: npm run db:smoke */
import assert from "node:assert/strict";
import { createDb } from "@/lib/db/client";

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
  console.log("ok");
} finally {
  await db.end();
}
