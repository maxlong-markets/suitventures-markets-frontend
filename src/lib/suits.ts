"use client";

import { useReadContract } from "wagmi";
import type { Address } from "./types";
import { robinhoodChain } from "./chain";

/** The Suits NFT — address TBD (project README §2, week one). */
export const SUITS_NFT_ADDRESS = process.env.NEXT_PUBLIC_SUITS_NFT_ADDRESS as
  | Address
  | undefined;

const erc721BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * isSuitHolder = balanceOf(SuitsNFT, address) > 0. Until the contract address is
 * configured, NEXT_PUBLIC_MOCK_SUIT_HOLDER decides and defaults to "not a holder": an
 * unconfigured build must show the 0.5% router fee every user will actually pay, and the
 * quote route is told the same answer, so the displayed fee and the executed fee come from
 * one decision. Set the flag to exactly "true" to demo the 0% holder state.
 *
 * One caveat the mock flag buys: the chain charges what SVRouter's own feeFor() says, against
 * the SuitsNFT it was deployed with. A build with the flag set to "true" against a router whose
 * suitsNft is the zero address — which is exactly what scripts/fork/deploy-local.mts deploys —
 * would quote 0 bps and be charged 50. Never a loss of funds (slippage covers it or the swap
 * reverts), but it is why the fork e2e always runs with holder: false.
 */
export function useIsSuitHolder(address?: Address): boolean {
  const { data } = useReadContract({
    address: SUITS_NFT_ADDRESS,
    abi: erc721BalanceAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: robinhoodChain.id,
    query: { enabled: Boolean(address && SUITS_NFT_ADDRESS) },
  });
  if (!address) return false;
  if (!SUITS_NFT_ADDRESS) {
    return process.env.NEXT_PUBLIC_MOCK_SUIT_HOLDER === "true";
  }
  return (data ?? BigInt(0)) > BigInt(0);
}
