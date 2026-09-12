"use client";

import { useAccount } from "wagmi";
import type { TokenPair } from "@/lib/types";

export interface PairBalances {
  /** Quote-asset balance, in quote units. */
  quote: number;
  /** Pair-token balance. */
  token: number;
}

/**
 * Wallet balances for the trade panel. STUB: mirrors the prototype's
 * 1,250 quote / 125,000 token once a wallet is connected.
 *
 * TODO(M2): read the quote ERC-20 (`QuoteAsset.address`) and the pair token
 * (`TokenPair.address`) with wagmi `useReadContracts` balanceOf on chain 4663.
 */
export function usePairBalances(_pair: TokenPair): PairBalances {
  const { isConnected } = useAccount();
  return isConnected ? { quote: 1250, token: 125_000 } : { quote: 0, token: 0 };
}
