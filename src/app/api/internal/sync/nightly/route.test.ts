import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetDb, type Db } from "@/lib/db/client";
import { setSyncDeps } from "@/lib/sync/deps";
import { FakeSource } from "@/lib/sync/fakeSource";
import { POOL_A, T0, poolRec, tokenRec } from "@/lib/sync/testRows";
import { upsertPools, upsertTokens } from "@/lib/sync/writers";
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
  it("runs the nightly pass against the injected store", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    // Task 6: nightly no longer walks tokens/pools in from an Envio-shaped source (the chain reader owns
    // those tables now) — seed them directly, the way the chain reader would already have written them.
    // syncDeps("nightly") always returns a source (nightly/route.ts still destructures and forwards it into
    // runSync), but nothing reads it anymore, so an empty FakeSource stands in for deps.ts's real dead stub.
    await upsertTokens(db, [tokenRec()], T0);
    await upsertPools(db, [poolRec()], T0);
    setSyncDeps(() => ({ db, source: new FakeSource({}) }));
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const report = await res.json();
    expect(report).toMatchObject({ job: "nightly", skipped: null, cycles: 1, error: null });
    expect(report.results[0]).toMatchObject({ done: true, phase: "", listed: 1 });
    expect(await db.query("select listed_pool_id from market.tokens")).toEqual([{ listed_pool_id: POOL_A }]);
  });
});
