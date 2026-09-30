"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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
/** Outline: the Retry recipe from page.tsx's pairs-load error card, verbatim (also quoted in
 *  GatedSection.tsx's OUTLINE_BTN); reused here for B1b's timed-out Retry, 30 Sep 2026. */
const OUTLINE_BTN =
  "h-[30px] border border-hairline-btn bg-transparent px-[14px] font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink hover:border-[rgba(240,232,214,0.5)]";

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

interface Props {
  address: string;
  launchedTx?: Hex;
  /**
   * Whether the server's own read (`page.tsx`'s `getPair`) already had this token, passed down
   * so the two never print a conflicting pair of messages for the same request (fix round 1
   * findings 1 and 5). Required, not optional, so every call site has to say which case it is in.
   */
  serverHadPair: boolean;
}

export default function TokenView({ address, launchedTx, serverHadPair }: Props) {
  const router = useRouter();
  const { pair, isPending, dataUpdatedAt, retryWait } = usePair(address, { launched: launchedTx !== undefined });
  // Spec 7.3: a page opened by /launch's redirect waits for the reader for five minutes, then
  // either finds the token or, once the wait is over, says so honestly (B1b).
  // `waitAttempt` restarts the clock below on Retry (B1b): bumping it re-runs the effect, which schedules a fresh timeout.
  const [waitOver, setWaitOver] = useState(false);
  const [waitAttempt, setWaitAttempt] = useState(0);
  useEffect(() => {
    if (!launchedTx) return;
    const id = window.setTimeout(() => setWaitOver(true), LAUNCH_WAIT_MAX_MS);
    return () => window.clearTimeout(id);
  }, [launchedTx, waitAttempt]);
  /**
   * B1a, amended 30 Sep 2026, guarded per fix round 1 finding 5, widened per re-review finding 2:
   * the server rendered this page's facts block and tab title before this component's own client
   * read ever settled, so once that read actually finds the token those server-rendered parts
   * must catch up without the visitor reloading. That is only true when the server itself had no
   * pair yet (`!serverHadPair`); a shared or reloaded link whose server render already found the
   * token needs no refresh, since TokenFacts and the tab title are already right, and firing one
   * anyway would be one needless server render on every such view. This is no longer limited to
   * `launchedTx`: a plain `/t/<address>` link opened in the minute after a launch, with no
   * `?launched=` at all, has exactly the same shape of gap between the server's miss and a later
   * client-side find (the pairs list catching up, or the single-pair fallback's own refetch), and
   * left uncorrected the app would sit above a facts block still saying "No token at ..." under a
   * tab still reading "Unknown token". `router.refresh()` re-runs the Server Components for this
   * route with a fresh read; it does not touch this component's own state (`pair` above keeps
   * coming from react-query, not from the server), so refreshing does not by itself change any of
   * this effect's dependencies and cannot loop on its own. The ref is the actual guard: it
   * survives Strict Mode's double effect-invocation in development and a later re-render with the
   * same pair, so this fires at most once per token, not once per render.
   */
  const refreshedForRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!pair || serverHadPair) return;
    if (refreshedForRef.current === pair.id) return;
    refreshedForRef.current = pair.id;
    router.refresh();
  }, [pair, serverHadPair, router]);
  /** B1b: the wait timed out with nothing found. Same countdown, asked again right now. */
  const retry = () => {
    setWaitOver(false);
    setWaitAttempt((n) => n + 1);
    retryWait();
  };
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
    // Fix round 1 finding 1: a plain unknown address (no launch in play) that the server also
    // could not find already gets its "No token at ..." message from TokenFacts, the
    // server-rendered block below this one. Printing it again here duplicated that exact text
    // for a holder, or for anyone with the gate off. When the server DID have the pair but this
    // component's own, independent client-side read somehow does not, that is a genuinely
    // different fact from what TokenFacts is showing, so it is still worth saying below.
    if (!launchedTx && !serverHadPair) {
      return (
        <section className={GUTTER}>
          <BackLink />
        </section>
      );
    }
    const waiting = launchedTx !== undefined && !waitOver;
    // B1b, amended 30 Sep 2026: the five-minute wait running out is not the same fact as a bad
    // address, and must not read like one. This state keeps the tx link and adds Retry, which
    // asks for another five minutes rather than sending the creator to reload the page.
    const timedOut = launchedTx !== undefined && waitOver;
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
          ) : timedOut ? (
            <>
              <div className="text-[16px]">Your token is on chain, but the site&apos;s data is running late.</div>
              <div className="mt-[6px] text-[12.5px] text-ink-50">
                Retry checks again for up to five more minutes.
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
          {timedOut ? (
            <div className="mt-4">
              <button type="button" onClick={retry} className={OUTLINE_BTN}>
                Retry
              </button>
            </div>
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
