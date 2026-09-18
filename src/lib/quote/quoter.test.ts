import { describe, expect, it, vi } from "vitest";
import {
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  TimeoutError,
  type PublicClient,
} from "viem";
import { V4_QUOTER_ADDRESS } from "@/lib/chain";
import type { PoolKeyRow } from "@/lib/market/poolKey";
import { NotRoutableError, QUOTER_ABI, QuoterUnavailableError, createQuoter } from "./quoter";

// The real AI/NVDA pool: the fixtures' constants, and the only key that hashes to this pool id.
// The two amounts below are what the live Quoter answered at block 0x3e8ee47 (header facts).
const AI = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const HOOK = "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544";
const POOL = "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27";
const pool: PoolKeyRow = {
  poolId: POOL, currency0: AI, currency1: NVDA, fee: 8388608, tickSpacing: 8, hooks: HOOK,
  tokenIsCurrency0: true, priceQuote: 0.000866,
  tokenAddress: AI, tokenDecimals: 18, quoteAddress: NVDA, quoteDecimals: 18,
};
const KEY = { currency0: AI, currency1: NVDA, fee: 8388608, tickSpacing: 8, hooks: HOOK };

function fake() {
  const simulateContract = vi.fn();
  return { simulateContract, client: { simulateContract } as unknown as PublicClient };
}

describe("createQuoter", () => {
  it("simulates quoteExactInputSingle and returns the output, dropping the gas estimate", async () => {
    const { simulateContract, client } = fake();
    simulateContract.mockResolvedValue({ result: [602_148_524_866_942_348_891n, 348_787n] });
    const out = await createQuoter({ client }).exactIn({ poolKey: pool, zeroForOne: false, exactAmount: 10n ** 18n });
    expect(out).toBe(602_148_524_866_942_348_891n);
    expect(simulateContract).toHaveBeenCalledWith({
      address: V4_QUOTER_ADDRESS,
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: KEY, zeroForOne: false, exactAmount: 10n ** 18n, hookData: "0x" }],
    });
  });

  it("simulates quoteExactOutputSingle for the input an exact output needs", async () => {
    const { simulateContract, client } = fake();
    simulateContract.mockResolvedValue({ result: [1_660_639_452_746_401_247n, 262_929n] });
    const need = await createQuoter({ client }).exactOut({ poolKey: pool, zeroForOne: false, exactAmount: 10n ** 21n });
    expect(need).toBe(1_660_639_452_746_401_247n);
    expect(simulateContract).toHaveBeenCalledWith({
      address: V4_QUOTER_ADDRESS,
      abi: QUOTER_ABI,
      functionName: "quoteExactOutputSingle",
      args: [{ poolKey: KEY, zeroForOne: false, exactAmount: 10n ** 21n, hookData: "0x" }],
    });
  });

  it("sends the PoolKey's five fields and nothing else: decimals and the stored price never reach the chain", async () => {
    const { simulateContract, client } = fake();
    simulateContract.mockResolvedValue({ result: [1n, 1n] });
    await createQuoter({ client }).exactIn({ poolKey: pool, zeroForOne: true, exactAmount: 1n });
    const [call] = simulateContract.mock.calls[0]!;
    expect(Object.keys(call.args[0].poolKey)).toEqual(["currency0", "currency1", "fee", "tickSpacing", "hooks"]);
    expect(Object.keys(call.args[0])).toEqual(["poolKey", "zeroForOne", "exactAmount", "hookData"]);
  });

  it("carries the ABI the chain was probed with: nonpayable, one tuple in, two words out", () => {
    // Indexed, not searched: `find` would hand back a union of the two fragments and `.map` on a union of tuples does not typecheck.
    const [exactIn, exactOut] = QUOTER_ABI;
    expect(exactIn.name).toBe("quoteExactInputSingle");
    expect(exactOut.name).toBe("quoteExactOutputSingle");
    // Both revert to return their value, so a view call would be refused and `simulateContract` is the only way to read them.
    expect(exactIn.stateMutability).toBe("nonpayable");
    expect(exactOut.stateMutability).toBe("nonpayable");
    expect(exactIn.outputs.map((o) => o.type)).toEqual(["uint256", "uint256"]);
    expect(exactOut.outputs.map((o) => o.type)).toEqual(["uint256", "uint256"]);
    expect(exactIn.inputs[0].components.map((c) => c.type)).toEqual(["tuple", "bool", "uint128", "bytes"]);
    expect(exactIn.inputs[0].components[0].components.map((c) => c.type)).toEqual(["address", "address", "uint24", "int24", "address"]);
  });

  it("turns a revert into NotRoutableError, on either function", async () => {
    const { simulateContract, client } = fake();
    simulateContract.mockRejectedValue(
      new ContractFunctionRevertedError({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", message: "execution reverted" }),
    );
    const quoter = createQuoter({ client });
    await expect(quoter.exactIn({ poolKey: pool, zeroForOne: true, exactAmount: 1n })).rejects.toBeInstanceOf(NotRoutableError);
    await expect(quoter.exactOut({ poolKey: pool, zeroForOne: true, exactAmount: 1n })).rejects.toBeInstanceOf(NotRoutableError);
  });

  it("turns an empty answer — nothing deployed at the address — into NotRoutableError", async () => {
    const { simulateContract, client } = fake();
    simulateContract.mockRejectedValue(new ContractFunctionZeroDataError({ functionName: "quoteExactOutputSingle" }));
    await expect(createQuoter({ client }).exactOut({ poolKey: pool, zeroForOne: true, exactAmount: 1n })).rejects.toBeInstanceOf(NotRoutableError);
  });

  it("names no address in the message it hands the route", async () => {
    const { simulateContract, client } = fake();
    simulateContract.mockRejectedValue(new ContractFunctionRevertedError({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", message: "execution reverted" }));
    const err = await createQuoter({ client }).exactIn({ poolKey: pool, zeroForOne: true, exactAmount: 1n }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("the pool cannot be routed");
    expect((err as Error).name).toBe("NotRoutableError");
  });

  it("wraps a transport failure in QuoterUnavailableError, so the route answers 503 rather than 'not routed'", async () => {
    const { simulateContract, client } = fake();
    // viem's own timeout, carrying the endpoint and the request body it was sent.
    simulateContract.mockRejectedValue(
      new TimeoutError({ body: { method: "eth_call" }, url: "https://rpc.internal.example/secret-key" }),
    );
    const err = await createQuoter({ client }).exactIn({ poolKey: pool, zeroForOne: true, exactAmount: 1n }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuoterUnavailableError);
    expect(err).not.toBeInstanceOf(NotRoutableError);
    expect((err as Error).name).toBe("QuoterUnavailableError");
    // The class of the failure and nothing else: no URL, no host, no body (rule 4).
    expect((err as Error).message).toBe("quoter unreachable (TimeoutError)");
    expect((err as Error).message).not.toContain("secret-key");
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  it("wraps a bare fetch failure the same way, keeping none of its message", async () => {
    const { simulateContract, client } = fake();
    simulateContract.mockRejectedValue(new Error("fetch failed: https://rpc.internal.example/secret-key"));
    const err = await createQuoter({ client }).exactIn({ poolKey: pool, zeroForOne: true, exactAmount: 1n }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuoterUnavailableError);
    expect((err as Error).message).toBe("quoter unreachable (Error)");
  });

  it("refuses an amount the Quoter's uint128 cannot hold, before any RPC call", async () => {
    const { simulateContract, client } = fake();
    const quoter = createQuoter({ client });
    await expect(quoter.exactIn({ poolKey: pool, zeroForOne: true, exactAmount: 0n })).rejects.toBeInstanceOf(RangeError);
    await expect(quoter.exactIn({ poolKey: pool, zeroForOne: true, exactAmount: -1n })).rejects.toBeInstanceOf(RangeError);
    await expect(quoter.exactOut({ poolKey: pool, zeroForOne: true, exactAmount: 1n << 128n })).rejects.toBeInstanceOf(RangeError);
    expect(simulateContract).not.toHaveBeenCalled();
  });
});
