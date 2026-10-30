import { isStockQuote } from "./sharedTickers";
import type { QuoteAsset, TokenPair } from "./types";

/** One line of The Desk: a headline pair and what makes it the headline. */
export interface BriefItem {
  key: "gainer" | "volume" | "newest" | "stock";
  label: string;
  /** A pair for the first three; a quote asset for the busiest stock. */
  pair?: TokenPair;
  quote?: QuoteAsset;
}

/**
 * The Desk's brief, computed from the same lists the table shows, never invented: the biggest 24h
 * gainer that actually traded, the most traded pair, the newest pair, and the stock (never ether or a
 * stablecoin) with the most memecoins quoted against it. An item with nothing to point at is left out, so a stale feed
 * shows fewer cards rather than zeros.
 */
export function buildBrief(pairs: readonly TokenPair[], quotes: readonly QuoteAsset[]): BriefItem[] {
  const out: BriefItem[] = [];
  const live = pairs.filter((p) => !p.stale);

  const traded = live.filter((p) => p.vol24h > 0);
  const gainer = traded
    .filter((p) => p.change24h !== null && p.change24h > 0)
    .sort((a, b) => (b.change24h ?? 0) - (a.change24h ?? 0))[0];
  if (gainer) out.push({ key: "gainer", label: "Top gainer · 24h", pair: gainer });

  const volume = [...traded].sort((a, b) => b.vol24h - a.vol24h)[0];
  if (volume) out.push({ key: "volume", label: "Most traded · 24h", pair: volume });

  const newest = [...pairs].sort((a, b) => b.createdAt - a.createdAt)[0];
  if (newest) out.push({ key: "newest", label: "Newest pair", pair: newest });

  const stock = quotes.filter((q) => isStockQuote(q) && q.pairs > 0).sort((a, b) => b.pairs - a.pairs || b.vol24h - a.vol24h)[0];
  if (stock) out.push({ key: "stock", label: "Most memes quoted in", quote: stock });

  return out;
}
