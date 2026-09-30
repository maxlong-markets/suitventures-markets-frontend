import { addressUrl } from "@/lib/chain";
import { ageHours, fmtAge, fmtInt, fmtISODate, fmtPctOrDash, fmtPriceOrDash, fmtUsdOrDash, toneClassOrFlat } from "@/lib/format";
import { originLabel } from "@/lib/markets";
import type { TokenPair } from "@/lib/types";

/** One label and value of a token's details, in the card under the trade panel and in the public block alike. */
export interface FactRow {
  label: string;
  value: string;
  href?: string;
  /** text-up / text-down / neutral, for a signed change; unset for every other row. */
  toneClass?: string;
  /** One plain sentence under the value, explaining it; only the Pool fee tier row carries one. */
  note?: string;
}

/** `key`: the six figures a trader looks for first, always on screen. `more`: everything else, behind "All details". */
export interface FactRows {
  key: FactRow[];
  more: FactRow[];
}

/**
 * One plain sentence under the fee tier value, since "0.30%" or "Dynamic" means nothing to a reader who has never met
 * a Uniswap v4 pool. A fixed tier says what the pool charges, and that is all: who receives it is not said, for a
 * token launched here as for any other (the owner's ruling of 30 Sep 2026: "just show 1% and its good enough"). A
 * dynamic fee has no fixed percentage to name, because the pool's hook decides it on each trade.
 */
export function feeTierNote(pair: TokenPair): string {
  if (pair.feeTier === "Dynamic") {
    return "The pool's hook sets the fee on each trade, so it can differ from one trade to the next.";
  }
  return `The pool charges ${pair.feeTier} on every trade.`;
}

/**
 * A token's details in two parts (30 Sep 2026, the owner's request: "first show the important details and then when
 * you expand show all"). `now` is handed in, so a caller in the browser passes the moment its data was fetched and a
 * Server Component passes the request's own clock.
 */
export function buildFactRows(pair: TokenPair, now: number): FactRows {
  // USD-denominated fields read 0 when `stale` (TokenPair.stale's doc comment) and must show a dash rather than a
  // misleading "$0", the same `stale ? null : v` gate PairsTable's row and TokenHeader use. `liquidity` is nullable
  // independently of `stale`, and the two changes are percentages rather than USD, so neither is gated here.
  const priceUsd = pair.stale ? null : pair.priceUsd;
  const vol24h = pair.stale ? null : pair.vol24h;
  const mcap = pair.stale ? null : pair.mcap;
  const fdv = pair.stale ? null : pair.fdv;
  return {
    key: [
      { label: "1h change", value: fmtPctOrDash(pair.change1h), toneClass: toneClassOrFlat(pair.change1h) },
      { label: "24h change", value: fmtPctOrDash(pair.change24h), toneClass: toneClassOrFlat(pair.change24h) },
      { label: "24h volume", value: fmtUsdOrDash(vol24h) },
      { label: "FDV", value: fmtUsdOrDash(fdv) },
      { label: "Liquidity", value: fmtUsdOrDash(pair.liquidity) },
      { label: "Holders", value: fmtInt(pair.holders) },
    ],
    more: [
      { label: "Ticker", value: pair.ticker },
      { label: "Name", value: pair.name },
      { label: "Token address", value: pair.address, href: addressUrl(pair.address) },
      { label: "Quote asset", value: pair.quote },
      { label: "Origin", value: originLabel(pair.origin) },
      { label: "Price (USD)", value: fmtPriceOrDash(priceUsd) },
      { label: "Market cap", value: fmtUsdOrDash(mcap) },
      { label: "Age", value: `${fmtAge(ageHours(pair.createdAt, now))} · ${fmtISODate(pair.createdAt)}` },
      { label: "Pool fee tier", value: pair.feeTier, note: feeTierNote(pair) },
    ],
  };
}
