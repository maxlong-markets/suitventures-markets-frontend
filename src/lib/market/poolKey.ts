import type { Address } from "@/lib/types";

/**
 * Everything a swap needs to know about a token's listed pool: the v4 PoolKey's five fields, the
 * direction flag, both assets' decimals and the stored quote-per-token price the route measures
 * price impact against. `TokenPair` carries none of this; widening it would push a PoolKey into
 * every screen that lists a row.
 */
export type PoolKeyRow = {
  poolId: Address;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  tokenIsCurrency0: boolean;
  priceQuote: number;
  tokenAddress: Address;
  tokenDecimals: number;
  quoteAddress: Address;
  quoteDecimals: number;
};

/** What a backend has read about the listed pool, in either source's own casing. */
export type PoolKeyParts = {
  poolId: string;
  hooks: string;
  fee: number;
  tickSpacing: number;
  tokenIsCurrency0: boolean;
  priceQuote: number;
  tokenAddress: string;
  tokenDecimals: number;
  quoteAddress: string;
  quoteDecimals: number;
};

const lower = (a: string): Address => a.toLowerCase() as Address;

/**
 * The one place a PoolKeyRow is built, so the store and the indexer cannot drift. Addresses are
 * lowercased because the indexer returns ids lowercase but `Token.address` and `Quote.address`
 * checksummed; viem accepts a lowercase address, and `tokenIsCurrency0` — the flag the pool was
 * created with — decides the currency order, so nothing here depends on string comparison.
 *
 * `quoteId` (C2) is the trading pool's required quote asset, lowercase, exactly as
 * `MarketBackend.poolKey`'s own second parameter: a candidate whose quote does not match is not a
 * trading pool for this request at all — the panel would label, balance-check and gate on the
 * pair's quote asset while the wallet signed a Permit2 for a different one — so this, the one
 * place every candidate becomes a `PoolKeyRow`, is where both backends enforce it, primary and
 * fallback candidates alike.
 */
export function poolKeyRow(p: PoolKeyParts, quoteId: string): PoolKeyRow | null {
  const tokenAddress = lower(p.tokenAddress);
  const quoteAddress = lower(p.quoteAddress);
  if (quoteAddress !== quoteId) return null;
  return {
    poolId: lower(p.poolId),
    currency0: p.tokenIsCurrency0 ? tokenAddress : quoteAddress,
    currency1: p.tokenIsCurrency0 ? quoteAddress : tokenAddress,
    fee: p.fee,
    tickSpacing: p.tickSpacing,
    hooks: lower(p.hooks),
    tokenIsCurrency0: p.tokenIsCurrency0,
    priceQuote: p.priceQuote,
    tokenAddress,
    tokenDecimals: p.tokenDecimals,
    quoteAddress,
    quoteDecimals: p.quoteDecimals,
  };
}
