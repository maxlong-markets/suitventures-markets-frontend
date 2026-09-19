"use client";

import { useEffect, useRef, useState } from "react";
import { useAppState } from "@/context/AppState";
import type { TokenPair } from "@/lib/types";
import {
  fmtPctOrDash,
  fmtPriceOrDash,
  fmtQuote,
  short,
  toneClassOrFlat,
} from "@/lib/format";
import { Avatar, Badge } from "./ui";
import VoteButtons from "./VoteButtons";

const COPIED_MS = 1400;

export default function TokenHeader({ pair }: { pair: TokenPair }) {
  const { stars, toggleStar, votes, vote } = useAppState();
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  const starred = stars.has(pair.id);
  const voted = votes[pair.id];

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pair.address);
    } catch {
      // Clipboard can be unavailable (insecure context); the label still flips.
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <div className="flex flex-col gap-[18px] border-b border-hairline py-[18px] hdr:flex-row hdr:items-center hdr:justify-between hdr:gap-6">
      <div className="flex min-w-0 items-center gap-[14px]">
        <Avatar
          ticker={pair.ticker}
          logoUrl={pair.logoUrl}
          size={40}
          fontSize={14}
          className="text-ink-80"
        />
        <div className="min-w-0">
          <div className="flex items-baseline gap-[10px] overflow-hidden whitespace-nowrap">
            <span className="text-[20px] font-medium leading-[1.1] tracking-[-0.01em]">
              {pair.ticker}
            </span>
            <span className="truncate text-[13px] text-ink-50">{pair.name}</span>
          </div>
          <div className="mt-[6px] flex items-center gap-[10px] whitespace-nowrap font-mono text-[11px] text-ink-50">
            <span className="text-ink-65">
              {pair.ticker} / {pair.quote}
            </span>
            <Badge>{pair.origin.toUpperCase()}</Badge>
            <span>{short(pair.address)}</span>
            <button
              type="button"
              onClick={copy}
              className="bg-transparent p-0 font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-45 hover:text-ink"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </div>
      <div className="flex flex-none flex-col items-start gap-[14px] tablet:flex-row tablet:items-center tablet:justify-between tablet:gap-7">
        <div className="font-mono tabular-nums">
          <div className="text-[28px] leading-none tracking-[-0.01em]">
            {fmtPriceOrDash(pair.stale ? null : pair.priceUsd)}
          </div>
          <div className="mt-[5px] whitespace-nowrap text-[11.5px]">
            <span className={toneClassOrFlat(pair.change24h)}>
              {fmtPctOrDash(pair.change24h)}
            </span>{" "}
            <span className="ml-[6px] text-ink-40">
              24h · {fmtQuote(pair.priceQuote)} {pair.quote}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => toggleStar(pair.id)}
            aria-label={starred ? "Remove from watchlist" : "Add to watchlist"}
            aria-pressed={starred}
            className={`h-[34px] w-[34px] border border-hairline-strong bg-transparent text-[15px] hover:border-[rgba(252,251,247,0.8)] ${
              starred ? "text-chalk" : "text-ink-40"
            }`}
          >
            {starred ? "★" : "☆"}
          </button>
          <VoteButtons
            bull={pair.bull}
            bear={pair.bear}
            voted={voted}
            onVote={(dir) => vote(pair.id, dir)}
          />
        </div>
      </div>
    </div>
  );
}
