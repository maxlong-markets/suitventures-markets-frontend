"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import { logoShade } from "@/lib/format";

/** The Suits mark, always a circle with a hairline ring. */
export function SuitsMark({
  size,
  className = "",
}: {
  size: number;
  className?: string;
}) {
  return (
    <Image
      src="/suits-mark.png"
      alt=""
      width={size}
      height={size}
      className={`block flex-none rounded-full object-cover shadow-[0_0_0_1px_rgba(240,232,214,0.16)] ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/** Launchpad / holder tag: mono 8.5px, 0.14em, 1px hairline-strong border. */
export function Badge({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-block border border-hairline-strong px-[4px] py-px font-mono text-[8.5px] leading-[1.3] tracking-[0.14em] text-ink-60 ${className}`}
    >
      {children}
    </span>
  );
}

/** Token avatar: the logo when the indexer has one, else the initial on a logo shade. */
export function Avatar({
  ticker,
  logoUrl,
  size,
  fontSize,
  className = "",
}: {
  ticker: string;
  logoUrl?: string;
  size: number;
  fontSize: number;
  className?: string;
}) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- logo hosts come from the indexer and are not known ahead of time
      <img
        src={logoUrl}
        alt=""
        width={size}
        height={size}
        className={`flex-none rounded-full object-cover ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`flex flex-none items-center justify-center rounded-full font-mono text-ink-75 ${className}`}
      style={{ width: size, height: size, background: logoShade(ticker), fontSize }}
    >
      {ticker[0]}
    </span>
  );
}

export function MagnifierIcon({
  className = "",
  stroke = "rgba(232,228,220,0.45)",
}: {
  className?: string;
  stroke?: string;
}) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className={className} aria-hidden>
      <circle cx="5" cy="5" r="3.6" fill="none" stroke={stroke} strokeWidth="1.2" />
      <line x1="7.8" y1="7.8" x2="11" y2="11" stroke={stroke} strokeWidth="1.2" />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle
        cx="7"
        cy="7"
        r="5.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeDasharray="2.6 1.6"
      />
      <circle cx="7" cy="7" r="1.8" fill="currentColor" />
    </svg>
  );
}

/** 12px spinner ring, 1.5px stroke, 0.9s. `dark` for use on chalk. */
export function Spinner({ dark = false }: { dark?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-3 w-3 flex-none animate-ring rounded-full border-[1.5px] ${
        dark
          ? "border-[rgba(5,5,6,0.25)] border-t-void"
          : "border-ink-25 border-t-ink"
      }`}
    />
  );
}
