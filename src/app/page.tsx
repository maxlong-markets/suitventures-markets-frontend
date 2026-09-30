"use client";

import { useMemo } from "react";
import QuoteChips from "@/components/QuoteChips";
import MarketsToolbar from "@/components/MarketsToolbar";
import PairsTable from "@/components/PairsTable";
import { useAppState } from "@/context/AppState";
import { useDataSource } from "@/context/DataSource";
import { usePairs } from "@/hooks/useMarketsData";
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

  // Ages are measured from the moment the pairs were fetched.
  const now = pairsQuery.dataUpdatedAt;
  const rows = useMemo(
    // Every Suits row is a launch already, so the origin test is skipped there: a launch whose listed pool belongs to
    // another origin still shows. The quote chips, the presets, the search and the sort apply as usual.
    () => selectPairs(pairsQuery.data ?? [], suits ? { ...filters, origin: "all" } : filters, now),
    [pairsQuery.data, filters, now, suits],
  );

  const loading = pairsQuery.isPending;
  const query = filters.query.trim();
  const emptySub = query
    ? `No pair matches “${query}”.`
    : `No ${filters.quotes.length ? filters.quotes.join(" / ") + " " : ""}pairs${
        filters.origin !== "all" ? ` on ${originLabel(filters.origin)}` : ""
      } match ${presetLabel(filters.preset)}.`;
  const showMockNote =
    isMockSource(ds) &&
    !loading &&
    rows.length > 8 &&
    filters.quotes.length === 0 &&
    !query;

  return (
    <>
      <QuoteChips />
      <section className="px-4 pb-8 tablet:px-5 desktop:px-6">
        <MarketsToolbar total={rows.length} loading={loading} />
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
