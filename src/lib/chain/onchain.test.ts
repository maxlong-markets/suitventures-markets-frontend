import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpRequestError,
  decodeFunctionResult,
  encodeAbiParameters,
  getAddress,
  http,
  stringToHex,
  type Abi,
  type PublicClient,
} from "viem";
import { robinhoodChain } from "@/lib/chain";
import {
  BALANCE_READ_CHUNK, balancePairKey, chainRpcHosts, createChainClient, PUBLIC_RPC_CALLS_PER_SECOND,
  readBalances, readBalancesBothSides, readQuotePrices, readTokenMetadata, type QuoteFeedConfig,
} from "./onchain";

// Spies on viem's `http` (delegating to the real implementation) so createChainClient's tests
// below can assert on the exact transport config it passes — batchSize/wait aren't observable
// any other way; they're consumed inside http()'s closure and never attached to the client it
// returns. Nothing else in this file calls http(): readTokenMetadata/readQuotePrices are always
// exercised against hand-written fake clients, never a real transport.
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, http: vi.fn(actual.http) };
});

const TOKEN_MIXED = "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18";
const TOKEN = TOKEN_MIXED.toLowerCase();
const TOKEN_2 = "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc"; // AMD, from the indexer's config/quotes.json

const QUOTE_A = "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9"; // AAPL
const PROXY_A = "0x6b22a786baa607d76728168703a39ea9c99f2cd0";
const QUOTE_A_MIXED = getAddress(QUOTE_A);
const PROXY_A_MIXED = getAddress(PROXY_A);
const QUOTE_NO_FEED = "0x05a3d1cd21d0c88145e82600e62e7e496e0f222b"; // AMC: no chainlinkProxy in config
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

// ---------------------------------------------------------------------------
// readTokenMetadata
// ---------------------------------------------------------------------------

type FieldName = "symbol" | "name" | "decimals" | "totalSupply";
type RecordedCall = { functionName: string; abi: Abi };

// Structural check (not reference equality), matching the indexer's own test helper: works
// regardless of which module's parseAbi([...]) call produced the ABI array onchain.ts actually
// passed to readContract.
function abiReturnsBytes32(abi: Abi, functionName: string): boolean {
  const item = abi.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "type" in entry &&
      entry.type === "function" &&
      "name" in entry &&
      entry.name === functionName,
  ) as { outputs?: readonly { type?: string }[] } | undefined;
  return item?.outputs?.[0]?.type === "bytes32";
}

function encodeString(value: string): `0x${string}` {
  return encodeAbiParameters([{ type: "string" }], [value]);
}
function encodeBytes32(value: string): `0x${string}` {
  return encodeAbiParameters([{ type: "bytes32" }], [stringToHex(value, { size: 32 })]);
}
function encodeDecimals(value: number): `0x${string}` {
  return encodeAbiParameters([{ type: "uint8" }], [value]);
}
function encodeOutOfRangeDecimals(value: bigint): `0x${string}` {
  return encodeAbiParameters([{ type: "uint256" }], [value]);
}
function encodeSupply(value: bigint): `0x${string}` {
  return encodeAbiParameters([{ type: "uint256" }], [value]);
}

/**
 * A fake `readContract` for one token's symbol/name/decimals/totalSupply, decoding canned
 * ABI-encoded return data with whatever ABI the code under test passes in — so onchain.ts, not
 * the test, decides whether a call is decoded as `string` or `bytes32`. Mirrors the indexer's
 * src/effects/tokenMetadata.test.ts fake, extended with a totalSupply field/throw.
 */
function makeFakeClient(
  raw: Partial<Record<FieldName, `0x${string}`>>,
  opts: { throwOnce?: unknown; throwOnBytes32?: unknown; throwOnSupply?: unknown } = {},
): { client: Pick<PublicClient, "readContract">; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let hasThrownOnce = false;
  let hasThrownBytes32 = false;
  const fakeClient = {
    readContract: async (args: { abi: Abi; functionName: string }) => {
      const { abi, functionName } = args;
      calls.push({ abi, functionName });
      if (functionName === "totalSupply") {
        if (opts.throwOnSupply !== undefined) throw opts.throwOnSupply;
      } else {
        if (opts.throwOnce !== undefined && !hasThrownOnce) {
          hasThrownOnce = true;
          throw opts.throwOnce;
        }
        if (opts.throwOnBytes32 !== undefined && !hasThrownBytes32 && abiReturnsBytes32(abi, functionName)) {
          hasThrownBytes32 = true;
          throw opts.throwOnBytes32;
        }
      }
      const data = raw[functionName as FieldName];
      if (data === undefined) throw new Error(`test setup: no canned data for ${functionName}`);
      return decodeFunctionResult({ abi, functionName, data } as Parameters<typeof decodeFunctionResult>[0]);
    },
  };
  return { client: fakeClient as unknown as Pick<PublicClient, "readContract">, calls };
}

const FALLBACK = { symbol: TOKEN.slice(0, 6), name: TOKEN, decimals: 18 };

describe("readTokenMetadata", () => {
  it("decodes standard string returns plus totalSupply, keyed by lowercase address", async () => {
    const { client } = makeFakeClient({
      symbol: encodeString("AI"),
      name: encodeString("AI Token"),
      decimals: encodeDecimals(18),
      totalSupply: encodeSupply(1_000_000n * 10n ** 18n),
    });
    const result = await readTokenMetadata(client, [TOKEN_MIXED]);
    expect(result.get(TOKEN)).toEqual({
      ok: true,
      symbol: "AI",
      name: "AI Token",
      decimals: 18,
      totalSupply: 1_000_000n * 10n ** 18n,
    });
    expect(result.has(TOKEN_MIXED)).toBe(false);
    expect([...result.keys()]).toEqual([TOKEN]);
  });

  it("retries with the bytes32 ABI and decodes MKR-style returns", async () => {
    const { client, calls } = makeFakeClient({
      symbol: encodeBytes32("MKR"),
      name: encodeBytes32("Maker"),
      decimals: encodeDecimals(18),
      totalSupply: encodeSupply(500n),
    });
    const result = await readTokenMetadata(client, [TOKEN]);
    expect(result.get(TOKEN)).toEqual({ ok: true, symbol: "MKR", name: "Maker", decimals: 18, totalSupply: 500n });
    expect(calls.some((c) => abiReturnsBytes32(c.abi, c.functionName))).toBe(true);
  });

  it("falls back to the synthetic metadata when the bytes32 retry itself throws, without affecting the rest of the batch", async () => {
    const transportError = new HttpRequestError({ url: "https://rpc.example" });
    const client: Pick<PublicClient, "readContract"> = {
      readContract: (async (args: { address: string; abi: Abi; functionName: string }) => {
        const addr = args.address.toLowerCase();
        if (addr === TOKEN) {
          // symbol/name are bytes32-shaped, so the string-ABI attempt genuinely throws
          // (IntegerOutOfRangeError) and triggers the bytes32 retry — which then throws too,
          // simulating a transport failure on the retry itself rather than a bad decode.
          if (abiReturnsBytes32(args.abi, args.functionName)) {
            throw transportError;
          }
          const raw: Partial<Record<FieldName, `0x${string}`>> = {
            symbol: encodeBytes32("MKR"),
            name: encodeBytes32("Maker"),
            decimals: encodeDecimals(18),
            totalSupply: encodeSupply(1n),
          };
          const data = raw[args.functionName as FieldName];
          if (data === undefined) throw new Error(`test setup: no canned data for ${args.functionName}`);
          return decodeFunctionResult({
            abi: args.abi,
            functionName: args.functionName,
            data,
          } as Parameters<typeof decodeFunctionResult>[0]);
        }
        if (addr === TOKEN_2) {
          switch (args.functionName) {
            case "symbol":
              return "AI";
            case "name":
              return "AI Token";
            case "decimals":
              return 18;
            case "totalSupply":
              return 1n;
            default:
              throw new Error(`unexpected functionName ${args.functionName}`);
          }
        }
        throw new Error(`unexpected address ${addr}`);
      }) as unknown as PublicClient["readContract"],
    };

    const result = await readTokenMetadata(client, [TOKEN, TOKEN_2]);
    expect(result.get(TOKEN)).toEqual({ ...FALLBACK, ok: false, totalSupply: 1n });
    expect(result.get(TOKEN_2)).toEqual({ ok: true, symbol: "AI", name: "AI Token", decimals: 18, totalSupply: 1n });
  });

  it("falls back to the indexer's synthetic metadata when every read fails, with totalSupply null", async () => {
    const { client } = makeFakeClient(
      {},
      { throwOnce: new HttpRequestError({ url: "https://rpc.example" }), throwOnSupply: new Error("revert") },
    );
    const result = await readTokenMetadata(client, [TOKEN]);
    expect(result.get(TOKEN)).toEqual({ ...FALLBACK, ok: false, totalSupply: null });
  });

  it("treats a bytes32 symbol that decodes blank as a failed read", async () => {
    const { client } = makeFakeClient({
      symbol: encodeBytes32(" "),
      name: encodeBytes32("Maker"),
      decimals: encodeDecimals(18),
      totalSupply: encodeSupply(1n),
    });
    const result = await readTokenMetadata(client, [TOKEN]);
    // totalSupply still reads fine independently of the metadata fallback.
    expect(result.get(TOKEN)).toEqual({ ...FALLBACK, ok: false, totalSupply: 1n });
  });

  it("cleans NUL padding and surrounding space from a symbol", async () => {
    const NUL = String.fromCharCode(0);
    const { client } = makeFakeClient({
      symbol: encodeString(`  AI${NUL}${NUL}  `),
      name: encodeString("AI Token"),
      decimals: encodeDecimals(18),
      totalSupply: encodeSupply(0n),
    });
    const result = await readTokenMetadata(client, [TOKEN]);
    expect(result.get(TOKEN)).toEqual({ ok: true, symbol: "AI", name: "AI Token", decimals: 18, totalSupply: 0n });
  });

  it("caps an overlong name at 128 characters", async () => {
    const longName = "A".repeat(200);
    const { client } = makeFakeClient({
      symbol: encodeString("AI"),
      name: encodeString(longName),
      decimals: encodeDecimals(18),
      totalSupply: encodeSupply(1n),
    });
    const result = await readTokenMetadata(client, [TOKEN]);
    expect(result.get(TOKEN)?.name).toBe(longName.slice(0, 128));
  });

  it("rejects an out-of-range decimals value", async () => {
    const { client } = makeFakeClient({
      symbol: encodeString("AI"),
      name: encodeString("AI Token"),
      decimals: encodeOutOfRangeDecimals(1000n),
      totalSupply: encodeSupply(1n),
    });
    const result = await readTokenMetadata(client, [TOKEN]);
    expect(result.get(TOKEN)).toEqual({ ...FALLBACK, ok: false, totalSupply: 1n });
  });

  it("keeps ok:true metadata when only the totalSupply read fails", async () => {
    const { client } = makeFakeClient(
      { symbol: encodeString("AI"), name: encodeString("AI Token"), decimals: encodeDecimals(18) },
      { throwOnSupply: new Error("revert") },
    );
    const result = await readTokenMetadata(client, [TOKEN]);
    expect(result.get(TOKEN)).toEqual({ ok: true, symbol: "AI", name: "AI Token", decimals: 18, totalSupply: null });
  });

  it("never lets one reverting token fail the rest of the batch", async () => {
    const perAddress: Record<
      string,
      "revert" | { symbol: string; name: string; decimals: number; totalSupply: bigint }
    > = {
      [TOKEN]: { symbol: "AI", name: "AI Token", decimals: 18, totalSupply: 1n },
      [TOKEN_2]: "revert",
    };
    const client: Pick<PublicClient, "readContract"> = {
      readContract: (async (args: { address: string; functionName: string }) => {
        const addr = args.address.toLowerCase();
        const entry = perAddress[addr];
        if (!entry || entry === "revert") throw new Error(`revert: ${addr}`);
        switch (args.functionName) {
          case "symbol":
            return entry.symbol;
          case "name":
            return entry.name;
          case "decimals":
            return entry.decimals;
          case "totalSupply":
            return entry.totalSupply;
          default:
            throw new Error(`unexpected functionName ${args.functionName}`);
        }
      }) as unknown as PublicClient["readContract"],
    };
    const result = await readTokenMetadata(client, [TOKEN, TOKEN_2]);
    expect(result.get(TOKEN)).toEqual({ ok: true, symbol: "AI", name: "AI Token", decimals: 18, totalSupply: 1n });
    expect(result.get(TOKEN_2)).toEqual({
      ok: false,
      symbol: TOKEN_2.slice(0, 6),
      name: TOKEN_2,
      decimals: 18,
      totalSupply: null,
    });
  });

  it("returns an empty map for an empty address list", async () => {
    const { client } = makeFakeClient({});
    const result = await readTokenMetadata(client, []);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readQuotePrices
// ---------------------------------------------------------------------------

type RoundData = readonly [bigint, bigint, bigint, bigint, bigint]; // roundId, answer, startedAt, updatedAt, answeredInRound

function makeQuoteClient(byProxy: Record<string, RoundData | "revert">): Pick<PublicClient, "readContract"> {
  return {
    readContract: (async (args: { address: string; functionName: string }) => {
      const proxy = args.address.toLowerCase();
      const entry = byProxy[proxy];
      if (!entry || entry === "revert") throw new Error(`revert: ${proxy}`);
      if (args.functionName !== "latestRoundData") {
        throw new Error(`unexpected functionName ${args.functionName}`);
      }
      return entry;
    }) as unknown as PublicClient["readContract"],
  };
}

describe("readQuotePrices", () => {
  it("reads latestRoundData on the proxy and scales the answer by chainlinkDecimals", async () => {
    const client = makeQuoteClient({ [PROXY_A]: [1n, 22_440_000_000n, 1_700_000_000n, 1_700_000_005n, 1n] });
    const quotes: QuoteFeedConfig[] = [{ address: QUOTE_A, chainlinkProxy: PROXY_A, chainlinkDecimals: 8 }];
    const result = await readQuotePrices(client, quotes, 1_700_000_999);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(QUOTE_A);
    expect(result[0]?.usdPrice).toBeCloseTo(224.4, 6);
    expect(result[0]?.updatedAt).toBe(1_700_000_005);
    expect(result[0]?.aggregator).toBe(PROXY_A);
  });

  it("lowercases id and aggregator for mixed-case input", async () => {
    const client = makeQuoteClient({ [PROXY_A]: [1n, 22_440_000_000n, 1_700_000_000n, 1_700_000_005n, 1n] });
    const quotes: QuoteFeedConfig[] = [
      { address: QUOTE_A_MIXED, chainlinkProxy: PROXY_A_MIXED, chainlinkDecimals: 8 },
    ];
    const result = await readQuotePrices(client, quotes, 1_700_000_999);
    expect(result[0]?.id).toBe(QUOTE_A);
    expect(result[0]?.aggregator).toBe(PROXY_A);
  });

  it("skips a zero answer", async () => {
    const client = makeQuoteClient({ [PROXY_A]: [1n, 0n, 1_700_000_000n, 1_700_000_005n, 1n] });
    const quotes: QuoteFeedConfig[] = [{ address: QUOTE_A, chainlinkProxy: PROXY_A, chainlinkDecimals: 8 }];
    expect(await readQuotePrices(client, quotes, 1_700_000_999)).toEqual([]);
  });

  it("skips a negative answer", async () => {
    const client = makeQuoteClient({ [PROXY_A]: [1n, -5n, 1_700_000_000n, 1_700_000_005n, 1n] });
    const quotes: QuoteFeedConfig[] = [{ address: QUOTE_A, chainlinkProxy: PROXY_A, chainlinkDecimals: 8 }];
    expect(await readQuotePrices(client, quotes, 1_700_000_999)).toEqual([]);
  });

  it("skips a feed whose read throws, without failing the batch", async () => {
    const client = makeQuoteClient({ [PROXY_A]: "revert" });
    const quotes: QuoteFeedConfig[] = [{ address: QUOTE_A, chainlinkProxy: PROXY_A, chainlinkDecimals: 8 }];
    expect(await readQuotePrices(client, quotes, 1_700_000_999)).toEqual([]);
  });

  it("skips a quote with no configured Chainlink feed, without calling the client", async () => {
    const readContract = vi.fn();
    const quotes: QuoteFeedConfig[] = [{ address: QUOTE_NO_FEED, chainlinkProxy: null, chainlinkDecimals: null }];
    const client = { readContract } as unknown as Pick<PublicClient, "readContract">;
    const result = await readQuotePrices(client, quotes, 1_700_000_999);
    expect(result).toEqual([]);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('pins USDG at 1 with aggregator "pinned", without calling the client', async () => {
    const readContract = vi.fn();
    const quotes: QuoteFeedConfig[] = [{ address: USDG, chainlinkProxy: null, chainlinkDecimals: null }];
    const client = { readContract } as unknown as Pick<PublicClient, "readContract">;
    const result = await readQuotePrices(client, quotes, 1_700_000_999);
    expect(result).toEqual([{ id: USDG, usdPrice: 1, updatedAt: 1_700_000_999, aggregator: "pinned" }]);
    expect(readContract).not.toHaveBeenCalled();
  });

  it("falls back to `now` when updatedAt is not a sane positive value", async () => {
    const client = makeQuoteClient({ [PROXY_A]: [1n, 22_440_000_000n, 1_700_000_000n, 0n, 1n] });
    const quotes: QuoteFeedConfig[] = [{ address: QUOTE_A, chainlinkProxy: PROXY_A, chainlinkDecimals: 8 }];
    const result = await readQuotePrices(client, quotes, 1_700_000_999);
    expect(result[0]?.updatedAt).toBe(1_700_000_999);
  });

  it("falls back to `now` when updatedAt overflows Number.MAX_SAFE_INTEGER", async () => {
    // A "sane positive value" has an upper bound too, not just a lower one: a corrupt or
    // adversarial feed returning a huge updatedAt must not be passed through as-is.
    const hugeUpdatedAt = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const client = makeQuoteClient({ [PROXY_A]: [1n, 22_440_000_000n, 1_700_000_000n, hugeUpdatedAt, 1n] });
    const quotes: QuoteFeedConfig[] = [{ address: QUOTE_A, chainlinkProxy: PROXY_A, chainlinkDecimals: 8 }];
    const result = await readQuotePrices(client, quotes, 1_700_000_999);
    expect(result[0]?.updatedAt).toBe(1_700_000_999);
  });

  // All the other fixtures in this file use 8 decimals (Chainlink's usual USD-feed width), which
  // would let a `10 ** 8` hardcoded straight into readQuotePrices pass every other test here.
  it("scales the answer by whatever chainlinkDecimals a quote declares, not a hardcoded 8", async () => {
    const proxy = "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed";
    const quoteAddr = "0xc0fec0fec0fec0fec0fec0fec0fec0fec0fec0fe";
    const client = makeQuoteClient({
      [proxy]: [1n, 2_500n * 10n ** 18n, 1_700_000_000n, 1_700_000_005n, 1n],
    });
    const quotes: QuoteFeedConfig[] = [{ address: quoteAddr, chainlinkProxy: proxy, chainlinkDecimals: 18 }];
    const result = await readQuotePrices(client, quotes, 1_700_000_999);
    expect(result).toHaveLength(1);
    expect(result[0]?.usdPrice).toBeCloseTo(2500, 6);
  });

  it("keeps good feeds and the USDG pin when another feed in the same batch reverts", async () => {
    const badProxy = "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead";
    const client = makeQuoteClient({ [PROXY_A]: [1n, 22_440_000_000n, 1_700_000_000n, 1_700_000_005n, 1n] });
    const quotes: QuoteFeedConfig[] = [
      { address: QUOTE_A, chainlinkProxy: PROXY_A, chainlinkDecimals: 8 },
      { address: "0xbadbadbadbadbadbadbadbadbadbadbadbadbad", chainlinkProxy: badProxy, chainlinkDecimals: 8 },
      { address: USDG, chainlinkProxy: null, chainlinkDecimals: null },
    ];
    const result = await readQuotePrices(client, quotes, 1_700_000_999);
    expect(result.map((r) => r.id)).toEqual([QUOTE_A, USDG]);
  });

  it("returns an empty array when there are no quotes", async () => {
    const readContract = vi.fn();
    const client = { readContract } as unknown as Pick<PublicClient, "readContract">;
    expect(await readQuotePrices(client, [], 1_700_000_999)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// readBalances
// ---------------------------------------------------------------------------

const WALLET_MIXED = "0x3F8a7C21e9B4d0A6f15C8e2b7d9A4c0e1F6b9a2C";
const WALLET = WALLET_MIXED.toLowerCase();
const WALLET_2 = "0x0000000000000000000000000000000000dead";

function makeBalanceClient(
  byKey: Record<string, bigint | "revert">,
): { client: Pick<PublicClient, "readContract">; calls: { address: string; args: readonly unknown[]; blockNumber?: bigint }[] } {
  const calls: { address: string; args: readonly unknown[]; blockNumber?: bigint }[] = [];
  const client = {
    readContract: (async (args: { address: string; functionName: string; args: readonly unknown[]; blockNumber?: bigint }) => {
      if (args.functionName !== "balanceOf") throw new Error(`unexpected functionName ${args.functionName}`);
      calls.push({ address: args.address.toLowerCase(), args: args.args, blockNumber: args.blockNumber });
      const wallet = (args.args[0] as string).toLowerCase();
      const key = `${args.address.toLowerCase()}-${wallet}`;
      const entry = byKey[key];
      if (entry === undefined || entry === "revert") throw new Error(`revert: ${key}`);
      return entry;
    }) as unknown as PublicClient["readContract"],
  };
  return { client, calls };
}

// Fix round 1, MINOR-6 (holder-count-review.md): one exported key builder, so a caller building a
// lookup against readBalances' result (run.ts's computeHolderDeltas) cannot drift from how the map
// itself is keyed.
describe("balancePairKey", () => {
  it("lowercases both sides and joins them with a dash", () => {
    expect(balancePairKey({ token: TOKEN_MIXED, wallet: WALLET_MIXED })).toBe(`${TOKEN}-${WALLET}`);
  });

  it("is exactly the key readBalances' own map uses", async () => {
    const { client } = makeBalanceClient({ [`${TOKEN}-${WALLET}`]: 500n });
    const result = await readBalances(client, [{ token: TOKEN_MIXED, wallet: WALLET_MIXED }]);
    expect(result.get(balancePairKey({ token: TOKEN_MIXED, wallet: WALLET_MIXED }))).toBe(500n);
  });
});

describe("readBalances", () => {
  it("reads balanceOf and keys the result by lowercase token-wallet", async () => {
    const { client } = makeBalanceClient({ [`${TOKEN}-${WALLET}`]: 500n });
    const result = await readBalances(client, [{ token: TOKEN_MIXED, wallet: WALLET_MIXED }]);
    expect(result.get(`${TOKEN}-${WALLET}`)).toBe(500n);
    expect(result.size).toBe(1);
  });

  it("passes blockNumber through for a historical read", async () => {
    const { client, calls } = makeBalanceClient({ [`${TOKEN}-${WALLET}`]: 500n });
    await readBalances(client, [{ token: TOKEN, wallet: WALLET }], 12_345n);
    expect(calls[0]?.blockNumber).toBe(12_345n);
  });

  it("omits blockNumber for a current-balance read", async () => {
    const { client, calls } = makeBalanceClient({ [`${TOKEN}-${WALLET}`]: 500n });
    await readBalances(client, [{ token: TOKEN, wallet: WALLET }]);
    expect(calls[0]?.blockNumber).toBeUndefined();
  });

  it("leaves a reverting pair ABSENT from the map rather than defaulting it to zero, without failing the rest of the batch", async () => {
    const { client } = makeBalanceClient({
      [`${TOKEN}-${WALLET}`]: "revert",
      [`${TOKEN_2}-${WALLET}`]: 0n, // a real, meaningful zero balance for the other pair
    });
    const result = await readBalances(client, [
      { token: TOKEN, wallet: WALLET },
      { token: TOKEN_2, wallet: WALLET },
    ]);
    expect(result.has(`${TOKEN}-${WALLET}`)).toBe(false); // absent, not 0n
    expect(result.get(`${TOKEN_2}-${WALLET}`)).toBe(0n); // a genuine zero balance still comes through
    expect(result.size).toBe(1);
  });

  it("keys mixed-case input as lowercase and distinguishes two wallets of the same token", async () => {
    const { client } = makeBalanceClient({ [`${TOKEN}-${WALLET}`]: 1n, [`${TOKEN}-${WALLET_2}`]: 2n });
    const result = await readBalances(client, [
      { token: TOKEN_MIXED, wallet: WALLET_MIXED },
      { token: TOKEN_MIXED, wallet: WALLET_2 },
    ]);
    expect([...result.keys()].sort()).toEqual([`${TOKEN}-${WALLET}`, `${TOKEN}-${WALLET_2}`].sort());
    expect(result.get(`${TOKEN}-${WALLET}`)).toBe(1n);
    expect(result.get(`${TOKEN}-${WALLET_2}`)).toBe(2n);
  });

  it("returns an empty map for an empty pair list, without calling the client", async () => {
    const readContract = vi.fn();
    const client = { readContract } as unknown as Pick<PublicClient, "readContract">;
    const result = await readBalances(client, []);
    expect(result.size).toBe(0);
    expect(readContract).not.toHaveBeenCalled();
  });

  // Fix round 1, MAJOR-2 (holder-count-review.md): a slow RPC must not hold up a whole cycle.
  describe("timeoutMs", () => {
    it("times out a read that never resolves, leaving it absent, without affecting a fast pair in the same batch", async () => {
      vi.useFakeTimers();
      try {
        const never = new Promise<bigint>(() => {
          /* deliberately never settles */
        });
        const client: Pick<PublicClient, "readContract"> = {
          readContract: (async (args: { args: readonly unknown[] }) => {
            const wallet = String(args.args[0]).toLowerCase();
            return wallet === WALLET ? never : 42n;
          }) as unknown as PublicClient["readContract"],
        };
        const promise = readBalances(
          client,
          [
            { token: TOKEN, wallet: WALLET },
            { token: TOKEN, wallet: WALLET_2 },
          ],
          undefined,
          1_000,
        );
        await vi.advanceTimersByTimeAsync(1_000);
        const result = await promise;
        expect(result.has(`${TOKEN}-${WALLET}`)).toBe(false); // timed out: absent, never 0n
        expect(result.get(`${TOKEN}-${WALLET_2}`)).toBe(42n); // the other pair's own timer is unaffected
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not time out a read that resolves comfortably inside the deadline", async () => {
      const { client } = makeBalanceClient({ [`${TOKEN}-${WALLET}`]: 500n });
      const result = await readBalances(client, [{ token: TOKEN, wallet: WALLET }], undefined, 5_000);
      expect(result.get(`${TOKEN}-${WALLET}`)).toBe(500n);
    });

    it("imposes no deadline at all when timeoutMs is omitted", async () => {
      const { client } = makeBalanceClient({ [`${TOKEN}-${WALLET}`]: 500n });
      const result = await readBalances(client, [{ token: TOKEN, wallet: WALLET }]);
      expect(result.get(`${TOKEN}-${WALLET}`)).toBe(500n);
    });
  });
});

// ---------------------------------------------------------------------------
// createChainClient
// ---------------------------------------------------------------------------

/** createChainClient returns a paced client or a fallback one, so `url` lives on the transport's value only for the former. */
const transportUrl = (client: ReturnType<typeof createChainClient>) => (client.transport as { url?: string }).url;

describe("createChainClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(http).mockClear();
  });

  it("builds a client on Robinhood Chain (4663)", () => {
    const client = createChainClient();
    expect(client.chain?.id).toBe(4663);
  });

  it("retries three times", () => {
    const client = createChainClient();
    expect(client.transport.retryCount).toBe(3);
  });

  it("falls back to the chain's own default RPC when nothing is configured", () => {
    const client = createChainClient();
    expect(transportUrl(client)).toBe(robinhoodChain.rpcUrls.default.http[0]);
  });

  it("uses CHAIN_RPC_URL when no explicit URL is passed", () => {
    vi.stubEnv("CHAIN_RPC_URL", "https://chain-rpc.example");
    const client = createChainClient();
    expect(transportUrl(client)).toBe("https://chain-rpc.example");
  });

  it("prefers an explicit rpcUrl over CHAIN_RPC_URL", () => {
    vi.stubEnv("CHAIN_RPC_URL", "https://chain-rpc.example");
    const client = createChainClient("https://explicit.example");
    expect(transportUrl(client)).toBe("https://explicit.example");
  });

  // 23 Sep 2026: the public node meters 40 calls per address per second (pacing.ts), so the primary
  // is always a paced transport whose batches are exactly that size, never a bare http().
  it("paces the primary at the public node's 40 calls a second, batched 40 to a request, with no inner retries", () => {
    const client = createChainClient("https://batch.example");
    expect(client.transport.type).toBe("pacedHttp");
    expect((client.transport as { callsPerSecond?: number }).callsPerSecond).toBe(PUBLIC_RPC_CALLS_PER_SECOND);
    expect(PUBLIC_RPC_CALLS_PER_SECOND).toBe(40);
    expect(BALANCE_READ_CHUNK).toBe(40);
    expect(http).toHaveBeenCalledWith("https://batch.example", { batch: { batchSize: 40, wait: 16 }, retryCount: 0 });
  });

  it("has no backup transport unless CHAIN_RPC_FALLBACK_URL (or fallbackUrl) is set", () => {
    const client = createChainClient("https://primary.example");
    expect(client.transport.type).toBe("pacedHttp");
    expect(client.transport.transports).toBeUndefined();
  });

  it("puts the paced primary first and the backup second when CHAIN_RPC_FALLBACK_URL is set", () => {
    vi.stubEnv("CHAIN_RPC_URL", "https://primary.example");
    vi.stubEnv("CHAIN_RPC_FALLBACK_URL", "https://backup.example/v2/key");
    const client = createChainClient();
    expect(client.transport.type).toBe("fallback");
    const transports = client.transport.transports as { config: { type: string }; value?: { url?: string } }[];
    expect(transports.map((t) => t.config.type)).toEqual(["pacedHttp", "http"]);
    expect(transports[0]?.value?.url).toBe("https://primary.example");
    expect(transports[1]?.value?.url).toBe("https://backup.example/v2/key");
    expect(http).toHaveBeenCalledWith("https://backup.example/v2/key", { batch: { batchSize: 40, wait: 16 }, retryCount: 0 });
  });

  it("an explicit fallbackUrl wins over CHAIN_RPC_FALLBACK_URL", () => {
    vi.stubEnv("CHAIN_RPC_FALLBACK_URL", "https://env-backup.example");
    const client = createChainClient("https://primary.example", "https://explicit-backup.example");
    const transports = client.transport.transports as { value?: { url?: string } }[];
    expect(transports[1]?.value?.url).toBe("https://explicit-backup.example");
  });

  it("ignores a backup equal to the primary (falling back to the same node buys nothing)", () => {
    const client = createChainClient("https://same.example", "https://same.example");
    expect(client.transport.type).toBe("pacedHttp");
  });
});

describe("chainRpcHosts", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports hostnames only, never the URL (a paid endpoint's key is in its path)", () => {
    vi.stubEnv("CHAIN_RPC_URL", "https://rpc.mainnet.chain.robinhood.com");
    vi.stubEnv("CHAIN_RPC_FALLBACK_URL", "https://robinhood-mainnet.g.alchemy.com/v2/SECRET-KEY");
    expect(chainRpcHosts()).toEqual({ primary: "rpc.mainnet.chain.robinhood.com", backup: "robinhood-mainnet.g.alchemy.com" });
  });

  it("names the chain default and no backup when nothing is configured", () => {
    vi.stubEnv("CHAIN_RPC_URL", "");
    vi.stubEnv("CHAIN_RPC_FALLBACK_URL", "");
    expect(chainRpcHosts()).toEqual({ primary: new URL(robinhoodChain.rpcUrls.default.http[0]!).host, backup: null });
  });
});

// ---------------------------------------------------------------------------
// readBalancesBothSides (23 Sep 2026): both sides of a pair in one batch, under a deadline
// ---------------------------------------------------------------------------

describe("readBalancesBothSides", () => {
  const pairsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ token: TOKEN, wallet: `0x${(i + 1).toString(16).padStart(40, "0")}` }));
  const balancesFor = (pairs: { token: string; wallet: string }[], value: bigint) =>
    Object.fromEntries(pairs.map((p) => [`${p.token}-${p.wallet}`, value]));

  it("reads every pair at both blocks and returns the two maps with nothing skipped", async () => {
    const pairs = pairsOf(3);
    const { client, calls } = makeBalanceClient(balancesFor(pairs, 7n));
    const { before, after, skipped } = await readBalancesBothSides(client, pairs, 100n, 101n);
    expect(before.size).toBe(3);
    expect(after.size).toBe(3);
    expect(skipped).toBe(0);
    expect(calls.filter((c) => c.blockNumber === 100n)).toHaveLength(3);
    expect(calls.filter((c) => c.blockNumber === 101n)).toHaveLength(3);
  });

  it("issues each chunk's before AND after reads together, never more than BALANCE_READ_CHUNK calls at once", async () => {
    const pairs = pairsOf(BALANCE_READ_CHUNK + 5); // 45 pairs = 90 calls
    let inFlight = 0;
    let peak = 0;
    const client: Pick<PublicClient, "readContract"> = {
      readContract: (async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return 1n;
      }) as unknown as PublicClient["readContract"],
    };
    const { before, after } = await readBalancesBothSides(client, pairs, 100n, 101n);
    expect(peak).toBe(BALANCE_READ_CHUNK); // 20 pairs x 2 sides per chunk
    expect(before.size).toBe(pairs.length);
    expect(after.size).toBe(pairs.length);
  });

  it("stops starting chunks at the deadline, counts the rest skipped, and never leaves a started chunk half-read", async () => {
    const pairs = pairsOf(BALANCE_READ_CHUNK); // 40 pairs = 2 chunks of 20
    const { client, calls } = makeBalanceClient(balancesFor(pairs, 1n));
    let tick = 0;
    const deadline = { untilMs: 1, now: () => tick++ }; // the clock is read once per chunk: 0 starts the first, 1 is the deadline before the second
    const { before, after, skipped } = await readBalancesBothSides(client, pairs, 100n, 101n, undefined, deadline);
    expect(before.size).toBe(20);
    expect(after.size).toBe(20);
    expect(skipped).toBe(20);
    expect(calls).toHaveLength(40); // one chunk: 20 before + 20 after, none of the second chunk
  });

  it("a failed read leaves that pair absent from that side only; the other side and the other pairs still resolve", async () => {
    const pairs = pairsOf(2);
    let n = 0;
    const client: Pick<PublicClient, "readContract"> = {
      readContract: (async (args: { blockNumber?: bigint; args: readonly unknown[] }) => {
        n += 1;
        if (args.blockNumber === 101n && String(args.args[0]) === pairs[0]!.wallet) throw new Error("revert");
        return 5n;
      }) as unknown as PublicClient["readContract"],
    };
    const { before, after, skipped } = await readBalancesBothSides(client, pairs, 100n, 101n);
    expect(n).toBe(4);
    expect(before.size).toBe(2);
    expect(after.has(balancePairKey(pairs[0]!))).toBe(false);
    expect(after.get(balancePairKey(pairs[1]!))).toBe(5n);
    expect(skipped).toBe(0);
  });

  it("returns empty maps for no pairs without calling the client", async () => {
    const readContract = vi.fn();
    const client = { readContract } as unknown as Pick<PublicClient, "readContract">;
    const result = await readBalancesBothSides(client, [], 1n, 2n);
    expect(result).toEqual({ before: new Map(), after: new Map(), skipped: 0 });
    expect(readContract).not.toHaveBeenCalled();
  });
});
