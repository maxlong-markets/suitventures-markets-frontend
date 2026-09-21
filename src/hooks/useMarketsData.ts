"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDataSource } from "@/context/DataSource";
import { StoreUnavailableError } from "@/lib/data/envio";
import type { Candle, Denom, Interval, Side, TokenPair, TradersBy } from "@/lib/types";

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

/** `enabled` defaults to true; callers that need to hold a query back (useChartCandles's cascade
 * below) pass false and flip it once it should run. */
export function useCandles(id: string, interval: Interval, enabled: boolean = true) {
  const ds = useDataSource();
  return useQuery({
    queryKey: keys.candles(id, interval),
    queryFn: () => ds.candles(id, interval),
    staleTime: 60_000,
    enabled,
  });
}

interface CandleQueryState {
  isSuccess: boolean;
  isError: boolean;
  data: Candle[] | undefined;
}
const isEmptyResult = (q: CandleQueryState) => q.isError || (q.isSuccess && (q.data?.length ?? 0) === 0);
const hasRows = (q: CandleQueryState) => q.isSuccess && (q.data?.length ?? 0) > 0;

export interface ChartCandles {
  /** The interval to show — or, while a fallback probe is still in flight, the one currently
   * being tried. Always `selected` once the caller has one. */
  interval: Interval;
  /** This interval's candles; undefined while it hasn't settled yet. */
  candles: Candle[] | undefined;
  /** True once there is a final answer: candles were found, or (with no `selected`) every
   * interval in the 15m -> 1h -> 1d fallback order came back empty or errored. */
  settled: boolean;
  /** Settled, and nothing was found at any interval that was tried. */
  empty: boolean;
}

/**
 * Candle data for the token chart, with the retention-aware fallback the chart opens on.
 * `selected` null — no tab clicked yet for this token — probes 15m, then 1h, then 1d, stopping at
 * the first one with rows: a token that traded inside its own 15m retention window
 * (src/lib/sync/retention.ts) resolves on the first query, exactly as before candle pruning
 * shipped, and never fetches 1h or 1d. A dormant token falls through to whichever interval still
 * has data, or, if none of the three do, settles `empty: true` rather than hanging. `1m` and `5m`
 * are never tried — retention.ts keeps them for less time than 15m (1 and 2 days against 15m's
 * 4), so a 15m miss already means they would miss too.
 *
 * `selected` non-null — the user picked a tab — fetches exactly that interval and nothing else,
 * even when it comes back empty: once used, the switcher is left alone.
 */
export function useChartCandles(id: string, selected: Interval | null): ChartCandles {
  const auto = selected === null;
  const m15 = useCandles(id, "15m", auto);
  const tryH1 = auto && isEmptyResult(m15);
  const h1 = useCandles(id, "1h", tryH1);
  const tryD1 = tryH1 && isEmptyResult(h1);
  const d1 = useCandles(id, "1d", tryD1);
  // Only fetched outside auto mode (enabled mirrors `!auto` exactly). `selected` is only null
  // when `auto` is true, so the `?? "15m"` never actually matters — it exists so this call always
  // gets a concrete Interval, keeping every render's hook calls the same shape.
  const direct = useCandles(id, selected ?? "15m", !auto);

  if (selected !== null) {
    return {
      interval: selected,
      candles: direct.data,
      settled: direct.isSuccess || direct.isError,
      empty: direct.isSuccess && (direct.data?.length ?? 0) === 0,
    };
  }
  if (hasRows(m15)) return { interval: "15m", candles: m15.data, settled: true, empty: false };
  if (!isEmptyResult(m15)) return { interval: "15m", candles: undefined, settled: false, empty: false };
  if (hasRows(h1)) return { interval: "1h", candles: h1.data, settled: true, empty: false };
  if (!isEmptyResult(h1)) return { interval: "1h", candles: undefined, settled: false, empty: false };
  if (hasRows(d1)) return { interval: "1d", candles: d1.data, settled: true, empty: false };
  if (!isEmptyResult(d1)) return { interval: "1d", candles: undefined, settled: false, empty: false };
  return { interval: "1d", candles: [], settled: true, empty: true };
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
    // A missing store is a deploy step, not a blip (review M2): retrying it only delays the note
    // the board already knows how to show. Any other failure still gets the usual three attempts.
    retry: (count, err) => !(err instanceof StoreUnavailableError) && count < 3,
  });
}
