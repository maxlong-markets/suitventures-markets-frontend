import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  maxUint256,
  type Hex,
  type Log,
  type PublicClient,
  type TypedDataDefinition,
  type WalletClient,
} from "viem";
import { PERMIT2_ADDRESS } from "@/lib/chain";
import type { SwapCall } from "@/lib/quote/price";
import type { Address } from "@/lib/types";
import { svRouterAbi } from "./swap/abi";
import { SwapFailedError, SwapRejectedError, executeSwap, type SwapDeps, type SwapRequest, SwapUnconfirmedError } from "./swap";

// vi.mock's factory is hoisted above every top-level `const`, so the address it returns must be
// declared through vi.hoisted rather than closed over directly (the same pattern as
// src/app/api/tokens/[address]/quote/route.test.ts).
const { ROUTER } = vi.hoisted(() => ({
  ROUTER: "0x7777777777777777777777777777777777777777" as Address,
}));
vi.mock("@/lib/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain")>()),
  SVROUTER_ADDRESS: ROUTER,
}));

const ACCOUNT = "0x8888888888888888888888888888888888888888" as Address;
/** Another contract in the same transaction, emitting a log shaped exactly like ours. */
const DECOY = "0x6666666666666666666666666666666666666666" as Address;
const TOKEN_IN = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN_OUT = "0x1111111111111111111111111111111111111111" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const POOL_ID = `0x${"ab".repeat(32)}` as Hex;
const SWAP_HASH = `0x${"11".repeat(32)}` as Address;
const APPROVE_HASH = `0x${"22".repeat(32)}` as Address;
const SIGNATURE = `0x${"33".repeat(65)}` as Hex;
const NOW_SEC = 1_789_547_000;

const CALL: SwapCall = {
  poolKey: { currency0: TOKEN_OUT, currency1: TOKEN_IN, fee: 3000, tickSpacing: 60, hooks: ZERO },
  zeroForOne: false,
  amountIn: "100000000",
  amountOutMin: "197010000000000000000",
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  tokenInDecimals: 6,
  tokenOutDecimals: 18,
};

// No dead fields (Task 4 review, Important 3): executeSwap reads only slippagePct and call, and
// the signer is deps.account alone.
const REQUEST: SwapRequest = {
  slippagePct: 1,
  call: CALL,
};

/** A Trade log the router would have emitted, built with viem so the encoding is the real one. */
function tradeLog(args: { amountOut: bigint; fee: bigint; holderRate: boolean; address?: Address }): Log {
  const topics = encodeEventTopics({
    abi: svRouterAbi,
    eventName: "Trade",
    args: { user: ACCOUNT, poolId: POOL_ID, tokenIn: TOKEN_IN },
  });
  return {
    address: args.address ?? ROUTER,
    topics: topics as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }],
      [TOKEN_OUT, 100_000_000n, args.fee, args.amountOut, args.holderRate],
    ),
    blockHash: `0x${"00".repeat(32)}` as Hex,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: SWAP_HASH,
    transactionIndex: 0,
    removed: false,
  };
}

function reverted(errorName: "Expired" | "InsufficientOutput" | "V4TooLittleReceived" | "unknown"): Error {
  const data =
    errorName === "unknown"
      ? ("0xdeadbeef" as Hex)
      : errorName === "Expired"
        ? encodeErrorResult({ abi: svRouterAbi, errorName: "Expired" })
        : errorName === "InsufficientOutput"
          ? encodeErrorResult({ abi: svRouterAbi, errorName: "InsufficientOutput", args: [90n, 100n] })
          : encodeErrorResult({
              abi: svRouterAbi,
              errorName: "ExecutionFailed",
              args: [0n, encodeErrorResult({ abi: svRouterAbi, errorName: "V4TooLittleReceived", args: [100n, 90n] })],
            });
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: svRouterAbi, data, functionName: "swapExactIn" }),
    { abi: svRouterAbi, functionName: "swapExactIn", args: [] },
  );
}

type Harness = {
  deps: SwapDeps;
  readContract: ReturnType<typeof vi.fn>;
  writeContract: ReturnType<typeof vi.fn>;
  signTypedData: ReturnType<typeof vi.fn>;
  waitForTransactionReceipt: ReturnType<typeof vi.fn>;
};

function harness(allowance: bigint): Harness {
  const readContract = vi.fn().mockResolvedValue(allowance);
  const writeContract = vi.fn(async ({ functionName }: { functionName: string }) =>
    functionName === "approve" ? APPROVE_HASH : SWAP_HASH,
  );
  const signTypedData = vi.fn().mockResolvedValue(SIGNATURE);
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({
    status: "success",
    logs: [tradeLog({ amountOut: 198_500_000_000_000_000_000n, fee: 500_000n, holderRate: false })],
  });
  return {
    readContract,
    writeContract,
    signTypedData,
    waitForTransactionReceipt,
    deps: {
      wallet: { writeContract, signTypedData } as unknown as WalletClient,
      publicClient: { readContract, waitForTransactionReceipt } as unknown as PublicClient,
      account: ACCOUNT,
    },
  };
}

describe("executeSwap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends no approval when the allowance already covers the input", async () => {
    const h = harness(maxUint256);
    await executeSwap(REQUEST, h.deps);
    expect(h.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: TOKEN_IN, functionName: "allowance", args: [ACCOUNT, PERMIT2_ADDRESS] }),
    );
    expect(h.writeContract).toHaveBeenCalledTimes(1);
    expect(h.writeContract.mock.calls[0][0].functionName).toBe("swapExactIn");
  });

  it("approves Permit2 for the maximum and waits for it before signing", async () => {
    const h = harness(0n);
    await executeSwap(REQUEST, h.deps);
    expect(h.writeContract).toHaveBeenCalledTimes(2);
    expect(h.writeContract.mock.calls[0][0]).toMatchObject({
      address: TOKEN_IN,
      functionName: "approve",
      args: [PERMIT2_ADDRESS, maxUint256],
      account: ACCOUNT,
    });
    expect(h.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: APPROVE_HASH });
    // The receipt came back before the wallet was asked to sign.
    expect(h.waitForTransactionReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      h.signTypedData.mock.invocationCallOrder[0],
    );
  });

  it("signs a Permit2 message naming the router, with a fresh nonce and a 20-minute deadline", async () => {
    const h = harness(maxUint256);
    await executeSwap(REQUEST, h.deps);
    const typed = h.signTypedData.mock.calls[0][0] as TypedDataDefinition & { account: Address };
    expect(typed.account).toBe(ACCOUNT);
    expect(typed.domain).toEqual({ name: "Permit2", chainId: 4663, verifyingContract: PERMIT2_ADDRESS });
    const message = typed.message as { permitted: { token: Address; amount: bigint }; spender: Address; nonce: bigint; deadline: bigint };
    expect(message.permitted).toEqual({ token: TOKEN_IN, amount: 100_000_000n });
    expect(message.spender).toBe(ROUTER);
    expect(message.deadline).toBe(BigInt(NOW_SEC + 1200));
    expect(message.nonce).toBeGreaterThan(0n);
    // The same nonce and deadline travel in the calldata, or Permit2 would hash a different message.
    const [params, permit, signature] = h.writeContract.mock.calls[0][0].args;
    expect(permit).toEqual({ permitted: { token: TOKEN_IN, amount: 100_000_000n }, nonce: message.nonce, deadline: message.deadline });
    expect(params.deadline).toBe(message.deadline);
    expect(signature).toBe(SIGNATURE);
  });

  it("sends the route's call block verbatim, recomputing nothing", async () => {
    const h = harness(maxUint256);
    const handle = await executeSwap(REQUEST, h.deps);
    expect(handle.hash).toBe(SWAP_HASH);
    const sent = h.writeContract.mock.calls[0][0];
    expect(sent).toMatchObject({ address: ROUTER, functionName: "swapExactIn", account: ACCOUNT });
    expect(sent.args[0]).toMatchObject({
      key: CALL.poolKey,
      zeroForOne: false,
      amountIn: 100_000_000n,
      amountOutMin: 197_010_000_000_000_000_000n,
      hookData: "0x",
    });
  });

  it("resolves the confirmation with the Trade event's own numbers", async () => {
    const h = harness(maxUint256);
    const handle = await executeSwap(REQUEST, h.deps);
    await expect(handle.confirmation).resolves.toEqual({
      amountOut: 198_500_000_000_000_000_000n,
      fee: 500_000n,
      holderRate: false,
      poolId: POOL_ID,
    });
    expect(h.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: SWAP_HASH });
  });

  it("reads only our router's Trade event, never one another contract emitted in the same transaction", async () => {
    const h = harness(maxUint256);
    h.waitForTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [
        // Same topic0, same data layout, different emitter — and it comes first.
        tradeLog({ amountOut: 1n, fee: 999_999n, holderRate: true, address: DECOY }),
        tradeLog({ amountOut: 198_500_000_000_000_000_000n, fee: 500_000n, holderRate: false }),
      ],
    });
    await expect((await executeSwap(REQUEST, h.deps)).confirmation).resolves.toEqual({
      amountOut: 198_500_000_000_000_000_000n,
      fee: 500_000n,
      holderRate: false,
      poolId: POOL_ID,
    });
  });

  it.each([
    { amountIn: "0" },
    { amountIn: (2n ** 128n).toString() },
    { amountOutMin: "0" },
    { amountOutMin: (2n ** 128n).toString() },
  ])("refuses a call block the router's uint128 cannot hold, before the wallet is touched (%o)", async (over) => {
    const h = harness(maxUint256);
    const req = { ...REQUEST, call: { ...CALL, ...over } };
    await expect(executeSwap(req, h.deps)).rejects.toBeInstanceOf(SwapFailedError);
    await expect(executeSwap(req, h.deps)).rejects.toThrow("Nothing was spent.");
    expect(h.readContract).not.toHaveBeenCalled();
    expect(h.writeContract).not.toHaveBeenCalled();
    expect(h.signTypedData).not.toHaveBeenCalled();
  });

  it("maps a dismissed wallet to SwapRejectedError", async () => {
    const h = harness(maxUint256);
    h.signTypedData.mockRejectedValue(
      new ContractFunctionExecutionError(new UserRejectedRequestError(new Error("User rejected the request.")), {
        abi: svRouterAbi,
        functionName: "swapExactIn",
        args: [],
      }),
    );
    await expect(executeSwap(REQUEST, h.deps)).rejects.toBeInstanceOf(SwapRejectedError);
    await expect(executeSwap(REQUEST, h.deps)).rejects.toThrow("Cancelled in wallet. Nothing was spent.");
  });

  it.each([
    ["InsufficientOutput" as const, "Price moved past 1% slippage; nothing was spent."],
    ["V4TooLittleReceived" as const, "Price moved past 1% slippage; nothing was spent."],
    ["Expired" as const, "The quote expired; try again. Nothing was spent."],
    ["unknown" as const, "Swap failed. Nothing was spent."],
  ])("maps a %s revert to its message", async (errorName, message) => {
    const h = harness(maxUint256);
    h.writeContract.mockRejectedValue(reverted(errorName));
    await expect(executeSwap(REQUEST, h.deps)).rejects.toBeInstanceOf(SwapFailedError);
    await expect(executeSwap(REQUEST, h.deps)).rejects.toThrow(message);
  });

  it("fails the confirmation when the transaction reverted or carried no Trade event", async () => {
    const h = harness(maxUint256);
    h.waitForTransactionReceipt.mockResolvedValueOnce({ status: "success", logs: [] });
    await expect((await executeSwap(REQUEST, h.deps)).confirmation).rejects.toThrow(
      "Swap failed. Nothing was spent.",
    );
    // A mined revert carries no revert data to decode (I3): the message is the honest generic
    // cause, and — unlike every other failure message in this file — says gas was spent, because
    // for a mined transaction it was.
    h.waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted", logs: [] });
    const handle = await executeSwap(REQUEST, h.deps);
    await expect(handle.confirmation).rejects.toBeInstanceOf(SwapFailedError);
    await expect(handle.confirmation).rejects.toThrow(
      "The swap reverted on-chain: the price moved past your slippage or the quote expired. Nothing was spent except gas.",
    );
  });
});

describe("a broadcast swap whose outcome cannot be read", () => {
  it("never tells the user nothing was spent, and keeps the hash", async () => {
    const h = harness(maxUint256);
    h.waitForTransactionReceipt.mockRejectedValue(new Error("timed out while waiting for receipt"));
    const handle = await executeSwap(REQUEST, h.deps);
    expect(handle.hash).toBe(SWAP_HASH);
    await expect(handle.confirmation).rejects.toBeInstanceOf(SwapUnconfirmedError);
    // The promise rejects, so this resolves to the error; assert that rather than widening the type.
    const err = await handle.confirmation.then(
      () => { throw new Error("confirmation resolved, but it must reject"); },
      (e: unknown) => e as Error,
    );
    // The wording is the point: "nothing was spent" here would invite a duplicate swap.
    expect(err.message).not.toMatch(/nothing was spent/i);
    expect(err.message).toMatch(/could not confirm/i);
  });
});

describe("a reverted approval", () => {
  it("is reported as an approval failure, and the swap is never broadcast", async () => {
    const h = harness(0n);
    h.waitForTransactionReceipt.mockResolvedValue({ status: "reverted", logs: [] });
    await expect(executeSwap(REQUEST, h.deps)).rejects.toThrow(/approve the token/i);
    const sent = h.writeContract.mock.calls.map((c) => (c[0] as { functionName: string }).functionName);
    expect(sent).toEqual(["approve"]);
  });
});

describe("a Trade event naming another account", () => {
  it("is not reported as this user's result", async () => {
    const h = harness(maxUint256);
    const foreign = tradeLog({ amountOut: 1n, fee: 0n, holderRate: false });
    // Same router, same event, different user: re-topic it to someone else.
    const otherUser = `0x${"99".repeat(20)}` as Address;
    foreign.topics = encodeEventTopics({
      abi: svRouterAbi,
      eventName: "Trade",
      args: { user: otherUser, poolId: POOL_ID, tokenIn: TOKEN_IN },
    }) as [Hex, ...Hex[]];
    h.waitForTransactionReceipt.mockResolvedValue({ status: "success", logs: [foreign] });
    const handle = await executeSwap(REQUEST, h.deps);
    await expect(handle.confirmation).rejects.toBeInstanceOf(SwapFailedError);
  });

  it("picks this user's Trade when the transaction carries several", async () => {
    const h = harness(maxUint256);
    const otherUser = `0x${"99".repeat(20)}` as Address;
    const foreign = tradeLog({ amountOut: 1n, fee: 0n, holderRate: false });
    foreign.topics = encodeEventTopics({
      abi: svRouterAbi,
      eventName: "Trade",
      args: { user: otherUser, poolId: POOL_ID, tokenIn: TOKEN_IN },
    }) as [Hex, ...Hex[]];
    const mine = tradeLog({ amountOut: 42n, fee: 7n, holderRate: false });
    h.waitForTransactionReceipt.mockResolvedValue({ status: "success", logs: [foreign, mine] });
    const handle = await executeSwap(REQUEST, h.deps);
    await expect(handle.confirmation).resolves.toMatchObject({ amountOut: 42n, fee: 7n, poolId: POOL_ID });
  });
});
