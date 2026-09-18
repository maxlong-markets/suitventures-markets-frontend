"use client";

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { erc20Abi } from "viem";
import { useAccount, useBlockNumber, useReadContract, useReadContracts } from "wagmi";
import { useQuotes } from "@/hooks/useMarketsData";
import { robinhoodChain } from "@/lib/chain";
import { toHuman } from "@/lib/quote/math";
import type { Address, TokenPair } from "@/lib/types";

/**
 * Each balance three ways (ruling 12). `quote`/`token` are for display and comparison;
 * `quoteText`/`tokenText` are the exact decimal expansion, which is what the panel's 100 % button
 * writes into the amount field, and `quoteBase`/`tokenBase` are what the chain returned. The floats
 * are parsed from the strings, never computed beside them, so "Max is exactly the balance" holds
 * through `toBase` on the server and through the insufficient-balance check in the browser.
 */
export interface PairBalances {
  /** Quote-asset balance, in quote units. */
  quote: number;
  /** Pair-token balance. */
  token: number;
  /** Base units, as the chain returned them. */
  quoteBase: bigint;
  tokenBase: bigint;
  /** The same two balances as exact decimal strings: no exponent, no rounding. */
  quoteText: string;
  tokenText: string;
}

const ZERO: PairBalances = {
  quote: 0,
  token: 0,
  quoteBase: 0n,
  tokenBase: 0n,
  quoteText: "0",
  tokenText: "0",
};

/**
 * Robinhood Chain produces a block about every 0.1 s, so "refetch on block" samples the
 * head every 10 s rather than subscribing to each one: a balance at most one sample old is
 * what the panel needs, and a per-block invalidation would refetch a hundred times a minute.
 */
const BLOCK_POLL_MS = 10_000;

/**
 * Both wallet balances the trade panel needs, in one `useReadContracts` batch:
 * `balanceOf(quoteAddress, user)` and `balanceOf(tokenAddress, user)`.
 *
 * Decimals come from two places, deliberately. The quote asset carries its own
 * (`QuoteAsset.decimals`, already loaded for the whole app by `useQuotes`), matched on
 * `TokenPair.quote`. The pair token has none in `TokenPair`, so its `decimals()` is read on
 * chain and kept for the session: the value is immutable, and the balance is needed before
 * any quote exists — the 25/50/75/100 buttons and the insufficient-balance check run at
 * amount 0, where the quote route is not called and no `call` block, and therefore no
 * decimals, has come back.
 *
 * Disconnected returns zeroes, and so does every state where a scale is still unknown: a
 * balance rendered at the wrong scale is worse than no balance.
 */
export function usePairBalances(pair: TokenPair): PairBalances {
  const { address, isConnected } = useAccount();
  const quotes = useQuotes();
  const qc = useQueryClient();

  const owner = address as Address | undefined;
  const quoteAsset = quotes.data?.find((q) => q.symbol === pair.quote);
  const ready = Boolean(isConnected && owner && quoteAsset);

  const decimals = useReadContract({
    address: pair.address,
    abi: erc20Abi,
    functionName: "decimals",
    chainId: robinhoodChain.id,
    // Immutable: read once per token, never re-read, and never part of the block batch.
    query: { enabled: Boolean(isConnected), staleTime: Infinity, gcTime: Infinity },
  });

  // No `readonly ContractFunctionParameters[]` annotation here, on purpose: viem's
  // `ContractFunctionParameters` has no `chainId` member, so the annotation erases the per-entry
  // `chainId` overload wagmi accepts and `tsc --noEmit` fails with TS2322. The literal infers, and
  // `as const` keeps the argument tuples readable to wagmi.
  const contracts =
    owner && quoteAsset
      ? ([
          {
            address: quoteAsset.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [owner],
            chainId: robinhoodChain.id,
          },
          {
            address: pair.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [owner],
            chainId: robinhoodChain.id,
          },
        ] as const)
      : undefined;

  const batch = useReadContracts({
    allowFailure: false,
    contracts,
    query: { enabled: ready, refetchOnWindowFocus: true },
  });

  const { data: blockNumber } = useBlockNumber({
    chainId: robinhoodChain.id,
    watch: { poll: true, pollingInterval: BLOCK_POLL_MS },
    query: { enabled: ready },
  });

  // wagmi hands back a fresh key array every render. Holding it in a ref keeps the invalidation
  // effect's dependency list down to the block that actually changed, so an invalidation can
  // never feed itself a new render and loop. The sync itself runs in its own effect, never
  // during render, which is what `react-hooks/refs` requires — the same split CandleChartInner
  // already uses for its own latest-value refs.
  const keyRef = useRef(batch.queryKey);
  useEffect(() => {
    keyRef.current = batch.queryKey;
  }, [batch.queryKey]);
  useEffect(() => {
    if (!ready || blockNumber === undefined) return;
    void qc.invalidateQueries({ queryKey: keyRef.current });
  }, [blockNumber, ready, qc]);

  const raw = batch.data as readonly bigint[] | undefined;
  if (!ready || !quoteAsset || !raw || raw.length < 2 || decimals.data === undefined) {
    return ZERO;
  }
  // One decimal expansion per balance, and the float parsed from it: "Max" writes the string, the
  // route turns that same string back into these base units, and no rounding sits in between.
  const quoteText = toHuman(raw[0], quoteAsset.decimals);
  const tokenText = toHuman(raw[1], decimals.data);
  return {
    quote: Number(quoteText),
    token: Number(tokenText),
    quoteBase: raw[0],
    tokenBase: raw[1],
    quoteText,
    tokenText,
  };
}

/**
 * Refresh every balance batch after a confirmed swap. wagmi keys each `useReadContracts`
 * query `["readContracts", …]`, so this prefix matches the batch above wherever it is
 * mounted. The 10 s block poll would catch up on its own; this only makes the panel honest
 * immediately.
 */
export function invalidatePairBalances(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: ["readContracts"] });
}
