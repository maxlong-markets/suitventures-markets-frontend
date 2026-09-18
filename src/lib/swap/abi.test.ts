import { describe, expect, it } from "vitest";
import {
  decodeErrorResult,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  maxUint256,
  toEventSelector,
  toFunctionSelector,
  type Hex,
} from "viem";
import type { Address } from "@/lib/types";
import { erc20Abi, permit2Abi, svRouterAbi } from "./abi";

/** The signatures the deployed contracts actually answer to, copied from the Solidity. */
const SWAP_EXACT_IN =
  "swapExactIn(((address,address,uint24,int24,address),bool,uint128,uint128,bytes,uint256),((address,uint256),uint256,uint256),bytes)";
const TRADE = "Trade(address,bytes32,address,address,uint256,uint256,uint256,bool)";

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

describe("svRouterAbi", () => {
  it("encodes swapExactIn with the interface's own selector", () => {
    const data = encodeFunctionData({
      abi: svRouterAbi,
      functionName: "swapExactIn",
      args: [
        {
          key: { currency0: A, currency1: B, fee: 3000, tickSpacing: 60, hooks: ZERO },
          zeroForOne: true,
          amountIn: 5n,
          amountOutMin: 1n,
          hookData: "0x",
          deadline: 9n,
        },
        { permitted: { token: A, amount: 5n }, nonce: 7n, deadline: 9n },
        "0xabcd",
      ],
    });
    expect(data.slice(0, 10)).toBe(toFunctionSelector(SWAP_EXACT_IN));
    expect(data.slice(0, 10)).toBe("0x4d20a50e");
  });

  it("carries the Trade event the router emits", () => {
    const topics = encodeEventTopics({ abi: svRouterAbi, eventName: "Trade" });
    expect(topics[0]).toBe(toEventSelector(TRADE));
    expect(topics[0]).toBe("0xae40db530a6f81e9282323b921d77b7a760136cb1ac63e1d0d00d6b4c6a837aa");
  });

  it.each([
    ["Expired", "0x203d82d8"],
    ["ZeroAmount", "0x1f2a2005"],
    ["ZeroAddress", "0xd92e233d"],
    ["PermitMismatch", "0xceaf57ba"],
    ["FeeTooHigh", "0xcd4e6167"],
    ["RenounceDisabled", "0x89051165"],
    ["TransactionDeadlinePassed", "0x5bf6f916"],
  ] as ReadonlyArray<[string, Hex]>)("decodes the %s revert from its selector", (name, selector) => {
    expect(toFunctionSelector(`${name}()`)).toBe(selector);
    expect(decodeErrorResult({ abi: svRouterAbi, data: selector }).errorName).toBe(name);
  });

  it("decodes the reverts that carry numbers, including the one the Universal Router wraps", () => {
    const short = encodeErrorResult({ abi: svRouterAbi, errorName: "InsufficientOutput", args: [90n, 100n] });
    expect(short.slice(0, 10)).toBe(toFunctionSelector("InsufficientOutput(uint256,uint256)"));
    expect(decodeErrorResult({ abi: svRouterAbi, data: short }).errorName).toBe("InsufficientOutput");

    const inner = encodeErrorResult({ abi: svRouterAbi, errorName: "V4TooLittleReceived", args: [100n, 90n] });
    expect(inner.slice(0, 10)).toBe(toFunctionSelector("V4TooLittleReceived(uint256,uint256)"));
    const outer = encodeErrorResult({ abi: svRouterAbi, errorName: "ExecutionFailed", args: [0n, inner] });
    const decoded = decodeErrorResult({ abi: svRouterAbi, data: outer });
    expect(decoded.errorName).toBe("ExecutionFailed");
    const nested = (decoded.args as readonly unknown[])[1] as Hex;
    expect(decodeErrorResult({ abi: svRouterAbi, data: nested }).errorName).toBe("V4TooLittleReceived");
  });
});

describe("erc20Abi and permit2Abi", () => {
  it("carry exactly what the swap reads and writes, and nothing the balances hook owns", () => {
    // No `decimals`: the balances hook reads it through viem's own erc20Abi (Task 5).
    expect(erc20Abi.map((item) => item.name).sort()).toEqual(["allowance", "approve", "balanceOf"]);
    expect(
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [A, maxUint256] }).slice(0, 10),
    ).toBe("0x095ea7b3");
    expect(
      encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [A, B] }).slice(0, 10),
    ).toBe("0xdd62ed3e");
    expect(
      encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [A] }).slice(0, 10),
    ).toBe("0x70a08231");
    expect(
      encodeFunctionData({ abi: permit2Abi, functionName: "nonceBitmap", args: [A, 0n] }).slice(0, 10),
    ).toBe("0x4fe02b44");
  });
});
