import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, toEventSelector } from "viem";
import { LAUNCH_TOPIC0, LAUNCHPAD_EVENTS_ABI, POOL_MANAGER, POOL_MANAGER_EVENTS_ABI, TOPIC0 } from "./abi";
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

/** Topics + data for one Swap log, HyperSync-shaped (a raw JSON object, not yet decoded). `address` is the emitter; null omits it. */
function swapLog(opts: { blockNumber?: number; logIndex?: number; txHash?: string; amount0?: bigint; amount1?: bigint; address?: string | null } = {}) {
  const topics = encodeEventTopics({ abi: POOL_MANAGER_EVENTS_ABI, eventName: "Swap", args: { id: POOL_ID, sender: SENDER } });
  const data = encodeAbiParameters(
    [{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }],
    [opts.amount0 ?? -1000n, opts.amount1 ?? 2000n, 79_228_162_514_264_337_593_543_950_336n, 123_456n, 100, 3000],
  );
  return {
    ...(opts.address === null ? {} : { address: opts.address ?? POOL_MANAGER }),
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

const LAUNCHPAD = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const LAUNCHED_TOKEN = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
const FEE_PAYOUT = "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";

/** One FeesCollected log from the launchpad, HyperSync-shaped. */
function feesLog(opts: { logIndex?: number; address?: string } = {}) {
  const topics = encodeEventTopics({ abi: LAUNCHPAD_EVENTS_ABI, eventName: "FeesCollected", args: { token: LAUNCHED_TOKEN, payout: FEE_PAYOUT } });
  return {
    address: opts.address ?? LAUNCHPAD,
    block_number: 100,
    log_index: opts.logIndex ?? 0,
    transaction_hash: TX_HASH,
    topic0: topics[0],
    topic1: topics[1],
    topic2: topics[2],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [1000n, 10n, 700n, 7n]),
  };
}

// Derived here rather than copied from the source, so the test would catch a wrong constant there.
const TRANSFER_TOPIC0 = toEventSelector("Transfer(address,address,uint256)");
// Letters, not digits: the tests below upper-case these to prove transfers() lowercases what it sends and what
// it decodes, and a digit-only address would upper-case to itself and make those assertions vacuous.
const ERC20 = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const HOLDER_A = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const HOLDER_B = "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef";

/** An address as a 32-byte topic, the way an indexed `address` parameter is emitted: 24 zero nibbles then the 40. */
const addressTopic = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;

/**
 * One ERC-20 Transfer log, HyperSync-shaped (raw JSON, not yet decoded). It carries only the fields
 * transfers() asks for — no topic0, no transaction_hash — because HyperSync returns only the selected ones.
 * topic3 IS selected but still absent here: an ERC-20 Transfer has two indexed parameters, so it emits no third
 * topic, and an absent topic arrives as a missing key rather than a zero one.
 */
function transferLog(opts: { blockNumber?: number; logIndex?: number; from?: string; to?: string; value?: bigint; data?: string } = {}) {
  return {
    block_number: opts.blockNumber ?? 100,
    log_index: opts.logIndex ?? 0,
    topic1: addressTopic(opts.from ?? HOLDER_A),
    topic2: addressTopic(opts.to ?? HOLDER_B),
    data: opts.data ?? encodeAbiParameters([{ type: "uint256" }], [opts.value ?? 1n]),
  };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("createHyperSyncSource", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("rateLimitPerMinute (24 Sep 2026: the key's advertised budget, read from the response headers)", () => {
  it("is null before any request and reads the free package's 30,000-units-per-60-s limit at 1,000 a request as 30 a minute", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ height: 1 }, 200, { "x-ratelimit-limit": "30000, 30000;w=60", "x-ratelimit-cost": "1000", "x-ratelimit-remaining": "29000" }),
    );
    const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
    expect(source.rateLimitPerMinute).toBeNull();
    await source.head();
    expect(source.rateLimitPerMinute).toBe(30);
  });

  it("reads null (no advertised budget) from the paid package's answer, which carries a cost of 0 and no limit header", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ height: 1 }, 200, { "x-ratelimit-cost": "0" }));
    const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
    await source.head();
    expect(source.rateLimitPerMinute).toBeNull();
  });

  it("reads the budget off a 429 too — the one response that always carries the headers (review 24 Sep, I1)", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      // Only the 429 carries headers, so a value read here can have come from nowhere else.
      return call === 1
        ? jsonResponse({ error: "rate limit exceeded" }, 429, { "x-ratelimit-limit": "30000, 30000;w=60", "x-ratelimit-cost": "1000" })
        : jsonResponse({ height: 7 });
    });
    const { sleep } = fakeSleep();
    const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, sleep });
    await expect(source.head()).resolves.toBe(7);
    expect(source.rateLimitPerMinute).toBe(30);
  });

  it("scales a non-minute window and keeps the last answered value when a later response says nothing", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? jsonResponse({ height: 1 }, 200, { "x-ratelimit-limit": "6000;w=30", "x-ratelimit-cost": "1000" }) // 6 per 30 s = 12 a minute
        : jsonResponse({ height: 2 }, 200);
    });
    const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
    await source.head();
    expect(source.rateLimitPerMinute).toBe(12);
    await source.head();
    expect(source.rateLimitPerMinute).toBe(12);
  });
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
    it("POSTs {url}/query with the documented body and field selection, one selection without a launchpad", async () => {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(page([], 200)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, launchpad: null });
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
          log: ["block_number", "log_index", "transaction_hash", "address", "topic0", "topic1", "topic2", "topic3", "data"],
          transaction: ["hash", "from"],
        },
      });
    });

    // Spec 5.2: the launchpad rides the same request as a second selection filtered to its three activity events.
    it("adds the launchpad as a second selection of its three activity topics, lowercased, still one request", async () => {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(page([], 200)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, launchpad: LAUNCHPAD.toUpperCase().replace("0X", "0x") });
      await source.fetch(100, 199);
      const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as Record<string, unknown>;
      expect(body.logs).toEqual([
        { address: [POOL_MANAGER], topics: [[TOPIC0.initialize, TOPIC0.swap, TOPIC0.modifyLiquidity]] },
        { address: [LAUNCHPAD], topics: [[LAUNCH_TOPIC0.launched, LAUNCH_TOPIC0.feesCollected, LAUNCH_TOPIC0.payoutChanged]] },
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
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

    it("decodes a launchpad log by its address, and drops a PoolManager-shaped log from any other address", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          page(
            [
              {
                logs: [feesLog({ logIndex: 0 }), swapLog({ logIndex: 1, address: "0x9999999999999999999999999999999999999999" }), swapLog({ logIndex: 2 })],
                blocks: [{ number: 100, timestamp: "0x1" }],
                transactions: [{ hash: TX_HASH, from: TX_FROM }],
              },
            ],
            200,
          ),
        ),
      );
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, launchpad: LAUNCHPAD });
      const { events } = await source.fetch(100, 199);
      expect(events.map((e) => [e.kind, e.logIndex])).toEqual([
        ["launchFees", 0],
        ["swap", 2],
      ]);
      expect(events[0]).toMatchObject({ kind: "launchFees", token: LAUNCHED_TOKEN, payout: FEE_PAYOUT, tokenFees: 1000n, txFrom: TX_FROM.toLowerCase() });
    });

    // A missing address fails the cycle, like a missing timestamp: dropping the log would move the cursor past it and
    // lose it for good, while a throw keeps the cursor where it was so the next cycle retries the range.
    it("fails the fetch, returning no events, when a log arrives without an address", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          page(
            [
              {
                logs: [swapLog({ logIndex: 0 }), swapLog({ logIndex: 3, address: null }), swapLog({ logIndex: 4 })],
                blocks: [{ number: 100, timestamp: "0x1" }],
                transactions: [{ hash: TX_HASH, from: TX_FROM }],
              },
            ],
            200,
          ),
        ),
      );
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, launchpad: null });
      let events: unknown = undefined;
      await expect(
        source.fetch(100, 199).then((r) => {
          events = r.events;
        }),
      ).rejects.toThrow("HyperSync log at block 100 index 3 has no address");
      expect(events).toBeUndefined();
    });

    it("drops a launchpad log while no launchpad is configured", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          page(
            [
              {
                logs: [feesLog({ logIndex: 1 }), swapLog({ logIndex: 2 })],
                blocks: [{ number: 100, timestamp: "0x1" }],
                transactions: [{ hash: TX_HASH, from: TX_FROM }],
              },
            ],
            200,
          ),
        ),
      );
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, launchpad: null });
      const { events } = await source.fetch(100, 199);
      expect(events.map((e) => [e.kind, e.logIndex])).toEqual([["swap", 2]]);
    });

    // NEXT_PUBLIC_LAUNCHPAD_ADDRESS is not normalised (it may be EIP-55 mixed case), while HyperSync's log addresses are
    // lowercase: the source lowercases the configured address once, so the comparison still matches.
    it("decodes launchpad logs when the configured launchpad address is mixed case", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          page(
            [
              {
                logs: [feesLog({ logIndex: 0 })],
                blocks: [{ number: 100, timestamp: "0x1" }],
                transactions: [{ hash: TX_HASH, from: TX_FROM }],
              },
            ],
            200,
          ),
        ),
      );
      const mixedCase = LAUNCHPAD.toUpperCase().replace("0X", "0x");
      expect(mixedCase).not.toBe(LAUNCHPAD);
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, launchpad: mixedCase });
      const { events } = await source.fetch(100, 199);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "launchFees", token: LAUNCHED_TOKEN, payout: FEE_PAYOUT });
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

  // Fix round 1, finding 1 (BLOCKER): Math.min coerces a missing or non-numeric next_block to
  // NaN, and `NaN <= fromBlock` is false, so the no-progress guard used to never fire for this
  // input class — fetch() returned `{ events, nextBlock: NaN }` instead of throwing. Validated
  // directly before the fix: each of these three resolved (or threw the wrong error) rather than
  // rejecting with a "malformed" message.
  describe("fetch: malformed response", () => {
    it("throws a clear error when next_block is missing from an otherwise well-formed response", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ data: [] })); // no next_block key at all
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await expect(source.fetch(100, 199)).rejects.toThrow(/malformed/i);
    });

    it("throws a clear error when next_block is present but not an integer", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ data: [], next_block: "not-a-number" }));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await expect(source.fetch(100, 199)).rejects.toThrow(/malformed/i);
    });

    it("throws a clear error when data is missing or not an array", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ next_block: 200 })); // no data key
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await expect(source.fetch(100, 199)).rejects.toThrow(/malformed/i);
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

  // Fix round 1, finding 3 (MAJOR): BigInt("") is 0n, so a present-but-empty timestamp used to
  // silently decode to 0 (1 Jan 1970) instead of throwing, the same "silent fallback that hides
  // bad data" pattern the plan explicitly rules out for the adjacent "block row absent" case
  // above. Validated directly before the fix: this resolved with timestamp 0 rather than rejecting.
  describe("fetch: malformed timestamp", () => {
    it("throws when a block's timestamp is an empty string instead of silently parsing to 0", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          page(
            [
              {
                logs: [swapLog({ blockNumber: 100 })],
                blocks: [{ number: 100, timestamp: "" }],
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

    // Fix round 1, finding 2 (MAJOR): res.json() used to sit outside the retried region, so a
    // truncated/malformed body on an otherwise-ok 2xx response failed the whole call with no
    // retry, unlike every other transient failure this function handles. Validated directly
    // before the fix: fetchImpl was called exactly once and the call rejected with a SyntaxError.
    it("retries a 2xx response whose body fails to parse as JSON, then succeeds", async () => {
      const { sleep } = fakeSleep();
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        if (calls === 1) return new Response("not json{{{", { status: 200 });
        return jsonResponse(page([], 200));
      });
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl, sleep });
      const { nextBlock } = await source.fetch(100, 199);
      expect(nextBlock).toBe(200);
      expect(calls).toBe(2);
      expect(source.requests).toBe(2);
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

  describe("transfers: request shape", () => {
    it("POSTs {url}/query for one token's Transfer logs, lowercased, with only the fields the fold needs", async () => {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(page([], 250)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await source.transfers(`0x${ERC20.slice(2).toUpperCase()}`, 100);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(source.requests).toBe(1);
      const [calledUrl, init] = fetchImpl.mock.calls[0]!;
      expect(calledUrl).toBe(`${URL}/query`);
      const req = init as RequestInit;
      expect(req.method).toBe("POST");
      expect((req.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      // No to_block key at all when no ceiling is given: the slice takes whatever one response covers.
      expect(JSON.parse(String(req.body))).toEqual({
        from_block: 100,
        logs: [{ address: [ERC20], topics: [[TRANSFER_TOPIC0]] }],
        field_selection: { log: ["block_number", "log_index", "topic1", "topic2", "topic3", "data"] },
      });
    });

    it("sends a given toBlock as the exclusive to_block, so the builder's head-minus-safety line is never passed", async () => {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(page([], 200)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await source.transfers(ERC20, 100, 199);
      const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as Record<string, unknown>;
      expect(body.to_block).toBe(200); // exclusive: to + 1, exactly as fetch() sends it
      expect(body.from_block).toBe(100);
    });

    it("clamps nextBlock to toBlock+1 when the response overshoots the ceiling", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(page([], 5_000_000)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await expect(source.transfers(ERC20, 100, 199)).resolves.toMatchObject({ nextBlock: 200 });
    });
  });

  describe("transfers: decoding", () => {
    it("decodes from, to and value, lowercasing the addresses, and returns the response's next_block", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          page([{ logs: [transferLog({ blockNumber: 120, logIndex: 4, from: `0x${HOLDER_A.slice(2).toUpperCase()}`, value: 10n ** 30n })] }], 250),
        ),
      );
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      const { transfers, nextBlock } = await source.transfers(ERC20, 100);
      expect(nextBlock).toBe(250);
      expect(transfers).toEqual([{ block: 120, logIndex: 4, from: HOLDER_A, to: HOLDER_B, value: 1_000_000_000_000_000_000_000_000_000_000n }]);
    });

    it("reads a value of 0 from empty or '0x' data instead of throwing on it", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(page([{ logs: [transferLog({ logIndex: 0, data: "0x" }), transferLog({ logIndex: 1, data: "" })] }], 250)),
      );
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      const { transfers } = await source.transfers(ERC20, 100);
      expect(transfers.map((t) => t.value)).toEqual([0n, 0n]);
    });

    it("skips an ERC-721 Transfer (a fourth topic) and a log with no topic2", async () => {
      // Same topic0 as ERC-20's, but the third indexed parameter is a token id, not a balance movement.
      const erc721 = { ...transferLog({ logIndex: 1 }), topic3: `0x${"0".repeat(63)}7`, data: "0x" };
      const { topic2: _noRecipient, ...missingTopic2 } = transferLog({ logIndex: 2 });
      const fetchImpl = vi.fn(async () => jsonResponse(page([{ logs: [transferLog({ logIndex: 0 }), erc721, missingTopic2] }], 250)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      const { transfers } = await source.transfers(ERC20, 100);
      expect(transfers.map((t) => t.logIndex)).toEqual([0]);
    });

    it("returns an empty slice, with the response's next_block, when the token moved in no block of the range", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(page([], 250)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await expect(source.transfers(ERC20, 100)).resolves.toEqual({ transfers: [], nextBlock: 250 });
    });

    // A NaN block would sort unpredictably against every other transfer and then be written as an ordinary row,
    // so a log whose position is not an integer fails the slice instead — the cursor stays put and it is retried.
    it("throws, naming the offending values, when a log's block_number or log_index is not an integer", async () => {
      const badBlock = { ...transferLog(), block_number: "not-a-number" };
      const badIndex = { ...transferLog(), log_index: null };
      const source = (log: unknown) =>
        createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl: vi.fn(async () => jsonResponse(page([{ logs: [log] }], 250))) });
      await expect(source(badBlock).transfers(ERC20, 100)).rejects.toThrow(/malformed position.*not-a-number/i);
      await expect(source(badIndex).transfers(ERC20, 100)).rejects.toThrow(/malformed position.*log_index=null/i);
    });

    it("sorts transfers by (block, logIndex) ascending across the response's chunks", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          page(
            [
              { logs: [transferLog({ blockNumber: 105, logIndex: 2 })] },
              { logs: [transferLog({ blockNumber: 100, logIndex: 5 }), transferLog({ blockNumber: 100, logIndex: 1 })] },
            ],
            250,
          ),
        ),
      );
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      const { transfers } = await source.transfers(ERC20, 100);
      expect(transfers.map((t) => [t.block, t.logIndex])).toEqual([
        [100, 1],
        [100, 5],
        [105, 2],
      ]);
    });
  });

  // The same two guards fetch() carries, for the same reason: a missing or non-numeric next_block must not
  // reach the caller as a cursor, and a response that does not pass fromBlock must never look like an empty
  // range — the builder would store the cursor and spin on that block forever.
  describe("transfers: malformed response and no progress", () => {
    it("throws when next_block is missing from an otherwise well-formed response, naming what arrived", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await expect(source.transfers(ERC20, 100)).rejects.toThrow(/malformed.*next_block=undefined/i);
    });

    it("throws when next_block is present but not an integer, naming what arrived", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ data: [], next_block: "not-a-number" }));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await expect(source.transfers(ERC20, 100)).rejects.toThrow(/malformed.*next_block=not-a-number/i);
    });

    it("throws when data is missing or not an array", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ next_block: 250 }));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await expect(source.transfers(ERC20, 100)).rejects.toThrow(/malformed/i);
    });

    it("throws when the response makes no progress past fromBlock, naming the block it stopped at", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(page([], 100)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await expect(source.transfers(ERC20, 100)).rejects.toThrow(/no progress.*next_block=100/i);
    });

    it("throws when the response regresses below fromBlock", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(page([], 50)));
      const source = createHyperSyncSource({ url: URL, token: TOKEN, fetchImpl });
      await expect(source.transfers(ERC20, 100)).rejects.toThrow(/no progress.*next_block=50/i);
    });
  });
});
