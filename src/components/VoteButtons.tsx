"use client";

import type { VoteDir } from "@/lib/types";
import { fmtInt } from "@/lib/format";

interface Props {
  bull: number;
  bear: number;
  voted?: VoteDir;
  onVote(dir: VoteDir): void;
}

const BASE =
  "h-[34px] whitespace-nowrap border bg-transparent px-3 font-mono text-[11px] tracking-[0.06em] hover:border-[rgba(252,251,247,0.8)]";

function cls(on: boolean): string {
  return `${BASE} ${on ? "border-chalk-60 text-chalk" : "border-hairline-strong text-ink"}`;
}

export default function VoteButtons({ bull, bear, voted, onVote }: Props) {
  return (
    <>
      <button
        type="button"
        onClick={() => onVote("bull")}
        aria-pressed={voted === "bull"}
        className={cls(voted === "bull")}
      >
        <span className="text-up">↑</span> Bullish{" "}
        <span className="ml-1 text-up">{fmtInt(bull)}</span>
      </button>
      <button
        type="button"
        onClick={() => onVote("bear")}
        aria-pressed={voted === "bear"}
        className={cls(voted === "bear")}
      >
        <span className="text-down">↓</span> Bearish{" "}
        <span className="ml-1 text-down">{fmtInt(bear)}</span>
      </button>
    </>
  );
}
