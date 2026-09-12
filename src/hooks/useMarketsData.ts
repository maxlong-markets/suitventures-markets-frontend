"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDataSource } from "@/context/DataSource";
import type { Address, Denom, Interval, Side, TokenPair } from "@/lib/types";

export const keys = {
  pairs: ["pairs"] as const,
  quotes: ["quotes"] as const,
  candles: (ticker: string, interval: Interval) =>
    ["candles", ticker, interval] as const,
  trades: (ticker: string) => ["trades", ticker] as const,
  holders: (ticker: string) => ["holders", ticker] as const,
  watchlist: (address: Address) =>
    ["watchlist", address.toLowerCase()] as const,
  votes: (address: Address) => ["votes", address.toLowerCase()] as const,
};

export function usePairs() {
  const ds = useDataSource();
  return useQuery({ queryKey: keys.pairs, queryFn: () => ds.pairs() });
}

export function usePair(ticker: string) {
  const query = usePairs();
  const key = ticker.toLowerCase();
  const pair: TokenPair | undefined = query.data?.find(
    (p) => p.ticker.toLowerCase() === key,
  );
  return { ...query, pair };
}

export function useQuotes() {
  const ds = useDataSource();
  return useQuery({ queryKey: keys.quotes, queryFn: () => ds.quotes() });
}

export function useCandles(ticker: string, interval: Interval) {
  const ds = useDataSource();
  return useQuery({
    queryKey: keys.candles(ticker, interval),
    queryFn: () => ds.candles(ticker, interval),
    staleTime: 60_000,
  });
}

export function useTrades(ticker: string) {
  const ds = useDataSource();
  return useQuery({
    queryKey: keys.trades(ticker),
    queryFn: () => ds.trades(ticker),
  });
}

export function useHolders(ticker: string) {
  const ds = useDataSource();
  return useQuery({
    queryKey: keys.holders(ticker),
    queryFn: () => ds.holders(ticker),
  });
}

export interface SwapQuoteParams {
  ticker: string;
  side: Side;
  amount: number;
  denom: Denom;
  isSuitHolder: boolean;
  slippagePct: number;
}

export function useSwapQuote(params: SwapQuoteParams) {
  const ds = useDataSource();
  const { ticker, side, amount, denom, isSuitHolder, slippagePct } = params;
  return useQuery({
    queryKey: ["quote", ticker, side, amount, denom, isSuitHolder, slippagePct],
    // Runs at amount 0 too: the panel shows rate and fees before any input.
    queryFn: () =>
      ds.quoteSwap(ticker, side, amount, denom, isSuitHolder, slippagePct),
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
