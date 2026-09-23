import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChainRunDeps } from "@/lib/chain/run";
import type { ChainEvent, TransferEvent } from "@/lib/chain/types";
import { resetDb, type Db } from "@/lib/db/client";
import { setChainDeps } from "@/lib/sync/deps";
import { saveCursors } from "@/lib/sync/state";
import { testDb } from "@/test/db";
import { GET } from "./route";

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.end(); });
afterEach(() => { setChainDeps(null); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const call = (auth?: string) => GET(new Request("http://localhost/api/internal/sync", { headers: auth ? { authorization: auth } : {} }));

/**
 * A LogSource whose head is always far ahead of the cursor, so the runner never finds itself "caught up" —
 * every cycle fetches, and the request budget (not the window's real 50 s or an idle sleep) is what stops
 * the loop. Keeps this route test fast and free of real timers.
 */
function alwaysBehindSource(): ChainRunDeps["source"] & { requests: number } {
  let requests = 0;
  return {
    async head() {
      requests += 1;
      return 10_000_000;
    },
    async fetch(_from: number, to: number): Promise<{ events: ChainEvent[]; nextBlock: number }> {
      requests += 1;
      return { events: [], nextBlock: to + 1 };
    },
    async transfers(): Promise<{ transfers: TransferEvent[]; nextBlock: number }> {
      throw new Error("alwaysBehindSource.transfers: not used by this route's tests");
    },
    get requests() {
      return requests;
    },
  };
}
const noClient: ChainRunDeps["client"] = { readContract: () => { throw new Error("unused by this test"); } };

describe("GET /api/internal/sync", () => {
  it("answers 401 without the cron secret", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await call();
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
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ error: "database unavailable" });
  });

  it("answers 500 when the chain cursor was never initialised (a genuine throw, not a reported error)", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.spyOn(console, "error").mockImplementation(() => {});
    setChainDeps(() => ({ db, source: alwaysBehindSource(), client: noClient, quotes: [] }));
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ error: "internal error" });
  });

  it("runs the chain job against the injected store, source and client, and answers the report", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    await saveCursors(db, "chain", { cursor: 1000 });
    const source = alwaysBehindSource();
    setChainDeps(() => ({ db, source, client: noClient, quotes: [] }));
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const report = await res.json();
    // maxRequests defaults to 80 (head + fetch per cycle): the budget, not the window or an idle sleep,
    // is what stops this test's loop, and it does so well inside the real 50 s window this route asks for.
    expect(report).toMatchObject({ skipped: null, cycles: 40, requests: 80, error: null, cursor: 1000 + 40 * 2000 });
    expect(source.requests).toBe(80);
  });
});
