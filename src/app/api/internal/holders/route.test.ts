import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogSource, TransferEvent } from "@/lib/chain/types";
import { resetDb, type Db } from "@/lib/db/client";
import { refreshRow } from "@/lib/holders/store";
import { setHoldersDeps } from "@/lib/sync/deps";
import { testDb } from "@/test/db";
import { GET } from "./route";

const hex = (n: number, digits: number) => "0x" + n.toString(16).padStart(digits, "0");
const addr = (n: number) => hex(n, 40);
const TOKEN = addr(0xb1); // not a quote asset, so the route's excludedIds never touch it
const WALLET = addr(0xc1);
const ZERO = "0x0000000000000000000000000000000000000000";
const HEAD = 10_000;
/** head - DEFAULT_SAFETY_BLOCKS (30), + 1: the first block past the line the builder stops at. */
const PAST_CEILING = HEAD - 30 + 1;

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(() =>
  db.exec("delete from market.token_balances; delete from market.holder_refresh; delete from market.swaps; delete from market.tokens; delete from market.sync_state"),
);
afterEach(() => {
  setHoldersDeps(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const call = (auth?: string) =>
  GET(new Request("http://localhost/api/internal/holders", { headers: auth ? { authorization: auth } : {} }));

/** One token, one slice that reaches the ceiling: the route's real 750 ms spacing is paid exactly once. */
function oneSliceSource(): Pick<LogSource, "head" | "transfers" | "requests"> {
  let requests = 0;
  return {
    async head() {
      requests += 1;
      return HEAD;
    },
    async transfers(_token: string, _fromBlock: number, toBlock?: number): Promise<{ transfers: TransferEvent[]; nextBlock: number }> {
      requests += 1;
      return {
        transfers: [{ block: 10, logIndex: 0, from: ZERO, to: WALLET, value: 100n }],
        nextBlock: toBlock === undefined ? PAST_CEILING : Math.min(PAST_CEILING, toBlock + 1),
      };
    },
    get requests() {
      return requests;
    },
  };
}

const seedRequestedToken = async () => {
  await db.query(
    `insert into market.tokens (id, address, symbol, name, decimals, total_supply, holders_count, pool_count, origin,
       created_at, metadata_loaded, synced_at)
     values ($1, $1, 'AI', 'Artificial Inu', 18, 0, 0, 1, 'LONG', 1, true, 1)`,
    [TOKEN],
  );
  await db.query("insert into market.holder_refresh (token_id, refreshed_at, requested_at) values ($1, 0, $2)", [
    TOKEN,
    Math.floor(Date.now() / 1000),
  ]);
};

describe("GET /api/internal/holders", () => {
  it("answers 401 without the cron secret", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await call();
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
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

  it("runs the builder against the injected store and source, and answers the report", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    await seedRequestedToken();
    const source = oneSliceSource();
    setHoldersDeps(() => ({ db, source }));

    const res = await call("Bearer s3cret");

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      skipped: null, coverage: 0, due: 1, tokensTouched: 1, tokensReady: 1, tokensSkipped: 0,
      slices: 1, requests: 2, transfers: 1, errors: 0, error: null,
    });
    expect(source.requests).toBe(2); // the head read plus the one slice
    expect(await refreshRow(db, TOKEN)).toMatchObject({ status: "ready", cursorBlock: PAST_CEILING });
  });
});
