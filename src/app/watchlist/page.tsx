"use client";

import { useMemo } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import QuoteChips from "@/components/QuoteChips";
import MarketsToolbar from "@/components/MarketsToolbar";
import PairsTable from "@/components/PairsTable";
import { SuitsMark } from "@/components/ui";
import { walletButtonClass } from "@/components/WalletButton";
import { useAppState } from "@/context/AppState";
import { usePairs } from "@/hooks/useMarketsData";
import { selectPairs } from "@/lib/markets";

export default function WatchlistPage() {
  const { isConnected, filters, stars, watchlistLoading, toggleStar, sortBy } =
    useAppState();
  const { openConnectModal } = useConnectModal();
  const pairsQuery = usePairs();

  // Ages are measured from the moment the pairs were fetched.
  const now = pairsQuery.dataUpdatedAt;
  const rows = useMemo(
    () => selectPairs(pairsQuery.data ?? [], filters, now, { only: stars }),
    [pairsQuery.data, filters, now, stars],
  );

  const loading = pairsQuery.isPending || watchlistLoading;

  return (
    <>
      <QuoteChips />
      <section className="px-4 pb-8 tablet:px-5 desktop:px-6">
        <div className="mt-[18px] flex items-baseline gap-[14px]">
          <h1 className="text-[18px] font-medium tracking-[-0.01em]">Watchlist</h1>
          {isConnected && !loading ? (
            <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-40">
              {rows.length} token{rows.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        {isConnected ? (
          <>
            <MarketsToolbar total={rows.length} loading={loading} />
            <PairsTable
              rows={rows}
              loading={loading}
              now={now}
              stars={stars}
              onToggleStar={toggleStar}
              sortKey={filters.sortKey}
              sortDir={filters.sortDir}
              onSort={sortBy}
              empty={{
                title: "Nothing on your watchlist yet.",
                sub: "Star a token in Markets to track it here.",
              }}
            />
          </>
        ) : (
          <div className="mt-[14px] border-t border-hairline px-4 py-[72px] text-center">
            <SuitsMark size={36} className="mx-auto opacity-80" />
            <div className="mb-[6px] mt-[18px] text-[17px]">
              Your watchlist lives with your wallet.
            </div>
            <div className="text-[12.5px] text-ink-50">
              Connect to see the tokens you&apos;ve starred.
            </div>
            <button
              type="button"
              onClick={openConnectModal}
              className={`${walletButtonClass} mx-auto mt-[22px] h-[34px] px-[18px]`}
            >
              Connect Wallet
            </button>
          </div>
        )}
      </section>
    </>
  );
}
