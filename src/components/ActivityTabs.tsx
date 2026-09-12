"use client";

import { useHolders, useTrades } from "@/hooks/useMarketsData";
import type { TokenPair } from "@/lib/types";
import { txUrl } from "@/lib/chain";
import {
  ageHours,
  fmtAge,
  fmtAmt,
  fmtClock,
  fmtISODate,
  fmtPrice,
  fmtUsd,
  short,
} from "@/lib/format";
import { Badge } from "./ui";

export type ActivityTab = "trades" | "holders" | "info";

const TABS: ReadonlyArray<readonly [ActivityTab, string]> = [
  ["trades", "Trades"],
  ["holders", "Holders"],
  ["info", "Info"],
];

interface Props {
  pair: TokenPair;
  /** Fetch timestamp the Created age is measured from. */
  now: number;
  tab: ActivityTab;
  onTabChange(tab: ActivityTab): void;
}

function RowsSkeleton({ rows }: { rows: number }) {
  return (
    <div aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-8 items-center border-b border-hairline-soft">
          <span className="skeleton h-[10px]" style={{ width: 120 + ((i * 41) % 160) }} />
        </div>
      ))}
    </div>
  );
}

const TRADE_COLS =
  "grid grid-cols-[64px_40px_minmax(0,1fr)_minmax(0,1fr)_24px] items-center gap-[10px] tablet:grid-cols-[72px_44px_minmax(0,1fr)_minmax(0,1fr)_110px_24px]";

function TradesTable({ pair }: { pair: TokenPair }) {
  const { data, isPending } = useTrades(pair.ticker);
  return (
    <>
      <div
        className={`${TRADE_COLS} h-[30px] border-b border-hairline text-[9.5px] uppercase tracking-[0.16em] text-ink-40`}
      >
        <div>Time</div>
        <div>Side</div>
        <div className="text-right">Amount</div>
        <div className="text-right">Price</div>
        <div className="hidden text-right tablet:block">Wallet</div>
        <div className="text-right">Tx</div>
      </div>
      {isPending ? (
        <RowsSkeleton rows={8} />
      ) : (
        data?.map((t) => (
          <div
            key={t.tx}
            className={`${TRADE_COLS} h-8 whitespace-nowrap border-b border-hairline-soft hover:bg-hover-soft`}
          >
            <div className="text-ink-55">{fmtClock(t.t)}</div>
            <div className={t.side === "buy" ? "text-up" : "text-down"}>
              {t.side === "buy" ? "Buy" : "Sell"}
            </div>
            <div className="text-right">
              {fmtAmt(t.amount, 0)} {pair.ticker}
            </div>
            <div className="text-right">{fmtPrice(t.priceUsd)}</div>
            <div className="hidden text-right text-ink-55 tablet:block">{short(t.wallet)}</div>
            <a
              href={txUrl(t.tx)}
              target="_blank"
              rel="noreferrer"
              aria-label="View transaction on Blockscout"
              className="text-right text-ink-45 hover:text-ink"
            >
              ↗
            </a>
          </div>
        ))
      )}
    </>
  );
}

const HOLDER_COLS =
  "grid grid-cols-[32px_minmax(0,1fr)_120px_90px] items-center gap-[10px]";

function HoldersTable({ pair }: { pair: TokenPair }) {
  const { data, isPending } = useHolders(pair.ticker);
  return (
    <>
      <div
        className={`${HOLDER_COLS} h-[30px] border-b border-hairline text-[9.5px] uppercase tracking-[0.16em] text-ink-40`}
      >
        <div>#</div>
        <div>Wallet</div>
        <div className="text-right">Balance</div>
        <div className="text-right">Share</div>
      </div>
      {isPending ? (
        <RowsSkeleton rows={8} />
      ) : (
        data?.map((h, i) => (
          <div
            key={h.wallet}
            className={`${HOLDER_COLS} h-8 border-b border-hairline-soft hover:bg-hover-soft`}
          >
            <div className="text-ink-40">{i + 1}</div>
            <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap">
              <span>{short(h.wallet)}</span>
              {h.tag ? <Badge>{h.tag}</Badge> : null}
            </div>
            <div className="text-right">{fmtAmt(h.balance, 0)}</div>
            <div className="text-right text-ink-70">{h.share.toFixed(2)}%</div>
          </div>
        ))
      )}
    </>
  );
}

function InfoList({ pair, now }: { pair: TokenPair; now: number }) {
  const quoteUsd = pair.priceUsd / pair.priceQuote;
  const rows: Array<[string, string]> = [
    ["Pool", short(pair.poolId)],
    ["Hook", pair.hook],
    ["Fee tier", pair.feeTier],
    ["Created", `${fmtISODate(pair.createdAt)} · ${fmtAge(ageHours(pair.createdAt, now))} ago`],
    [
      "Liquidity",
      `${fmtUsd(pair.liquidity)} · ${fmtAmt(pair.liquidity / 2 / quoteUsd, 2)} ${pair.quote}`,
    ],
    ["Quote", `${pair.quote} · ${fmtUsd(quoteUsd)}`],
  ];
  return (
    <>
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="flex justify-between gap-4 border-b border-hairline-soft py-[11px]"
        >
          <span className="flex-none text-[10px] uppercase tracking-[0.16em] text-ink-40">
            {label}
          </span>
          <span className="truncate text-right">{value}</span>
        </div>
      ))}
    </>
  );
}

export default function ActivityTabs({ pair, now, tab, onTabChange }: Props) {
  return (
    <>
      <div className="mt-[26px] flex gap-[22px] border-b border-hairline" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => onTabChange(key)}
            className={`-mb-px h-[34px] border-b bg-transparent p-0 font-mono text-[10.5px] uppercase tracking-[0.22em] hover:text-white ${
              tab === key ? "border-ink text-ink" : "border-transparent text-ink-50"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="font-mono text-[12px] tabular-nums" role="tabpanel">
        {tab === "trades" ? <TradesTable pair={pair} /> : null}
        {tab === "holders" ? <HoldersTable pair={pair} /> : null}
        {tab === "info" ? <InfoList pair={pair} now={now} /> : null}
      </div>
    </>
  );
}
