import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { clearCountsCache } from "@/lib/social/countsCache";
import { MAX_VOTE_IDS, toggleVote } from "@/lib/social/store";
import type { Address } from "@/lib/types";
import { testDb } from "@/test/db";
import { GET } from "./route";

const { holder } = vi.hoisted(() => ({ holder: { db: null as Db | null } }));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, hasDb: () => holder.db !== null, getDb: () => holder.db as Db };
});

const W1 = `0x${"a".repeat(40)}` as Address;
const W2 = `0x${"b".repeat(40)}` as Address;
const T1 = `0x${"1".repeat(40)}`;
const T2 = `0x${"2".repeat(40)}`;
const NOW = 1_789_000_000;

let db: Db;
beforeAll(async () => {
  db = await testDb();
  holder.db = db;
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  clearCountsCache();
  holder.db = db;
  await db.exec("truncate market.votes");
});

/** Hex letters, so upper-casing it really changes the string — `0x111…1` would not. */
const T3 = `0x${"c".repeat(40)}`;

const call = (ids?: string) =>
  GET(new Request(`http://localhost:3000/api/votes${ids === undefined ? "" : `?ids=${ids}`}`));

describe("GET /api/votes", () => {
  it("counts both directions per token and zeroes the rest, cached for thirty seconds", async () => {
    await toggleVote(db, W1, T1, "bull", NOW);
    await toggleVote(db, W2, T1, "bear", NOW);
    const res = await call(`${T1},${T2}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=30, stale-while-revalidate=60");
    await expect(res.json()).resolves.toEqual({ [T1]: { bull: 1, bear: 1 }, [T2]: { bull: 0, bear: 0 } });
  });

  it("accepts a checksummed id and answers under the lowercase key", async () => {
    await toggleVote(db, W1, T3, "bull", NOW);
    const mixed = T3.toUpperCase().replace("0X", "0x");
    expect(mixed).not.toBe(T3); // the whole case rests on this, which is why T3 carries letters
    await expect((await call(mixed)).json()).resolves.toEqual({ [T3]: { bull: 1, bear: 0 } });
  });

  it("de-duplicates and tolerates whitespace and empty entries", async () => {
    await expect((await call(` ${T1} , ${T1} ,,`)).json()).resolves.toEqual({ [T1]: { bull: 0, bear: 0 } });
  });

  it("collapses many repeats of one id below the cap that would otherwise refuse the request", async () => {
    // Without the dedup this is MAX_VOTE_IDS + 1 ids and would be refused as "too many ids".
    const many = Array.from({ length: MAX_VOTE_IDS + 1 }, () => T1).join(",");
    const res = await call(many);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ [T1]: { bull: 0, bear: 0 } });
  });

  it("answers an empty map when no ids are asked for", async () => {
    await expect((await call()).json()).resolves.toEqual({});
    await expect((await call("")).json()).resolves.toEqual({});
  });

  it("answers 400 above five hundred ids and for anything that is not an address", async () => {
    const many = Array.from({ length: MAX_VOTE_IDS + 1 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`).join(",");
    const tooMany = await call(many);
    expect(tooMany.status).toBe(400);
    await expect(tooMany.json()).resolves.toEqual({ error: "too many ids" });
    for (const bad of ["nope", "0x1234", `${T1},nope`, `0x${"z".repeat(40)}`]) {
      const res = await call(bad);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "bad ids" });
    }
  });

  it("serves exactly five hundred ids", async () => {
    const ids = Array.from({ length: MAX_VOTE_IDS }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    const res = await call(ids.join(","));
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object)).toHaveLength(MAX_VOTE_IDS);
  });

  it("holds its answer for the cache window rather than re-counting every request", async () => {
    await toggleVote(db, W1, T1, "bull", NOW);
    await expect((await call(T1)).json()).resolves.toEqual({ [T1]: { bull: 1, bear: 0 } });
    await toggleVote(db, W2, T1, "bull", NOW);
    await expect((await call(T1)).json()).resolves.toEqual({ [T1]: { bull: 1, bear: 0 } }); // still the memo
    clearCountsCache();
    await expect((await call(T1)).json()).resolves.toEqual({ [T1]: { bull: 2, bear: 0 } });
  });

  it("answers zeros rather than an error without a database", async () => {
    holder.db = null;
    const res = await call(`${T1},${T2}`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ [T1]: { bull: 0, bear: 0 }, [T2]: { bull: 0, bear: 0 } });
  });
});
