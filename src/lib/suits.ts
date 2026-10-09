"use client";

import { useReadContract } from "wagmi";
import type { Address } from "./types";
import { robinhoodChain, SVROUTER_ADDRESS, ZERO_ADDRESS } from "./chain";

/** The Suits NFT — `Suits`/`SUITS`, ERC-721, 3,000 supply, on 4663 itself (README §2, D44). */
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

const svRouterSuitsNftAbi = [
  {
    type: "function",
    name: "suitsNft",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/**
 * Owning a Suit and being charged the 0% fee are two different questions, answered by two
 * different reads, and must stay that way:
 *
 * - Ownership — "does this wallet hold a Suit" — is `balanceOf(SuitsNFT, wallet) > 0`. Until
 *   9 Oct 2026 that alone drove a holders-only access gate (D44); the gate is gone and the app
 *   is public, so ownership on its own no longer decides anything here.
 * - The fee perk — "does this wallet get charged 0%" — is access AND SVRouter actually
 *   configured to grant it. `SVRouter.feeFor()` charges what its own `suitsNft` says, not what
 *   this app displays, so `useIsSuitHolder` (the only feed into `AppState.isHolder`, hence the
 *   "Suit holder, 0% fee" badge in `WalletButton`) must read the router's `suitsNft()` and
 *   confirm it is non-zero and equal to `SUITS_NFT_ADDRESS` before it says true. Skipping this
 *   would light the badge up for every real holder the moment `NEXT_PUBLIC_SUITS_NFT_ADDRESS`
 *   is set, while the router — until `setSuitsNft` is called — still charges them
 *   the same 0.5% as everyone else.
 */
export function useIsSuitHolder(address?: Address): boolean {
  const { data: balance } = useReadContract({
    address: SUITS_NFT_ADDRESS,
    abi: erc721BalanceAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: robinhoodChain.id,
    query: { enabled: Boolean(address && SUITS_NFT_ADDRESS) },
  });
  const { data: routerSuitsNft } = useReadContract({
    address: SVROUTER_ADDRESS,
    abi: svRouterSuitsNftAbi,
    functionName: "suitsNft",
    chainId: robinhoodChain.id,
    query: { enabled: Boolean(address && SUITS_NFT_ADDRESS && SVROUTER_ADDRESS) },
  });

  if (!address) return false;
  if (!SUITS_NFT_ADDRESS) {
    return process.env.NEXT_PUBLIC_MOCK_SUIT_HOLDER === "true";
  }
  if ((balance ?? BigInt(0)) <= BigInt(0)) return false;
  if (!SVROUTER_ADDRESS || !routerSuitsNft) return false;
  const configuredNft = routerSuitsNft.toLowerCase();
  return configuredNft !== ZERO_ADDRESS && configuredNft === SUITS_NFT_ADDRESS.toLowerCase();
}
