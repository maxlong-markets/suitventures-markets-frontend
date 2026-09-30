"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type KeyboardEvent } from "react";
import { useAppState } from "@/context/AppState";
import { MagnifierIcon, SuitsMark } from "./ui";
import WalletButton from "./WalletButton";

// No Traders tab since 30 Sep 2026: the board showed nothing while its data is not available. TradersBoard and
// /api/traders stay parked behind TRADERS_BOARD, so bringing the tab back is this one entry and a page.
const NAV = [
  { href: "/", label: "Markets" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/launch", label: "Launch" },
] as const;

function navClass(active: boolean): string {
  return `whitespace-nowrap font-mono text-[10.5px] uppercase tracking-[0.22em] hover:text-white ${
    active ? "text-ink" : "text-ink-50"
  }`;
}

export default function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const { filters, setQuery } = useAppState();
  const [searchOpen, setSearchOpen] = useState(false);
  const onTokenPage = pathname.startsWith("/t/");

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Searching from a token page lands you back on the table.
    if (e.key === "Enter" && onTokenPage) router.push("/");
  };

  const searchInput = (className: string) => (
    <input
      value={filters.query}
      onChange={(e) => setQuery(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder="Ticker or address"
      aria-label="Search pairs"
      autoComplete="off"
      spellCheck={false}
      className={className}
    />
  );

  return (
    <>
      <header className="flex h-14 items-center justify-between gap-4 border-b border-hairline-strong px-4 tablet:px-5 desktop:px-6">
        <div className="flex min-w-0 items-center gap-[30px]">
          <Link href="/" className="flex items-center gap-[10px] whitespace-nowrap">
            <SuitsMark size={22} />
            <span className="flex items-baseline gap-2">
              <span className="font-script text-[22px] leading-none text-chalk">
                MaxLong
              </span>
              <span className="hidden font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-50 tablet:inline">
                Markets
              </span>
            </span>
          </Link>
          <nav className="hidden gap-[22px] tablet:flex" aria-label="Primary">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={`${navClass(pathname === n.href)} py-1`}
                aria-current={pathname === n.href ? "page" : undefined}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-[10px]">
          <div className="relative hidden items-center tablet:flex">
            {searchInput(
              "h-8 w-[160px] border border-hairline-strong bg-transparent pl-[30px] pr-[10px] font-mono text-[11.5px] outline-none focus:border-hairline-focus desktop:w-[220px]",
            )}
            <MagnifierIcon className="pointer-events-none absolute left-[10px]" />
          </div>
          <button
            type="button"
            onClick={() => setSearchOpen((o) => !o)}
            aria-label="Search"
            aria-expanded={searchOpen}
            className="flex h-8 w-8 items-center justify-center border border-hairline-strong bg-transparent tablet:hidden"
          >
            <MagnifierIcon stroke="rgba(232,228,220,0.6)" />
          </button>
          <WalletButton />
        </div>
      </header>
      <nav
        className="no-scrollbar flex gap-[22px] overflow-x-auto px-4 pt-3 tablet:hidden"
        aria-label="Primary"
      >
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={navClass(pathname === n.href)}
            aria-current={pathname === n.href ? "page" : undefined}
          >
            {n.label}
          </Link>
        ))}
      </nav>
      {searchOpen ? (
        <div className="px-4 pt-3 tablet:hidden">
          {searchInput(
            "h-[34px] w-full border border-hairline-strong bg-transparent px-[10px] font-mono text-[12px] outline-none focus:border-hairline-focus",
          )}
        </div>
      ) : null}
    </>
  );
}
