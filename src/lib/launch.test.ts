import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContractFunctionExecutionError, ContractFunctionRevertedError, RawContractError, UserRejectedRequestError, encodeAbiParameters,
  encodeErrorResult, encodeEventTopics, maxUint256, zeroAddress, type Hex, type Log, type PublicClient, type WalletClient,
} from "viem";
import { LAUNCHPAD_EVENTS_ABI } from "@/lib/chain/abi";
import { PERMIT2_ADDRESS } from "@/lib/chain";
import type { Address } from "@/lib/types";
import { svLaunchpadAbi } from "./launch/abi";
import {
  LAUNCH_MESSAGES, LaunchFailedError, LaunchRejectedError, LaunchUnconfirmedError, changePayout, claimOwed, collectLaunchFees,
  executeLaunch, messageForRevert, type LaunchDeps, type LaunchInput, type LaunchStep,
} from "./launch";

const h = vi.hoisted(() => ({ launchpad: "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a" as string | undefined }));
vi.mock("./launch/address", () => ({
  get LAUNCHPAD_ADDRESS() {
    return h.launchpad;
  },
  hasLaunchpad: () => h.launchpad !== undefined,
}));

const LAUNCHPAD = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a" as Address;
const ACCOUNT = "0x8888888888888888888888888888888888888888" as Address;
const OTHER = "0x9999999999999999999999999999999999999999" as Address;
const DECOY = "0x6666666666666666666666666666666666666666" as Address;
const QUOTE = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const TOKEN = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as Address;
const TX_HASH = `0x${"11".repeat(32)}` as Hex;
const APPROVE_HASH = `0x${"22".repeat(32)}` as Hex;
const SIGNATURE = `0x${"33".repeat(65)}` as Hex;
const SALT = `0x${"44".repeat(32)}` as Hex;
const NOW_SEC = 1_790_000_000;

const INPUT: LaunchInput = {
  name: "Tailor's Chalk", symbol: "CHALK", metadataUri: "ipfs://bafymeta", quote: QUOTE, valuation: 5_000_000_000n, firstBuy: 0n,
  minFirstBuyTokens: 0n, payout: ACCOUNT, salt: SALT, creationFee: 0n,
};

/** One Launched log, built with viem so the encoding is the real one; `address` defaults to the launchpad. */
function launchedLog(creator: Address = ACCOUNT, address: Address = LAUNCHPAD): Log {
  const topics = encodeEventTopics({ abi: LAUNCHPAD_EVENTS_ABI, eventName: "Launched", args: { token: TOKEN, creator, quote: QUOTE } });
  const data = encodeAbiParameters([LAUNCHPAD_EVENTS_ABI[0].inputs[3]], [{
    poolId: `0x${"cd".repeat(32)}`, payout: creator, hook: zeroAddress, tokenIsCurrency0: false, openTick: 398_400,
    openingValuation: 4_995_430_000n, liquidity: 1n, tokensInPool: 1n, firstBuyIn: 0n, firstBuyTokens: 0n, routerFee: 0n,
    creationFee: 0n, creatorShareBps: 7000, name: "Tailor's Chalk", symbol: "CHALK", metadataUri: "ipfs://bafymeta",
  }]);
  return {
    address, topics: topics as [Hex, ...Hex[]], data, blockHash: `0x${"00".repeat(32)}`, blockNumber: 77n, logIndex: 0,
    transactionHash: TX_HASH, transactionIndex: 0, removed: false,
  };
}

function reverted(errorName: string, args?: readonly unknown[]): Error {
  const data = encodeErrorResult({ abi: svLaunchpadAbi, errorName, args } as Parameters<typeof encodeErrorResult>[0]);
  return new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: svLaunchpadAbi, data, functionName: "launch" }), {
    abi: svLaunchpadAbi, functionName: "launch", args: [],
  });
}

function harness(o: { allowance?: bigint; logs?: Log[]; status?: "success" | "reverted" } = {}) {
  const readContract = vi.fn().mockResolvedValue(o.allowance ?? 0n);
  const simulateContract = vi.fn().mockResolvedValue({ request: {} });
  const writeContract = vi.fn(async ({ functionName }: { functionName: string; args: readonly unknown[] }) => (functionName === "approve" ? APPROVE_HASH : TX_HASH));
  const signTypedData = vi.fn().mockResolvedValue(SIGNATURE);
  const waitForTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) =>
    hash === APPROVE_HASH ? { status: "success", logs: [], blockNumber: 70n } : { status: o.status ?? "success", logs: o.logs ?? [launchedLog()], blockNumber: 77n },
  );
  const getTransaction = vi.fn().mockResolvedValue({ from: ACCOUNT, to: LAUNCHPAD, input: "0xabcdef", value: 0n });
  const call = vi.fn().mockResolvedValue({ data: "0x" });
  const deps: LaunchDeps = {
    wallet: { writeContract, signTypedData } as unknown as WalletClient,
    publicClient: { readContract, simulateContract, waitForTransactionReceipt, getTransaction, call } as unknown as PublicClient,
    account: ACCOUNT,
  };
  return { deps, readContract, simulateContract, writeContract, signTypedData, waitForTransactionReceipt, getTransaction, call };
}

beforeEach(() => {
  h.launchpad = LAUNCHPAD;
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("executeLaunch (spec 7.2, submit steps 3 to 6)", () => {
  it("sends a free launch with a zeroed permit and an empty signature, simulating first, and reads the token from our Launched", async () => {
    const t = harness({ logs: [launchedLog(OTHER), launchedLog()] }); // another creator's launch in the same block comes first
    const steps: LaunchStep[] = [];
    const handle = await executeLaunch(INPUT, t.deps, (s) => steps.push(s));
    expect(handle.hash).toBe(TX_HASH);
    expect(t.readContract).not.toHaveBeenCalled(); // no allowance: nothing is pulled
    expect(t.signTypedData).not.toHaveBeenCalled();
    const { name, symbol, metadataUri, quote, valuation, firstBuy, minFirstBuyTokens, payout, salt } = INPUT;
    const args = [
      { name, symbol, metadataUri, quote, valuation, firstBuy, minFirstBuyTokens, payout, salt, deadline: BigInt(NOW_SEC + 1200) },
      { permitted: { token: zeroAddress, amount: 0n }, nonce: 0n, deadline: 0n },
      "0x",
    ];
    expect(t.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ address: LAUNCHPAD, functionName: "launch", args, account: ACCOUNT }));
    expect(t.writeContract).toHaveBeenCalledWith(expect.objectContaining({ address: LAUNCHPAD, functionName: "launch", args, account: ACCOUNT }));
    expect(t.simulateContract.mock.invocationCallOrder[0]!).toBeLessThan(t.writeContract.mock.invocationCallOrder[0]!);
    expect(steps).toEqual(["confirm", "launching"]);
    await expect(handle.confirmation).resolves.toEqual({ token: TOKEN });
  });

  it("approves Permit2 for the maximum when the allowance is short, then signs exactly first buy plus creation fee to the launchpad", async () => {
    const t = harness({ allowance: 10n });
    const steps: LaunchStep[] = [];
    await executeLaunch({ ...INPUT, firstBuy: 100_000_000n, minFirstBuyTokens: 5n, creationFee: 2_000_000n }, t.deps, (s) => steps.push(s));
    expect(t.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: QUOTE, functionName: "allowance", args: [ACCOUNT, PERMIT2_ADDRESS] }));
    expect(t.writeContract.mock.calls[0]![0]).toMatchObject({ address: QUOTE, functionName: "approve", args: [PERMIT2_ADDRESS, maxUint256] });
    expect(t.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: APPROVE_HASH });
    const typed = t.signTypedData.mock.calls[0]![0];
    expect(typed.message).toMatchObject({ permitted: { token: QUOTE, amount: 102_000_000n }, spender: LAUNCHPAD, deadline: BigInt(NOW_SEC + 1200) });
    const [, permit, signature] = t.writeContract.mock.calls[1]![0].args;
    expect(permit).toEqual({ permitted: { token: QUOTE, amount: 102_000_000n }, nonce: typed.message.nonce, deadline: BigInt(NOW_SEC + 1200) });
    expect(signature).toBe(SIGNATURE);
    expect(steps).toEqual(["approve", "sign", "confirm", "launching"]);
  });

  it("skips the approval when the allowance already covers the total", async () => {
    const t = harness({ allowance: maxUint256 });
    const steps: LaunchStep[] = [];
    await executeLaunch({ ...INPUT, firstBuy: 1n }, t.deps, (s) => steps.push(s));
    expect(t.writeContract).toHaveBeenCalledTimes(1);
    expect(steps).toEqual(["sign", "confirm", "launching"]);
  });

  it("maps a simulated revert to spec 7.2's message and never opens the wallet", async () => {
    const t = harness();
    t.simulateContract.mockRejectedValueOnce(reverted("DailyLimitReached"));
    const err = await executeLaunch(INPUT, t.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaunchFailedError);
    expect((err as LaunchFailedError).message).toBe("You have used today's launches.");
    expect((err as LaunchFailedError).revert).toBe("DailyLimitReached");
    expect(t.writeContract).not.toHaveBeenCalled();
  });

  it("names PoolAlreadyInitialized, bubbled up from the PoolManager, so the form can draw a new salt", async () => {
    const t = harness();
    t.simulateContract.mockRejectedValueOnce(reverted("PoolAlreadyInitialized"));
    await expect(executeLaunch(INPUT, t.deps)).rejects.toMatchObject({
      revert: "PoolAlreadyInitialized",
      message: "Someone opened this token's pool first. A new address is ready; press Launch again.",
    });
  });

  it("names a refused token transfer, an OpenZeppelin error the compiled contract carries", async () => {
    const t = harness();
    t.simulateContract.mockRejectedValueOnce(reverted("SafeERC20FailedOperation", [QUOTE]));
    await expect(executeLaunch(INPUT, t.deps)).rejects.toMatchObject({
      revert: "SafeERC20FailedOperation",
      message: "The token refused the transfer. Nothing was spent except gas.",
    });
  });

  it("maps a dismissed wallet to LaunchRejectedError", async () => {
    const t = harness({ allowance: maxUint256 });
    t.signTypedData.mockRejectedValueOnce(new UserRejectedRequestError(new Error("User rejected the request.")));
    await expect(executeLaunch({ ...INPUT, firstBuy: 1n }, t.deps)).rejects.toThrow(new LaunchRejectedError(LAUNCH_MESSAGES.rejected));
  });

  it("replays a mined revert with eth_call at its block, same sender, data and value, and decodes the reason from the replay", async () => {
    const t = harness({ status: "reverted" });
    t.call.mockRejectedValueOnce(new RawContractError({ data: encodeErrorResult({ abi: svLaunchpadAbi, errorName: "FirstBuyTooSmall", args: [1n, 2n] }) }));
    const handle = await executeLaunch(INPUT, t.deps);
    await expect(handle.confirmation).rejects.toMatchObject({
      name: "LaunchFailedError", revert: "FirstBuyTooSmall", message: "The first buy would get fewer tokens than shown. Review and try again.",
    });
    expect(t.call).toHaveBeenCalledWith({ account: ACCOUNT, to: LAUNCHPAD, data: "0xabcdef", value: 0n, blockNumber: 77n });
  });

  it("says it could not confirm, never that nothing was spent, when the receipt cannot be read", async () => {
    const t = harness();
    t.waitForTransactionReceipt.mockRejectedValueOnce(new Error("timeout"));
    const handle = await executeLaunch(INPUT, t.deps);
    await expect(handle.confirmation).rejects.toBeInstanceOf(LaunchUnconfirmedError);
  });

  it("ignores a Launched emitted by another contract, and fails when none is ours", async () => {
    const t = harness({ logs: [launchedLog(ACCOUNT, DECOY)] });
    const handle = await executeLaunch(INPUT, t.deps);
    await expect(handle.confirmation).rejects.toThrow(LAUNCH_MESSAGES.launchFallback);
  });

  it("refuses to run before the launchpad is live", async () => {
    h.launchpad = undefined;
    await expect(executeLaunch(INPUT, harness().deps)).rejects.toThrow(LAUNCH_MESSAGES.notLive);
  });
});

describe("the fee panel's writes (spec 7.3)", () => {
  it("collects, claims to a chosen address and changes the payout, each simulated first and confirmed by its receipt", async () => {
    const t = harness();
    await (await collectLaunchFees(TOKEN, t.deps)).confirmation;
    await (await claimOwed(QUOTE, OTHER, t.deps)).confirmation;
    await (await changePayout(TOKEN, OTHER, t.deps)).confirmation;
    expect(t.writeContract.mock.calls.map(([c]) => [c.functionName, c.args])).toEqual([
      ["collectFees", [TOKEN]],
      ["claim", [QUOTE, OTHER]],
      ["setPayout", [TOKEN, OTHER]],
    ]);
    expect(t.simulateContract).toHaveBeenCalledTimes(3);
  });

  it("maps the panel's own reverts to plain words", async () => {
    const t = harness();
    t.simulateContract.mockRejectedValueOnce(reverted("NothingToCollect"));
    await expect(collectLaunchFees(TOKEN, t.deps)).rejects.toThrow("Nothing to collect yet.");
    expect(messageForRevert("NothingOwed", LAUNCH_MESSAGES.writeFallback)).toBe("Nothing is owed to this wallet.");
    expect(messageForRevert("NotPayout", LAUNCH_MESSAGES.writeFallback)).toBe("Only the current payout address can change it.");
    expect(messageForRevert("SomethingNew", LAUNCH_MESSAGES.writeFallback)).toBe(LAUNCH_MESSAGES.writeFallback);
    expect(messageForRevert("SafeERC20FailedOperation")).toBe("The token refused the transfer. Nothing was spent except gas.");
    expect(messageForRevert(null)).toBe("Launch failed. Nothing was spent except gas.");
  });
});
