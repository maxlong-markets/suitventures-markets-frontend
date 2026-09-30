import type { Metadata } from "next";
import LaunchForm from "@/components/LaunchForm";
import YourLaunches from "@/components/YourLaunches";
import { hasLaunchpad } from "@/lib/launch/address";

export const metadata: Metadata = { title: "Launch" };

/** Spec 7.2: while NEXT_PUBLIC_LAUNCHPAD_ADDRESS is unset the page shows only this card, in TradePanel's card recipe. */
function NotLive() {
  return (
    <div className="mt-5 border border-hairline px-[22px] py-[34px] text-center">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-40">Launch</div>
      <div className="mb-2 mt-3 text-[17px]">Launching is not live yet</div>
      <div className="text-pretty text-[12.5px] leading-[1.5] text-ink-50">Token launches open here once the launchpad contract is deployed.</div>
    </div>
  );
}

export default function LaunchPage() {
  return (
    <section className="px-4 pb-8 tablet:px-5 desktop:px-6">
      <div className="mt-[18px] flex items-baseline gap-[14px]">
        <h1 className="text-[18px] font-medium tracking-[-0.01em]">Launch a token</h1>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-40">Uniswap v4 · Robinhood Chain</span>
      </div>
      {hasLaunchpad() ? (
        <>
          <LaunchForm />
          {/* Amended 30 Sep 2026: the connected wallet's own launches, shown only once it has one. */}
          <YourLaunches />
        </>
      ) : (
        <NotLive />
      )}
    </section>
  );
}
