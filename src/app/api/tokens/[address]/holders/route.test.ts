import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DbUnavailableError } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import type { HoldersView } from "@/lib/types";
import { GET } from "./route";

const { holders } = vi.hoisted(() => ({ holders: vi.fn<(id: string) => Promise<HoldersView>>() }));
vi.mock("@/lib/market/backend", () => ({ getBackend: () => ({ kind: "db", holders }) }));

const ADDR = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const view = (over: Partial<HoldersView> = {}): HoldersView => ({ holders: [], count: 3, status: "ready", asOf: 1_789_547_000, ...over });
const call = (address: string) =>
  GET(new Request(`http://localhost:3000/api/tokens/${address}/holders`), { params: Promise.resolve({ address }) });

describe("GET /api/tokens/[address]/holders", () => {
  beforeEach(() => {
    clearTtlCache();
    holders.mockReset().mockResolvedValue(view());
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects a malformed address before touching the backend", async () => {
    const res = await call("not-an-address");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad address" });
    expect(holders).not.toHaveBeenCalled();
  });

  it("answers the whole view, lowercasing the path segment", async () => {
    const ready = view({ count: 7, asOf: 1_789_546_000 });
    holders.mockResolvedValue(ready);
    const res = await call(ADDR.toUpperCase().replace("0X", "0x"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(ready);
    expect(holders).toHaveBeenCalledWith(ADDR);
  });

  // Design section 5: a finished list may sit on the CDN for a minute; a list the tab is polling
  // must not, or the poll would read the same "building" for a minute after it went ready.
  it("lets the CDN hold a ready list for 60 s", async () => {
    expect((await call(ADDR)).headers.get("Cache-Control")).toBe("public, s-maxage=60, stale-while-revalidate=60");
  });

  it.each(["building", "skipped"] as const)("holds a %s answer for 5 s only", async (status) => {
    holders.mockResolvedValue(view({ status, asOf: null }));
    expect((await call(ADDR)).headers.get("Cache-Control")).toBe("public, s-maxage=5, stale-while-revalidate=60");
  });

  it("memoises one token's view for 5 s in-process, then asks the backend again", async () => {
    vi.useFakeTimers();
    await call(ADDR);
    await call(ADDR);
    expect(holders).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_001);
    await call(ADDR);
    expect(holders).toHaveBeenCalledTimes(2);
  });

  it("answers 503 when the store is unreachable", async () => {
    holders.mockRejectedValue(new DbUnavailableError("connection refused"));
    const res = await call(ADDR);
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
