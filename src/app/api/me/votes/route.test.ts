import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { toggleVote } from "@/lib/social/store";
import type { Address } from "@/lib/types";
import { testDb } from "@/test/db";
import { TEST_SESSION_SECRET, sessionHeader } from "@/test/session";
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
  await db.exec("truncate market.votes");
});
afterEach(() => vi.unstubAllEnvs());

const call = (cookie?: string) => GET(new Request("http://localhost:3000/api/me/votes", { headers: cookie ? { cookie } : {} }));

describe("GET /api/me/votes", () => {
  it("answers 401 without a session cookie", async () => {
    expect((await call()).status).toBe(401);
  });

  it("answers 503 while SESSION_SECRET is unset", async () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    expect((await call(sessionHeader(WALLET))).status).toBe(503);
  });

  it("answers the wallet's own direction per token and nobody else's", async () => {
    await toggleVote(db, WALLET, T1, "bull", NOW);
    await toggleVote(db, WALLET, T2, "bear", NOW);
    await toggleVote(db, OTHER, T1, "bear", NOW);
    const res = await call(sessionHeader(WALLET));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ [T1]: "bull", [T2]: "bear" });
    await expect((await call(sessionHeader(OTHER))).json()).resolves.toEqual({ [T1]: "bear" });
  });

  it("answers an empty map for a wallet that has never voted", async () => {
    await expect((await call(sessionHeader(WALLET))).json()).resolves.toEqual({});
  });

  it("ignores a wallet query parameter: the cookie's wallet answers, never the override", async () => {
    await toggleVote(db, WALLET, T1, "bull", NOW);
    await toggleVote(db, OTHER, T1, "bear", NOW);
    const res = await GET(
      new Request(`http://localhost:3000/api/me/votes?wallet=${OTHER}`, { headers: { cookie: sessionHeader(WALLET) } }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ [T1]: "bull" });
  });
});
