import type { QuoteAsset, TokenPair } from "./types";

/**
 * Tickers that more than one token uses, upper-cased. Thousands of memecoins share tickers (two
 * "NVIDIA" coins both trade against NVDA), and a buyer who goes by the ticker alone can buy the
 * wrong token. Counted over distinct token ids, so one token listed twice is not a clash.
 */
export function sharedTickers(pairs: readonly TokenPair[]): Set<string> {
  const ids = new Map<string, Set<string>>();
  for (const p of pairs) {
    const t = p.ticker.trim().toUpperCase();
    if (!t) continue;
    let set = ids.get(t);
    if (!set) ids.set(t, (set = new Set()));
    set.add(p.id);
  }
  const out = new Set<string>();
  for (const [t, set] of ids) if (set.size > 1) out.add(t);
  return out;
}

/** The quote assets that are not stocks: ether and the dollar stablecoins. */
const NON_STOCK = /^(W?ETH|USDG|USDC|USDT|DAI)$/i;

/**
 * Robinhood stock tokens among the quote assets. Live names end "• Robinhood Token"; the demo
 * source's names are plain ("NVIDIA"), so anything that is not ether or a stablecoin counts too.
 */
export function isStockQuote(q: QuoteAsset): boolean {
  return /robinhood token/i.test(q.name) || !NON_STOCK.test(q.symbol);
}

/** Healthcare and biotech stock tokens on Robinhood Chain, for the stock tape's Biotech group. */
export const BIOTECH = ["LLY", "MRNA", "PFE", "JNJ", "HIMS"] as const;
