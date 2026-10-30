"use client";

import { useMemo } from "react";
import Link from "next/link";
import QuoteChips from "@/components/QuoteChips";
import MarketsToolbar from "@/components/MarketsToolbar";
import PairsTable from "@/components/PairsTable";
import StockTape from "@/components/StockTape";
import TheDesk from "@/components/TheDesk";
import { sharedTickers } from "@/lib/sharedTickers";
import { useAppState } from "@/context/AppState";
import { useDataSource } from "@/context/DataSource";
import { usePairs, useQuotes } from "@/hooks/useMarketsData";
import { isMockSource } from "@/lib/data";
import { originLabel, presetLabel, selectPairs } from "@/lib/markets";

export default function MarketsPage() {
  const { filters, stars, toggleStar, sortBy, resetFilters } = useAppState();
  const ds = useDataSource();
  // The SUITS chip reads its own list (amended 30 Sep 2026): every launch, traded or not, listed or not. The default
  // list is the 500 most recently traded tokens, which a fresh launch can already be pushed out of. Loading and errors
  // below follow whichever list is in use.
  const suits = filters.origin === "SV";
  const pairsQuery = usePairs(suits ? "sv" : undefined);
  const quotesQuery = useQuotes();

  // Ages are measured from the moment the pairs were fetched.
  const now = pairsQuery.dataUpdatedAt;
  const rows = useMemo(
    // Every Suits row is a launch already, so the origin test is skipped there: a launch whose listed pool belongs to
    // another origin still shows. The quote chips, the presets, the search and the sort apply as usual.
    () => selectPairs(pairsQuery.data ?? [], suits ? { ...filters, origin: "all" } : filters, now),
    [pairsQuery.data, filters, now, suits],
  );

  // Clashes are counted over the whole list, not the filtered rows, so a filter that hides one of two
  // same-ticker tokens still marks the one that shows.
  const shared = useMemo(() => sharedTickers(pairsQuery.data ?? []), [pairsQuery.data]);
  const sharedShown = useMemo(
    () => new Set(rows.map((r) => r.ticker.trim().toUpperCase()).filter((t) => shared.has(t))).size,
    [rows, shared],
  );

  const loading = pairsQuery.isPending;
  const query = filters.query.trim();
  const emptySub = query
    ? `No pair matches “${query}”.`
    : `No ${filters.quotes.length ? filters.quotes.join(" / ") + " " : ""}pairs${
        filters.origin !== "all" ? ` on ${originLabel(filters.origin)}` : ""
      } match ${presetLabel(filters.preset)}.`;
  // Review round 1, finding 15: "no launches" means the Suits list itself is empty, read off its raw length,
  // not the post-filter row count, so a preset that filters an existing list to zero rows still gets the usual
  // reset-minded copy. A search is covered by the !query check above: while one is typed this state never
  // applies, so the regular "No pair matches" copy takes over as usual. The ternary below already checks
  // pairsQuery.isError first, so this never needs its own check on it.
  const noLaunches = suits && !query && !loading && (pairsQuery.data ?? []).length === 0;
  const showMockNote =
    isMockSource(ds) &&
    !loading &&
    rows.length > 8 &&
    filters.quotes.length === 0 &&
    !query;

  return (
    <>
      <StockTape />
      <QuoteChips />
      <section className="px-4 pb-8 tablet:px-5 desktop:px-6">
        {!loading && !pairsQuery.isError ? (
          <TheDesk pairs={pairsQuery.data ?? []} quotes={quotesQuery.data ?? []} now={now} />
        ) : null}
        <MarketsToolbar total={rows.length} loading={loading} />
        {!loading && sharedShown > 0 ? (
          <div
            role="note"
            className="mb-[10px] flex items-center gap-[10px] border border-[rgba(212,106,99,0.35)] px-3 py-2 text-[12px] text-ink-80"
          >
            <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-down">Check the address</span>
            <span>
              {sharedShown} {sharedShown === 1 ? "ticker here is" : "tickers here are"} used by more than one
              token. Rows marked SAME TICKER show their contract address.
            </span>
          </div>
        ) : null}
        {pairsQuery.isError ? (
          <div className="px-4 py-16 text-center">
            <div className="text-[16px]">Couldn&apos;t load pairs.</div>
            <div className="mt-[6px] text-[12.5px] text-ink-50">
              {pairsQuery.error.message}
            </div>
            <button
              type="button"
              onClick={() => pairsQuery.refetch()}
              className="mt-[18px] h-[30px] border border-hairline-btn bg-transparent px-[14px] font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink hover:border-[rgba(240,232,214,0.5)]"
            >
              Retry
            </button>
          </div>
        ) : noLaunches ? (
          <div className="px-4 py-16 text-center">
            <div className="text-[16px]">No launches yet.</div>
            <Link
              href="/launch"
              className="mt-[18px] inline-flex h-[30px] items-center justify-center border border-hairline-btn bg-transparent px-[14px] font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink hover:border-[rgba(240,232,214,0.5)]"
            >
              Launch a token
            </Link>
          </div>
        ) : (
          <PairsTable
            rows={rows}
            loading={loading}
            now={now}
            stars={stars}
            onToggleStar={toggleStar}
            sortKey={filters.sortKey}
            sortDir={filters.sortDir}
            onSort={sortBy}
            empty={{ title: "No pairs match.", sub: emptySub, onReset: resetFilters }}
            shared={shared}
          />
        )}
        {showMockNote ? (
          <div className="mt-[14px] font-mono text-[10px] tracking-[0.08em] text-ink-30">
            Mock data. Rows below the eight real pairs are placeholders for density only.
          </div>
        ) : null}
      </section>
    </>
  );
}
