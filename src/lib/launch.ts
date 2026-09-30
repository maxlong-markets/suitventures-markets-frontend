import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  decodeErrorResult,
  isAddressEqual,
  maxUint256,
  parseEventLogs,
  zeroAddress,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { PERMIT2_ADDRESS, robinhoodChain } from "./chain";
import { svLaunchpadAbi } from "./launch/abi";
import { LAUNCHPAD_ADDRESS } from "./launch/address";
import { erc20Abi } from "./swap/abi";
import { permitTypedData, randomNonce } from "./swap/permit";
import type { Address } from "./types";

/**
 * Every launchpad wallet write (instant launchpad design, sections 7.2 and 7.3), the mirror of `src/lib/swap.ts`, with one
 * difference: each write is simulated before the wallet opens, so a revert is shown by name before anything is signed.
 * A write that reached the chain and reverted is replayed with `eth_call` at its block, because a receipt carries no reason.
 */

/** The permit's and the launch's deadline: 20 minutes, which the nightly clean-up also allows for (spec 6). */
export const LAUNCH_DEADLINE_SEC = 1_200;

export type LaunchDeps = { wallet: WalletClient; publicClient: PublicClient; account: Address };
/**
 * `token` is not sent: it is the address `predictToken` gives for this creator, salt, name and symbol, where the launch
 * will deploy. It is checked for code before anything is sent.
 */
export type LaunchInput = {
  name: string; symbol: string; metadataUri: string; quote: Address; valuation: bigint; firstBuy: bigint;
  minFirstBuyTokens: bigint; payout: Address; salt: Hex; creationFee: bigint; token: Address;
};
export type LaunchStep = "approve" | "sign" | "confirm" | "launching";
export interface LaunchHandle {
  hash: Hex;
  confirmation: Promise<{ token: Address }>;
}
export interface WriteHandle {
  hash: Hex;
  confirmation: Promise<void>;
}

export class LaunchFailedError extends Error {
  readonly revert: string | null;
  constructor(message: string, revert: string | null = null) {
    super(message);
    this.name = "LaunchFailedError";
    this.revert = revert;
  }
}
/** The user dismissed the wallet. Nothing was signed and nothing was sent. */
export class LaunchRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchRejectedError";
  }
}
/** Sent, but its outcome could not be read. It may have succeeded: never tell the user nothing was spent. */
export class LaunchUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchUnconfirmedError";
  }
}
/**
 * The predicted address already holds a token. The creator is part of the CREATE2 salt (spec 4.1), so it can only be
 * this creator's own launch with the same salt, name and symbol: an earlier press went through. Nothing was sent.
 */
export class LaunchExistsError extends Error {
  readonly token: Address;
  constructor(message: string, token: Address) {
    super(message);
    this.name = "LaunchExistsError";
    this.token = token;
  }
}

export const LAUNCH_MESSAGES = {
  rejected: "Cancelled in wallet. Nothing was spent.",
  rejectedAfterApprove: "Cancelled in wallet. Nothing was spent except gas.",
  unconfirmed: "Sent, but we could not confirm it. Check the transaction before trying again.",
  maybeSent:
    "Your wallet reported an error after the launch was requested. It may have been sent. Check your wallet's activity before trying again.",
  alreadyLive: "This token is already live: an earlier press of Launch went through. Nothing more was sent.",
  checkFailed: "Could not check the network. Nothing was sent. Try again.",
  notLive: "Launching is not live yet.",
  wrongChain: "Switch your wallet to Robinhood Chain and try again. Nothing was sent.",
  approveFailed: "Could not approve the currency. Nothing was spent except gas.",
  launchFallback: "Launch failed. Nothing was spent except gas.",
  writeFallback: "That did not go through. Nothing was spent except gas.",
} as const;

/** Spec 7.2's error table, plus the fee panel's own reverts (7.3). */
const REVERT_MESSAGES: Readonly<Record<string, string>> = {
  PoolAlreadyInitialized: "Someone opened this token's pool first. A new address is ready; press Launch again.",
  DailyLimitReached: "You have used today's launches.",
  NotAllowedToLaunch: "Launching is open to Suits holders.",
  FirstBuyTooLarge: "The first buy is above the cap. Lower it and try again.",
  FirstBuyTooSmall: "The first buy would get fewer tokens than shown. Review and try again.",
  BadPayout: "That payout address cannot receive fees. Choose another.",
  PermitMismatch: "The fees changed. Review and try again.",
  Expired: "The launch expired before it was sent. Try again.",
  NothingToCollect: "Nothing to collect yet.",
  NothingOwed: "Nothing is owed to this wallet.",
  NotPayout: "Only the current payout address can change it.",
  ZeroAddress: "Enter an address.",
  SafeERC20FailedOperation: "The token refused the transfer. Nothing was spent except gas.",
};

export function messageForRevert(name: string | null, fallback: string = LAUNCH_MESSAGES.launchFallback): string {
  return (name !== null && REVERT_MESSAGES[name]) || fallback;
}

function decodeName(data: Hex): string | null {
  try {
    return decodeErrorResult({ abi: svLaunchpadAbi, data }).errorName;
  } catch {
    return null;
  }
}

/** The innermost named revert: viem's decoded one from a simulation, or raw revert data from a replay's `eth_call`. */
export function revertNameOf(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    if (reverted.data?.errorName) return reverted.data.errorName;
    if (reverted.raw) return decodeName(reverted.raw);
  }
  const holder = err.walk((e) => {
    const data = (e as { data?: unknown }).data;
    return typeof data === "string" || (typeof data === "object" && data !== null && typeof (data as { data?: unknown }).data === "string");
  }) as { data?: unknown } | null;
  const raw = typeof holder?.data === "string" ? holder.data : (holder?.data as { data?: string } | undefined)?.data;
  return raw && raw.startsWith("0x") ? decodeName(raw as Hex) : null;
}

/** The creator dismissed the wallet: viem's error for it, anywhere in the chain of causes. */
function isRejection(err: unknown): boolean {
  return err instanceof BaseError && Boolean(err.walk((e) => e instanceof UserRejectedRequestError));
}

export function mapLaunchError(err: unknown, fallback: string = LAUNCH_MESSAGES.launchFallback): Error {
  if (
    err instanceof LaunchFailedError || err instanceof LaunchRejectedError || err instanceof LaunchUnconfirmedError || err instanceof LaunchExistsError
  ) {
    return err;
  }
  if (isRejection(err)) return new LaunchRejectedError(LAUNCH_MESSAGES.rejected);
  const name = revertNameOf(err);
  return new LaunchFailedError(messageForRevert(name, fallback), name);
}

function requireLaunchpad(): Address {
  if (!LAUNCHPAD_ADDRESS) throw new LaunchFailedError(LAUNCH_MESSAGES.notLive);
  return LAUNCHPAD_ADDRESS;
}

/** Every write starts here: a wallet on another network would sign or send against the wrong chain. */
async function requireRobinhood(deps: LaunchDeps): Promise<void> {
  if ((await deps.wallet.getChainId()) !== robinhoodChain.id) throw new LaunchFailedError(LAUNCH_MESSAGES.wrongChain);
}

/** Replays a mined transaction at its own block, same sender, data and value, and names the revert (spec 7.2 step 6). */
async function replayRevert(deps: LaunchDeps, hash: Hex, blockNumber: bigint): Promise<string | null> {
  try {
    const tx = await deps.publicClient.getTransaction({ hash });
    await deps.publicClient.call({ account: tx.from, to: tx.to ?? undefined, data: tx.input, value: tx.value, blockNumber });
    return null;
  } catch (err) {
    return revertNameOf(err);
  }
}

/** The receipt, or the reason it reverted, or "could not confirm" when it cannot be read. */
async function receiptOf(deps: LaunchDeps, hash: Hex, fallback: string) {
  let receipt;
  try {
    receipt = await deps.publicClient.waitForTransactionReceipt({ hash });
  } catch {
    throw new LaunchUnconfirmedError(LAUNCH_MESSAGES.unconfirmed);
  }
  if (receipt.status === "reverted") {
    const name = await replayRevert(deps, hash, receipt.blockNumber);
    throw new LaunchFailedError(messageForRevert(name, fallback), name);
  }
  return receipt;
}

/**
 * The token from this creator's `Launched`, filtered by the launchpad's address first: topic0 is not proof of provenance.
 * A successful receipt without that log is "could not confirm", never "failed": the transaction was mined and paid for.
 */
async function confirmLaunch(deps: LaunchDeps, launchpad: Address, hash: Hex): Promise<{ token: Address }> {
  const receipt = await receiptOf(deps, hash, LAUNCH_MESSAGES.launchFallback);
  const ours = parseEventLogs({
    abi: svLaunchpadAbi,
    eventName: "Launched",
    logs: receipt.logs.filter((log) => isAddressEqual(log.address, launchpad)),
  }).find((event) => isAddressEqual(event.args.creator, deps.account));
  if (!ours) throw new LaunchUnconfirmedError(LAUNCH_MESSAGES.unconfirmed);
  return { token: ours.args.token.toLowerCase() as Address };
}

/**
 * Code at the predicted address: the launch already happened (see LaunchExistsError). viem answers undefined for none.
 * A read that fails stops the launch too (fix round 1, ruling 5): nothing has been read, signed or sent at this point.
 */
async function alreadyDeployed(deps: LaunchDeps, token: Address): Promise<boolean> {
  let code: Hex | undefined;
  try {
    code = await deps.publicClient.getCode({ address: token });
  } catch {
    throw new LaunchFailedError(LAUNCH_MESSAGES.checkFailed);
  }
  return code !== undefined && code !== "0x";
}

/**
 * Spec 7.2, submit steps 3 to 6: approve Permit2 when the total is above zero and the allowance is short; sign exactly
 * `firstBuy + creationFee` to the launchpad; simulate; send; wait. A zero total sends a zeroed permit and an empty
 * signature, and needs no approval at all. Before any of it, a token already at the predicted address stops the launch
 * with LaunchExistsError (UX review B3: a retry after "could not confirm" would otherwise deploy onto it and revert).
 */
export async function executeLaunch(input: LaunchInput, deps: LaunchDeps, onStep: (step: LaunchStep) => void = () => {}): Promise<LaunchHandle> {
  const launchpad = requireLaunchpad();
  const total = input.firstBuy + input.creationFee;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + LAUNCH_DEADLINE_SEC);
  const params = {
    name: input.name, symbol: input.symbol, metadataUri: input.metadataUri, quote: input.quote, valuation: input.valuation,
    firstBuy: input.firstBuy, minFirstBuyTokens: input.minFirstBuyTokens, payout: input.payout, salt: input.salt, deadline,
  };
  let permit = { permitted: { token: zeroAddress as Address, amount: 0n }, nonce: 0n, deadline: 0n };
  let signature: Hex = "0x";
  // Once the approval has been sent its gas is spent, so a later cancel must not say nothing was.
  let approvalSent = false;
  try {
    await requireRobinhood(deps);
    if (await alreadyDeployed(deps, input.token)) throw new LaunchExistsError(LAUNCH_MESSAGES.alreadyLive, input.token);
    if (total > 0n) {
      const allowance = await deps.publicClient.readContract({
        address: input.quote, abi: erc20Abi, functionName: "allowance", args: [deps.account, PERMIT2_ADDRESS],
      });
      if (allowance < total) {
        onStep("approve");
        const approval = await deps.wallet.writeContract({
          address: input.quote, abi: erc20Abi, functionName: "approve", args: [PERMIT2_ADDRESS, maxUint256], account: deps.account, chain: robinhoodChain,
        });
        approvalSent = true;
        const approved = await deps.publicClient.waitForTransactionReceipt({ hash: approval });
        if (approved.status === "reverted") throw new LaunchFailedError(LAUNCH_MESSAGES.approveFailed);
      }
      onStep("sign");
      const nonce = randomNonce();
      signature = await deps.wallet.signTypedData({
        ...permitTypedData({ token: input.quote, amount: total, spender: launchpad, nonce, deadline }),
        account: deps.account,
      });
      permit = { permitted: { token: input.quote, amount: total }, nonce, deadline };
    }
    onStep("confirm");
    const request = { address: launchpad, abi: svLaunchpadAbi, functionName: "launch", args: [params, permit, signature], account: deps.account } as const;
    await deps.publicClient.simulateContract(request);
    let hash: Hex;
    try {
      hash = await deps.wallet.writeContract({ ...request, chain: robinhoodChain });
    } catch (err) {
      // The wallet was asked to send a launch that simulates (fix round 1, ruling 1). Only the creator's own rejection
      // means nothing was sent; any other error may come after the broadcast (an expired WalletConnect request, an
      // injected wallet's internal error), so the outcome is unknown and the form must lock, never re-open.
      if (isRejection(err)) throw err;
      throw new LaunchUnconfirmedError(LAUNCH_MESSAGES.maybeSent);
    }
    onStep("launching");
    const confirmation = confirmLaunch(deps, launchpad, hash);
    void confirmation.catch(() => {});
    return { hash, confirmation };
  } catch (err) {
    const mapped = mapLaunchError(err);
    throw approvalSent && mapped instanceof LaunchRejectedError ? new LaunchRejectedError(LAUNCH_MESSAGES.rejectedAfterApprove) : mapped;
  }
}

function handle(hash: Hex, confirmation: Promise<void>): WriteHandle {
  void confirmation.catch(() => {});
  return { hash, confirmation };
}

async function confirmWrite(deps: LaunchDeps, hash: Hex): Promise<void> {
  await receiptOf(deps, hash, LAUNCH_MESSAGES.writeFallback);
}

/** `collectFees(token)`: anyone may trigger it (spec 4.6). */
export async function collectLaunchFees(token: Address, deps: LaunchDeps): Promise<WriteHandle> {
  const launchpad = requireLaunchpad();
  try {
    await requireRobinhood(deps);
    const request = { address: launchpad, abi: svLaunchpadAbi, functionName: "collectFees", args: [token], account: deps.account } as const;
    await deps.publicClient.simulateContract(request);
    const hash = await deps.wallet.writeContract({ ...request, chain: robinhoodChain });
    return handle(hash, confirmWrite(deps, hash));
  } catch (err) {
    throw mapLaunchError(err, LAUNCH_MESSAGES.writeFallback);
  }
}

/** `claim(currency, to)`: pays the caller's owed balance to `to`, which rescues a recipient the token refuses (spec 4.6). */
export async function claimOwed(currency: Address, to: Address, deps: LaunchDeps): Promise<WriteHandle> {
  const launchpad = requireLaunchpad();
  try {
    await requireRobinhood(deps);
    const request = { address: launchpad, abi: svLaunchpadAbi, functionName: "claim", args: [currency, to], account: deps.account } as const;
    await deps.publicClient.simulateContract(request);
    const hash = await deps.wallet.writeContract({ ...request, chain: robinhoodChain });
    return handle(hash, confirmWrite(deps, hash));
  } catch (err) {
    throw mapLaunchError(err, LAUNCH_MESSAGES.writeFallback);
  }
}

/** `setPayout(token, payout)`: the current payout address only; once handed on, the old one cannot take it back. */
export async function changePayout(token: Address, payout: Address, deps: LaunchDeps): Promise<WriteHandle> {
  const launchpad = requireLaunchpad();
  try {
    await requireRobinhood(deps);
    const request = { address: launchpad, abi: svLaunchpadAbi, functionName: "setPayout", args: [token, payout], account: deps.account } as const;
    await deps.publicClient.simulateContract(request);
    const hash = await deps.wallet.writeContract({ ...request, chain: robinhoodChain });
    return handle(hash, confirmWrite(deps, hash));
  } catch (err) {
    throw mapLaunchError(err, LAUNCH_MESSAGES.writeFallback);
  }
}
