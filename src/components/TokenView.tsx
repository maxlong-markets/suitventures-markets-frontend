"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LAUNCH_WAIT_MAX_MS, usePair } from "@/hooks/useMarketsData";
import { txUrl } from "@/lib/chain";
import { short } from "@/lib/format";
import type { Hex, Interval } from "@/lib/types";
import ActivityTabs, { type ActivityTab } from "./ActivityTabs";
import CandleChart from "./CandleChart";
import LaunchFeesPanel from "./LaunchFeesPanel";
import TokenHeader from "./TokenHeader";
import TradePanel from "./TradePanel";
import { Spinner } from "./ui";

const GUTTER = "px-4 pb-4 tablet:px-5 tablet:pb-5 desktop:px-6 desktop:pb-6";

function BackLink() {
  return (
    <Link
      href="/"
      className="mt-[14px] inline-block font-mono text-[10px] uppercase tracking-[0.2em] text-ink-45 hover:text-ink"
    >
      ← Markets
    </Link>
  );
}

function TokenSkeleton() {
  return (
    <div aria-busy className="border-b border-hairline py-[18px]">
      <div className="flex items-center gap-[14px]">
        <span className="h-10 w-10 rounded-full bg-[rgba(232,228,220,0.06)]" />
        <div className="flex flex-col gap-2">
          <span className="skeleton h-[12px] w-[140px]" />
          <span className="skeleton h-[10px] w-[220px]" />
        </div>
      </div>
    </div>
  );
}

export default function TokenView({ address, launchedTx }: { address: string; launchedTx?: Hex }) {
  const { pair, isPending, dataUpdatedAt } = usePair(address, { launched: launchedTx !== undefined });
  // Spec 7.3: a page opened by /launch's redirect waits for the reader for five minutes, then says what it always says.
  const [waitOver, setWaitOver] = useState(false);
  useEffect(() => {
    if (!launchedTx) return;
    const id = window.setTimeout(() => setWaitOver(true), LAUNCH_WAIT_MAX_MS);
    return () => window.clearTimeout(id);
  }, [launchedTx]);
  // null: no tab clicked yet for the current token, so CandleChart opens on the finest interval
  // that actually has data (useChartCandles) instead of a fixed default.
  const [selectedInterval, setSelectedInterval] = useState<Interval | null>(null);
  const [tab, setTab] = useState<ActivityTab>("trades");
  // A client-side navigation between two /t/[address] pages can reuse this component instance —
  // Next does not remount it just because the dynamic segment changed — so an explicit interval
  // pick for the last token must not leak into the next one's default. Adjusting state during
  // render (not in an effect) avoids painting the previous token's pick for even one frame.
  const [intervalForId, setIntervalForId] = useState(pair?.id);
  if (pair?.id !== intervalForId) {
    setIntervalForId(pair?.id);
    setSelectedInterval(null);
  }

  if (isPending) {
    return (
      <section className={GUTTER}>
        <BackLink />
        <TokenSkeleton />
      </section>
    );
  }

  if (!pair) {
    const waiting = launchedTx !== undefined && !waitOver;
    return (
      <section className={GUTTER}>
        <BackLink />
        <div className="px-4 py-16 text-center">
          {waiting ? (
            <>
              <div className="text-[16px]">Your token is live on chain. Its page fills in within about two minutes.</div>
              <div className="mt-3 flex justify-center">
                <Spinner />
              </div>
            </>
          ) : (
            <>
              <div className="text-[16px]">No token at {short(address)}.</div>
              <div className="mt-[6px] text-[12.5px] text-ink-50">
                It may not be indexed yet, or the address is wrong.
              </div>
            </>
          )}
          {launchedTx ? (
            <a
              href={txUrl(launchedTx)}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-block font-mono text-[10px] uppercase tracking-[0.2em] text-ink-60 hover:text-ink"
            >
              View the launch transaction ↗
            </a>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className={GUTTER}>
      <BackLink />
      <TokenHeader pair={pair} />
      <div className="mt-5 flex flex-col gap-6 twocol:flex-row twocol:items-start twocol:gap-8">
        <div className="order-2 w-full min-w-0 flex-1 twocol:order-1">
          <CandleChart pair={pair} selectedInterval={selectedInterval} onIntervalChange={setSelectedInterval} />
          <ActivityTabs pair={pair} now={dataUpdatedAt} tab={tab} onTabChange={setTab} />
        </div>
        <div className="order-1 w-full flex-none twocol:order-2 twocol:w-[360px]">
          <TradePanel pair={pair} />
          {pair.launch ? (
            <div className="mt-6">
              <LaunchFeesPanel pair={pair} launch={pair.launch} now={dataUpdatedAt} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
