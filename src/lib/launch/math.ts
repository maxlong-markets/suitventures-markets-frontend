import type { Hex } from "viem";
import { toBase, toHuman } from "@/lib/quote/math";

/**
 * The launch form's arithmetic (instant launchpad design, sections 3.4 and 7.2), in raw integers. It only previews: the
 * contract snaps the valuation itself (the form reads `openingFor`), and `minFirstBuyTokens` protects the creator if a
 * setting or the currency order differs from what the form showed. USD appears only at the edges, for display.
 */
export const SUPPLY = 1_000_000_000n * 10n ** 18n;
export const TOKEN_DECIMALS = 18;
const BPS = 10_000n;
/** Spec 3.4: the only price claim the form makes. No line may say that every buyer pays the same price. */
export const RULE_OF_THUMB = "Buys worth about 41 % of the opening valuation double the price, plus the 1 % pool fee.";
/** DEFAULT (spec 12): the currency's minimum times 1, 2, 5 and 20. */
export const PRESET_MULTIPLIERS = [1n, 2n, 5n, 20n] as const;

export function presetValuations(min: bigint, max: bigint): bigint[] {
  return PRESET_MULTIPLIERS.map((k) => (min * k > max ? max : min * k));
}

/** `floor(gross × routerFeeBps / 10_000)`, exactly as SVRouter and the launchpad take it (spec 4.5 step 7). */
export function routerFeeOf(gross: bigint, routerFeeBps: number): bigint {
  return (gross * BigInt(routerFeeBps)) / BPS;
}

/** Tokens a gross first buy receives: `S × y / (V' + y)` with `y = 0.99 × (gross − routerFee)` (spec 3.4). */
export function estimateFirstBuyTokens(gross: bigint, snapped: bigint, routerFeeBps: number): bigint {
  if (gross <= 0n || snapped <= 0n) return 0n;
  const y = ((gross - routerFeeOf(gross, routerFeeBps)) * 99n) / 100n;
  return (SUPPLY * y) / (snapped + y);
}

/** The floor sent as `minFirstBuyTokens`: the estimate less 0.5 % (spec 7.2). */
export function minFirstBuyTokens(estimate: bigint): bigint {
  return (estimate * 995n) / 1000n;
}

export function capTokens(capBps: number): bigint {
  return (SUPPLY * BigInt(capBps)) / BPS;
}

/**
 * The largest gross first buy that stays under the cap: `V' × cap/(1 − cap) / 0.99 / (1 − fee) × 0.999`, floored.
 * 0 when the cap is 0 (first buys blocked); null when the cap is the whole supply, since then there is nothing to stay under.
 */
export function firstBuyCapGross(snapped: bigint, capBps: number, routerFeeBps: number): bigint | null {
  if (capBps <= 0) return 0n;
  if (capBps >= 10_000) return null;
  const c = BigInt(capBps);
  const f = BigInt(routerFeeBps);
  return (snapped * c * 100n * BPS * 999n) / ((BPS - c) * 99n * (BPS - f) * 1000n);
}

/** The Max button: the smaller of the balance less the creation fee and the cap; null when neither is known. */
export function maxFirstBuy(balance: bigint | undefined, creationFee: bigint, capGross: bigint | null): bigint | null {
  const spendable = balance === undefined ? null : balance > creationFee ? balance - creationFee : 0n;
  if (spendable === null) return capGross;
  if (capGross === null) return spendable;
  return spendable < capGross ? spendable : capGross;
}

export function shareOfSupplyPct(tokens: bigint): number {
  return Number((tokens * 1_000_000n) / SUPPLY) / 10_000;
}

/** Raw units as a plain number, for display only. */
export function rawToNumber(raw: bigint, decimals: number): number {
  return Number(toHuman(raw, decimals));
}

/**
 * A typed USD amount in raw quote units at `usdPrice` (per whole quote unit), rounded to the currency's last decimal
 * (`toFixed` rounds; beyond 18 decimals `toBase` then truncates); null for anything unusable. A requested valuation
 * only: the contract snaps it and bounds-checks it itself.
 */
export function usdToRaw(usd: string, usdPrice: number, decimals: number): bigint | null {
  const value = Number(usd);
  if (usd.trim() === "" || !Number.isFinite(value) || value <= 0 || !(usdPrice > 0)) return null;
  try {
    return toBase((value / usdPrice).toFixed(Math.min(decimals, 18)), decimals);
  } catch {
    return null;
  }
}

/** One whole token's opening price in whole quote units: V' over one billion tokens. */
export function pricePerToken(snapped: bigint, quoteDecimals: number): number {
  return rawToNumber(snapped, quoteDecimals) / 1e9;
}

/** The app's CREATE2 salt (spec 4.2): random, so nobody can predict the token address before the transaction is sequenced. */
export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}
