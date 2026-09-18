import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { WRITE_LIMIT, rateLimitSize, resetRateLimit } from "@/lib/social/rateLimit";
import { watchlist } from "@/lib/social/store";
import type { Address } from "@/lib/types";
import { testDb } from "@/test/db";
import { TEST_SESSION_SECRET, sessionHeader } from "@/test/session";
import { DELETE, PUT } from "./route";

const { holder } = vi.hoisted(() => ({ holder: { db: null as Db | null } }));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, hasDb: () => holder.db !== null, getDb: () => holder.db as Db };
});

const WALLET = `0x${"a".repeat(40)}` as Address;
const OTHER = `0x${"b".repeat(40)}` as Address;
const T1 = `0x${"1".repeat(40)}`;
const MIXED = `0x${"A".repeat(40)}`;

let db: Db;
beforeAll(async () => {
  db = await testDb();
  holder.db = db;
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", TEST_SESSION_SECRET);
  resetRateLimit();
  await db.exec("truncate market.watchlist");
});
afterEach(() => vi.unstubAllEnvs());

const req = (address: string, cookie?: string) =>
  [
    new Request(`http://localhost:3000/api/me/watchlist/${address}`, { method: "PUT", headers: cookie ? { cookie } : {} }),
    { params: Promise.resolve({ address }) },
  ] as const;
const put = (address: string, cookie?: string) => PUT(...req(address, cookie));
const del = (address: string, cookie?: string) => DELETE(...req(address, cookie));

const reqWithWalletOverride = (address: string, wallet: string, cookie?: string) =>
  [
    new Request(`http://localhost:3000/api/me/watchlist/${address}?wallet=${wallet}`, { method: "PUT", headers: cookie ? { cookie } : {} }),
    { params: Promise.resolve({ address }) },
  ] as const;

describe("PUT|DELETE /api/me/watchlist/[address]", () => {
  it("answers 401 without a session and spends no budget", async () => {
    expect((await put(T1)).status).toBe(401);
    expect((await del(T1)).status).toBe(401);
    expect(rateLimitSize()).toBe(0);
  });

  it("answers 503 while SESSION_SECRET is unset", async () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    expect((await put(T1, sessionHeader(WALLET))).status).toBe(503);
  });

  it("adds and removes, idempotently, answering 204 each time", async () => {
    for (const res of [await put(T1, sessionHeader(WALLET)), await put(T1, sessionHeader(WALLET))]) {
      expect(res.status).toBe(204);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      await expect(res.text()).resolves.toBe("");
    }
    expect(await watchlist(db, WALLET)).toEqual([T1]);
    expect((await del(T1, sessionHeader(WALLET))).status).toBe(204);
    expect((await del(T1, sessionHeader(WALLET))).status).toBe(204);
    expect(await watchlist(db, WALLET)).toEqual([]);
  });

  it("lowercases the path segment, so a checksummed address stars the same token", async () => {
    expect((await put(MIXED, sessionHeader(WALLET))).status).toBe(204);
    expect(await watchlist(db, WALLET)).toEqual([MIXED.toLowerCase()]);
  });

  it("answers 400 for anything that is not an address", async () => {
    for (const bad of ["not-an-address", "0x1234", `0x${"1".repeat(41)}`, `0x${"z".repeat(40)}`]) {
      const res = await put(bad, sessionHeader(WALLET));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "bad address" });
    }
    expect(await watchlist(db, WALLET)).toEqual([]);
  });

  it("answers 429 on the sixty-first write of a minute, before it even looks at the address", async () => {
    for (let i = 0; i < WRITE_LIMIT; i++) expect((await put(T1, sessionHeader(WALLET))).status).toBe(204);
    const res = await put(T1, sessionHeader(WALLET));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.text()).resolves.toBe("too many requests");
    expect((await put("not-an-address", sessionHeader(WALLET))).status).toBe(429); // the budget is checked first
  });

  it("answers 429 on the sixty-first delete of a minute too", async () => {
    for (let i = 0; i < WRITE_LIMIT; i++) expect((await del(T1, sessionHeader(WALLET))).status).toBe(204);
    const res = await del(T1, sessionHeader(WALLET));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.text()).resolves.toBe("too many requests");
  });

  it("ignores a wallet query parameter: the write still lands under the cookie's wallet", async () => {
    const [request, ctx] = reqWithWalletOverride(T1, OTHER, sessionHeader(WALLET));
    expect((await PUT(request, ctx)).status).toBe(204);
    expect(await watchlist(db, WALLET)).toEqual([T1]);
    expect(await watchlist(db, OTHER)).toEqual([]);
  });
});
