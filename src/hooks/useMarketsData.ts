"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDataSource } from "@/context/DataSource";
import type { Address, Denom, Interval, Side, TokenPair } from "@/lib/types";

export const keys = {
  pairs: ["pairs"] as const,
  quotes: ["quotes"] as const,
  candles: (id: string, interval: Interval) =>
    ["candles", id, interval] as const,
  trades: (id: string) => ["trades", id] as const,
  holders: (id: string) => ["holders", id] as const,
  watchlist: (address: Address) =>
    ["watchlist", address.toLowerCase()] as const,
  votes: (address: Address) => ["votes", address.toLowerCase()] as const,
};

export function usePairs() {
  const ds = useDataSource();
  return useQuery({ queryKey: keys.pairs, queryFn: () => ds.pairs() });
}

export function usePair(id: string) {
  const query = usePairs();
  const key = id.toLowerCase();
  const pair: TokenPair | undefined = query.data?.find((p) => p.id === key);
  return { ...query, pair };
}

export function useQuotes() {
  const ds = useDataSource();
  return useQuery({ queryKey: keys.quotes, queryFn: () => ds.quotes() });
}

export function useCandles(id: string, interval: Interval) {
  const ds = useDataSource();
  return useQuery({
    queryKey: keys.candles(id, interval),
    queryFn: () => ds.candles(id, interval),
    staleTime: 60_000,
  });
}

export function useTrades(id: string) {
  const ds = useDataSource();
  return useQuery({
    queryKey: keys.trades(id),
    queryFn: () => ds.trades(id),
  });
}

export function useHolders(id: string) {
  const ds = useDataSource();
  return useQuery({
    queryKey: keys.holders(id),
    queryFn: () => ds.holders(id),
  });
}

export interface SwapQuoteParams {
  id: string;
  side: Side;
  amount: number;
  denom: Denom;
  isSuitHolder: boolean;
  slippagePct: number;
}

export function useSwapQuote(params: SwapQuoteParams) {
  const ds = useDataSource();
  const { id, side, amount, denom, isSuitHolder, slippagePct } = params;
  return useQuery({
    queryKey: ["quote", id, side, amount, denom, isSuitHolder, slippagePct],
    // Runs at amount 0 too: the panel shows rate and fees before any input.
    queryFn: () =>
      ds.quoteSwap(id, side, amount, denom, isSuitHolder, slippagePct),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}

export function useWatchlist(address?: Address) {
  const ds = useDataSource();
  return useQuery({
    queryKey: address ? keys.watchlist(address) : ["watchlist", "none"],
    queryFn: () => (address ? ds.watchlist(address) : Promise.resolve([])),
    enabled: Boolean(address),
  });
}

export function useVotes(address?: Address) {
  const ds = useDataSource();
  return useQuery({
    queryKey: address ? keys.votes(address) : ["votes", "none"],
    queryFn: () => (address ? ds.votes(address) : Promise.resolve({})),
    enabled: Boolean(address),
  });
}
