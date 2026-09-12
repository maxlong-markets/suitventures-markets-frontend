import type { Address, Side } from "./types";
import { hash } from "./format";
import { hexBytes32, rng } from "./data/random";

/**
 * SVRouter execution — STUB. The UI already models pending → confirmed /
 * failed; this fakes the wallet round-trip and confirmation.
 *
 * TODO(M2): real path is wagmi `writeContract` against SVRouter: Permit2
 * signature for the pay asset, then a Universal Router v4 exact-input swap
 * with 0.5% taken on the quote side (0% for Suit holders), output straight
 * to the user. Quotes come from the V4 Quoter, never pool math.
 */

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
}

export interface SwapHandle {
  /** Transaction hash, known once the wallet has signed and sent. */
  hash: Address;
  /** Resolves on confirmation, rejects with SwapFailedError on revert. */
  confirmation: Promise<void>;
}

export class SwapFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapFailedError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function executeSwap(req: SwapRequest): Promise<SwapHandle> {
  // "Confirm in wallet"
  await sleep(700);
  const txHash = hexBytes32(rng((Date.now() ^ hash(req.ticker)) >>> 0));
  const confirmation = sleep(1200).then(() => {
    if (process.env.NEXT_PUBLIC_MOCK_TX_OUTCOME === "failed") {
      throw new SwapFailedError(
        `Swap failed. Price moved past ${req.slippagePct}% slippage; nothing was spent.`,
      );
    }
  });
  return { hash: txHash, confirmation };
}
