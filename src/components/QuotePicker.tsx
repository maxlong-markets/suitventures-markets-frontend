"use client";

import { useMemo, useState } from "react";
import type { QuoteAsset } from "@/lib/types";
import { fmtInt, fmtUsd } from "@/lib/format";
import { MagnifierIcon } from "./ui";

type PickSort = "sym" | "pairs" | "vol";

interface Props {
  /** Already sorted by 24h volume, descending. */
  quotes: QuoteAsset[];
  selected: string[];
  onToggle(symbol: string): void;
  onClear(): void;
  onDone(): void;
}

const GRID =
  "grid grid-cols-[14px_minmax(0,1fr)_64px_84px] items-center gap-3 px-3";

export default function QuotePicker({
  quotes,
  selected,
  onToggle,
  onClear,
  onDone,
}: Props) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PickSort>("vol");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  const sortBy = (k: PickSort) => {
    if (sort === k) {
      setDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSort(k);
      setDir(k === "sym" ? "asc" : "desc");
    }
  };

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sign = dir === "asc" ? 1 : -1;
    return quotes
      .filter(
        (q) =>
          !needle ||
          q.symbol.toLowerCase().includes(needle) ||
          q.name.toLowerCase().includes(needle),
      )
      .sort((a, b) =>
        sort === "sym"
          ? sign * a.symbol.localeCompare(b.symbol)
          : sort === "pairs"
            ? sign * (a.pairs - b.pairs)
            : sign * (a.vol24h - b.vol24h),
      );
  }, [quotes, query, sort, dir]);

  const caret = (k: PickSort) => (sort === k ? (dir === "asc" ? "▲" : "▼") : "");

  return (
    <div
      role="dialog"
      aria-label="Quote assets"
      className="absolute left-4 right-4 top-full z-[25] -mt-px max-w-[520px] border border-hairline-strong bg-panel font-mono tablet:left-5 tablet:right-5 desktop:left-6 desktop:right-6"
    >
      <div className="flex items-center gap-3 border-b border-hairline px-3 py-[10px]">
        <div className="relative flex flex-1 items-center">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a quote asset"
            aria-label="Find a quote asset"
            className="h-[30px] w-full border border-hairline-strong bg-transparent pl-7 pr-[10px] text-[11px] outline-none focus:border-hairline-focus"
          />
          <MagnifierIcon className="pointer-events-none absolute left-[9px]" />
        </div>
        <span className="whitespace-nowrap text-[9.5px] uppercase tracking-[0.16em] text-ink-40">
          {quotes.length} quotes
        </span>
      </div>
      <div
        className={`${GRID} h-7 border-b border-hairline text-[9.5px] uppercase tracking-[0.16em] text-ink-40`}
      >
        <span />
        <button type="button" onClick={() => sortBy("sym")} className="text-left uppercase">
          Asset <span className="text-ink">{caret("sym")}</span>
        </button>
        <button type="button" onClick={() => sortBy("pairs")} className="text-right uppercase">
          Pairs <span className="text-ink">{caret("pairs")}</span>
        </button>
        <button type="button" onClick={() => sortBy("vol")} className="text-right uppercase">
          Vol 24h <span className="text-ink">{caret("vol")}</span>
        </button>
      </div>
      <div className="max-h-[312px] overflow-y-auto" role="listbox" aria-multiselectable>
        {rows.map((q) => {
          const on = selected.includes(q.symbol);
          return (
            <div
              key={q.symbol}
              role="option"
              aria-selected={on}
              tabIndex={0}
              onClick={() => onToggle(q.symbol)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle(q.symbol);
                }
              }}
              className={`${GRID} h-9 cursor-pointer border-b border-hairline-soft text-[11.5px] tabular-nums hover:bg-hover-row`}
            >
              <span
                className={`flex h-[14px] w-[14px] items-center justify-center border text-[9px] leading-none text-onlight ${
                  on
                    ? "border-chalk bg-chalk"
                    : "border-[rgba(12,13,16,0.35)] bg-transparent"
                }`}
              >
                {on ? "✓" : ""}
              </span>
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="text-ink">{q.symbol}</span>
                <span className="truncate font-sans text-[11px] text-ink-45">
                  {q.name}
                </span>
              </span>
              <span className="text-right text-ink-70">{fmtInt(q.pairs)}</span>
              <span className="text-right">{fmtUsd(q.vol24h)}</span>
            </div>
          );
        })}
        {rows.length === 0 ? (
          <div className="px-3 py-[22px] text-center text-[11px] text-ink-45">
            No quote asset matches.
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-hairline px-3 py-[10px]">
        <span className="text-[10.5px] text-ink-50">
          {selected.length
            ? `${selected.length} selected · ${selected.join(", ")}`
            : "Showing every quote asset"}
        </span>
        <div className="flex gap-[6px]">
          <button
            type="button"
            onClick={onClear}
            className="h-7 border border-hairline-strong bg-transparent px-3 text-[9.5px] uppercase tracking-[0.18em] text-ink-70 hover:border-hairline-hover hover:text-ink"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onDone}
            className="h-7 bg-chalk px-[14px] text-[9.5px] uppercase tracking-[0.18em] text-onlight hover:bg-white"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
