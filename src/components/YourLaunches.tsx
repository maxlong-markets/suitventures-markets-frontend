"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useAppState } from "@/context/AppState";
import { usePairs } from "@/hooks/useMarketsData";
import { ageHours, fmtAge, fmtUsd } from "@/lib/format";
import { hasLaunchpad } from "@/lib/launch/address";
import type { Address } from "@/lib/types";

/**
 * Under the form on `/launch` (amended 30 Sep 2026): the connected wallet's own launches, read from the Suits list, which
 * holds every launch whether or not it traded. The markets table can lose a launch nobody bought, so this is where its
 * creator finds it again. It renders nothing until it has something to show: no launchpad, no wallet, the list still
 * loading or failing, or no launch of this wallet's in it.
 */
export default function YourLaunches() {
  const { address, isConnected } = useAppState();
  if (!hasLaunchpad() || !isConnected || !address) return null;
  return <Launches wallet={address} />;
}

function Launches({ wallet }: { wallet: Address }) {
  const { data, dataUpdatedAt } = usePairs("sv");
  // The store keeps the creator lowercase and wagmi hands over a mixed-case address, so both sides are lowercased.
  // The list already answers newest first, so its order is kept.
  const mine = useMemo(() => {
    const me = wallet.toLowerCase();
    return (data ?? []).filter((p) => p.launchCreator?.toLowerCase() === me);
  }, [data, wallet]);
  if (mine.length === 0) return null;

  return (
    <section className="mt-6 border border-hairline p-4">
      <h2 className="mb-3 font-mono text-[9.5px] font-normal uppercase tracking-[0.22em] text-ink-40">Your launches</h2>
      <ul>
        {mine.map((p) => (
          <li key={p.id}>
            <Link href={`/t/${p.id}`} className="flex items-baseline justify-between gap-3 py-1 font-mono text-[11.5px] hover:bg-hover-row">
              <span className="flex min-w-0 items-baseline gap-[10px]">
                <span className="flex-none font-sans text-[13px] font-medium">{p.ticker}</span>
                <span className="truncate font-sans text-[11px] text-ink-45">{p.name}</span>
              </span>
              <span className="flex flex-none gap-3 tabular-nums text-ink-60">
                {/* Measured from when the list was fetched, as the markets table measures its Age column. */}
                <span>{fmtAge(ageHours(p.createdAt, dataUpdatedAt))} ago</span>
                {p.mcap > 0 ? <span>Mcap {fmtUsd(p.mcap)}</span> : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
