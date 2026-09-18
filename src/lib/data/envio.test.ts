import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Quote, SwapCall, TokenPair } from "@/lib/types";
import { EnvioDataSource } from "./envio";

const TOKEN = "0x000000000000000000000000000000000000000a";
const QUOTE_ADDRESS = "0x000000000000000000000000000000000000000b";

const pair = {
  id: TOKEN, ticker: "AI", name: "Artificial Inu", address: TOKEN, quote: "NVDA", origin: "LONG",
  tradeable: true, priceUsd: 0.1943, priceQuote: 0.000866, change1h: 0, change24h: 0, vol24h: 0,
  mcap: 0, fdv: 0, liquidity: 1_000_000, holders: 0, createdAt: 0, bull: 0, bear: 0,
  poolId: "0x000000000000000000000000000000000000000c", hook: "", feeTier: "0.30%",
} as TokenPair;

const PRICED = {
  routable: true,
  payAmount: "100",
  receiveAmount: "1000",
  minReceived: "990",
  routerFeePct: 0.5,
  routerFeeAmount: "0.5",
  poolFeePct: 0.3,
  priceImpactPct: 0.004,
  call: {
    poolKey: { currency0: TOKEN, currency1: QUOTE_ADDRESS, fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" },
    zeroForOne: false,
    amountIn: "100000000",
    amountOutMin: "990000000000000000000",
    tokenIn: QUOTE_ADDRESS,
    tokenOut: TOKEN,
    tokenInDecimals: 6,
    tokenOutDecimals: 18,
  } as SwapCall,
};

/** What the route answers next, and what every fetch was asked for. */
let answer: { status: number; body: unknown } = { status: 200, body: PRICED };
const fetchMock = vi.fn(async (input: string) => {
  const url = String(input);
  const res =
    url.startsWith("/api/pairs")
      ? { ok: true, status: 200, json: async () => [pair] }
      : { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
  return res as unknown as Response;
});

/** The one request that went to the quote route, parsed. Throws if there was none. */
function quoteCall(): URL {
  const url = fetchMock.mock.calls.map(([input]) => String(input)).find((u) => u.includes("/quote?"));
  if (!url) throw new Error("the quote route was never called");
  return new URL(url, "http://localhost:3000");
}

function source(): EnvioDataSource {
  return new EnvioDataSource();
}

describe("EnvioDataSource.quoteSwap", () => {
  beforeEach(() => {
    answer = { status: 200, body: PRICED };
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks the token's own quote route, with every parameter the route requires", async () => {
    await source().quoteSwap(TOKEN, "buy", "100", "quote", false, 1);
    const url = quoteCall();
    expect(url.pathname).toBe(`/api/tokens/${TOKEN}/quote`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      side: "buy",
      amount: "100",
      denom: "quote",
      slippageBps: "100",
      holder: "0",
    });
  });

  it("tells the route the holder rate the panel is showing", async () => {
    await source().quoteSwap(TOKEN, "sell", "5", "token", true, 0.5);
    expect(quoteCall().searchParams.get("holder")).toBe("1");
  });

  it.each([
    [0.5, "50"],
    [0.1, "10"],
    [1, "100"],
    [0.001, "1"], // below one basis point: clamped up, never to 0
    [100, "5000"], // above the route's ceiling: clamped down
  ])("turns %s %% of slippage into %s basis points", async (pct, bps) => {
    await source().quoteSwap(TOKEN, "buy", "1", "quote", false, pct);
    expect(quoteCall().searchParams.get("slippageBps")).toBe(bps);
  });

  it.each([
    ["125000.123456789012345678", "125000.123456789012345678"], // no double holds this
    ["0.0000001", "0.0000001"], // String(1e-7) would have been "1e-7"
    ["1.", "1"], // shapes the keyboard produces, which the route refuses
    [".5", "0.5"],
    ["0.50", "0.5"],
    ["0001.5", "1.5"],
  ])("sends the typed amount %s as %s, never through a float", async (typed, sent) => {
    await source().quoteSwap(TOKEN, "buy", typed, "quote", false, 1);
    expect(quoteCall().searchParams.get("amount")).toBe(sent);
  });

  it("answers amount 0 from the local approximation, without calling the route", async () => {
    const quote = await source().quoteSwap(TOKEN, "buy", "0", "quote", false, 1);
    expect(quote.call).toBeUndefined();
    expect(quote.routable).toBeUndefined();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(["/api/pairs"]);
  });

  it("maps the route's numbers onto Quote and keeps the call block identical", async () => {
    const quote = await source().quoteSwap(TOKEN, "buy", "100", "quote", false, 1);
    expect(quote).toEqual({
      payAmount: 100,
      receiveAmount: 1000,
      priceImpactPct: 0.004,
      routerFeePct: 0.5,
      poolFeePct: 0.3,
      minReceived: 990,
      routable: true,
      call: PRICED.call,
    } satisfies Quote);
  });

  it("maps routable:false to a zeroed quote with nothing to submit", async () => {
    answer = { status: 200, body: { routable: false } };
    const quote = await source().quoteSwap(TOKEN, "buy", "100", "quote", false, 1);
    expect(quote).toEqual({
      payAmount: 0,
      receiveAmount: 0,
      priceImpactPct: 0,
      routerFeePct: 0.5,
      poolFeePct: 0.3,
      minReceived: 0,
      routable: false,
    } satisfies Quote);
    expect(quote.call).toBeUndefined();
  });

  it("throws when the chain is unreachable, so the panel can say the quote failed", async () => {
    answer = { status: 503, body: { error: "rpc unavailable" } };
    await expect(source().quoteSwap(TOKEN, "buy", "100", "quote", false, 1)).rejects.toThrow("503");
  });
});
