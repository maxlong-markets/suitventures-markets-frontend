import { describe, expect, it } from "vitest";
import { EnvioUnavailableError, type gql } from "@/lib/envio/client";
import { createEnvioSource } from "./envioSource";
import type { Limiter } from "./limiter";

type Call = { query: string; variables: Record<string, unknown> };

/** A gql double: records every document with its variables and answers from a queue (an Error entry is thrown). */
function fakeGql(responses: unknown[]) {
  const calls: Call[] = [];
  const fn = (async (query: string, variables: Record<string, unknown> = {}) => {
    calls.push({ query, variables });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  }) as typeof gql;
  return { fn, calls };
}

function countingLimiter() {
  const limiter: Limiter & { takes: number } = {
    takes: 0,
    async take() {
      limiter.takes += 1;
    },
  };
  return limiter;
}

/** Documents are compared with whitespace collapsed, so their layout in the source is free. */
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const POOL = "0x" + "ab".repeat(32);
const POOL2 = "0x" + "cd".repeat(32);
const POOL_FIELDS = "id token_id quote_id tokenIsCurrency0 hooks fee tickSpacing origin createdAt priceQuote tvlToken tvlQuote swapCount lastSwapAt volumeQuoteAllTime sqrtPriceX96";
const TOKEN_FIELDS = "id address symbol name decimals totalSupply holdersCount poolCount origin createdAt primaryPool_id metadataLoaded";
const SWAP_FIELDS = "id pool_id token_id timestamp side amountToken amountQuote priceQuote wallet txHash";
const CANDLE_FIELDS = "id pool_id t open high low close volumeQuote volumeToken trades";
const BALANCE_FIELDS = "id token_id holder balance updatedAt";
const keyset = (col: string) => `{ _or: [ { ${col}: { _gt: $k } }, { ${col}: { _eq: $k }, id: { _gt: $kid } } ] }`;
const ordered = (col: string) => `order_by: [ { ${col}: asc }, { id: asc } ], limit: $limit`;

describe("createEnvioSource", () => {
  it("awaits the limiter, counts one query per request and maps quotes", async () => {
    const g = fakeGql([{ Quote: [{ id: "q" }], QuotePrice: [{ id: "q", usdPrice: "1" }] }]);
    const limiter = countingLimiter();
    const source = createEnvioSource({ gql: g.fn, limiter });
    expect(await source.quotes()).toEqual({ quotes: [{ id: "q" }], prices: [{ id: "q", usdPrice: "1" }] });
    expect(limiter.takes).toBe(1);
    expect(source.queries).toBe(1);
    expect(norm(g.calls[0].query)).toContain("Quote { id address symbol name decimals enabled }");
    expect(norm(g.calls[0].query)).toContain("QuotePrice { id usdPrice updatedAt aggregator }");
  });

  it("pages pools that traded with a (lastSwapAt, id) keyset", async () => {
    const g = fakeGql([{ Pool: [] }, { Pool: [{ id: POOL }] }]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter() });
    expect(await source.poolsSince(100, null, 1000)).toEqual([]);
    expect(await source.poolsSince(100, { lastSwapAt: 150, id: POOL }, 1000)).toEqual([{ id: POOL }]);
    const q = norm(g.calls[0].query);
    expect(q).toContain(`Pool(where: { _and: [ { lastSwapAt: { _gte: $since } }, ${keyset("lastSwapAt")} ] }, ${ordered("lastSwapAt")}) { ${POOL_FIELDS} }`);
    expect(g.calls[0].variables).toEqual({ since: 100, limit: 1000, k: -1, kid: "" });
    expect(g.calls[1].variables).toEqual({ since: 100, limit: 1000, k: 150, kid: POOL });
    expect(source.queries).toBe(2);
  });

  it("pages new pools by (createdAt, id) among the never-traded", async () => {
    const g = fakeGql([{ Pool: [] }]);
    await createEnvioSource({ gql: g.fn, limiter: countingLimiter() }).poolsCreatedSince(7, { createdAt: 9, id: POOL }, 50);
    const q = norm(g.calls[0].query);
    expect(q).toContain(`Pool(where: { _and: [ { createdAt: { _gte: $since } }, { lastSwapAt: { _is_null: true } }, ${keyset("createdAt")} ] }, ${ordered("createdAt")}) { ${POOL_FIELDS} }`);
    expect(g.calls[0].variables).toEqual({ since: 7, limit: 50, k: 9, kid: POOL });
  });

  it("pages the swaps of a pool batch by (timestamp, id)", async () => {
    const g = fakeGql([{ Swap: [] }]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter() });
    expect(await source.swapsFor([], 5, null, 10)).toEqual([]);
    await source.swapsFor([POOL, POOL2], 5, null, 10);
    expect(g.calls).toHaveLength(1);
    const q = norm(g.calls[0].query);
    expect(q).toContain(`Swap(where: { _and: [ { pool_id: { _in: $pools } }, { timestamp: { _gte: $since } }, ${keyset("timestamp")} ] }, ${ordered("timestamp")}) { ${SWAP_FIELDS} }`);
    expect(g.calls[0].variables).toEqual({ pools: [POOL, POOL2], since: 5, limit: 10, k: -1, kid: "" });
  });

  it("fetches the open h1/d1 buckets by id on the first candle page only, and never selects interval", async () => {
    const open = [`${POOL}-h1-3600`, `${POOL}-d1-0`];
    const g = fakeGql([{ recent: [{ id: "r1" }], open: [{ id: "o1" }] }, { recent: [{ id: "r2" }] }]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter() });
    expect(await source.candlesFor([POOL], 100, open, null, 1000)).toEqual({ recent: [{ id: "r1" }], open: [{ id: "o1" }] });
    expect(await source.candlesFor([POOL], 100, open, { t: 120, id: "r1" }, 1000)).toEqual({ recent: [{ id: "r2" }], open: [] });
    const first = norm(g.calls[0].query);
    const next = norm(g.calls[1].query);
    for (const q of [first, next]) {
      expect(q).toContain(`recent: Candle(where: { _and: [ { pool_id: { _in: $pools } }, { t: { _gte: $since } }, ${keyset("t")} ] }, ${ordered("t")}) { ${CANDLE_FIELDS} }`);
      expect(q).not.toContain("interval");
    }
    expect(first).toContain(`open: Candle(where: { id: { _in: $openIds } }) { ${CANDLE_FIELDS} }`);
    expect(next).not.toContain("open:");
    expect(g.calls[0].variables).toEqual({ pools: [POOL], since: 100, limit: 1000, openIds: open, k: -1, kid: "" });
    expect(g.calls[1].variables).toEqual({ pools: [POOL], since: 100, limit: 1000, k: 120, kid: "r1" });
    expect(await source.candlesFor([], 100, open, null, 1000)).toEqual({ recent: [], open: [] });
    expect(g.calls).toHaveLength(2);
  });

  it("looks tokens up by id", async () => {
    const g = fakeGql([{ Token: [{ id: "t" }] }]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter() });
    expect(await source.tokensById([])).toEqual([]);
    expect(await source.tokensById(["0xa", "0xb"])).toEqual([{ id: "t" }]);
    expect(norm(g.calls[0].query)).toContain(`Token(where: { id: { _in: $ids } }) { ${TOKEN_FIELDS} }`);
    expect(g.calls[0].variables).toEqual({ ids: ["0xa", "0xb"] });
  });

  it("fetches top holders for a batch of tokens in one request, one aliased selection per token, flattened in request order", async () => {
    const g = fakeGql([{ t0: [{ id: "b0" }], t1: [{ id: "b1" }] }]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter() });
    expect(await source.topHoldersBatch(["0xa", "0xb"], 100)).toEqual([{ id: "b0" }, { id: "b1" }]);
    expect(g.calls).toHaveLength(1);
    const q = norm(g.calls[0].query);
    expect(q).toContain(`t0: TokenBalance(where: { token_id: { _eq: $t0 }, balance: { _gt: "0" } }, order_by: { balance: desc }, limit: $limit) { ${BALANCE_FIELDS} }`);
    expect(q).toContain(`t1: TokenBalance(where: { token_id: { _eq: $t1 }, balance: { _gt: "0" } }, order_by: { balance: desc }, limit: $limit) { ${BALANCE_FIELDS} }`);
    expect(g.calls[0].variables).toEqual({ t0: "0xa", t1: "0xb", limit: 100 });
    expect(source.queries).toBe(1);
  });

  it("returns [] without a request for an empty topHoldersBatch", async () => {
    const g = fakeGql([]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter() });
    expect(await source.topHoldersBatch([], 100)).toEqual([]);
    expect(g.calls).toHaveLength(0);
    expect(source.queries).toBe(0);
  });

  it("reads chain 4663 from chain_metadata and fails when it is missing", async () => {
    const rows = [{ chain_id: 1, latest_processed_block: 5, block_height: 9 }, { chain_id: 4663, latest_processed_block: 10, block_height: 12 }];
    const g = fakeGql([{ chain_metadata: rows }, { chain_metadata: [] }]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter() });
    expect(await source.chainMeta()).toEqual({ latestProcessedBlock: 10, blockHeight: 12 });
    expect(norm(g.calls[0].query)).toContain("chain_metadata { chain_id latest_processed_block block_height }");
    await expect(source.chainMeta()).rejects.toBeInstanceOf(EnvioUnavailableError);
  });

  it("walks id ranges ascending, bounding them only when beforeId is given", async () => {
    const g = fakeGql([{ Token: [] }, { Pool: [] }, { Swap: [] }, { Candle: [] }]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter() });
    await source.tokensPage("", 1000);
    await source.poolsPage("0x1", 1000);
    await source.swapsPage("0x1", "0x2", 1000);
    await source.candlesPage("0x1", null, 1000);
    const [tokens, pools, swaps, candles] = g.calls.map((c) => norm(c.query));
    expect(tokens).toContain(`Token(where: { id: { _gt: $after } }, order_by: { id: asc }, limit: $limit) { ${TOKEN_FIELDS} }`);
    expect(pools).toContain(`Pool(where: { id: { _gt: $after } }, order_by: { id: asc }, limit: $limit) { ${POOL_FIELDS} }`);
    expect(swaps).toContain(`Swap(where: { id: { _gt: $after, _lt: $before } }, order_by: { id: asc }, limit: $limit) { ${SWAP_FIELDS} }`);
    expect(candles).toContain(`Candle(where: { id: { _gt: $after } }, order_by: { id: asc }, limit: $limit) { ${CANDLE_FIELDS} }`);
    expect(g.calls[0].variables).toEqual({ after: "", limit: 1000 });
    expect(g.calls[2].variables).toEqual({ after: "0x1", before: "0x2", limit: 1000 });
    expect(g.calls[3].variables).toEqual({ after: "0x1", limit: 1000 });
    expect(source.queries).toBe(4);
  });

  it("does not retry when retry is false", async () => {
    const g = fakeGql([new EnvioUnavailableError("indexer responded 429")]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter(), retry: false });
    await expect(source.quotes()).rejects.toThrow("responded 429");
    expect(g.calls).toHaveLength(1);
    expect(source.queries).toBe(1);
  });

  it("retries with the given options: attempts 2 gives up after the second failure, each attempt counted", async () => {
    const g = fakeGql([new EnvioUnavailableError("indexer responded 429"), new EnvioUnavailableError("indexer responded 429"), { Quote: [], QuotePrice: [] }]);
    const source = createEnvioSource({ gql: g.fn, limiter: countingLimiter(), retry: { attempts: 2, sleep: async () => {} } });
    await expect(source.quotes()).rejects.toThrow("responded 429");
    expect(g.calls).toHaveLength(2);
    expect(source.queries).toBe(2);
  });
});
