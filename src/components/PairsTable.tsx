"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { SortDir, SortKey } from "@/lib/markets";
import type { TokenPair } from "@/lib/types";
import {
  ageHours,
  fmtAge,
  fmtInt,
  fmtPctOrDash,
  fmtPriceOrDash,
  fmtUsdOrDash,
  toneClassOrFlat,
} from "@/lib/format";
import { isPhoneNow } from "@/hooks/useBreakpoint";
import { Avatar, Badge } from "./ui";

/**
 * Column tracks per breakpoint (handoff). Cells hide themselves with the
 * matching `hidden tablet:block` / `hidden desktop:block` classes, so the
 * layout is pure CSS and safe to server-render.
 */
const COLS =
  "grid-cols-[minmax(0,1fr)_76px_54px_60px] tablet:grid-cols-[22px_minmax(104px,1fr)_22px_56px_78px_54px_54px_80px_76px_74px_88px] desktop:grid-cols-[28px_minmax(120px,1fr)_22px_64px_92px_62px_62px_90px_90px_90px_90px_68px_44px_96px]";

export interface EmptyStateProps {
  title: string;
  sub: string;
  onReset?: () => void;
}

export interface PairsTableProps {
  rows: TokenPair[];
  loading: boolean;
  /** Reference time for ages; fixed per data load so rows don't drift mid-render. */
  now: number;
  stars: ReadonlySet<string>;
  onToggleStar(id: string): void;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort(key: SortKey): void;
  empty: EmptyStateProps;
}

interface ThProps {
  k?: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort(key: SortKey): void;
  align?: "left" | "right";
  className?: string;
  children: React.ReactNode;
}

function Th({ k, sortKey, sortDir, onSort, align = "left", className = "", children }: ThProps) {
  const alignClass = align === "right" ? "text-right" : "text-left";
  if (!k) return <div className={`${alignClass} ${className}`}>{children}</div>;
  const active = sortKey === k;
  return (
    <div
      role="columnheader"
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
      className={`${alignClass} ${className}`}
    >
      <button type="button" onClick={() => onSort(k)} className="uppercase">
        {children}
        {active ? <span className="text-ink"> {sortDir === "desc" ? "▼" : "▲"}</span> : null}
      </button>
    </div>
  );
}

const SKELETON_WIDTHS = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
  a: 90 + ((i * 37) % 70),
  b: 60 + ((i * 23) % 40),
  c: 50 + ((i * 31) % 50),
  d: 70 + ((i * 17) % 40),
}));

function SkeletonRows() {
  return (
    <div aria-busy aria-label="Loading pairs">
      {SKELETON_WIDTHS.map((w, i) => (
        <div
          key={i}
          className="flex h-11 items-center gap-[14px] border-b border-hairline-row"
        >
          <span className="h-[22px] w-[22px] flex-none rounded-full bg-[rgba(232,228,220,0.06)]" />
          <span className="skeleton h-[10px]" style={{ width: w.a }} />
          <span className="flex-1" />
          <span className="skeleton h-[10px]" style={{ width: w.b }} />
          <span className="skeleton h-[10px]" style={{ width: w.c }} />
          <span className="skeleton h-[10px]" style={{ width: w.d }} />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ title, sub, onReset }: EmptyStateProps) {
  return (
    <div className="px-4 py-16 text-center">
      <div className="text-[16px]">{title}</div>
      <div className="mt-[6px] text-[12.5px] text-ink-50">{sub}</div>
      {onReset ? (
        <button
          type="button"
          onClick={onReset}
          className="mt-[18px] h-[30px] border border-hairline-btn bg-transparent px-[14px] font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink hover:border-[rgba(240,232,214,0.5)]"
        >
          Show all pairs
        </button>
      ) : null}
    </div>
  );
}

interface RowProps {
  pair: TokenPair;
  rank: number;
  now: number;
  starred: boolean;
  expanded: boolean;
  onToggleExpand(id: string): void;
  onToggleStar(id: string): void;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between border-b border-dotted border-hairline-strong pb-1">
      <span className="text-[10px] uppercase tracking-[0.14em] text-ink-45">{label}</span>
      <span>{children}</span>
    </div>
  );
}

const PairRow = memo(function PairRow({
  pair,
  rank,
  now,
  starred,
  expanded,
  onToggleExpand,
  onToggleStar,
}: RowProps) {
  const router = useRouter();
  const href = `/t/${pair.id}`;
  const age = fmtAge(ageHours(pair.createdAt, now));
  const pad = pair.origin.toUpperCase();

  const open = () => {
    // Phone rows expand in place; larger screens go straight to the token.
    if (isPhoneNow()) onToggleExpand(pair.id);
    else router.push(href);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };
  const star = (e: MouseEvent) => {
    e.stopPropagation();
    onToggleStar(pair.id);
  };

  return (
    <div className="border-b border-hairline-row">
      <div
        role="link"
        tabIndex={0}
        onClick={open}
        onKeyDown={onKeyDown}
        onMouseEnter={() => router.prefetch(href)}
        aria-expanded={expanded}
        className={`grid ${COLS} h-11 cursor-pointer items-center gap-2 whitespace-nowrap font-mono text-[12.5px] tabular-nums hover:bg-hover-row`}
      >
        <div className="hidden text-[11px] text-ink-40 tablet:block">{rank}</div>
        <div className="flex min-w-0 items-center gap-[10px]">
          <Avatar ticker={pair.ticker} logoUrl={pair.logoUrl} size={22} fontSize={9.5} />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-[7px]">
              <span className="min-w-0 truncate font-sans text-[13px] font-medium tracking-[0.01em]">
                {pair.ticker}
              </span>
              <span className="hidden flex-none tablet:inline">
                <Badge>{pad}</Badge>
              </span>
            </div>
            <div className="mt-px truncate font-sans text-[11px] text-ink-45">
              <span className="tablet:hidden">
                {pair.name} · {pair.quote} · {pad}
              </span>
              <span className="hidden tablet:inline">{pair.name}</span>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={star}
          aria-label={starred ? `Unwatch ${pair.ticker}` : `Watch ${pair.ticker}`}
          aria-pressed={starred}
          className={`hidden h-7 w-7 justify-self-center bg-transparent p-0 text-[14px] hover:text-chalk tablet:block ${
            starred ? "text-chalk" : "text-ink-34"
          }`}
        >
          {starred ? "★" : "☆"}
        </button>
        <div className="hidden truncate text-[11.5px] text-ink-60 tablet:block">
          / {pair.quote}
        </div>
        <div className="text-right">
          {fmtPriceOrDash(pair.stale ? null : pair.priceUsd)}
        </div>
        <div
          className={`hidden text-right tablet:block ${toneClassOrFlat(pair.change1h)}`}
        >
          {fmtPctOrDash(pair.change1h)}
        </div>
        <div className={`text-right ${toneClassOrFlat(pair.change24h)}`}>
          {fmtPctOrDash(pair.change24h)}
        </div>
        <div className="text-right">
          {fmtUsdOrDash(pair.stale ? null : pair.vol24h)}
        </div>
        <div className="hidden text-right tablet:block">
          {fmtUsdOrDash(pair.stale ? null : pair.mcap)}
        </div>
        <div className="hidden text-right desktop:block">
          {fmtUsdOrDash(pair.stale ? null : pair.fdv)}
        </div>
        <div className="hidden text-right tablet:block">
          {fmtUsdOrDash(pair.liquidity)}
        </div>
        <div className="hidden text-right desktop:block">{fmtInt(pair.holders)}</div>
        <div className="hidden text-right text-ink-60 desktop:block">{age}</div>
        <div className="hidden grid-cols-2 gap-2 text-[11px] tablet:grid">
          <span className="whitespace-nowrap text-right text-up">
            <span className="opacity-55">↑</span>
            {fmtInt(pair.bull)}
          </span>
          <span className="whitespace-nowrap text-right text-down">
            <span className="opacity-55">↓</span>
            {fmtInt(pair.bear)}
          </span>
        </div>
      </div>
      {expanded ? (
        <div className="pb-[14px] pl-8 pt-[6px] font-mono text-[12px] tabular-nums tablet:hidden">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Detail label="1h">
              <span className={toneClassOrFlat(pair.change1h)}>
                {fmtPctOrDash(pair.change1h)}
              </span>
            </Detail>
            <Detail label="Mcap">
              {fmtUsdOrDash(pair.stale ? null : pair.mcap)}
            </Detail>
            <Detail label="FDV">
              {fmtUsdOrDash(pair.stale ? null : pair.fdv)}
            </Detail>
            <Detail label="Liquidity">{fmtUsdOrDash(pair.liquidity)}</Detail>
            <Detail label="Holders">{fmtInt(pair.holders)}</Detail>
            <Detail label="Age">{age}</Detail>
            <Detail label="Votes">
              <span className="text-up">↑{fmtInt(pair.bull)}</span>
              <span className="ml-[6px] text-down">↓{fmtInt(pair.bear)}</span>
            </Detail>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={star}
              className={`h-8 border border-hairline-btn bg-transparent px-3 text-[12px] ${
                starred ? "text-chalk" : "text-ink-35"
              }`}
            >
              {starred ? "★" : "☆"} Watch
            </button>
            <Link
              href={href}
              className="flex h-8 flex-1 items-center justify-center bg-chalk text-[10px] uppercase tracking-[0.18em] text-onlight hover:bg-white"
            >
              Open {pair.ticker} →
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
});

export default function PairsTable({
  rows,
  loading,
  now,
  stars,
  onToggleStar,
  sortKey,
  sortDir,
  onSort,
  empty,
}: PairsTableProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggleExpand = (id: string) =>
    setExpanded((cur) => (cur === id ? null : id));
  const th = { sortKey, sortDir, onSort };

  return (
    <div className="overflow-x-auto">
      <div
        className={`grid ${COLS} h-8 items-center gap-2 whitespace-nowrap border-b border-hairline-strong font-mono text-[10px] uppercase tracking-[0.16em] text-ink-40`}
        role="row"
      >
        <Th k="rank" {...th} className="hidden tablet:block">#</Th>
        <Th k="ticker" {...th}>Token</Th>
        <div className="hidden tablet:block" />
        <Th {...th} className="hidden tablet:block">Quote</Th>
        <Th k="price" {...th} align="right">Price</Th>
        <Th k="h1" {...th} align="right" className="hidden tablet:block">1h</Th>
        <Th k="h24" {...th} align="right">24h</Th>
        <Th k="vol" {...th} align="right">
          <span className="tablet:hidden">Vol</span>
          <span className="hidden tablet:inline">Vol 24h</span>
        </Th>
        <Th k="mcap" {...th} align="right" className="hidden tablet:block">Mcap</Th>
        <Th k="fdv" {...th} align="right" className="hidden desktop:block">FDV</Th>
        <Th k="liq" {...th} align="right" className="hidden tablet:block">Liquidity</Th>
        <Th k="holders" {...th} align="right" className="hidden desktop:block">Holders</Th>
        <Th k="age" {...th} align="right" className="hidden desktop:block">Age</Th>
        <div className="hidden grid-cols-2 gap-2 tablet:grid">
          <span className="text-right">Bull</span>
          <span className="text-right">Bear</span>
        </div>
      </div>
      {loading ? (
        <SkeletonRows />
      ) : rows.length === 0 ? (
        <EmptyState {...empty} />
      ) : (
        rows.map((p, i) => (
          <PairRow
            key={p.id}
            pair={p}
            rank={i + 1}
            now={now}
            starred={stars.has(p.id)}
            expanded={expanded === p.id}
            onToggleExpand={toggleExpand}
            onToggleStar={onToggleStar}
          />
        ))
      )}
    </div>
  );
}
