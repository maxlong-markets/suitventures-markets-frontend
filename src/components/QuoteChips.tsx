"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "@/context/AppState";
import { useQuotes } from "@/hooks/useMarketsData";
import { useBreakpoint, type Breakpoint } from "@/hooks/useBreakpoint";
import QuotePicker from "./QuotePicker";

/** Top quotes by 24h volume shown inline; the rest live in the picker. */
const TOP_N: Record<Breakpoint, number> = { phone: 4, tablet: 6, desktop: 8 };

function chipClass(on: boolean): string {
  return `h-[26px] flex-none border px-[11px] font-mono text-[10px] tracking-[0.14em] hover:border-hairline-hover ${
    on ? "border-ink bg-ink text-onlight" : "border-hairline-strong bg-transparent text-ink-60"
  }`;
}

export default function QuoteChips() {
  const { filters, toggleQuote, clearQuotes } = useAppState();
  const { data: quotes } = useQuotes();
  const bp = useBreakpoint();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = filters.quotes;

  const sorted = useMemo(
    () => [...(quotes ?? [])].sort((a, b) => b.vol24h - a.vol24h),
    [quotes],
  );

  const visible = useMemo(() => {
    const list = sorted.slice(0, TOP_N[bp]).map((q) => q.symbol);
    for (const s of selected) if (!list.includes(s)) list.push(s);
    return list;
  }, [sorted, bp, selected]);

  const hidden = Math.max(0, sorted.length - visible.length);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative border-b border-hairline">
      <div className="no-scrollbar flex items-center gap-[6px] overflow-x-auto px-4 py-3 tablet:px-5 desktop:px-6">
        <button
          type="button"
          onClick={clearQuotes}
          aria-pressed={selected.length === 0}
          className={chipClass(selected.length === 0)}
        >
          ALL
        </button>
        {visible.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => toggleQuote(s)}
            aria-pressed={selected.includes(s)}
            className={chipClass(selected.includes(s))}
          >
            {s}
          </button>
        ))}
        {sorted.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className={`ml-1 h-[26px] flex-none whitespace-nowrap border border-dashed bg-transparent px-[11px] font-mono text-[10px] tracking-[0.14em] hover:border-[rgba(240,232,214,0.6)] hover:text-ink ${
              open
                ? "border-chalk-60 text-chalk"
                : "border-[rgba(240,232,214,0.28)] text-ink-60"
            }`}
          >
            +{hidden} more {open ? "▴" : "▾"}
          </button>
        ) : null}
        {selected.length > 0 ? (
          <button
            type="button"
            onClick={clearQuotes}
            className="h-[26px] flex-none bg-transparent px-[6px] font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-45 hover:text-ink"
          >
            Clear
          </button>
        ) : null}
      </div>
      {open ? (
        <QuotePicker
          quotes={sorted}
          selected={selected}
          onToggle={toggleQuote}
          onClear={clearQuotes}
          onDone={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
