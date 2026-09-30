import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearTtlCache } from "@/lib/envio/cache";
import type { PoolKeyRow } from "@/lib/market/poolKey";
import type { QuoteAsset, TokenPair } from "@/lib/types";
import { GET as tokenGet } from "../tokens/[address]/route";
import { GET as quoteGet } from "../tokens/[address]/quote/route";
import { lookupPair } from "./pairLookup";

const { pair, poolKey, quotes } = vi.hoisted(() => ({
  pair: vi.fn<(id: string) => Promise<TokenPair | null>>(),
  poolKey: vi.fn<(id: string, quoteId: string) => Promise<PoolKeyRow | null>>(),
  quotes: vi.fn<() => Promise<QuoteAsset[]>>(),
}));
vi.mock("@/lib/market/backend", () => ({ getBackend: () => ({ kind: "db", pair, poolKey, quotes }) }));

const ADDR = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const FOUND = { id: ADDR, ticker: "AI", name: "Artificial Inu" } as TokenPair;

describe("lookupPair", () => {
  beforeEach(() => {
    clearTtlCache();
    pair.mockReset();
  });

  // Fix round 1, finding 9: a malformed address answers null immediately, with no ttlCache call
  // and no database read at all, for every caller: the token page, which validated nothing of
  // its own before this, the token API and the quote route, which both already checked this
  // themselves but now share the same guard as a floor.
  it("answers null with no backend read at all for a malformed address", async () => {
    const result = await lookupPair("not-an-address");
    expect(result).toBeNull();
    expect(pair).not.toHaveBeenCalled();
  });

  it("answers null with no backend read for an address with the wrong number of hex characters", async () => {
    const result = await lookupPair("0x1234");
    expect(result).toBeNull();
    expect(pair).not.toHaveBeenCalled();
  });

  // Re-review finding 5: every caller already lowercases before calling this, but the helper
  // answering "not found" for a checksummed or uppercase id was a footgun of its own rather than
  // a fact about the address, and would have quietly served the wrong answer to a future caller
  // (a viem `getAddress` value, say) that did not lowercase first. On the round-1 code this test
  // asserted the opposite (null, no backend call); that is the very behaviour this round drops.
  it("lowercases a checksummed or uppercase address before checking and reading it", async () => {
    pair.mockResolvedValue(FOUND);
    const upper = ADDR.toUpperCase().replace("0X", "0x");
    const result = await lookupPair(upper);
    expect(result).toEqual(FOUND);
    expect(pair).toHaveBeenCalledWith(ADDR);
  });

  it("shares one memo entry for the same address regardless of casing", async () => {
    pair.mockResolvedValue(FOUND);
    const upper = ADDR.toUpperCase().replace("0X", "0x");
    await lookupPair(upper);
    await lookupPair(ADDR);
    expect(pair).toHaveBeenCalledTimes(1);
  });

  it("reads the backend for a well-formed address", async () => {
    pair.mockResolvedValue(FOUND);
    const result = await lookupPair(ADDR);
    expect(result).toEqual(FOUND);
    expect(pair).toHaveBeenCalledWith(ADDR);
  });
});

/**
 * Finding 3: the token page, the token API and the quote route all resolve `lookupPair` to the
 * same `ttlCache` key. This is the cross-route case the review named directly: a quote request
 * for a token not yet in the store must not leave the token API (or the page, which shares this
 * exact helper and so is covered by the same fix) serving that miss back afterwards. Before this
 * round, each of the three ran its own independent `ttlCache` call under the same key, so
 * whichever asked first decided, for the other two, whether the miss sat cached for the full
 * 30 s; on that code this test's second read would have been served the quote route's own stale
 * `null` and `pair` would have been called once, not twice.
 */
describe("lookupPair shared across the quote route and the token API (finding 3)", () => {
  beforeEach(() => {
    clearTtlCache();
    pair.mockReset();
    poolKey.mockReset();
    quotes.mockReset();
    quotes.mockResolvedValue([]);
  });

  it("a quote for a token not yet indexed does not poison the token API's answer once it lands", async () => {
    pair.mockResolvedValueOnce(null);
    const quoteRes = await quoteGet(
      new Request(`http://localhost:3000/api/tokens/${ADDR}/quote?side=buy&amount=100&denom=quote&slippageBps=100`),
      { params: Promise.resolve({ address: ADDR }) },
    );
    expect(quoteRes.status).toBe(404);
    expect(pair).toHaveBeenCalledTimes(1);

    pair.mockResolvedValueOnce(FOUND);
    const tokenRes = await tokenGet(new Request(`http://localhost:3000/api/tokens/${ADDR}`), {
      params: Promise.resolve({ address: ADDR }),
    });
    expect(tokenRes.status).toBe(200);
    // Not served the quote route's stale miss: the token API asked the backend again.
    expect(pair).toHaveBeenCalledTimes(2);
  });

  it("the reverse order holds too: a token-API miss does not poison the quote route's answer once it lands", async () => {
    pair.mockResolvedValueOnce(null);
    const tokenRes = await tokenGet(new Request(`http://localhost:3000/api/tokens/${ADDR}`), {
      params: Promise.resolve({ address: ADDR }),
    });
    expect(tokenRes.status).toBe(404);
    expect(pair).toHaveBeenCalledTimes(1);

    // quotes() stays empty (beforeEach), so the route answers 404 on the quote-asset step
    // without ever reaching poolKey(); only the pair lookup itself matters for this test.
    pair.mockResolvedValueOnce(FOUND);
    const quoteRes = await quoteGet(
      new Request(`http://localhost:3000/api/tokens/${ADDR}/quote?side=buy&amount=100&denom=quote&slippageBps=100`),
      { params: Promise.resolve({ address: ADDR }) },
    );
    expect(quoteRes.status).toBe(404);
    await expect(quoteRes.json()).resolves.toEqual({ error: "no listed pool" });
    expect(pair).toHaveBeenCalledTimes(2);
  });
});
