import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSiweMessage } from "viem/siwe";
import type { Address, Hex, HoldersView, Quote, SwapCall, TokenPair } from "@/lib/types";
import { EnvioDataSource, StoreUnavailableError } from "./envio";

const TOKEN = "0x000000000000000000000000000000000000000a";
const QUOTE_ADDRESS = "0x000000000000000000000000000000000000000b";

const pair = {
  id: TOKEN, ticker: "AI", name: "Artificial Inu", address: TOKEN, quote: "NVDA", origin: "LONG",
  tradeable: true, priceUsd: 0.1943, priceQuote: 0.000866, change1h: 0, change24h: 0, vol24h: 0,
  mcap: 0, fdv: 0, liquidity: 1_000_000, holders: 0, createdAt: 0, bull: 0, bear: 0,
  poolId: "0x000000000000000000000000000000000000000c", hook: "", hookAddress: "0x0000000000000000000000000000000000000000", feeTier: "0.30%",
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
/** The capped /api/pairs list (C1): defaults to carrying the token, like every test before C1. */
let pairsList: TokenPair[] = [pair];
/** What GET /api/tokens/{address} answers — the fallback quoteSwap now takes when pairsList misses. */
let pairAnswer: { status: number; body: unknown } = { status: 200, body: pair };
const fetchMock = vi.fn(async (input: string) => {
  const url = String(input);
  if (url.startsWith("/api/pairs")) {
    return { ok: true, status: 200, json: async () => pairsList } as unknown as Response;
  }
  if (url.includes("/quote?")) {
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body } as unknown as Response;
  }
  // GET /api/tokens/{address} — EnvioDataSource.pair()'s own route.
  return {
    ok: pairAnswer.status >= 200 && pairAnswer.status < 300,
    status: pairAnswer.status,
    json: async () => pairAnswer.body,
  } as unknown as Response;
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
    pairsList = [pair];
    pairAnswer = { status: 200, body: pair };
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

  // C1: a token outside the capped /api/pairs list still has a page (usePair falls back to
  // pair(id) the same way), so quoteSwap must not give up just because the list misses it.
  describe("a token absent from the capped pairs list (C1)", () => {
    beforeEach(() => {
      pairsList = []; // the 500-row window misses this token, exactly like AI/NVDA in production
    });

    it("quotes normally at amount 0, from the local path", async () => {
      const quote = await source().quoteSwap(TOKEN, "buy", "0", "quote", false, 1);
      expect(quote.call).toBeUndefined();
      expect(quote.routable).toBeUndefined();
      expect(quote.poolFeePct).toBe(0.3); // localQuote's poolFeePctFor(pair), from the fallback pair
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls).toContain("/api/pairs");
      expect(urls).toContain(`/api/tokens/${TOKEN}`);
      expect(urls.some((u) => u.includes("/quote?"))).toBe(false);
    });

    it("quotes normally at a real amount, from the route path", async () => {
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
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls).toContain(`/api/tokens/${TOKEN}`);
      expect(urls.some((u) => u.includes("/quote?"))).toBe(true);
    });

    it("still throws Unknown token when the token route does not know it either", async () => {
      pairAnswer = { status: 404, body: { error: "not found" } };
      await expect(source().quoteSwap(TOKEN, "buy", "0", "quote", false, 1)).rejects.toThrow(
        `Unknown token ${TOKEN}`,
      );
    });
  });
});

describe("EnvioDataSource sessions and user data", () => {
  const WALLET = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" as Address;
  /** What the next fetch answers, by path. */
  let routes: Record<string, { status: number; body?: unknown }>;
  const calls: { url: string; init?: RequestInit }[] = [];

  const sessionFetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = `${init?.method ?? "GET"} ${url.split("?")[0]}`;
    const answer = routes[key] ?? { status: 404 };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      // A route entry with no `body` at all models an empty response: real `Response#json()`
      // throws on one, and the traders 503 path's `.catch(() => null)` (review I1) needs a real
      // rejection here to prove it treats that the same as any other non-"no-store" 503.
      json: async () => {
        if (answer.body === undefined) throw new SyntaxError("Unexpected end of JSON input");
        return answer.body;
      },
    } as unknown as Response;
  });

  beforeEach(() => {
    calls.length = 0;
    routes = {
      "GET /api/session/nonce": { status: 200, body: { nonce: "cafebabe" } },
      "GET /api/session": { status: 200, body: { address: WALLET.toLowerCase() } },
      "POST /api/session": { status: 200, body: { address: WALLET.toLowerCase() } },
      "DELETE /api/session": { status: 204 },
      "GET /api/me/watchlist": { status: 200, body: [TOKEN] },
      [`PUT /api/me/watchlist/${TOKEN}`]: { status: 204 },
      [`DELETE /api/me/watchlist/${TOKEN}`]: { status: 204 },
      "GET /api/me/votes": { status: 200, body: { [TOKEN]: "bull" } },
      [`POST /api/me/votes/${TOKEN}`]: { status: 200, body: { dir: "bull", bull: 4, bear: 1 } },
    };
    sessionFetch.mockClear();
    vi.stubGlobal("fetch", sessionFetch);
    // This file runs under the `node` project, which has no `window`; `signIn` reads the page's
    // own host and origin, so the test says what page the user is on.
    vi.stubGlobal("window", {
      location: { host: "markets.suitventures.xyz", origin: "https://markets.suitventures.xyz" },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  function call(url: string): { url: string; init?: RequestInit } {
    const found = calls.find((c) => c.url.split("?")[0] === url);
    if (!found) throw new Error(`${url} was never called`);
    return found;
  }

  it("reads the session from the cookie route", async () => {
    await expect(source().session()).resolves.toBe(WALLET.toLowerCase());
  });

  it.each([401, 503])("answers null when the session route says %i", async (status) => {
    routes["GET /api/session"] = { status };
    await expect(source().session()).resolves.toBeNull();
  });

  it("signs in: nonce, then the signed message, then the cookie", async () => {
    // Typed with an explicit parameter (rather than `vi.fn(async () => ...)`) so `mock.calls[0]`
    // is `[string]`, not `[]`: TS2493 otherwise, since vitest's `MockParameters` is `Parameters<T>`
    // of the implementation actually passed in.
    const sign = vi.fn(async (_message: string) => "0xsig" as Hex);
    await expect(source().signIn(sign, WALLET)).resolves.toBe(WALLET.toLowerCase());
    expect(calls.map((c) => `${c.init?.method ?? "GET"} ${c.url}`)).toEqual([
      "GET /api/session/nonce",
      "POST /api/session",
    ]);
    const body = JSON.parse(String(call("/api/session").init?.body)) as { message: string; signature: string };
    expect(body.signature).toBe("0xsig");
    expect(body.message).toBe(sign.mock.calls[0][0]);
  });

  it("builds an EIP-4361 message with the page's domain, chain 4663 and a seven-day expiry", async () => {
    let signedMessage = "";
    await source().signIn(async (message) => {
      signedMessage = message;
      return "0xsig" as Hex;
    }, WALLET);
    const parsed = parseSiweMessage(signedMessage);
    expect(parsed.domain).toBe("markets.suitventures.xyz");
    expect(parsed.uri).toBe("https://markets.suitventures.xyz");
    expect(parsed.chainId).toBe(4663);
    expect(parsed.version).toBe("1");
    expect(parsed.statement).toBe("Sign in to SuitVentures Markets");
    expect(parsed.nonce).toBe("cafebabe");
    expect(parsed.address?.toLowerCase()).toBe(WALLET.toLowerCase());
    const issuedAt = parsed.issuedAt as Date;
    const expires = parsed.expirationTime as Date;
    expect(expires.getTime() - issuedAt.getTime()).toBe(7 * 86_400 * 1000);
  });

  it("throws when the server refuses the signature, so the modal can stay open", async () => {
    routes["POST /api/session"] = { status: 401, body: { error: "bad signature" } };
    await expect(source().signIn(async () => "0xsig" as Hex, WALLET)).rejects.toThrow("401");
  });

  it("signs out through DELETE, and treats an already-dead cookie as success", async () => {
    await source().signOut();
    expect(call("/api/session").init?.method).toBe("DELETE");
    routes["DELETE /api/session"] = { status: 401 };
    await expect(source().signOut()).resolves.toBeUndefined();
  });

  it("reads the watchlist and the votes without sending an address anywhere", async () => {
    const ds = source();
    await expect(ds.watchlist()).resolves.toEqual([TOKEN]);
    await expect(ds.votes()).resolves.toEqual({ [TOKEN]: "bull" });
    expect(calls.every((c) => !c.url.includes(WALLET.toLowerCase()))).toBe(true);
    expect(call("/api/me/watchlist").init?.credentials).toBe("same-origin");
  });

  it.each([401, 503])("answers an empty watchlist and no votes on %i, never an error", async (status) => {
    routes["GET /api/me/watchlist"] = { status };
    routes["GET /api/me/votes"] = { status };
    const ds = source();
    await expect(ds.watchlist()).resolves.toEqual([]);
    await expect(ds.votes()).resolves.toEqual({});
  });

  it("stars with PUT and unstars with DELETE, on the token's own path", async () => {
    const ds = source();
    await ds.setWatch(TOKEN.toUpperCase().replace("0X", "0x"), true);
    expect(call(`/api/me/watchlist/${TOKEN}`).init?.method).toBe("PUT");
    calls.length = 0;
    await ds.setWatch(TOKEN, false);
    expect(call(`/api/me/watchlist/${TOKEN}`).init?.method).toBe("DELETE");
  });

  // The counts come back with the write (23 Sep): the read path they would otherwise come from is
  // a thirty-second cache, so a client that refetched it to show its own vote read a stale number.
  it("posts a vote and answers the direction that now stands, with the token's counts", async () => {
    routes[`POST /api/me/votes/${TOKEN}`] = { status: 200, body: { dir: null, bull: 3, bear: 1 } };
    await expect(source().vote(TOKEN, "bull")).resolves.toEqual({ dir: null, bull: 3, bear: 1 });
    const posted = call(`/api/me/votes/${TOKEN}`);
    expect(posted.init?.method).toBe("POST");
    expect(JSON.parse(String(posted.init?.body))).toEqual({ dir: "bull" });
  });

  // Review M9: the id went into the path raw. The server validates the segment either way, so this
  // is habit rather than a hole — but a path segment is built, not interpolated.
  it("escapes the token id it puts in a write path", async () => {
    const hostile = "0xab/../session?x=1";
    const escaped = encodeURIComponent(hostile);
    await expect(source().setWatch(hostile, true)).rejects.toThrow("404");
    expect(calls.at(-1)?.url).toBe(`/api/me/watchlist/${escaped}`);
    await expect(source().vote(hostile, "bull")).rejects.toThrow("404");
    expect(calls.at(-1)?.url).toBe(`/api/me/votes/${escaped}`);
  });

  it("throws when a write is refused, so the optimistic star can be rolled back", async () => {
    routes[`PUT /api/me/watchlist/${TOKEN}`] = { status: 401 };
    await expect(source().setWatch(TOKEN, true)).rejects.toThrow("401");
  });

  // Task 4 review F3/F4: `credentials: "same-origin"` is load-bearing on every one of these —
  // including `signIn`'s nonce GET, which used to ride the shared `getJson` and so carried no
  // explicit marker at all. One row per method; stripping the marker from any single fetch call
  // any of them makes, including the nonce GET inside `signIn`, fails that row.
  it.each([
    ["session", () => source().session()],
    ["signIn", () => source().signIn(async () => "0xsig" as Hex, WALLET)],
    ["signOut", () => source().signOut()],
    ["watchlist", () => source().watchlist()],
    ["setWatch", () => source().setWatch(TOKEN, true)],
    ["votes", () => source().votes()],
    ["vote", () => source().vote(TOKEN, "bull")],
  ])("%s: every request it makes carries credentials: same-origin", async (_name, run) => {
    await run();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.init?.credentials === "same-origin")).toBe(true);
  });

  it("asks the traders route for the ordering it was given", async () => {
    routes["GET /api/traders"] = { status: 200, body: [{ wallet: TOKEN, volumeUsd: 1, trades: 2, tokens: 3 }] };
    await expect(source().traders("trades")).resolves.toEqual([
      { wallet: TOKEN, volumeUsd: 1, trades: 2, tokens: 3 },
    ]);
    expect(calls.map((c) => c.url)).toEqual(["/api/traders?by=trades"]);
  });

  it("turns the route's 503 into StoreUnavailableError only when its body carries the no-store code", async () => {
    routes["GET /api/traders"] = {
      status: 503,
      body: { error: "traders board needs the market store", code: "no-store" },
    };
    await expect(source().traders("volume")).rejects.toBeInstanceOf(StoreUnavailableError);
  });

  it("throws a plain error for a 503 without the code — a database outage, not a missing store", async () => {
    routes["GET /api/traders"] = { status: 503, body: { error: "database unavailable" } };
    await expect(source().traders("volume")).rejects.toThrow("503");
    await expect(source().traders("volume")).rejects.not.toBeInstanceOf(StoreUnavailableError);
  });

  it("throws a plain error for a 503 whose body is not JSON at all", async () => {
    routes["GET /api/traders"] = { status: 503 }; // no body — the mock's json() rejects, as an empty response would
    await expect(source().traders("volume")).rejects.toThrow("503");
    await expect(source().traders("volume")).rejects.not.toBeInstanceOf(StoreUnavailableError);
  });

  it("throws a plain error for any other traders failure", async () => {
    routes["GET /api/traders"] = { status: 500, body: { error: "internal error" } };
    await expect(source().traders("volume")).rejects.toThrow("500");
    await expect(source().traders("volume")).rejects.not.toBeInstanceOf(StoreUnavailableError);
  });
});

describe("EnvioDataSource.holders", () => {
  /** What GET /api/tokens/{address}/holders answers. */
  let holdersAnswer: { status: number; body: unknown };
  const holdersFetch = vi.fn(async (input: string) => {
    const url = String(input);
    if (!url.endsWith("/holders")) throw new Error(`unexpected request ${url}`);
    return { ok: holdersAnswer.status < 400, status: holdersAnswer.status, json: async () => holdersAnswer.body } as unknown as Response;
  });

  beforeEach(() => {
    holdersAnswer = { status: 200, body: null };
    holdersFetch.mockClear();
    vi.stubGlobal("fetch", holdersFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  // The tab needs the status and the as-of stamp, not only the rows (design section 5), so this
  // hands the route's answer through whole rather than unwrapping `.holders` as it used to.
  it("answers the route's whole view, on the token's own holders path", async () => {
    const view: HoldersView = {
      holders: [{ wallet: "0x1111111111111111111111111111111111111111" as Address, balance: 12.5, share: 1.25 }],
      count: 42,
      status: "ready",
      asOf: 1_789_547_000,
    };
    holdersAnswer = { status: 200, body: view };
    await expect(source().holders(TOKEN)).resolves.toEqual(view);
    expect(holdersFetch.mock.calls.map(([input]) => String(input))).toEqual([`/api/tokens/${TOKEN}/holders`]);
  });

  it.each(["building", "skipped"] as const)("carries a %s list through untouched", async (status) => {
    holdersAnswer = { status: 200, body: { holders: [], count: 0, status, asOf: null } };
    await expect(source().holders(TOKEN)).resolves.toEqual({ holders: [], count: 0, status, asOf: null });
  });

  it("throws when the route fails, so the tab can show the query's error rather than an empty list", async () => {
    holdersAnswer = { status: 503, body: { error: "database unavailable" } };
    await expect(source().holders(TOKEN)).rejects.toThrow("503");
  });
});
