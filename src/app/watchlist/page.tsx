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
import type { TokenPair } from "@/lib/types";

export default function WatchlistPage() {
  const {
    isConnected,
    signed,
    filters,
    stars,
    watchlistLoading,
    promptSignIn,
    toggleStar,
    sortBy,
  } = useAppState();
  const { openConnectModal } = useConnectModal();
  const pairsQuery = usePairs();
  // Review Focus 17: a starred launch nobody bought can fall out of the default 500-row list within a day, with
  // no note that it is gone. The Suits list (every launch, listed or not) is read too, and merged in by id.
  const launchesQuery = usePairs("sv");

  // Ages are measured from the moment the default list was fetched.
  const now = pairsQuery.dataUpdatedAt;
  const merged = useMemo(() => {
    const byId = new Map<string, TokenPair>();
    for (const p of pairsQuery.data ?? []) byId.set(p.id, p);
    // The default list wins when a token is in both: it is the one already shown everywhere else in the app.
    // The Suits list only fills in a launch the default list dropped, never duplicates one it already has.
    for (const p of launchesQuery.data ?? []) if (!byId.has(p.id)) byId.set(p.id, p);
    return [...byId.values()];
  }, [pairsQuery.data, launchesQuery.data]);
  const rows = useMemo(
    () => selectPairs(merged, filters, now, { only: stars }),
    [merged, filters, now, stars],
  );

  const loading = pairsQuery.isPending || launchesQuery.isPending || watchlistLoading;
  /**
   * The list lives on the server behind a session, so a connected wallet that has not signed in
   * *here* has no stars to show and may well have twenty on it. Telling it the watchlist is empty
   * is simply false, and the star gate was the only sign-in affordance in the app (review I5).
   * `watchlistLoading` folds the cookie probe in, so this never fires while that is in flight.
   */
  const needsSignIn = isConnected && !signed && !watchlistLoading;

  return (
    <>
      <QuoteChips />
      <section className="px-4 pb-8 tablet:px-5 desktop:px-6">
        <div className="mt-[18px] flex items-baseline gap-[14px]">
          <h1 className="text-[18px] font-medium tracking-[-0.01em]">Watchlist</h1>
          {isConnected && !needsSignIn && !loading ? (
            <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-40">
              {rows.length} token{rows.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        {needsSignIn ? (
          <div className="mt-[14px] border-t border-hairline px-4 py-[72px] text-center">
            <SuitsMark size={36} className="mx-auto opacity-80" />
            <div className="mb-[6px] mt-[18px] text-[17px]">
              Sign in to load your watchlist.
            </div>
            <div className="text-[12.5px] text-ink-50">
              One signature, no gas. Your stars live with your wallet, not with
              this browser.
            </div>
            <button
              type="button"
              onClick={promptSignIn}
              className={`${walletButtonClass} mx-auto mt-[22px] h-[34px] px-[18px]`}
            >
              Sign In
            </button>
          </div>
        ) : isConnected ? (
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
