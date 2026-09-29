"use client";

import { useMemo, useState } from "react";
import { USDG } from "@/lib/chain/math/constants";
import type { Address, QuoteAsset } from "@/lib/types";
import { MagnifierIcon } from "./ui";

/** A fresh USD price, the same test the markets table uses: a stale or absent feed is no price at all. */
export function hasUsdPrice(q: QuoteAsset): boolean {
  return !q.stale && q.usdPrice > 0;
}

/** USDG first, then by 24 h volume, then by symbol (instant launchpad design, section 7.2). */
export function orderCurrencies(quotes: readonly QuoteAsset[]): QuoteAsset[] {
  return [...quotes].sort((a, b) => {
    const au = a.address.toLowerCase() === USDG;
    const bu = b.address.toLowerCase() === USDG;
    if (au !== bu) return au ? -1 : 1;
    return b.vol24h - a.vol24h || a.symbol.localeCompare(b.symbol);
  });
}

/**
 * A single-select popover on QuotePicker's recipe (search, then a listbox of rows), for the launch's currency. Each row
 * says whether the form will work in USD for it or in the currency's own units.
 */
export default function CurrencySelect({
  quotes,
  value,
  onChange,
}: {
  quotes: readonly QuoteAsset[];
  value: Address | null;
  onChange(address: Address): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ordered = useMemo(() => orderCurrencies(quotes), [quotes]);
  const needle = query.trim().toLowerCase();
  const rows = ordered.filter((q) => !needle || q.symbol.toLowerCase().includes(needle) || q.name.toLowerCase().includes(needle));
  const selected = quotes.find((q) => q.address.toLowerCase() === value?.toLowerCase());

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Currency ${selected?.symbol ?? ""}`.trim()}
        onClick={() => setOpen((o) => !o)}
        className="mt-2 flex h-10 w-full items-center justify-between border border-hairline-strong bg-transparent px-3 font-mono text-[12px] hover:border-hairline-hover"
      >
        <span>{selected?.symbol ?? "Pick a currency"}</span>
        <span className="text-ink-45">▾</span>
      </button>
      {open ? (
        <div role="dialog" aria-label="Pick a currency" className="absolute left-0 right-0 top-[46px] z-[8] border border-hairline-strong bg-panel p-[10px] font-mono">
          <div className="relative flex items-center">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a currency"
              aria-label="Find a currency"
              className="h-[30px] w-full border border-hairline-strong bg-transparent pl-7 pr-[10px] text-[11px] outline-none focus:border-hairline-focus"
            />
            <MagnifierIcon className="pointer-events-none absolute left-[9px]" />
          </div>
          <div role="listbox" aria-label="Currencies" className="mt-2 max-h-[280px] overflow-y-auto">
            {rows.map((q) => {
              const on = q.address.toLowerCase() === value?.toLowerCase();
              return (
                <button
                  key={q.address}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => {
                    onChange(q.address);
                    setOpen(false);
                    setQuery("");
                  }}
                  className={`flex w-full items-center justify-between px-2 py-[7px] text-left hover:bg-hover-item ${on ? "text-chalk" : "text-ink"}`}
                >
                  <span className="text-[11.5px]">{q.symbol}</span>
                  <span className="text-[10px] text-ink-45">{hasUsdPrice(q) ? "USD" : "No USD price"}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
