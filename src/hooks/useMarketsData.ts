"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDataSource } from "@/context/DataSource";
import type { Denom, Interval, Side, TokenPair, TradersBy } from "@/lib/types";

export const keys = {
  pairs: ["pairs"] as const,
  pair: (id: string) => ["pair", id] as const,
  quotes: ["quotes"] as const,
  candles: (id: string, interval: Interval) =>
    ["candles", id, interval] as const,
  trades: (id: string) => ["trades", id] as const,
  holders: (id: string) => ["holders", id] as const,
  // The session cookie is the identity, so neither key names a wallet. `AppState` drops both
  // caches the moment `signed` goes false, which is what keeps a second wallet in the same tab
  // from seeing the first one's stars.
  watchlist: ["watchlist"] as const,
  votes: ["votes"] as const,
  traders: (by: TradersBy) => ["traders", by] as const,
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
  /** The raw typed text, never a parsed float: Global Constraint 1. */
  amount: string;
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

/** Disabled until the session cookie says who the caller is; the data source sends no address. */
export function useWatchlist(enabled: boolean) {
  const ds = useDataSource();
  return useQuery({ queryKey: keys.watchlist, queryFn: () => ds.watchlist(), enabled });
}

export function useVotes(enabled: boolean) {
  const ds = useDataSource();
  return useQuery({ queryKey: keys.votes, queryFn: () => ds.votes(), enabled });
}

/** The public traders board. No session: the counts and the ranking are the same for everyone. */
export function useTraders(by: TradersBy) {
  const ds = useDataSource();
  return useQuery({
    queryKey: keys.traders(by),
    queryFn: () => ds.traders(by),
    // The route caches for 60 s; asking more often than that only moves bytes.
    staleTime: 60_000,
  });
}
