"use client";

import { useMemo } from "react";
import { useAppState } from "@/context/AppState";
import { useQuotes } from "@/hooks/useMarketsData";
import { fmtInt, fmtPrice, fmtUsd } from "@/lib/format";
import { BIOTECH, isStockQuote } from "@/lib/sharedTickers";

/**
 * The stock tape: every Robinhood stock token that memecoins trade against, by 24h pair volume,
 * with its onchain USD price and how many pairs quote in it. Clicking a stock filters the table
 * to its pairs, the same toggle as the quote chips below. Prices are the quote assets' own
 * (Chainlink where a feed exists); a stale price shows a dash.
 */
export default function StockTape() {
  const { data: quotes } = useQuotes();
  const { filters, toggleQuote, setQuotes, clearQuotes } = useAppState();

  const stocks = useMemo(
    () =>
      (quotes ?? [])
        .filter((q) => isStockQuote(q) && q.pairs > 0)
        .sort((a, b) => b.vol24h - a.vol24h),
    [quotes],
  );

  // The Biotech group selects every biotech stock that has pairs, in one click; a second click clears it.
  const biotech = useMemo(
    () => stocks.filter((q) => (BIOTECH as readonly string[]).includes(q.symbol)).map((q) => q.symbol),
    [stocks],
  );
  const biotechOn =
    biotech.length > 0 &&
    filters.quotes.length === biotech.length &&
    biotech.every((s) => filters.quotes.includes(s));

  if (stocks.length === 0) return null;

  return (
    <div className="mt-3 border-y border-hairline tablet:mt-0 tablet:border-t-0" aria-label="Stock tape">
      <div className="no-scrollbar flex items-stretch overflow-x-auto">
        <div className="flex flex-none items-center border-r border-hairline px-4 font-mono text-[9.5px] uppercase tracking-[0.22em] text-chalk tablet:px-5 desktop:px-6">
          Stock tape
        </div>
        {biotech.length > 0 ? (
          <button
            type="button"
            onClick={() => (biotechOn ? clearQuotes() : setQuotes(biotech))}
            aria-pressed={biotechOn}
            title={`Biotech and healthcare: ${biotech.join(", ")}`}
            className={`flex flex-none items-center border-r border-hairline px-4 font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-hover-row ${
              biotechOn ? "bg-chalk-10 text-chalk" : "text-ink-75"
            }`}
          >
            Biotech · {biotech.length}
          </button>
        ) : null}
        {stocks.map((q) => {
          const on = filters.quotes.includes(q.symbol);
          return (
            <button
              key={q.address}
              type="button"
              onClick={() => toggleQuote(q.symbol)}
              aria-pressed={on}
              title={`${q.name}: ${fmtInt(q.pairs)} pairs, ${fmtUsd(q.vol24h)} pair volume in 24h`}
              className={`flex flex-none items-baseline gap-[10px] border-r border-hairline px-4 py-[9px] font-mono text-[11px] tabular-nums hover:bg-hover-row ${
                on ? "bg-chalk-10" : ""
              }`}
            >
              <span className={`tracking-[0.08em] ${on ? "text-chalk" : "text-ink"}`}>{q.symbol}</span>
              <span className="text-ink-75">{q.stale || !q.usdPrice ? "—" : fmtPrice(q.usdPrice)}</span>
              <span className="text-[10px] text-ink-45">
                {fmtInt(q.pairs)} {q.pairs === 1 ? "pair" : "pairs"} · {fmtUsd(q.vol24h)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
