"use client";

import type { VoteDir } from "@/lib/types";
import { fmtInt } from "@/lib/format";

interface Props {
  bull: number;
  bear: number;
  voted?: VoteDir;
  /**
   * This token's vote write is in flight. `AppState` takes one write per token at a time and drops
   * a click made while one is out, so both buttons say so instead of looking like a click that did
   * nothing (the spam-click half of the 23 Sep report).
   */
  pending?: boolean;
  onVote(dir: VoteDir): void;
}

const BASE =
  "h-[34px] whitespace-nowrap border bg-transparent px-3 font-mono text-[11px] tracking-[0.06em] hover:border-[rgba(240,232,214,0.4)]";

function cls(on: boolean, pending: boolean): string {
  // Muted rather than disabled: a disabled button drops focus out from under the keyboard mid-
  // interaction, and the click it would swallow is already a no-op one layer up.
  return `${BASE} ${on ? "border-chalk-60 text-chalk" : "border-hairline-strong text-ink"}${pending ? " opacity-50" : ""}`;
}

export default function VoteButtons({ bull, bear, voted, pending = false, onVote }: Props) {
  return (
    <>
      <button
        type="button"
        onClick={() => onVote("bull")}
        aria-pressed={voted === "bull"}
        aria-busy={pending}
        className={cls(voted === "bull", pending)}
      >
        <span className="text-up">↑</span> Bullish{" "}
        <span className="ml-1 text-up">{fmtInt(bull)}</span>
      </button>
      <button
        type="button"
        onClick={() => onVote("bear")}
        aria-pressed={voted === "bear"}
        aria-busy={pending}
        className={cls(voted === "bear", pending)}
      >
        <span className="text-down">↓</span> Bearish{" "}
        <span className="ml-1 text-down">{fmtInt(bear)}</span>
      </button>
    </>
  );
}
