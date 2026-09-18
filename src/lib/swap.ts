import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  decodeErrorResult,
  isAddressEqual,
  maxUint256,
  parseEventLogs,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { SwapCall } from "@/lib/quote/price";
import { PERMIT2_ADDRESS, SVROUTER_ADDRESS, robinhoodChain } from "./chain";
import { erc20Abi, svRouterAbi } from "./swap/abi";
import { permitTypedData, randomNonce } from "./swap/permit";
import type { Address, Side } from "./types";

/**
 * SVRouter execution. The request carries the quote route's `call` block verbatim: the browser
 * signs and sends the amounts the route computed and never recomputes one of them.
 *
 * Order on submit (spec section 4): allowance, then a Permit2 signature, then one `swapExactIn`,
 * then the receipt's `Trade` event for the amount actually received. Every failure message ends in
 * "Nothing was spent." because the router pulls funds only after its checks pass.
 */

/** How long the signature and the trade stay valid, in seconds. */
const DEADLINE_SEC = 1200;
/** `SwapParams.amountIn` and `amountOutMin` are uint128 on chain. */
const UINT128_MAX = (1n << 128n) - 1n;

export interface SwapRequest {
  ticker: string;
  side: Side;
  payAmount: number;
  payAsset: string;
  receiveAmount: number;
  receiveAsset: string;
  slippagePct: number;
  account: Address;
  isSuitHolder: boolean;
  /** The quote route's execution block. */
  call: SwapCall;
}

/** What the `Trade` event reported: the truth the confirmed toast shows, not the quote's guess. */
export type SwapReceipt = { amountOut: bigint; fee: bigint; holderRate: boolean };

export interface SwapHandle {
  /** Transaction hash, known once the wallet has signed and sent. */
  hash: Address;
  /** Resolves with the event's numbers, rejects with SwapFailedError on a revert. */
  confirmation: Promise<SwapReceipt>;
}

export type SwapDeps = { wallet: WalletClient; publicClient: PublicClient; account: Address };

export class SwapFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapFailedError";
  }
}

/** The user dismissed the wallet. Nothing was signed and nothing was sent. */
/**
 * The transaction reached the chain but its outcome could not be read (an RPC timeout or hiccup
 * while waiting for the receipt). It may well have succeeded, so this must never tell the user that
 * nothing was spent: that wording invites a second, duplicate swap.
 */
export class SwapUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapUnconfirmedError";
  }
}

export class SwapRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapRejectedError";
  }
}

/**
 * Both of the router's amounts are uint128, and the route bounds only what it sends the Quoter: a
 * grossed-up input or a uint256 output can each overflow one. Checked here, before the wallet is
 * touched, because viem's encoding error is not something a user can read. A zero `amountOutMin` is
 * refused with them — a trade whose minimum has been floored away has no slippage protection left,
 * and re-quoting is the honest answer.
 */
function checkUint128(value: bigint): bigint {
  if (value <= 0n || value > UINT128_MAX) {
    throw new SwapFailedError("That amount is out of range for the router; re-quote and try again. Nothing was spent.");
  }
  return value;
}

function tryDecode(data: Hex): { errorName: string; args?: readonly unknown[] } | undefined {
  try {
    return decodeErrorResult({ abi: svRouterAbi, data });
  } catch {
    return undefined;
  }
}

/**
 * The innermost named revert. The Universal Router wraps whatever the v4 swap threw in
 * `ExecutionFailed(commandIndex, message)`, so a slippage failure arrives one layer down.
 */
function revertName(err: BaseError): string | null {
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  const decoded: { errorName: string; args?: readonly unknown[] } | undefined =
    reverted.data ?? (reverted.raw ? tryDecode(reverted.raw) : undefined);
  if (!decoded) return null;
  if (decoded.errorName !== "ExecutionFailed") return decoded.errorName;
  const inner = decoded.args?.[1];
  const nested = typeof inner === "string" ? tryDecode(inner as Hex) : undefined;
  return nested?.errorName ?? decoded.errorName;
}

/** Spec section 4's table, and the only place a chain error becomes something a user reads. */
export function mapSwapError(err: unknown, slippagePct: number): Error {
  if (err instanceof SwapFailedError || err instanceof SwapRejectedError) return err;
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) {
      return new SwapRejectedError("Cancelled in wallet. Nothing was spent.");
    }
    const name = revertName(err);
    if (name === "InsufficientOutput" || name === "V4TooLittleReceived") {
      return new SwapFailedError(`Price moved past ${slippagePct}% slippage; nothing was spent.`);
    }
    if (name === "Expired" || name === "TransactionDeadlinePassed") {
      return new SwapFailedError("The quote expired; try again. Nothing was spent.");
    }
  }
  return new SwapFailedError("Swap failed. Nothing was spent.");
}

async function confirm(deps: SwapDeps, router: Address, hash: Address, slippagePct: number): Promise<SwapReceipt> {
  let receipt;
  try {
    receipt = await deps.publicClient.waitForTransactionReceipt({ hash });
  } catch {
    // The transaction is already broadcast. Failing to READ its outcome says nothing about whether
    // it landed, so this must not be mapped to "nothing was spent": a user told that would
    // reasonably swap again and pay twice. The hash travels so the toast can link the explorer.
    throw new SwapUnconfirmedError(
      "Sent, but we could not confirm it. Check the transaction before trying again.",
    );
  }
  if (receipt.status === "reverted") throw new SwapFailedError("Swap failed. Nothing was spent.");
  // Filtered by address as well as by event: topic0 is not proof of provenance, and any other
  // contract in this transaction could emit a log shaped like ours. The toast reports these
  // numbers as the truth, so they must come from our router or from nowhere.
  //
  // viem 2.56.3's `parseEventLogs` (the version pinned in package.json) takes no `address` option —
  // its parameter type is only abi/args/eventName/logs/strict, so passing one is silently a no-op at
  // runtime and would be an excess-property type error if it were caught. The address filter is
  // therefore done by hand, before anything is decoded, with `isAddressEqual` rather than `===`
  // because a log's address arrives however the RPC cased it.
  const routerLogs = receipt.logs.filter((log) => isAddressEqual(log.address, router));
  const trades = parseEventLogs({
    abi: svRouterAbi,
    eventName: "Trade",
    logs: routerLogs,
  });
  // Without the event there is no honest number to report, so this is a failure, not a zero.
  // `user` is checked, not just decoded: one transaction can carry several of our router's Trade
  // logs (a batch or an aggregator), and reporting someone else's amount as this user's would be a
  // lie in the one place the user trusts a number.
  const ours = trades.find((t) => isAddressEqual(t.args.user, deps.account));
  if (!ours) throw new SwapFailedError("Swap failed. Nothing was spent.");
  return { amountOut: ours.args.amountOut, fee: ours.args.fee, holderRate: ours.args.holderRate };
}

export async function executeSwap(req: SwapRequest, deps: SwapDeps): Promise<SwapHandle> {
  const router = SVROUTER_ADDRESS;
  if (!router) throw new SwapFailedError("Trading goes live when the router is deployed. Nothing was spent.");
  const { call } = req;
  const amountIn = checkUint128(BigInt(call.amountIn));
  const amountOutMin = checkUint128(BigInt(call.amountOutMin));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SEC);

  try {
    // 1. Permit2 is what pulls the token, so it is the spender of the ERC20 approval. LONG (Doppler)
    //    tokens report an unlimited allowance for every holder and skip this entirely.
    const allowance = await deps.publicClient.readContract({
      address: call.tokenIn,
      abi: erc20Abi,
      functionName: "allowance",
      args: [deps.account, PERMIT2_ADDRESS],
    });
    if (allowance < amountIn) {
      const approval = await deps.wallet.writeContract({
        address: call.tokenIn,
        abi: erc20Abi,
        functionName: "approve",
        args: [PERMIT2_ADDRESS, maxUint256],
        account: deps.account,
        chain: robinhoodChain,
      });
      const approvalReceipt = await deps.publicClient.waitForTransactionReceipt({ hash: approval });
      // A reverted approve leaves the allowance short, so the swap would revert too — but as a
      // "swap failed", hiding the real cause. Nothing has been spent at this point beyond gas.
      if (approvalReceipt.status === "reverted") {
        throw new SwapFailedError("Could not approve the token for trading. Nothing was spent.");
      }
    }

    // 2. One signature, one nonce: Permit2 nonces are unordered bits, so a random one needs no read.
    const nonce = randomNonce();
    const signature = await deps.wallet.signTypedData({
      ...permitTypedData({ token: call.tokenIn, amount: amountIn, spender: router, nonce, deadline }),
      account: deps.account,
    });

    // 3. The trade. hookData is empty for every listed pool today.
    const hash = await deps.wallet.writeContract({
      address: router,
      abi: svRouterAbi,
      functionName: "swapExactIn",
      args: [
        {
          key: call.poolKey,
          zeroForOne: call.zeroForOne,
          amountIn,
          amountOutMin,
          hookData: "0x",
          deadline,
        },
        { permitted: { token: call.tokenIn, amount: amountIn }, nonce, deadline },
        signature,
      ],
      account: deps.account,
      chain: robinhoodChain,
    });

    // 4. The caller awaits this; it carries the event's numbers, not the quote's. The no-op catch
    //    keeps a caller that never awaits it from raising an unhandled rejection: the rejection
    //    the caller does await is the same promise, and still rejects.
    const confirmation = confirm(deps, router, hash, req.slippagePct);
    void confirmation.catch(() => {});
    return { hash, confirmation };
  } catch (err) {
    throw mapSwapError(err, req.slippagePct);
  }
}
