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

/** bps to a percent string with no more decimals than the value needs: 7000 -> "70", 6543 -> "65.43". */
function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(2).replace(/\.?0+$/, "");
}

/**
 * One plain sentence under the fee tier value, since "0.30%" or "Dynamic" means nothing to a reader who has never met
 * a Uniswap v4 pool. Three cases, checked in this order:
 *  - launched here, on its own launch pool (`pair.launch` present AND `pair.origin === "SV"`): every launchpad pool
 *    is origin SV with a static 1% fee, and a token has exactly one launch pool, so this is the one case where
 *    `pair.launch` being present proves the pool on screen IS that pool. A token launched here can later be listed
 *    through a traded pool of another origin while still carrying its `launch` block; checking `pair.launch` alone
 *    would then claim a creator and MaxLong split for fees that other pool's liquidity keeps. The pool itself is
 *    open, so anyone can add liquidity to it; the sentence says no more than that the launch's own locked liquidity
 *    earns its share of the fee, and that of what it earns `creatorShareBps` is the split to the creator's payout
 *    address versus MaxLong, read from the launch rather than assumed to be the usual 70/30.
 *  - a dynamic fee (`feeTier === "Dynamic"`): the pool's hook decides the number per trade, so there is no fixed
 *    percentage to name.
 *  - anything else: a plain fixed tier. Who receives it is not said, since that differs by launchpad.
 */
export function feeTierNote(pair: TokenPair): string {
  if (pair.launch && pair.origin === "SV") {
    const creatorBps = pair.launch.creatorShareBps;
    const lede = `${pair.feeTier} of every trade. The launch's locked liquidity earns this fee, and `;
    // 0 and 10000 bps get their own plain sentences rather than an odd "0% ... and 100% ...".
    if (creatorBps === 0) {
      return `${lede}all of what it earns goes to MaxLong.`;
    }
    if (creatorBps === 10_000) {
      return `${lede}all of what it earns goes to the creator's payout address.`;
    }
    const creatorPct = bpsToPercent(creatorBps);
    const maxlongPct = bpsToPercent(10_000 - creatorBps);
    return `${lede}${creatorPct}% of what it earns goes to the creator's payout address and ${maxlongPct}% to MaxLong.`;
  }
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
