"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDataSource } from "@/context/DataSource";
import type { Address, Denom, Interval, Side, TokenPair } from "@/lib/types";

export const keys = {
  pairs: ["pairs"] as const,
  pair: (id: string) => ["pair", id] as const,
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
  const ds = useDataSource();
  const query = usePairs();
  const key = id.toLowerCase();
  const listed: TokenPair | undefined = query.data?.find((p) => p.id === key);
  // Only once the list has settled without the id: a token outside the 500-row window still has a page.
  const fallback = useQuery({
    queryKey: keys.pair(key),
    queryFn: () => ds.pair(key),
    staleTime: 30_000,
    enabled: !query.isPending && listed === undefined,
  });
  const pair: TokenPair | undefined = listed ?? fallback.data ?? undefined;
  // TokenView reads isPending for its skeleton; both flags cover both queries, so a deep link
  // never flashes "No token" while the fallback is still in flight.
  return { ...query, pair, isPending: query.isPending || fallback.isLoading, isLoading: query.isLoading || fallback.isLoading };
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
