"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { useCandles } from "@/hooks/useMarketsData";
import type { Candle, Interval, TokenPair } from "@/lib/types";
import { MINUS, fmtPct, fmtPlainPrice, fmtUsd } from "@/lib/format";

const CandleChartInner = dynamic(() => import("./CandleChartInner"), {
  ssr: false,
  loading: () => <div className="h-[332px]" />,
});

const INTERVALS: readonly Interval[] = ["1m", "5m", "15m", "1h", "1d"];

interface Props {
  pair: TokenPair;
  interval: Interval;
  onIntervalChange(interval: Interval): void;
}

function ChartLegend({
  pairLabel,
  interval,
  candle,
}: {
  pairLabel: string;
  interval: Interval;
  candle: Candle | null;
}) {
  const tone = candle ? (candle.c >= candle.o ? "text-up" : "text-down") : "";
  const change = candle ? candle.c - candle.o : 0;
  const pct = candle && candle.o ? (change / candle.o) * 100 : 0;
  return (
    <div className="pointer-events-none absolute left-[10px] right-[74px] top-2 z-[2] font-mono text-[10.5px] leading-[1.6] tabular-nums tablet:right-auto tablet:whitespace-nowrap">
      <div className="text-ink">
        {pairLabel}{" "}
        <span className="text-ink-50">
          · {interval} · Uniswap v4
        </span>
      </div>
      {candle ? (
        <>
          <div className="text-ink-50">
            O <span className={tone}>{fmtPlainPrice(candle.o)}</span> H{" "}
            <span className={tone}>{fmtPlainPrice(candle.h)}</span> L{" "}
            <span className={tone}>{fmtPlainPrice(candle.l)}</span> C{" "}
            <span className={tone}>{fmtPlainPrice(candle.c)}</span>{" "}
            <span className={`ml-1 ${tone}`}>
              {(change >= 0 ? "+" : MINUS) + fmtPlainPrice(Math.abs(change))} ({fmtPct(pct)})
            </span>
          </div>
          <div className="text-ink-50">
            Vol <span className={tone}>{fmtUsd(candle.v)}</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

export default function CandleChart({ pair, interval, onIntervalChange }: Props) {
  const { data: candles } = useCandles(pair.ticker, interval);
  const [hover, setHover] = useState<Candle | null>(null);
  const pairLabel = `${pair.ticker} / ${pair.quote}`;
  const shown = hover ?? (candles && candles.length ? candles[candles.length - 1] : null);

  return (
    <div className="border border-hairline">
      <div className="flex h-9 items-center justify-between gap-3 border-b border-hairline px-[10px]">
        <div className="flex gap-[2px]" role="tablist" aria-label="Interval">
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              type="button"
              role="tab"
              aria-selected={iv === interval}
              onClick={() => onIntervalChange(iv)}
              className={`h-6 px-2 font-mono text-[10.5px] tracking-[0.06em] hover:text-ink ${
                iv === interval ? "bg-chalk-10 text-chalk" : "bg-transparent text-ink-50"
              }`}
            >
              {iv}
            </button>
          ))}
        </div>
        <div className="min-w-0 truncate font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-40">
          Uniswap v4 · Robinhood Chain
        </div>
      </div>
      <div className="relative h-[332px]">
        <ChartLegend pairLabel={pairLabel} interval={interval} candle={shown} />
        <CandleChartInner
          candles={candles ?? []}
          interval={interval}
          pairLabel={pairLabel}
          onHover={setHover}
        />
      </div>
    </div>
  );
}
