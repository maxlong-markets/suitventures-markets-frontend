"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useAppState } from "@/context/AppState";
import { buildBrief, type BriefItem } from "@/lib/brief";
import { ageHours, fmtAge, fmtInt, fmtPctOrDash, fmtUsd, toneClassOrFlat } from "@/lib/format";
import type { QuoteAsset, TokenPair } from "@/lib/types";
import { Avatar } from "./ui";

interface Props {
  pairs: readonly TokenPair[];
  quotes: readonly QuoteAsset[];
  now: number;
}

function Card({ item, now }: { item: BriefItem; now: number }) {
  const { toggleQuote, filters } = useAppState();
  const label = (
    <div className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-45">{item.label}</div>
  );
  const shell =
    "flex min-w-0 flex-col gap-[8px] border border-hairline-strong p-[10px] hover:border-hairline-hover tablet:gap-[10px] tablet:p-[14px]";

  if (item.pair) {
    const p = item.pair;
    const stat =
      item.key === "gainer" ? (
        <span className={toneClassOrFlat(p.change24h)}>{fmtPctOrDash(p.change24h)}</span>
      ) : item.key === "volume" ? (
        <span>{fmtUsd(p.vol24h)}</span>
      ) : (
        <span className="text-ink-75">{fmtAge(ageHours(p.createdAt, now))} old</span>
      );
    return (
      <Link href={`/t/${p.id}`} className={shell}>
        {label}
        <div className="flex min-w-0 flex-wrap items-center gap-x-[10px] gap-y-[4px]">
          <span className="hidden tablet:block">
            <Avatar ticker={p.ticker} logoUrl={p.logoUrl} size={28} fontSize={11} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-cond text-[17px] font-bold leading-tight tracking-[0.02em]">{p.ticker}</div>
            <div className="truncate font-mono text-[10.5px] text-chalk">/ {p.quote}</div>
          </div>
          <div className="flex-none font-mono text-[14px] tabular-nums">{stat}</div>
        </div>
      </Link>
    );
  }

  const q = item.quote!;
  const on = filters.quotes.includes(q.symbol);
  return (
    <button
      type="button"
      onClick={() => toggleQuote(q.symbol)}
      aria-pressed={on}
      className={`${shell} text-left ${on ? "border-chalk-60 bg-chalk-10" : ""}`}
    >
      {label}
      <div className="flex flex-wrap items-baseline justify-between gap-x-[10px] gap-y-[4px]">
        <span className="font-cond text-[17px] font-bold tracking-[0.02em] text-chalk">{q.symbol}</span>
        <span className="font-mono text-[14px] tabular-nums">
          {fmtInt(q.pairs)} <span className="text-[11px] text-ink-50">pairs</span>
        </span>
      </div>
    </button>
  );
}

/**
 * The Desk: the market brief above the table, four cards computed from the live lists. It is the
 * home for the AI desk later (Pair Briefs, The Close); until that ships it says only what the data
 * says, and it hides when there is nothing to say.
 */
export default function TheDesk({ pairs, quotes, now }: Props) {
  const items = useMemo(() => buildBrief(pairs, quotes), [pairs, quotes]);
  if (items.length === 0) return null;

  return (
    <section aria-label="The Desk" className="pt-[16px]">
      <div className="mb-[10px] flex items-baseline gap-[12px]">
        <h2 className="m-0 font-cond text-[20px] font-bold tracking-[0.04em]">The Desk</h2>
        <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-45">
          Brief from onchain data
        </span>
      </div>
      <div className="grid grid-cols-2 gap-[8px] tablet:gap-[10px] desktop:grid-cols-4">
        {items.map((it) => (
          <Card key={it.key} item={it} now={now} />
        ))}
      </div>
    </section>
  );
}
