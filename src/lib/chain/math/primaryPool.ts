import { toUnits } from "./price";

export type PoolRank = {
  id: string;
  quoteId: string;
  tvlQuote: bigint | undefined;
  quoteDecimals: number;
  swapCount: number;
  createdAt: number;
};

/**
 * Highest USD value of the pool's QUOTE side, then swap count, then earliest pool (spec section 5).
 *
 * Only the quote side counts. It is the real money in the pool and the side a seller is paid out
 * of. Counting the token side at the token's own price values a one-sided position at its own
 * market cap, so a pool holding an entire supply and no money at all would outrank a pool holding
 * real money — and then price the token, draw its chart and take its trades. Measured 28 Sep 2026
 * against KIDKOBS, a Doppler launch on the live table: both sides scored $20,005 of "TVL" for
 * about $1 of actual USDG. Amends D23.
 */
export function choosePrimaryPool(
  pools: PoolRank[],
  usdPrice: (quoteId: string) => number | undefined,
): string | undefined {
  if (pools.length === 0) return undefined;
  const scored = pools.map((p) => {
    const usd = usdPrice(p.quoteId) ?? 0;
    // undefined is "TVL not known for this pool yet": scores zero and falls through to swapCount.
    const quoteUnits = p.tvlQuote === undefined ? 0 : toUnits(p.tvlQuote, p.quoteDecimals);
    return { p, tvlUsd: quoteUnits * usd };
  });
  scored.sort((a, b) =>
    b.tvlUsd - a.tvlUsd ||
    b.p.swapCount - a.p.swapCount ||
    a.p.createdAt - b.p.createdAt ||
    a.p.id.localeCompare(b.p.id),
  );
  return scored[0]!.p.id;
}
