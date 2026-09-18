import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, QuoteAsset, TokenPair } from "@/lib/types";
import { queryHarness, renderHook } from "@/test/dom";
import { invalidatePairBalances, usePairBalances, blockWatch } from "./useTokenBalance";

const h = vi.hoisted(() => ({
  account: { address: undefined as `0x${string}` | undefined, isConnected: false },
  quotes: { data: undefined as unknown[] | undefined },
  decimals: { data: undefined as number | undefined },
  batch: {
    data: undefined as readonly bigint[] | undefined,
    queryKey: ["readContracts", { id: "balances" }] as unknown[],
  },
  block: { data: undefined as bigint | undefined },
  seenReadContract: vi.fn(),
  seenReadContracts: vi.fn(),
  seenBlockNumber: vi.fn(),
}));

vi.mock("wagmi", () => ({
  useAccount: () => h.account,
  useReadContract: (p: unknown) => {
    h.seenReadContract(p);
    return h.decimals;
  },
  useReadContracts: (p: unknown) => {
    h.seenReadContracts(p);
    return h.batch;
  },
  useBlockNumber: (p: unknown) => {
    h.seenBlockNumber(p);
    return h.block;
  },
}));
vi.mock("@/hooks/useMarketsData", () => ({ useQuotes: () => h.quotes }));

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x000000000000000000000000000000000000000a" as Address;
const QUOTE_ADDRESS = "0x000000000000000000000000000000000000000b" as Address;

const nvda: QuoteAsset = {
  symbol: "NVDA",
  name: "NVDA",
  address: QUOTE_ADDRESS,
  decimals: 6,
  usdPrice: 1,
  pairs: 3,
  vol24h: 0,
};

const pair = {
  id: TOKEN,
  ticker: "AI",
  name: "Artificial Inu",
  address: TOKEN,
  quote: "NVDA",
  origin: "LONG",
  tradeable: true,
} as TokenPair;

/** 1,250 NVDA at 6 dp and 125,000 AI at 18 dp, in base units. */
const QUOTE_BASE = BigInt("1250000000");
const TOKEN_BASE = BigInt("125000000000000000000000");

/** Every field zeroed: the one answer for "the scale is not known yet". */
const ZERO = {
  quote: 0,
  token: 0,
  quoteBase: BigInt(0),
  tokenBase: BigInt(0),
  quoteText: "0",
  tokenText: "0",
};

function connected(): void {
  h.account = { address: WALLET, isConnected: true };
  h.quotes.data = [nvda];
  h.decimals.data = 18;
  h.batch.data = [QUOTE_BASE, TOKEN_BASE];
}

function read() {
  const { client, wrapper } = queryHarness();
  const view = renderHook(() => usePairBalances(pair), { wrapper });
  return { client, ...view };
}

describe("usePairBalances", () => {
  beforeEach(() => {
    h.account = { address: undefined, isConnected: false };
    h.quotes.data = undefined;
    h.decimals.data = undefined;
    h.batch.data = undefined;
    h.block.data = undefined;
    h.seenReadContract.mockClear();
    h.seenReadContracts.mockClear();
    h.seenBlockNumber.mockClear();
  });

  it("returns zeroes and asks the chain for nothing while disconnected", () => {
    const { result } = read();
    expect(result.current).toEqual(ZERO);
    expect(h.seenReadContracts.mock.calls[0][0]).toMatchObject({ query: { enabled: false } });
    expect(h.seenReadContracts.mock.calls[0][0].contracts).toBeUndefined();
    expect(h.seenReadContract.mock.calls[0][0]).toMatchObject({ query: { enabled: false } });
  });

  it("scales each balance by its own asset's decimals", () => {
    connected();
    const { result } = read();
    expect(result.current).toEqual({
      quote: 1250,
      token: 125_000,
      quoteBase: QUOTE_BASE,
      tokenBase: TOKEN_BASE,
      quoteText: "1250",
      tokenText: "125000",
    });
  });

  it("keeps an exact decimal string beside the float, so Max can be the balance to the last wei", () => {
    connected();
    // A balance no double can hold: 125000.123456789012345678 rounds to …8901 as a float.
    const odd = BigInt("125000123456789012345678");
    h.batch.data = [QUOTE_BASE, odd];
    const { result } = read();
    expect(result.current.tokenBase).toBe(odd);
    expect(result.current.tokenText).toBe("125000.123456789012345678");
    // The float is parsed from that same string, so the panel's comparison and the route's
    // toBase() of the string can never disagree about which is larger.
    expect(result.current.token).toBe(Number("125000.123456789012345678"));
    expect(String(result.current.token)).not.toBe(result.current.tokenText);
  });

  it("batches balanceOf for the quote address and the pair token, both on chain 4663", () => {
    connected();
    read();
    const params = h.seenReadContracts.mock.calls[0][0];
    expect(params.allowFailure).toBe(false);
    expect(params.query).toMatchObject({ enabled: true, refetchOnWindowFocus: true });
    expect(params.contracts).toHaveLength(2);
    expect(params.contracts[0]).toMatchObject({
      address: QUOTE_ADDRESS,
      functionName: "balanceOf",
      args: [WALLET],
      chainId: 4663,
    });
    expect(params.contracts[1]).toMatchObject({
      address: TOKEN,
      functionName: "balanceOf",
      args: [WALLET],
      chainId: 4663,
    });
  });

  it("reads the token's decimals once and keeps it, never in the per-block batch", () => {
    connected();
    read();
    expect(h.seenReadContract.mock.calls[0][0]).toMatchObject({
      address: TOKEN,
      functionName: "decimals",
      chainId: 4663,
      query: { enabled: true, staleTime: Infinity, gcTime: Infinity },
    });
  });

  it("returns zeroes rather than a wrong scale while the token's decimals are unknown", () => {
    connected();
    h.decimals.data = undefined;
    expect(read().result.current).toEqual(ZERO);
  });

  it("returns zeroes when the pair's quote symbol is not in the quotes list", () => {
    connected();
    h.quotes.data = [{ ...nvda, symbol: "USDC" }];
    const { result } = read();
    expect(result.current).toEqual(ZERO);
    expect(h.seenReadContracts.mock.calls[0][0]).toMatchObject({ query: { enabled: false } });
  });

  it("watches the head by polling rather than subscribing to every 0.1 s block", () => {
    connected();
    read();
    expect(h.seenBlockNumber.mock.calls[0][0]).toMatchObject({
      chainId: 4663,
      watch: { poll: true, pollingInterval: 10_000 },
      query: { enabled: true },
    });
  });

  it("invalidates the balance batch when a new block arrives, and not before", () => {
    connected();
    const { client, rerender } = read();
    const spy = vi.spyOn(client, "invalidateQueries");
    rerender();
    expect(spy).not.toHaveBeenCalled();
    h.block.data = BigInt(100);
    rerender();
    expect(spy).toHaveBeenCalledWith({ queryKey: h.batch.queryKey });
  });

  it("refreshes every read batch after a confirmed swap", async () => {
    const { client } = queryHarness();
    const spy = vi.spyOn(client, "invalidateQueries");
    await invalidatePairBalances(client);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["readContracts"] });
  });
});

describe("blockWatch", () => {
  it("always carries its own enabled flag", () => {
    // wagmi ANDs watch.enabled with the query's, so a watch object missing `enabled` is always
    // false and the poll never starts. This exact omission shipped and no test caught it.
    expect(blockWatch(true)).toEqual({ enabled: true, poll: true, pollingInterval: expect.any(Number) });
    expect(blockWatch(false).enabled).toBe(false);
    expect(Object.keys(blockWatch(true))).toContain("enabled");
  });

  it("polls on a human timescale, not per block", () => {
    // Robinhood Chain produces a block about every 100 ms; polling per block would be absurd.
    expect(blockWatch(true).pollingInterval).toBeGreaterThanOrEqual(5_000);
  });
});
