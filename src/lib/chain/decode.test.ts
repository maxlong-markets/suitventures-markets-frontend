import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { LAUNCHPAD_EVENTS_ABI, POOL_MANAGER, POOL_MANAGER_EVENTS_ABI } from "./abi";
import { decodeLog, type RawLog } from "./decode";

// Mixed-case fixtures throughout: every test doubles as a lowercasing check, since decodeLog
// must lowercase every address/id/hash regardless of how the chain (or HyperSync) cased it.
const POOL_ID = ("0x" + "AB".repeat(32)) as `0x${string}`; // bytes32, mixed case
const CURRENCY0 = "0x1111111111111111111111111111111111111111";
const CURRENCY1 = "0x2222222222222222222222222222222222222222";
// All-lowercase on purpose: viem's ABI encoder rejects a mixed-case "address" input that isn't
// a valid EIP-55 checksum, and viem's decoder returns "address" outputs checksummed (mixed-case)
// regardless of the input's case — so this still exercises decodeLog's own `.toLowerCase()`.
const HOOKS = "0x" + "ab".repeat(20);
const SENDER = "0x3333333333333333333333333333333333333333";
const TX_HASH = "0x" + "CD".repeat(32); // mixed case, 32 bytes
const TX_FROM = "0x4444444444444444444444444444444444444444".toUpperCase();

/**
 * encodeEventTopics's return type allows an OR-group (`Hex[]`) or `null` per slot, for filter
 * queries; every topic built here is a concrete value, never either of those, so this narrows it
 * down to what decodeLog actually takes.
 */
function topicsOf(encoded: readonly (`0x${string}` | readonly `0x${string}`[] | null)[]): string[] {
  return encoded.filter((t): t is `0x${string}` => typeof t === "string");
}

const BASE: Omit<RawLog, "topics" | "data"> = {
  address: POOL_MANAGER.toUpperCase().replace("0X", "0x"), // mixed case: routing by address must lowercase too
  blockNumber: 68_500_000,
  logIndex: 7,
  txHash: TX_HASH,
  timestamp: 1_700_000_000,
  txFrom: TX_FROM,
};

describe("decodeLog", () => {
  it("decodes Initialize to the exact ChainEvent, lowercasing every address/id/hash", () => {
    const topics = encodeEventTopics({
      abi: POOL_MANAGER_EVENTS_ABI,
      eventName: "Initialize",
      args: { id: POOL_ID, currency0: CURRENCY0, currency1: CURRENCY1 },
    });
    const data = encodeAbiParameters(
      [{ type: "uint24" }, { type: "int24" }, { type: "address" }, { type: "uint160" }, { type: "int24" }],
      [3000, 60, HOOKS as `0x${string}`, 79_228_162_514_264_337_593_543_950_336n, -887_270],
    );
    const event = decodeLog({ ...BASE, topics: topicsOf(topics), data });
    expect(event).toEqual({
      kind: "initialize",
      block: BASE.blockNumber,
      logIndex: BASE.logIndex,
      timestamp: BASE.timestamp,
      txHash: TX_HASH.toLowerCase(),
      txFrom: TX_FROM.toLowerCase(),
      poolId: POOL_ID.toLowerCase(),
      currency0: CURRENCY0.toLowerCase(),
      currency1: CURRENCY1.toLowerCase(),
      fee: 3000,
      tickSpacing: 60,
      hooks: HOOKS.toLowerCase(),
      sqrtPriceX96: 79_228_162_514_264_337_593_543_950_336n,
      tick: -887_270,
    });
    // toEqual above already distinguishes bigint from number (79n !== 79), so this doesn't need
    // its own typeof assertions on top.
  });

  it("decodes Swap to the exact ChainEvent; negative int128 amounts and a uint160 beyond 2^63 survive", () => {
    const maxUint160 = 2n ** 160n - 1n; // well beyond 2^63: exercises the bigint path, not number precision
    const topics = encodeEventTopics({ abi: POOL_MANAGER_EVENTS_ABI, eventName: "Swap", args: { id: POOL_ID, sender: SENDER } });
    const data = encodeAbiParameters(
      [{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }],
      [-123_456_789_012_345_678_901_234n, 987_654_321_098_765_432_109n, maxUint160, 2n ** 128n - 1n, -887_272, 500],
    );
    const event = decodeLog({ ...BASE, topics: topicsOf(topics), data });
    expect(event).toEqual({
      kind: "swap",
      block: BASE.blockNumber,
      logIndex: BASE.logIndex,
      timestamp: BASE.timestamp,
      txHash: TX_HASH.toLowerCase(),
      txFrom: TX_FROM.toLowerCase(),
      poolId: POOL_ID.toLowerCase(),
      amount0: -123_456_789_012_345_678_901_234n,
      amount1: 987_654_321_098_765_432_109n,
      sqrtPriceX96: maxUint160,
      liquidity: 2n ** 128n - 1n,
      tick: -887_272,
      fee: 500,
    });
    expect(maxUint160 > 2n ** 63n).toBe(true);
  });

  it("decodes ModifyLiquidity to the exact ChainEvent; negative int24 ticks and a negative int256 delta survive", () => {
    const topics = encodeEventTopics({ abi: POOL_MANAGER_EVENTS_ABI, eventName: "ModifyLiquidity", args: { id: POOL_ID, sender: SENDER } });
    const salt = ("0x" + "0".repeat(64)) as `0x${string}`;
    const data = encodeAbiParameters(
      [{ type: "int24" }, { type: "int24" }, { type: "int256" }, { type: "bytes32" }],
      [-600, 600, -(2n ** 200n), salt],
    );
    const event = decodeLog({ ...BASE, topics: topicsOf(topics), data });
    expect(event).toEqual({
      kind: "modifyLiquidity",
      block: BASE.blockNumber,
      logIndex: BASE.logIndex,
      timestamp: BASE.timestamp,
      txHash: TX_HASH.toLowerCase(),
      txFrom: TX_FROM.toLowerCase(),
      poolId: POOL_ID.toLowerCase(),
      tickLower: -600,
      tickUpper: 600,
      liquidityDelta: -(2n ** 200n),
    });
  });

  it("returns null for an unknown topic0", () => {
    const unknownTopic0 = ("0x" + "9".repeat(64)) as `0x${string}`;
    const event = decodeLog({ ...BASE, topics: [unknownTopic0], data: "0x" });
    expect(event).toBeNull();
  });

  it("returns null when a log carries no topics at all", () => {
    const event = decodeLog({ ...BASE, topics: [], data: "0x" });
    expect(event).toBeNull();
  });

  it("carries a null txFrom straight through, lowercasing nothing", () => {
    const topics = encodeEventTopics({ abi: POOL_MANAGER_EVENTS_ABI, eventName: "Swap", args: { id: POOL_ID, sender: SENDER } });
    const data = encodeAbiParameters(
      [{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }],
      [1n, -1n, 1n, 1n, 0, 0],
    );
    const event = decodeLog({ ...BASE, txFrom: null, topics: topicsOf(topics), data });
    expect(event?.txFrom).toBeNull();
  });
});

describe("decodeLog routes by address, then topic0 (instant launchpad design, section 5.2)", () => {
  const LAUNCHPAD = "0x" + "5a".repeat(20);
  const TOKEN = "0x" + "7a".repeat(20);
  const CREATOR = "0x" + "c1".repeat(20);
  const PAYOUT = "0x" + "c2".repeat(20);
  const QUOTE = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  const ZERO = "0x" + "0".repeat(40);
  const LAUNCH_POOL = ("0x" + "CD".repeat(32)) as `0x${string}`;
  const DATA = {
    poolId: LAUNCH_POOL, payout: CREATOR as `0x${string}`, hook: ZERO as `0x${string}`, tokenIsCurrency0: false, openTick: 398_400,
    openingValuation: 4_995_430_000n, liquidity: 2_240_000_000_000_000_000n, tokensInPool: 10n ** 27n - 300n, firstBuyIn: 99_500_000n,
    firstBuyTokens: 19_000_000n * 10n ** 18n, routerFee: 500_000n, creationFee: 0n, creatorShareBps: 7000,
    name: "Tailor's Chalk", symbol: "CHALK", metadataUri: "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
  };
  const launchedLog = () => ({
    topics: topicsOf(
      encodeEventTopics({
        abi: LAUNCHPAD_EVENTS_ABI, eventName: "Launched",
        args: { token: TOKEN as `0x${string}`, creator: CREATOR as `0x${string}`, quote: QUOTE as `0x${string}` },
      }),
    ),
    data: encodeAbiParameters([LAUNCHPAD_EVENTS_ABI[0].inputs[3]], [DATA]),
  });

  it("decodes Launched from the launchpad's address, the struct flattened, addresses lowercase, amounts bigint", () => {
    const event = decodeLog({ ...BASE, address: LAUNCHPAD.toUpperCase().replace("0X", "0x"), ...launchedLog() }, { launchpad: LAUNCHPAD });
    expect(event).toEqual({
      kind: "launched", block: BASE.blockNumber, logIndex: BASE.logIndex, timestamp: BASE.timestamp,
      txHash: TX_HASH.toLowerCase(), txFrom: TX_FROM.toLowerCase(),
      token: TOKEN, creator: CREATOR, quote: QUOTE, poolId: LAUNCH_POOL.toLowerCase(), payout: CREATOR, hook: ZERO,
      tokenIsCurrency0: false, openTick: 398_400, openingValuation: 4_995_430_000n, liquidity: 2_240_000_000_000_000_000n,
      tokensInPool: 10n ** 27n - 300n, firstBuyIn: 99_500_000n, firstBuyTokens: 19_000_000n * 10n ** 18n, routerFee: 500_000n,
      creationFee: 0n, creatorShareBps: 7000, name: "Tailor's Chalk", symbol: "CHALK", metadataUri: DATA.metadataUri,
    });
  });

  it("decodes FeesCollected and PayoutChanged", () => {
    const fees = decodeLog(
      {
        ...BASE, address: LAUNCHPAD,
        topics: topicsOf(encodeEventTopics({ abi: LAUNCHPAD_EVENTS_ABI, eventName: "FeesCollected", args: { token: TOKEN as `0x${string}`, payout: PAYOUT as `0x${string}` } })),
        data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [1000n, 10_000_000n, 700n, 7_000_000n]),
      },
      { launchpad: LAUNCHPAD },
    );
    expect(fees).toMatchObject({ kind: "launchFees", token: TOKEN, payout: PAYOUT, tokenFees: 1000n, quoteFees: 10_000_000n, tokenToPayout: 700n, quoteToPayout: 7_000_000n });
    const moved = decodeLog(
      {
        ...BASE, address: LAUNCHPAD,
        topics: topicsOf(
          encodeEventTopics({
            abi: LAUNCHPAD_EVENTS_ABI, eventName: "PayoutChanged",
            args: { token: TOKEN as `0x${string}`, previous: CREATOR as `0x${string}`, payout: PAYOUT as `0x${string}` },
          }),
        ),
        data: "0x",
      },
      { launchpad: LAUNCHPAD },
    );
    expect(moved).toMatchObject({ kind: "payoutChanged", token: TOKEN, previous: CREATOR, payout: PAYOUT });
  });

  it("drops a PoolManager topic0 from the launchpad address, and a launchpad topic0 from any other address", () => {
    const swapTopics = topicsOf(encodeEventTopics({ abi: POOL_MANAGER_EVENTS_ABI, eventName: "Swap", args: { id: POOL_ID, sender: SENDER } }));
    const swapData = encodeAbiParameters(
      [{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }],
      [1n, -1n, 1n, 1n, 0, 0],
    );
    expect(decodeLog({ ...BASE, address: LAUNCHPAD, topics: swapTopics, data: swapData }, { launchpad: LAUNCHPAD })).toBeNull();
    expect(decodeLog({ ...BASE, address: "0x" + "99".repeat(20), ...launchedLog() }, { launchpad: LAUNCHPAD })).toBeNull();
    expect(decodeLog({ ...BASE, ...launchedLog() }, { launchpad: LAUNCHPAD })).toBeNull(); // a launchpad topic0 from the PoolManager
  });

  it("decodes nothing from the launchpad while no launchpad is configured", () => {
    expect(decodeLog({ ...BASE, address: LAUNCHPAD, ...launchedLog() })).toBeNull();
    expect(decodeLog({ ...BASE, address: LAUNCHPAD, ...launchedLog() }, { launchpad: null })).toBeNull();
  });
});
