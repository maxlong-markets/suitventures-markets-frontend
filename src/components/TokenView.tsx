"use client";

import Link from "next/link";
import { useState } from "react";
import { usePair } from "@/hooks/useMarketsData";
import { short } from "@/lib/format";
import type { Interval } from "@/lib/types";
import ActivityTabs, { type ActivityTab } from "./ActivityTabs";
import CandleChart from "./CandleChart";
import TokenHeader from "./TokenHeader";
import TradePanel from "./TradePanel";

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

export default function TokenView({ address }: { address: string }) {
  const { pair, isPending, dataUpdatedAt } = usePair(address);
  const [interval, setChartInterval] = useState<Interval>("15m");
  const [tab, setTab] = useState<ActivityTab>("trades");

  if (isPending) {
    return (
      <section className={GUTTER}>
        <BackLink />
        <TokenSkeleton />
      </section>
    );
  }

  if (!pair) {
    return (
      <section className={GUTTER}>
        <BackLink />
        <div className="px-4 py-16 text-center">
          <div className="text-[16px]">No token at {short(address)}.</div>
          <div className="mt-[6px] text-[12.5px] text-ink-50">
            It may not be indexed yet, or the address is wrong.
          </div>
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
          <CandleChart pair={pair} interval={interval} onIntervalChange={setChartInterval} />
          <ActivityTabs pair={pair} now={dataUpdatedAt} tab={tab} onTabChange={setTab} />
        </div>
        <div className="order-1 w-full flex-none twocol:order-2 twocol:w-[360px]">
          <TradePanel pair={pair} />
        </div>
      </div>
    </section>
  );
}
