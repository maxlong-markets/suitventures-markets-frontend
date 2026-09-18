import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpRequestError } from "viem";
import { DbUnavailableError } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import type { PoolKeyRow } from "@/lib/market/poolKey";
// The mock below spreads the real module, so these are the very classes priceSwap and the route
// check against.
import { NotRoutableError, QuoterUnavailableError, type QuoterCall } from "@/lib/quote/quoter";
import type { Address } from "@/lib/types";
import { GET } from "./route";

const { poolKey, exactIn, exactOut } = vi.hoisted(() => ({
  poolKey: vi.fn<(id: string) => Promise<PoolKeyRow | null>>(),
  exactIn: vi.fn<(call: QuoterCall) => Promise<bigint>>(),
  exactOut: vi.fn<(call: QuoterCall) => Promise<bigint>>(),
}));
vi.mock("@/lib/market/backend", () => ({ getBackend: () => ({ kind: "db", poolKey }) }));
// Only the factory is replaced: importOriginal keeps NotRoutableError the very class priceSwap
// checks with `instanceof`, so the not-routable path is the real one.
vi.mock("@/lib/quote/quoter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/quote/quoter")>()),
  createQuoter: () => ({ exactIn, exactOut }),
}));

const ADDR = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const QUOTE = "0x2222222222222222222222222222222222222222" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const POOL: PoolKeyRow = {
  poolId: `0x${"ab".repeat(32)}` as Address,
  currency0: TOKEN,
  currency1: QUOTE,
  fee: 3000,
  tickSpacing: 60,
  hooks: ZERO,
  tokenIsCurrency0: true,
  priceQuote: 0.5,
  tokenAddress: TOKEN,
  tokenDecimals: 18,
  quoteAddress: QUOTE,
  quoteDecimals: 6,
};

const OK = "side=buy&amount=100&denom=quote&slippageBps=100";
const call = (address: string, query: string) =>
  GET(new Request(`http://localhost:3000/api/tokens/${address}/quote?${query}`), {
    params: Promise.resolve({ address }),
  });

describe("GET /api/tokens/[address]/quote", () => {
  beforeEach(() => {
    clearTtlCache();
    poolKey.mockReset();
    exactIn.mockReset();
    exactOut.mockReset();
    poolKey.mockResolvedValue(POOL);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("rejects a malformed address before touching the backend", async () => {
    const res = await call("not-an-address", OK);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad address" });
    expect(poolKey).not.toHaveBeenCalled();
  });

  it.each([
    ["amount=1&denom=quote&slippageBps=100", "bad side"],
    ["side=long&amount=1&denom=quote&slippageBps=100", "bad side"],
    ["side=buy&amount=1&slippageBps=100", "bad denom"],
    ["side=buy&amount=1&denom=usd&slippageBps=100", "bad denom"],
    ["side=buy&denom=quote&slippageBps=100", "bad amount"],
    ["side=buy&amount=0&denom=quote&slippageBps=100", "bad amount"],
    ["side=buy&amount=-1&denom=quote&slippageBps=100", "bad amount"],
    ["side=buy&amount=1e9&denom=quote&slippageBps=100", "bad amount"],
    ["side=buy&amount=one&denom=quote&slippageBps=100", "bad amount"],
    ["side=buy&amount=1&denom=quote", "bad slippageBps"],
    ["side=buy&amount=1&denom=quote&slippageBps=0", "bad slippageBps"],
    ["side=buy&amount=1&denom=quote&slippageBps=5001", "bad slippageBps"],
    ["side=buy&amount=1&denom=quote&slippageBps=1.5", "bad slippageBps"],
    ["side=buy&amount=1&denom=quote&slippageBps=100&holder=yes", "bad holder"],
  ])("answers 400 for ?%s", async (query, error) => {
    const res = await call(ADDR, query);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error });
    expect(poolKey).not.toHaveBeenCalled();
  });

  it("answers 404 when the token has no listed pool", async () => {
    poolKey.mockResolvedValue(null);
    const res = await call(ADDR, OK);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ error: "no listed pool" });
    expect(poolKey).toHaveBeenCalledWith(ADDR);
  });

  it("answers 200 with the whole priced shape and never lets it be cached", async () => {
    exactIn.mockResolvedValue(199n * 10n ** 18n);
    const res = await call(ADDR.toUpperCase().replace("0X", "0x"), OK);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "call",
      "minReceived",
      "payAmount",
      "poolFeePct",
      "priceImpactPct",
      "receiveAmount",
      "routable",
      "routerFeeAmount",
      "routerFeePct",
    ]);
    expect(body.routable).toBe(true);
    expect(body.routerFeePct).toBe(0.5);
    expect(body.poolFeePct).toBe(0.3);
    expect([
      Number(body.payAmount),
      Number(body.receiveAmount),
      Number(body.minReceived),
      Number(body.routerFeeAmount),
    ]).toEqual([100, 199, 197.01, 0.5]);
    expect(body.call).toEqual({
      poolKey: { currency0: TOKEN, currency1: QUOTE, fee: 3000, tickSpacing: 60, hooks: ZERO },
      zeroForOne: false,
      amountIn: "100000000",
      amountOutMin: "197010000000000000000",
      tokenIn: QUOTE,
      tokenOut: TOKEN,
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
    });
    // The path segment is lowercased before the lookup, and the fee came off the input.
    expect(poolKey).toHaveBeenCalledWith(ADDR);
    expect(exactIn).toHaveBeenCalledWith({ poolKey: POOL, zeroForOne: false, exactAmount: 99_500_000n });
  });

  it("passes holder=1 through to the fee, and inverts when the amount names the receive side", async () => {
    exactOut.mockResolvedValue(100_000_000n);
    exactIn.mockResolvedValue(200n * 10n ** 18n);
    const res = await call(ADDR, "side=buy&amount=200&denom=token&slippageBps=50&holder=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.routerFeePct).toBe(0);
    expect(Number(body.routerFeeAmount)).toBe(0);
    // A holder pays no fee, so the gross-up is the identity and the net equals the input.
    expect(exactOut).toHaveBeenCalledWith({ poolKey: POOL, zeroForOne: false, exactAmount: 200n * 10n ** 18n });
    expect(exactIn).toHaveBeenCalledWith({ poolKey: POOL, zeroForOne: false, exactAmount: 100_000_000n });
    expect((body.call as { amountIn: string }).amountIn).toBe("100000000");
  });

  it("prices two concurrent requests for the same pool independently: a refusal is never shared", async () => {
    // The bug this pins: pricing used to run inside `ttlCache`'s loader, so a concurrent request
    // for the same pool key could inherit whichever outcome the in-flight call happened to produce.
    // A huge amount the pool refuses and a small one it serves happily, requested at the same time,
    // must each be priced on their own numbers — never on the other request's.
    exactIn.mockImplementation(async (call: QuoterCall) => {
      // amount=100 nets 99_500_000 (6 dp); amount=100000000 nets 99_500_000_000_000 — comfortably
      // apart, so the mock can tell the two requests' own calls apart without a shared counter.
      if (call.exactAmount > 1_000_000_000n) throw new NotRoutableError("pool cannot be routed");
      return 199n * 10n ** 18n;
    });
    const [refused, servable] = await Promise.all([
      call(ADDR, "side=buy&amount=100000000&denom=quote&slippageBps=100"),
      call(ADDR, OK), // amount=100
    ]);
    expect(refused.status).toBe(200);
    await expect(refused.json()).resolves.toEqual({ routable: false });
    expect(servable.status).toBe(200);
    const body = (await servable.json()) as { routable: boolean; receiveAmount: string };
    expect(body.routable).toBe(true);
    expect(body.receiveAmount).toBe("199");
    expect(exactIn).toHaveBeenCalledTimes(2);
  });

  it("answers 503 when the chain cannot be reached, without echoing the endpoint", async () => {
    // Exactly what the quoter throws for a transport failure (ruling 1); the route knows this
    // class and nothing about viem's own error taxonomy.
    exactIn.mockRejectedValue(
      new QuoterUnavailableError(new HttpRequestError({ url: "https://rpc.internal.example/secret-key" })),
    );
    const res = await call(ADDR, OK);
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("15");
    await expect(res.json()).resolves.toEqual({ error: "rpc unavailable" });
    const logged = vi.mocked(console.warn).mock.calls.flat().join(" ");
    expect(logged).not.toContain("secret-key");
  });

  it("answers 503 when the market store is unavailable", async () => {
    poolKey.mockRejectedValue(new DbUnavailableError("database unavailable (ECONNREFUSED)"));
    const res = await call(ADDR, OK);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "database unavailable" });
  });
});
