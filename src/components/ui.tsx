"use client";

import Image from "next/image";
import { useState, type ReactNode } from "react";
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

/** Origin / holder tag: mono 8.5px, 0.14em, 1px hairline-strong border. */
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

/**
 * Token avatar: the logo proxy when the row carries one, else the initial on a logo shade.
 * The proxy answers 404 for a token with no logo anywhere, which is the common case, so the
 * letter has to be a fallback and not just a placeholder.
 */
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
  // The URL that failed, not a bare "it failed": a re-sorted or re-filtered table reuses this
  // component for another token, and a boolean would hold the letter over the new logo.
  const [failed, setFailed] = useState<string | null>(null);
  if (logoUrl && failed !== logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- the proxy streams whatever the logo host sent; next/image would re-encode it
      <img
        src={logoUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(logoUrl)}
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
