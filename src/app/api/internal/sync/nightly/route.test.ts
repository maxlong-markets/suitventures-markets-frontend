import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetDb, type Db } from "@/lib/db/client";
import { setSyncDeps } from "@/lib/sync/deps";
import { FakeSource } from "@/lib/sync/fakeSource";
import { POOL_A, poolRec, tokenRec } from "@/lib/sync/testRows";
import { testDb } from "@/test/db";
import { GET } from "./route";

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
afterEach(() => { setSyncDeps(null); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const call = (auth?: string) => GET(new Request("http://localhost/api/internal/sync/nightly", { headers: auth ? { authorization: auth } : {} }));

describe("GET /api/internal/sync/nightly", () => {
  it("answers 401 without the cron secret", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await call("Bearer wrong!");
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });
  it("answers 503 when DATABASE_URL is unset", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("DATABASE_URL", undefined);
    resetDb();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "database unavailable" });
  });
  it("runs the nightly pass against the injected store and source", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const source = new FakeSource({ tokens: [tokenRec()], pools: [poolRec()] });
    setSyncDeps(() => ({ db, source }));
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const report = await res.json();
    expect(report).toMatchObject({ job: "nightly", skipped: null, cycles: 1, error: null });
    expect(report.results[0]).toMatchObject({ done: true, phase: "", tokens: 1, pools: 1, listed: 1 });
    expect(await db.query("select listed_pool_id from market.tokens")).toEqual([{ listed_pool_id: POOL_A }]);
  });
});
