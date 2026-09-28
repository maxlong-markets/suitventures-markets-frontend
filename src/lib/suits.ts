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
 * - Access — "does this wallet hold a Suit" — is `balanceOf(SuitsNFT, wallet) > 0`. That is
 *   `useSuitsAccess` below, which drives the gate: it decides who gets past the lock screen.
 * - The fee perk — "does this wallet get charged 0%" — is access AND SVRouter actually
 *   configured to grant it. `SVRouter.feeFor()` charges what its own `suitsNft` says, not what
 *   this app displays, so `useIsSuitHolder` (the only feed into `AppState.isHolder`, hence the
 *   "Suit holder, 0% fee" badge in `WalletButton`) must read the router's `suitsNft()` and
 *   confirm it is non-zero and equal to `SUITS_NFT_ADDRESS` before it says true. Skipping this
 *   would light the badge up for every real holder the moment `NEXT_PUBLIC_SUITS_NFT_ADDRESS`
 *   is set for the gate, while the router — until `setSuitsNft` is called — still charges them
 *   the same 0.5% as everyone else.
 */
export type SuitsAccess =
  | { status: "idle" } // no wallet connected
  | { status: "checking" } // read in flight
  | { status: "granted"; count: bigint } // balanceOf > 0
  | { status: "denied"; count: bigint } // balanceOf === 0n, confirmed
  | { status: "error"; retry: () => void }; // RPC failed — NOT a denial

/**
 * A boolean would collapse "the RPC blipped" into "you own nothing", telling a genuine
 * holder they aren't one. `denied` must mean the chain actually answered zero, so the three
 * outcomes are decided in the order that cannot lie: an answer we hold, then a failure, then
 * still waiting. `refetch` is handed back as `retry` rather than re-derived.
 */
export function useSuitsAccess(address?: Address): SuitsAccess {
  const { data, isError, refetch } = useReadContract({
    address: SUITS_NFT_ADDRESS,
    abi: erc721BalanceAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: robinhoodChain.id,
    query: {
      enabled: Boolean(address && SUITS_NFT_ADDRESS),
      // The app turns this off globally (Providers.tsx), and this is the one read that needs it.
      // A denied visitor's whole path out is the OpenSea link: they buy a Suit in another tab
      // and come back. Without a refetch on focus they would sit on "No Suit on this wallet"
      // until they thought to reload. react-query keeps the previous answer while the new one
      // is in flight, so this re-checks without flashing the screen back to "checking".
      refetchOnWindowFocus: true,
    },
  });

  if (!address || !SUITS_NFT_ADDRESS) return { status: "idle" };
  // An answer we already hold wins, even while a later refetch is failing: a holder already
  // through the gate must not be thrown back out by one bad background read.
  if (data !== undefined) {
    return data > BigInt(0)
      ? { status: "granted", count: data }
      : { status: "denied", count: data };
  }
  if (isError) return { status: "error", retry: () => void refetch() };
  // No answer and no error means the read is still in flight. `isLoading` alone does not catch
  // that: `enabled` flips from false to true the moment a wallet connects, and react-query
  // reports that first render as pending-but-not-fetching, so `isLoading` is false while `data`
  // is still undefined. Treating that render as an answer would read it as zero and flash
  // "no Suit" at a genuine holder — the one thing this five-state type exists to prevent.
  return { status: "checking" };
}

let warnedGateUnconfigured = false;

/**
 * The gate is on unless explicitly turned off, and off when no NFT address is configured (a
 * local build with an empty env var must not lock its own developer out). `NEXT_PUBLIC_*`
 * reaches the bundle as the empty string when unset, never `undefined`, and is substituted at
 * build time, so `NEXT_PUBLIC_TOKEN_GATE` is read here by direct member access rather than
 * destructured or looked up dynamically.
 */
export function gateEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_TOKEN_GATE === "off") return false;
  if (!SUITS_NFT_ADDRESS) {
    if (process.env.NODE_ENV === "production" && !warnedGateUnconfigured) {
      warnedGateUnconfigured = true;
      console.warn(
        "NEXT_PUBLIC_SUITS_NFT_ADDRESS is unset in a production build; the token gate is disabled.",
      );
    }
    return false;
  }
  return true;
}

/**
 * isSuitHolder answers the fee-perk question, not the access question (see the `SuitsAccess`
 * comment above): balanceOf(SuitsNFT, address) > 0 AND SVRouter.suitsNft() is non-zero and
 * equals SUITS_NFT_ADDRESS. Until the NFT address is configured, NEXT_PUBLIC_MOCK_SUIT_HOLDER
 * decides and defaults to "not a holder": an unconfigured build must show the 0.5% router fee
 * every user will actually pay, and the quote route is told the same answer, so the displayed
 * fee and the executed fee come from one decision. Set the flag to exactly "true" to demo the
 * 0% holder state.
 *
 * One caveat the mock flag buys: the chain charges what SVRouter's own feeFor() says, against
 * the SuitsNFT it was deployed with. A build with the flag set to "true" against a router whose
 * suitsNft is the zero address — which is exactly what scripts/fork/deploy-local.mts deploys —
 * would quote 0 bps and be charged 50. Never a loss of funds (slippage covers it or the swap
 * reverts), but it is why the fork e2e always runs with holder: false.
 *
 * Once the NFT address IS configured, the same shape of mistake is no longer just a fork-harness
 * caveat — it is the default state of production until Kobe calls setSuitsNft, which is why the
 * router's own suitsNft is read and checked here rather than assumed from SUITS_NFT_ADDRESS alone.
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
