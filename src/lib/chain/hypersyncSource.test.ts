import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { POOL_MANAGER, POOL_MANAGER_EVENTS_ABI, TOPIC0 } from "./abi";
import { createHyperSyncSource } from "./hypersyncSource";

const URL = "https://hypersync.test";
const TOKEN = "test-token";
const POOL_ID = ("0x" + "1".repeat(64)) as `0x${string}`;
const SENDER = "0x2222222222222222222222222222222222222222";
const TX_HASH = ("0x" + "5".repeat(64)) as `0x${string}`;
const TX_FROM = "0x6666666666666666666666666666666666666666";

/** A no-op, instant sleep so a retry test never actually waits, and captures the ms it was asked to wait. */
function fakeSleep() {
  const waits: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    waits.push(ms);
  });
  return { sleep, waits };
}

/** One HyperSync `/query` response envelope: `chunks` become `data`, in order. */
function page(chunks: Array<{ logs?: unknown[]; blocks?: unknown[]; transactions?: unknown[] }>, nextBlock: number) {
  return { data: chunks, next_block: nextBlock, archive_height: 999_999_999 };
}

/** Topics + data for one Swap log, HyperSync-shaped (a raw JSON object, not yet decoded). */
function swapLog(opts: { blockNumber?: number; logIndex?: number; txHash?: string; amount0?: bigint; amount1?: bigint } = {}) {
  const topics = encodeEventTopics({ abi: POOL_MANAGER_EVENTS_ABI, eventName: "Swap", args: { id: POOL_ID, sender: SENDER } });
  const data = encodeAbiParameters(
    [{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }],
    [opts.amount0 ?? -1000n, opts.amount1 ?? 2000n, 79_228_162_514_264_337_593_543_950_336n, 123_456n, 100, 3000],
  );
  return {
    block_number: opts.blockNumber ?? 100,
    log_index: opts.logIndex ?? 0,
    transaction_hash: opts.txHash ?? TX_HASH,
    topic0: topics[0],
    topic1: topics[1],
    topic2: topics[2],
    // topic3 intentionally absent: Swap has only two indexed params (id, sender).
    data,
  };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("createHyperSyncSource", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("head", () => {
    it("GETs {url}/height and returns the height", async () => {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ height: 68_689_936 }));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await expect(source.head()).resolves.toBe(68_689_936);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchImpl.mock.calls[0]!;
      expect(calledUrl).toBe(`${URL}/height`);
      expect((init as RequestInit).method).toBe("GET");
      expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    });
  });

  describe("fetch: request shape", () => {
    it("POSTs {url}/query with the documented body and field selection", async () => {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(page([], 200)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await source.fetch(100, 199);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchImpl.mock.calls[0]!;
      expect(calledUrl).toBe(`${URL}/query`);
      const req = init as RequestInit;
      expect((req.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      const body = JSON.parse(String(req.body)) as Record<string, unknown>;
      expect(body).toEqual({
        from_block: 100,
        to_block: 200, // exclusive: to + 1
        logs: [{ address: [POOL_MANAGER], topics: [[TOPIC0.initialize, TOPIC0.swap, TOPIC0.modifyLiquidity]] }],
        field_selection: {
          block: ["number", "timestamp"],
          log: ["block_number", "log_index", "transaction_hash", "topic0", "topic1", "topic2", "topic3", "data"],
          transaction: ["hash", "from"],
        },
      });
    });
  });

  describe("fetch: decoding and joining", () => {
    it("decodes a log, parses the block's hex timestamp, and attributes the transaction's sender", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          page(
            [
              {
                logs: [swapLog()],
                blocks: [{ number: 100, timestamp: "0x6ab0f871" }],
                transactions: [{ hash: TX_HASH, from: TX_FROM }],
              },
            ],
            200,
          ),
        ),
      );
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      const { events, nextBlock } = await source.fetch(100, 199);
      expect(nextBlock).toBe(200);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "swap",
        block: 100,
        logIndex: 0,
        timestamp: 0x6ab0f871,
        txHash: TX_HASH.toLowerCase(),
        txFrom: TX_FROM.toLowerCase(),
        poolId: POOL_ID.toLowerCase(),
        amount0: -1000n,
        amount1: 2000n,
      });
    });

    it("joins blocks, transactions and logs across separate chunks of the same response", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          page(
            [
              { blocks: [{ number: 100, timestamp: "0x64" }] }, // chunk 1: only the block
              { transactions: [{ hash: TX_HASH, from: TX_FROM }] }, // chunk 2: only the transaction
              { logs: [swapLog({ blockNumber: 100 })] }, // chunk 3: only the log
            ],
            200,
          ),
        ),
      );
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      const { events } = await source.fetch(100, 199);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ timestamp: 0x64, txFrom: TX_FROM.toLowerCase() });
    });

    it("sorts events by (block, logIndex) ascending regardless of response order", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          page(
            [
              {
                logs: [
                  swapLog({ blockNumber: 105, logIndex: 2 }),
                  swapLog({ blockNumber: 100, logIndex: 5 }),
                  swapLog({ blockNumber: 100, logIndex: 1 }),
                ],
                blocks: [
                  { number: 105, timestamp: "0x1" },
                  { number: 100, timestamp: "0x2" },
                ],
                transactions: [{ hash: TX_HASH, from: TX_FROM }],
              },
            ],
            200,
          ),
        ),
      );
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      const { events } = await source.fetch(100, 199);
      expect(events.map((e) => [e.block, e.logIndex])).toEqual([
        [100, 1],
        [100, 5],
        [105, 2],
      ]);
    });

    it("drops a log whose topic0 is not one of the three tracked events", async () => {
      const unknownLog = { ...swapLog({ blockNumber: 100, logIndex: 0 }), topic0: "0x" + "9".repeat(64) };
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          page(
            [
              {
                logs: [unknownLog, swapLog({ blockNumber: 100, logIndex: 1 })],
                blocks: [{ number: 100, timestamp: "0x1" }],
                transactions: [{ hash: TX_HASH, from: TX_FROM }],
              },
            ],
            200,
          ),
        ),
      );
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      const { events } = await source.fetch(100, 199);
      expect(events).toHaveLength(1);
      expect(events[0]?.logIndex).toBe(1);
    });
  });

  describe("fetch: nextBlock", () => {
    it("returns the response's next_block when it stops short of the requested range", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(page([], 150)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      const { nextBlock } = await source.fetch(100, 199);
      expect(nextBlock).toBe(150);
    });

    it("clamps nextBlock to to+1 when the response overshoots the requested range", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(page([], 5_000_000)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      const { nextBlock } = await source.fetch(100, 199);
      expect(nextBlock).toBe(200);
    });

    it("throws when the response makes no progress past fromBlock", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(page([], 100)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await expect(source.fetch(100, 199)).rejects.toThrow(/no progress/i);
    });

    it("throws when the response regresses below fromBlock", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(page([], 50)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await expect(source.fetch(100, 199)).rejects.toThrow(/no progress/i);
    });
  });

  describe("fetch: missing timestamp", () => {
    it("throws when a log's block has no matching timestamp anywhere in the response", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          page(
            [
              {
                logs: [swapLog({ blockNumber: 100 })],
                blocks: [], // block 100 never arrives
                transactions: [{ hash: TX_HASH, from: TX_FROM }],
              },
            ],
            200,
          ),
        ),
      );
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await expect(source.fetch(100, 199)).rejects.toThrow(/timestamp/i);
    });
  });

  describe("retries", () => {
    it("backs off on a 429 then succeeds on the retry", async () => {
      const { sleep, waits } = fakeSleep();
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ message: "slow down" }, 429);
        return jsonResponse(page([], 200));
      });
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, sleep });
      const { nextBlock } = await source.fetch(100, 199);
      expect(nextBlock).toBe(200);
      expect(calls).toBe(2);
      expect(source.requests).toBe(2);
      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeGreaterThan(0);
    });

    it("honours Retry-After as a floor under the backoff", async () => {
      const { sleep, waits } = fakeSleep();
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ message: "slow down" }, 429, { "Retry-After": "5" });
        return jsonResponse(page([], 200));
      });
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, sleep });
      await source.fetch(100, 199);
      expect(waits[0]).toBe(5000); // the header (5s) exceeds the first backoff step, so it wins
    });

    it("retries a 5xx and a rejected fetch the same way", async () => {
      const { sleep } = fakeSleep();
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({}, 503);
        if (calls === 2) throw new Error("ECONNRESET");
        return jsonResponse(page([], 200));
      });
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, sleep });
      const { nextBlock } = await source.fetch(100, 199);
      expect(nextBlock).toBe(200);
      expect(calls).toBe(3);
      expect(source.requests).toBe(3);
    });

    it("gives up after maxAttempts on a persistent 5xx", async () => {
      const { sleep } = fakeSleep();
      const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, sleep, maxAttempts: 3 });
      await expect(source.fetch(100, 199)).rejects.toThrow(/503/);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(source.requests).toBe(3);
    });

    it("fails a 401 on the first attempt with a clear message, never retrying", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ message: "bad token" }, 401));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await expect(source.fetch(100, 199)).rejects.toThrow("HyperSync rejected the API token");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(source.requests).toBe(1);
    });

    it("fails a 403 on the first attempt with a clear message, never retrying", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ message: "forbidden" }, 403));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await expect(source.fetch(100, 199)).rejects.toThrow("HyperSync rejected the API token");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe("the token", () => {
    it("appears in the Authorization header and never in a thrown message", async () => {
      const secret = "sekret-do-not-leak";
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ message: `token was ${secret}` }, 401));
      const source = createHyperSyncSource({ url: URL, token: secret, fetchImpl });
      const err: unknown = await source.fetch(100, 199).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(secret);
      const [, init] = fetchImpl.mock.calls[0]!;
      expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${secret}` });
    });

    it("is read lazily: construction never throws without one, but the first call does", async () => {
      vi.stubEnv("HYPERSYNC_API_TOKEN", "");
      vi.stubEnv("ENVIO_API_TOKEN", "");
      const fetchImpl = vi.fn();
      expect(() => createHyperSyncSource({ url: URL, fetchImpl })).not.toThrow();
      const source = createHyperSyncSource({ url: URL, fetchImpl });
      await expect(source.head()).rejects.toThrow(/HYPERSYNC_API_TOKEN/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("falls back from HYPERSYNC_API_TOKEN to ENVIO_API_TOKEN when the first is unset", async () => {
      vi.stubEnv("HYPERSYNC_API_TOKEN", "");
      vi.stubEnv("ENVIO_API_TOKEN", "fallback-token");
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ height: 1 }));
      const source = createHyperSyncSource({ url: URL, fetchImpl });
      await source.head();
      const [, init] = fetchImpl.mock.calls[0]!;
      expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer fallback-token" });
    });
  });

  describe("requests", () => {
    it("starts at 0 and accumulates across multiple calls on the same source", async () => {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ height: 1 }));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      expect(source.requests).toBe(0);
      await source.head();
      expect(source.requests).toBe(1);
      await source.head();
      expect(source.requests).toBe(2);
    });

    it("counts every retry attempt, not just successful calls", async () => {
      const { sleep } = fakeSleep();
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        if (calls < 3) return jsonResponse({}, 503);
        return jsonResponse({ height: 1 });
      });
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, sleep });
      await source.head();
      expect(source.requests).toBe(3);
    });
  });

  describe("defaults", () => {
    it("uses the documented default URL when none is given", async () => {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ height: 1 }));
      const source = createHyperSyncSource({ token: TOKEN, fetchImpl });
      await source.head();
      const [calledUrl] = fetchImpl.mock.calls[0]!;
      expect(calledUrl).toBe("https://4663.hypersync.xyz/height");
    });

    it("prefers an explicit url over HYPERSYNC_URL, which is preferred over the default", async () => {
      vi.stubEnv("HYPERSYNC_URL", "https://env.test");
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ height: 1 }));
      const source = createHyperSyncSource({ token: TOKEN, fetchImpl });
      await source.head();
      expect(fetchImpl.mock.calls[0]![0]).toBe("https://env.test/height");
    });
  });
});
