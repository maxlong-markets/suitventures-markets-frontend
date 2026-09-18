import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  http,
  type PublicClient,
} from "viem";
import { V4_QUOTER_ADDRESS, robinhoodChain } from "@/lib/chain";
import type { PoolKeyRow } from "@/lib/market/poolKey";
import type { Address } from "@/lib/types";

/**
 * IV4Quoter, as `cast call` reported it on 4663 (18 Sep 2026):
 *   quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))
 *   quoteExactOutputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))
 * Both are non-view — they run the swap and revert with the encoded result, which the Quoter's own
 * entry point catches and returns — so `simulateContract` is the right call and `readContract`
 * would refuse them. Each answers two words, `(amount, gasEstimate)`, which arrive as `result`.
 */
export const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "quoteExactOutputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export type QuoterCall = { poolKey: PoolKeyRow; zeroForOne: boolean; exactAmount: bigint };

export interface Quoter {
  /** Output for an exact input. NotRoutableError when the pool cannot be routed, QuoterUnavailableError when the node cannot be reached. */
  exactIn(call: QuoterCall): Promise<bigint>;
  /** Input an exact output needs. Same two failures. */
  exactOut(call: QuoterCall): Promise<bigint>;
}

/** The pool cannot be routed: the Quoter reverted with something other than its own return value. Carries no address, by rule 4. */
export class NotRoutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotRoutableError";
  }
}

/**
 * The Quoter could not be asked at all — an unreachable node, a timeout, a socket hangup. The
 * route answers 503 on this class alone (ruling 1), which is why viem's error taxonomy stops here.
 *
 * The message names the failing error's class and nothing else, and the original is deliberately
 * NOT kept as `cause`: viem's transport errors carry the endpoint URL and the request body in
 * their own fields, and rule 4 keeps those out of anything that can be logged or serialised.
 */
export class QuoterUnavailableError extends Error {
  constructor(cause: unknown) {
    const kind = cause instanceof Error && cause.name ? cause.name : typeof cause;
    super(`quoter unreachable (${kind})`);
    this.name = "QuoterUnavailableError";
  }
}

const UINT128_MAX = (1n << 128n) - 1n;
/** These pools' hooks read the swap, not an argument. */
const NO_HOOK_DATA = "0x" as const;

type ExactSingleParams = {
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  zeroForOne: boolean;
  exactAmount: bigint;
  hookData: `0x${string}`;
};

/** The Quoter's parameter, and only it: the row's decimals and stored price stay on the server. */
function paramsOf(call: QuoterCall): readonly [ExactSingleParams] {
  if (call.exactAmount <= 0n || call.exactAmount > UINT128_MAX) {
    throw new RangeError("quoter: exactAmount must be a positive uint128");
  }
  const k = call.poolKey;
  return [
    {
      poolKey: { currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks },
      zeroForOne: call.zeroForOne,
      exactAmount: call.exactAmount,
      hookData: NO_HOOK_DATA,
    },
  ];
}

/**
 * A revert — a hook rejecting the swap, a pool with no liquidity, a pair that is not a pool — means
 * "not routable". Every other failure (an unreachable RPC, a timeout, a bare `fetch failed`) becomes
 * `QuoterUnavailableError`, so the route can tell 200 `{ routable: false }` from 503 by class alone
 * and never has to know what viem's errors look like.
 */
function quoterError(err: unknown): Error {
  const reverted =
    err instanceof BaseError &&
    err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) !== null;
  return reverted ? new NotRoutableError("the pool cannot be routed") : new QuoterUnavailableError(err);
}

/** Talks to the V4 Quoter at `V4_QUOTER_ADDRESS`. The tests inject `client`; production builds one on the chain's RPC. */
export function createQuoter(opts: { client?: PublicClient } = {}): Quoter {
  const client = opts.client ?? createPublicClient({ chain: robinhoodChain, transport: http() });
  return {
    async exactIn(call) {
      // Outside the try on purpose: a RangeError from the argument check is the caller's bug and
      // must travel as itself, not as a transport failure the route would answer 503 to.
      const args = paramsOf(call);
      try {
        const { result } = await client.simulateContract({
          address: V4_QUOTER_ADDRESS,
          abi: QUOTER_ABI,
          functionName: "quoteExactInputSingle",
          args,
        });
        return result[0];
      } catch (err) {
        throw quoterError(err);
      }
    },
    async exactOut(call) {
      const args = paramsOf(call);
      try {
        const { result } = await client.simulateContract({
          address: V4_QUOTER_ADDRESS,
          abi: QUOTER_ABI,
          functionName: "quoteExactOutputSingle",
          args,
        });
        return result[0];
      } catch (err) {
        throw quoterError(err);
      }
    },
  };
}
