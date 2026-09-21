import { formatUnits } from "viem";

const Q96 = 2 ** 96;

/**
 * Token price in quote units from a v4 sqrtPriceX96.
 * price of currency0 in currency1 = (sqrtP / 2^96)^2 * 10^(dec0 - dec1); inverted when the token is currency1.
 * Doubles are fine for display (relative error about 1e-16).
 */
export function priceFromSqrtPriceX96(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
  tokenIsCurrency0: boolean,
): number {
  const ratio = Number(sqrtPriceX96) / Q96;
  const price1per0 = ratio * ratio * 10 ** (decimals0 - decimals1);
  return tokenIsCurrency0 ? price1per0 : 1 / price1per0;
}

/**
 * The sqrtPriceX96 a pool would report at a given quote price: the inverse of
 * priceFromSqrtPriceX96 above. For pools copied from the old indexer whose sqrtPriceX96
 * was never captured (see PoolState.sqrtPriceX96 in types.ts), so amountsForLiquidityDelta
 * still has a price to work from. Same double precision as priceFromSqrtPriceX96, so the
 * round trip through both functions is accurate to about 1e-9 relative, not 1e-16 exactly.
 */
export function sqrtPriceX96FromPrice(
  priceQuote: number,
  decimals0: number,
  decimals1: number,
  tokenIsCurrency0: boolean,
): bigint {
  if (!Number.isFinite(priceQuote) || priceQuote <= 0) {
    throw new Error(`sqrtPriceX96FromPrice: priceQuote must be a positive finite number, got ${priceQuote}`);
  }
  const price1per0 = tokenIsCurrency0 ? priceQuote : 1 / priceQuote;
  const ratio = Math.sqrt(price1per0 * 10 ** (decimals1 - decimals0));
  return BigInt(Math.round(ratio * Q96));
}

export function toUnits(raw: bigint, decimals: number): number {
  return Number(formatUnits(raw, decimals));
}

export function absBig(x: bigint): bigint {
  return x < 0n ? -x : x;
}
