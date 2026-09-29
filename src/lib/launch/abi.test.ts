import { describe, expect, it } from "vitest";
import {
  decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeErrorResult, encodeEventTopics,
  encodeFunctionData, toEventSelector, toFunctionSelector, type Hex,
} from "viem";
import { LAUNCHPAD_EVENTS_ABI, LAUNCH_TOPIC0 } from "@/lib/chain/abi";
import type { Address } from "@/lib/types";
import { svLaunchpadAbi } from "./abi";

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const C = "0x3333333333333333333333333333333333333333" as Address;
const SALT = `0x${"ab".repeat(32)}` as Hex;
const POOL_ID = `0x${"cd".repeat(32)}` as Hex;

/** Spec 4.2's canonical signatures, typed out here so the selectors are pinned independently of how abi.ts spells them. */
const EVENTS: ReadonlyArray<readonly [string, string]> = [
  ["Launched", "Launched(address,address,address,(bytes32,address,address,bool,int24,uint256,uint128,uint256,uint256,uint256,uint256,uint256,uint16,string,string,string))"],
  ["FeesCollected", "FeesCollected(address,address,uint256,uint256,uint256,uint256)"],
  ["PayoutChanged", "PayoutChanged(address,address,address)"],
  ["FeeWalletChanged", "FeeWalletChanged(address)"],
  ["RouterFeeChanged", "RouterFeeChanged(uint16)"],
  ["CreatorShareChanged", "CreatorShareChanged(uint16)"],
  ["FirstBuyCapChanged", "FirstBuyCapChanged(uint16)"],
  ["DailyLaunchLimitChanged", "DailyLaunchLimitChanged(uint8)"],
  ["LauncherGateChanged", "LauncherGateChanged(address)"],
  ["HookChanged", "HookChanged(address)"],
  ["CurrencyChanged", "CurrencyChanged(address,uint256,uint256,uint256)"],
];

type EventName = Extract<(typeof svLaunchpadAbi)[number], { type: "event" }>["name"];

describe("the launchpad's events (spec 4.2)", () => {
  it("carries exactly the eleven events, each with its Solidity signature's topic0", () => {
    const names = svLaunchpadAbi.filter((i) => i.type === "event").map((i) => i.name).sort();
    expect(names).toEqual(EVENTS.map(([name]) => name).sort());
    for (const [name, canonical] of EVENTS) {
      expect(encodeEventTopics({ abi: svLaunchpadAbi, eventName: name as EventName })[0]).toBe(toEventSelector(canonical));
    }
  });

  it("pins the three activity topics the reader filters on, to the digit", () => {
    expect(LAUNCH_TOPIC0).toEqual({
      launched: "0xb706006cc55fa62f2e1d800d1523c84da203937d74f39f8d10907d6f76fadfca",
      feesCollected: "0x3dafb2014fe30c40450cebb7865f8a48a63be8e7876aff5e38f3cba37b285263",
      payoutChanged: "0xd64e38e8ecb2ec71967e9aa3a68ee54619b91ff17757987e66aed49b5073ae13",
    });
    expect(LAUNCHPAD_EVENTS_ABI.map((e) => e.name)).toEqual(["Launched", "FeesCollected", "PayoutChanged"]);
  });

  it("round-trips a Launched log, its one tuple decoded field by field", () => {
    const data = {
      poolId: POOL_ID, payout: B, hook: C, tokenIsCurrency0: true, openTick: -398_400, openingValuation: 4_995_430_000n,
      liquidity: 2_240_000_000_000_000_000n, tokensInPool: 10n ** 27n - 300n, firstBuyIn: 99_500_000n, firstBuyTokens: 19n * 10n ** 24n,
      routerFee: 500_000n, creationFee: 0n, creatorShareBps: 7000, name: "Tailor's Chalk", symbol: "CHALK", metadataUri: "ipfs://bafy",
    };
    const topics = encodeEventTopics({ abi: svLaunchpadAbi, eventName: "Launched", args: { token: A, creator: B, quote: C } });
    const encoded = encodeAbiParameters([LAUNCHPAD_EVENTS_ABI[0].inputs[3]], [data]);
    const decoded = decodeEventLog({ abi: svLaunchpadAbi, topics: topics as [Hex, ...Hex[]], data: encoded });
    expect(decoded.eventName).toBe("Launched");
    expect(decoded.args).toEqual({ token: A, creator: B, quote: C, data });
  });
});

describe("the launchpad's functions (spec 4.2, in the interface's order)", () => {
  it("carries exactly the interface's functions, each encoding with the selector of its canonical signature", () => {
    const params = {
      name: "Tailor's Chalk", symbol: "CHALK", metadataUri: "ipfs://bafy", quote: A, valuation: 5n, firstBuy: 0n,
      minFirstBuyTokens: 0n, payout: B, salt: SALT, deadline: 9n,
    };
    const permit = { permitted: { token: A, amount: 5n }, nonce: 7n, deadline: 9n };
    const f = svLaunchpadAbi;
    const cases: ReadonlyArray<readonly [string, Hex]> = [
      ["launch((string,string,string,address,uint256,uint256,uint256,address,bytes32,uint256),((address,uint256),uint256,uint256),bytes)",
        encodeFunctionData({ abi: f, functionName: "launch", args: [params, permit, "0xabcd"] })],
      ["collectFees(address)", encodeFunctionData({ abi: f, functionName: "collectFees", args: [A] })],
      ["claim(address,address)", encodeFunctionData({ abi: f, functionName: "claim", args: [A, B] })],
      ["setPayout(address,address)", encodeFunctionData({ abi: f, functionName: "setPayout", args: [A, B] })],
      ["unlockCallback(bytes)", encodeFunctionData({ abi: f, functionName: "unlockCallback", args: ["0x"] })],
      ["setFeeWallet(address)", encodeFunctionData({ abi: f, functionName: "setFeeWallet", args: [A] })],
      ["setRouterFee(uint16)", encodeFunctionData({ abi: f, functionName: "setRouterFee", args: [50] })],
      ["setCreatorShare(uint16)", encodeFunctionData({ abi: f, functionName: "setCreatorShare", args: [7000] })],
      ["setFirstBuyCap(uint16)", encodeFunctionData({ abi: f, functionName: "setFirstBuyCap", args: [2000] })],
      ["setDailyLaunchLimit(uint8)", encodeFunctionData({ abi: f, functionName: "setDailyLaunchLimit", args: [5] })],
      ["setLauncherGate(address)", encodeFunctionData({ abi: f, functionName: "setLauncherGate", args: [A] })],
      ["setHook(address)", encodeFunctionData({ abi: f, functionName: "setHook", args: [A] })],
      ["setCurrency(address,uint256,uint256,uint256)", encodeFunctionData({ abi: f, functionName: "setCurrency", args: [A, 1n, 2n, 0n] })],
      ["getLaunch(address)", encodeFunctionData({ abi: f, functionName: "getLaunch", args: [A] })],
      ["poolKeyOf(address)", encodeFunctionData({ abi: f, functionName: "poolKeyOf", args: [A] })],
      ["uncollectedFees(address)", encodeFunctionData({ abi: f, functionName: "uncollectedFees", args: [A] })],
      ["predictToken(address,bytes32,string,string)", encodeFunctionData({ abi: f, functionName: "predictToken", args: [A, SALT, "N", "S"] })],
      ["openingFor(address,address,uint256)", encodeFunctionData({ abi: f, functionName: "openingFor", args: [A, B, 5n] })],
      ["isAllowedLauncher(address)", encodeFunctionData({ abi: f, functionName: "isAllowedLauncher", args: [A] })],
      ["launchesToday(address)", encodeFunctionData({ abi: f, functionName: "launchesToday", args: [A] })],
      ["currency(address)", encodeFunctionData({ abi: f, functionName: "currency", args: [A] })],
      ["owed(address,address)", encodeFunctionData({ abi: f, functionName: "owed", args: [A, B] })],
      ["launchCount()", encodeFunctionData({ abi: f, functionName: "launchCount" })],
      ["feeWallet()", encodeFunctionData({ abi: f, functionName: "feeWallet" })],
      ["routerFeeBps()", encodeFunctionData({ abi: f, functionName: "routerFeeBps" })],
      ["creatorShareBps()", encodeFunctionData({ abi: f, functionName: "creatorShareBps" })],
      ["firstBuyCapBps()", encodeFunctionData({ abi: f, functionName: "firstBuyCapBps" })],
      ["dailyLaunchLimit()", encodeFunctionData({ abi: f, functionName: "dailyLaunchLimit" })],
      ["launcherGate()", encodeFunctionData({ abi: f, functionName: "launcherGate" })],
      ["hook()", encodeFunctionData({ abi: f, functionName: "hook" })],
      ["POOL_MANAGER()", encodeFunctionData({ abi: f, functionName: "POOL_MANAGER" })],
      ["PERMIT2()", encodeFunctionData({ abi: f, functionName: "PERMIT2" })],
    ];
    for (const [canonical, data] of cases) expect(data.slice(0, 10)).toBe(toFunctionSelector(canonical));
    const names = f.filter((i) => i.type === "function").map((i) => i.name).sort();
    expect(names).toEqual(cases.map(([canonical]) => canonical.slice(0, canonical.indexOf("("))).sort());
    // The one selector the wallet signs against, pinned to the digit as well.
    expect(cases[0]![1].slice(0, 10)).toBe("0x7d74140f");
  });

  it("decodes the struct-returning views in spec 4.2's struct order", () => {
    // Each tuple is typed out here in the spec's field order, NOT taken from abi.ts: encoding with the ABI's own outputs
    // and decoding with them again would pass whatever order abi.ts happened to use.
    const f = svLaunchpadAbi;
    const ZERO = "0x0000000000000000000000000000000000000000" as Address;
    const launch = { creator: A, launchedAt: 1_790_000_000n, creatorShareBps: 7000, tokenIsCurrency0: false, payout: B, openTick: 398_400, quote: C, hook: ZERO, liquidity: 12n };
    const encodedLaunch = encodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "creator", type: "address" }, { name: "launchedAt", type: "uint64" }, { name: "creatorShareBps", type: "uint16" },
        { name: "tokenIsCurrency0", type: "bool" }, { name: "payout", type: "address" }, { name: "openTick", type: "int24" },
        { name: "quote", type: "address" }, { name: "hook", type: "address" }, { name: "liquidity", type: "uint128" },
      ] }],
      [launch],
    );
    expect(decodeFunctionResult({ abi: f, functionName: "getLaunch", data: encodedLaunch })).toEqual(launch);

    const fees = { tokenFees: 10n, quoteFees: 20n, tokenToPayout: 7n, quoteToPayout: 14n, tokenToFeeWallet: 3n, quoteToFeeWallet: 6n };
    const encodedFees = encodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "tokenFees", type: "uint256" }, { name: "quoteFees", type: "uint256" }, { name: "tokenToPayout", type: "uint256" },
        { name: "quoteToPayout", type: "uint256" }, { name: "tokenToFeeWallet", type: "uint256" }, { name: "quoteToFeeWallet", type: "uint256" },
      ] }],
      [fees],
    );
    expect(decodeFunctionResult({ abi: f, functionName: "uncollectedFees", data: encodedFees })).toEqual(fees);

    const config = { minValuation: 5_000_000_000n, maxValuation: 10_000_000_000_000n, creationFee: 0n };
    const encodedConfig = encodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "minValuation", type: "uint256" }, { name: "maxValuation", type: "uint256" }, { name: "creationFee", type: "uint256" },
      ] }],
      [config],
    );
    expect(decodeFunctionResult({ abi: f, functionName: "currency", data: encodedConfig })).toEqual(config);

    const opening = encodeAbiParameters(
      [{ type: "int24" }, { type: "uint160" }, { type: "uint256" }],
      [-398_400, 179_000_000_000_000_000_000n, 4_995_430_000n],
    );
    expect(decodeFunctionResult({ abi: f, functionName: "openingFor", data: opening })).toEqual([-398_400, 179_000_000_000_000_000_000n, 4_995_430_000n]);

    const key = { currency0: A, currency1: B, fee: 10_000, tickSpacing: 200, hooks: ZERO };
    const encodedKey = encodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
      ] }],
      [key],
    );
    expect(decodeFunctionResult({ abi: f, functionName: "poolKeyOf", data: encodedKey })).toEqual(key);
  });

  it("carries every custom error of spec 4.2 and the three foreign ones a launch can bubble up, so a revert reads by name", () => {
    const errors = svLaunchpadAbi.filter((i) => i.type === "error").map((i) => i.name).sort();
    expect(errors).toEqual([
      "BadName", "BadPayout", "BadSymbol", "BoundsOutOfRange", "CurrencyNotAllowed", "DailyLimitReached", "Expired", "FeeTooHigh",
      "FirstBuyTooLarge", "FirstBuyTooSmall", "HookNotAllowed", "InvalidNonce", "NotAllowedToLaunch", "NotPayout", "NotPoolManager",
      "NothingOwed", "NothingToCollect", "PermitMismatch", "PoolAlreadyInitialized", "RenounceDisabled", "SignatureExpired",
      "UnexpectedCallback", "UnknownLaunch", "UriTooLong", "ValuationOutOfRange", "ZeroAddress", "BpsTooHigh",
    ].sort());
    const data = encodeErrorResult({ abi: svLaunchpadAbi, errorName: "ValuationOutOfRange", args: [1n, 2n, 3n] });
    expect(data.slice(0, 10)).toBe(toFunctionSelector("ValuationOutOfRange(uint256,uint256,uint256)"));
    expect(decodeErrorResult({ abi: svLaunchpadAbi, data })).toMatchObject({ errorName: "ValuationOutOfRange", args: [1n, 2n, 3n] });
    expect(encodeErrorResult({ abi: svLaunchpadAbi, errorName: "PoolAlreadyInitialized" })).toBe(toFunctionSelector("PoolAlreadyInitialized()"));
    expect(encodeErrorResult({ abi: svLaunchpadAbi, errorName: "FirstBuyTooSmall", args: [1n, 2n] }).slice(0, 10)).toBe(
      toFunctionSelector("FirstBuyTooSmall(uint256,uint256)"),
    );
  });
});
