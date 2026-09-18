import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { setWatch } from "@/lib/social/store";
import { testDb } from "@/test/db";
import { TEST_SESSION_SECRET, sessionHeader } from "@/test/session";
import type { Address } from "@/lib/types";
import { GET } from "./route";

const { holder } = vi.hoisted(() => ({ holder: { db: null as Db | null } }));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, hasDb: () => holder.db !== null, getDb: () => holder.db as Db };
});

const WALLET = `0x${"a".repeat(40)}` as Address;
const OTHER = `0x${"b".repeat(40)}` as Address;
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
  vi.stubEnv("SESSION_SECRET", TEST_SESSION_SECRET);
  await db.exec("truncate market.watchlist");
});
afterEach(() => vi.unstubAllEnvs());

const call = (cookie?: string) =>
  GET(new Request("http://localhost:3000/api/me/watchlist", { headers: cookie ? { cookie } : {} }));

describe("GET /api/me/watchlist", () => {
  it("answers 401 without a session cookie", async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ error: "not signed in" });
  });

  it("answers 503 while SESSION_SECRET is unset", async () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    const res = await call(sessionHeader(WALLET));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "sessions not configured" });
  });

  it("answers the signed-in wallet's own list, newest first, and never another wallet's", async () => {
    await setWatch(db, WALLET, T1, true, NOW);
    await setWatch(db, WALLET, T2, true, NOW + 10);
    await setWatch(db, OTHER, T1, true, NOW);
    const res = await call(sessionHeader(WALLET));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual([T2, T1]);
    await expect((await call(sessionHeader(OTHER))).json()).resolves.toEqual([T1]);
  });

  it("answers an empty list for a wallet that has starred nothing", async () => {
    await expect((await call(sessionHeader(WALLET))).json()).resolves.toEqual([]);
  });
});
