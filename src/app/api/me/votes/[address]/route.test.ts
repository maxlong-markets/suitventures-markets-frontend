import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { clearCountsCache, countsCacheSize, countsFor } from "@/lib/social/countsCache";
import { WRITE_LIMIT, allowWrite, rateLimitSize, resetRateLimit } from "@/lib/social/rateLimit";
import { VOTES_CAP, votes } from "@/lib/social/store";
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
  clearCountsCache();
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

  it("casts, switches and clears, answering the new direction and the token's fresh counts each time", async () => {
    const cast = await post(T1, { dir: "bull" }, sessionHeader(WALLET));
    expect(cast.status).toBe(200);
    expect(cast.headers.get("Cache-Control")).toBe("no-store");
    await expect(cast.json()).resolves.toEqual({ dir: "bull", bull: 1, bear: 0 });
    await expect((await post(T1, { dir: "bear" }, sessionHeader(WALLET))).json()).resolves.toEqual({ dir: "bear", bull: 0, bear: 1 });
    await expect((await post(T1, { dir: "bear" }, sessionHeader(WALLET))).json()).resolves.toEqual({ dir: null, bull: 0, bear: 0 });
    expect(await votes(db, WALLET)).toEqual({});
  });

  /**
   * The counts the pairs list and `/api/votes` serve come from `countsFor`, whose entries live for
   * thirty seconds. Before this, a vote landed in the store while every reader kept answering the
   * pre-vote number, so the client's own refetch after the write painted the count back to where
   * it had been — the "right after I vote, it doesn't show" half of the 23 Sep report.
   */
  it("refreshes the token's counts cache, so a read inside the thirty-second window sees the vote", async () => {
    const now = nowSec();
    // The page load just before the vote: the id is cached at its pre-vote count.
    await expect(countsFor(db, [T1], now)).resolves.toEqual({ [T1]: { bull: 0, bear: 0 } });

    await post(T1, { dir: "bull" }, sessionHeader(WALLET));
    await expect(countsFor(db, [T1], now + 1)).resolves.toEqual({ [T1]: { bull: 1, bear: 0 } });

    // And the same on the way back out: clearing the vote must not leave the 1 behind either.
    await post(T1, { dir: "bull" }, sessionHeader(WALLET));
    await expect(countsFor(db, [T1], now + 2)).resolves.toEqual({ [T1]: { bull: 0, bear: 0 } });
  });

  it("leaves other tokens' cached counts alone", async () => {
    const now = nowSec();
    const T2 = `0x${"2".repeat(40)}`;
    await db.query("insert into market.votes (wallet, token_id, dir, updated_at) values ($1, $2, 'bear', $3)", [OTHER, T2, now]);
    await expect(countsFor(db, [T2], now)).resolves.toEqual({ [T2]: { bull: 0, bear: 1 } });
    await post(T1, { dir: "bull" }, sessionHeader(WALLET));
    expect(countsCacheSize()).toBe(2);
    await expect(countsFor(db, [T2], now + 1)).resolves.toEqual({ [T2]: { bull: 0, bear: 1 } });
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

  it("answers 409 once the wallet is at its row cap, but still lets it change a vote it holds (review I4)", async () => {
    const SEEDED = `0x${"0".repeat(39)}1`;
    await db.query(
      "insert into market.votes (wallet, token_id, dir, updated_at) select $1, '0x' || lpad(to_hex(g), 40, '0'), 'bull', 0 from generate_series(1, $2) g",
      [WALLET, VOTES_CAP],
    );
    const res = await post(T1, { dir: "bull" }, sessionHeader(WALLET));
    expect(res.status).toBe(409);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ error: "too many votes" });
    // A token the wallet already voted on is not a new row, so the switch goes through at the cap.
    await expect((await post(SEEDED, { dir: "bear" }, sessionHeader(WALLET))).json()).resolves.toEqual({ dir: "bear", bull: 0, bear: 1 });
  });

  it("ignores a wallet query parameter and a body wallet field: the vote still lands under the cookie's wallet", async () => {
    const res = await POST(
      new Request(`http://localhost:3000/api/me/votes/${T1}?wallet=${OTHER}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: sessionHeader(WALLET) },
        body: JSON.stringify({ dir: "bull", wallet: OTHER }),
      }),
      { params: Promise.resolve({ address: T1 }) },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ dir: "bull", bull: 1, bear: 0 });
    expect(await votes(db, WALLET)).toEqual({ [T1]: "bull" });
    expect(await votes(db, OTHER)).toEqual({});
  });
});
