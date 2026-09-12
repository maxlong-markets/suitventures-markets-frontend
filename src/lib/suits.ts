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
 * isSuitHolder = balanceOf(SuitsNFT, address) > 0. Until the contract address
 * is configured, NEXT_PUBLIC_MOCK_SUIT_HOLDER decides (default: holder), so
 * the 0% router-fee state can be demoed.
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
    return process.env.NEXT_PUBLIC_MOCK_SUIT_HOLDER !== "false";
  }
  return (data ?? BigInt(0)) > BigInt(0);
}
