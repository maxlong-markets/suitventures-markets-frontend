import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTtlCache } from "@/lib/envio/cache";
import { EnvioUnavailableError } from "@/lib/envio/client";
import type { TokenPair } from "@/lib/types";
import { GET } from "./route";

const { pair } = vi.hoisted(() => ({ pair: vi.fn<(id: string) => Promise<TokenPair | null>>() }));
vi.mock("@/lib/market/backend", () => ({ getBackend: () => ({ kind: "db", pair }) }));

const ADDR = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const CACHE = "public, s-maxage=30, stale-while-revalidate=60";
const call = (address: string) => GET(new Request(`http://localhost:3000/api/tokens/${address}`), { params: Promise.resolve({ address }) });
const found = { id: ADDR, ticker: "AI", name: "Artificial Inu" } as TokenPair;

describe("GET /api/tokens/[address]", () => {
  beforeEach(() => {
    clearTtlCache();
    pair.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("rejects a malformed address before touching the backend", async () => {
    const res = await call("not-an-address");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad address" });
    expect(pair).not.toHaveBeenCalled();
  });

  it("answers 404 with the list's cache header for an unknown token, and memoises that answer", async () => {
    pair.mockResolvedValue(null);
    const res = await call(ADDR);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "unknown token" });
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
    expect((await call(ADDR)).status).toBe(404);
    expect(pair).toHaveBeenCalledTimes(1); // ttlCache stores null as a value
  });

  it("answers the pair, lowercasing the path segment", async () => {
    pair.mockResolvedValue(found);
    const res = await call(ADDR.toUpperCase().replace("0X", "0x"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(CACHE);
    await expect(res.json()).resolves.toEqual(found);
    expect(pair).toHaveBeenCalledWith(ADDR);
  });

  it("answers 503 when the backend's source is unavailable", async () => {
    pair.mockRejectedValue(new EnvioUnavailableError("indexer responded 503"));
    const res = await call(ADDR);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("15");
  });
});
