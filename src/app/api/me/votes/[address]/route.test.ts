import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { WRITE_LIMIT, allowWrite, rateLimitSize, resetRateLimit } from "@/lib/social/rateLimit";
import { votes } from "@/lib/social/store";
import { nowSec } from "@/lib/time";
import type { Address } from "@/lib/types";
import { testDb } from "@/test/db";
import { TEST_SESSION_SECRET, sessionHeader } from "@/test/session";
import { POST } from "./route";

const { holder } = vi.hoisted(() => ({ holder: { db: null as Db | null } }));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, hasDb: () => holder.db !== null, getDb: () => holder.db as Db };
});

const WALLET = `0x${"a".repeat(40)}` as Address;
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
  await db.exec("truncate market.votes");
});
afterEach(() => vi.unstubAllEnvs());

const post = (address: string, body: unknown, cookie?: string) =>
  POST(
    new Request(`http://localhost:3000/api/me/votes/${address}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ address }) },
  );

describe("POST /api/me/votes/[address]", () => {
  it("answers 401 without a session and spends no budget", async () => {
    expect((await post(T1, { dir: "bull" })).status).toBe(401);
    expect(rateLimitSize()).toBe(0);
  });

  it("answers 503 while SESSION_SECRET is unset", async () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    expect((await post(T1, { dir: "bull" }, sessionHeader(WALLET))).status).toBe(503);
  });

  it("casts, switches and clears, answering the new direction each time", async () => {
    const cast = await post(T1, { dir: "bull" }, sessionHeader(WALLET));
    expect(cast.status).toBe(200);
    expect(cast.headers.get("Cache-Control")).toBe("no-store");
    await expect(cast.json()).resolves.toEqual({ dir: "bull" });
    await expect((await post(T1, { dir: "bear" }, sessionHeader(WALLET))).json()).resolves.toEqual({ dir: "bear" });
    await expect((await post(T1, { dir: "bear" }, sessionHeader(WALLET))).json()).resolves.toEqual({ dir: null });
    expect(await votes(db, WALLET)).toEqual({});
  });

  it("lowercases the path segment", async () => {
    await post(MIXED, { dir: "bull" }, sessionHeader(WALLET));
    expect(await votes(db, WALLET)).toEqual({ [MIXED.toLowerCase()]: "bull" });
  });

  it("answers 400 for a bad address, a body that is not JSON and a direction that is not bull or bear", async () => {
    await expect((await post("nope", { dir: "bull" }, sessionHeader(WALLET))).json()).resolves.toEqual({ error: "bad address" });
    await expect((await post(T1, "not json", sessionHeader(WALLET))).json()).resolves.toEqual({ error: "bad body" });
    for (const body of [{}, { dir: "up" }, { dir: 1 }, null]) {
      const res = await post(T1, body, sessionHeader(WALLET));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "bad direction" });
    }
    expect(await votes(db, WALLET)).toEqual({});
  });

  it("answers 429 once the wallet's minute is spent, and casts no vote", async () => {
    for (let i = 0; i < WRITE_LIMIT; i++) allowWrite(WALLET, nowSec());
    const res = await post(T1, { dir: "bull" }, sessionHeader(WALLET));
    expect(res.status).toBe(429);
    await expect(res.text()).resolves.toBe("too many requests");
    expect(await votes(db, WALLET)).toEqual({});
  });
});
