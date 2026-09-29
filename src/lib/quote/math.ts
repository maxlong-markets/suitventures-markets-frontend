/**
 * Quote arithmetic in base units. Every amount is a bigint: a float never holds an amount the
 * chain will see. Rounding always favours the pool — the fee floors, the gross-up ceilings and
 * `withSlippage` floors — so no rounding here can revert a swap on the user's behalf.
 */

/** SVRouter takes 0.5 % of the input before the swap (contracts spec section 5, D34). */
export const ROUTER_FEE_BPS = 50;
/** A Suits NFT holder pays no router fee. */
export const HOLDER_FEE_BPS = 0;

const BPS = 10_000n;
/** Generous: no listed token is past 18, and the ceiling still catches a swapped argument. */
const MAX_DECIMALS = 36;
/** Digits with an optional point. No sign, no exponent, no separators, no whitespace: a typed amount is a positive decimal or it is junk. */
const DECIMAL = /^(?:\d+|\d*\.\d+|\d+\.\d*)$/;

function checkBps(name: string, bps: number, max: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > max) throw new RangeError(`${name}: ${bps} is not an integer in 0..${max}`);
  return BigInt(bps);
}

function checkDecimals(decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(`decimals: ${decimals} is not an integer in 0..${MAX_DECIMALS}`);
  }
  return decimals;
}

/** The router's fee and what reaches the pool. Floors, as the contract's integer division does, so one wei pays nothing. */
export function feeFor(amountIn: bigint, feeBps: number): { fee: bigint; net: bigint } {
  if (amountIn < 0n) throw new RangeError("feeFor: amountIn is negative");
  const bps = checkBps("feeFor", feeBps, 9_999);
  const fee = (amountIn * bps) / BPS;
  return { fee, net: amountIn - fee };
}

/** The input whose net is at least `net`. Ceilings: flooring here would hand the pool a wei less than the quote promised. */
export function grossUp(net: bigint, feeBps: number): bigint {
  if (net < 0n) throw new RangeError("grossUp: net is negative");
  const bps = checkBps("grossUp", feeBps, 9_999);
  const denominator = BPS - bps;
  return (net * BPS + denominator - 1n) / denominator;
}

/** The least output the user will accept. Floors: rounding up would revert the swap for a wei. */
export function withSlippage(amountOut: bigint, slippageBps: number): bigint {
  if (amountOut < 0n) throw new RangeError("withSlippage: amountOut is negative");
  const bps = checkBps("withSlippage", slippageBps, 10_000);
  return (amountOut * (BPS - bps)) / BPS;
}

/**
 * How far the realised rate is from the pool's stored `price_quote`, in percent, signed: a stale
 * stored price can read better than the pool and that is worth showing. Both directions are
 * converted to quote-per-token first, so a buy and a sell are measured the same way. Display only
 * — a float never decides an amount — and 0 for a degenerate input rather than Infinity or NaN.
 *
 * The first parameter is `netIn`: the amount the pool actually swapped, after the router took its
 * fee off the input. Passing the gross `amountIn` would charge the router's 0.5 % to price impact
 * and show half a percent of slippage no pool caused (ruling 2).
 */
export function priceImpactPct(
  netIn: bigint,
  amountOut: bigint,
  inDecimals: number,
  outDecimals: number,
  poolPriceQuote: number,
  payingQuote: boolean,
): number {
  checkDecimals(inDecimals);
  checkDecimals(outDecimals);
  // The same window the rest of the app calls a sane pool price (isSanePool, writers.ts listedPool). It rules
  // out 0, NaN, Infinity and denormals in one test: outside it there is no price to compare against,
  // so the honest impact is 0 rather than a number computed from nonsense.
  if (netIn <= 0n || amountOut <= 0n || !(poolPriceQuote > 1e-24 && poolPriceQuote < 1e18)) return 0;
  const inHuman = Number(netIn) / 10 ** inDecimals;
  const outHuman = Number(amountOut) / 10 ** outDecimals;
  const realised = payingQuote ? inHuman / outHuman : outHuman / inHuman;
  if (!Number.isFinite(realised) || realised <= 0) return 0;
  // Paying the quote, a higher realised price is worse; paying the token, a lower one is.
  const pct = payingQuote ? (realised / poolPriceQuote - 1) * 100 : (poolPriceQuote / realised - 1) * 100;
  // Belt and braces: a finite ratio of two in-window numbers cannot overflow, but the response must
  // never carry Infinity or NaN, which JSON.stringify would send as `null`.
  return Number.isFinite(pct) ? pct : 0;
}

/**
 * A typed decimal string in base units. Digits past the token's decimals are truncated, never
 * rounded up: 100 % of a balance must stay inside that balance, because this number is what
 * Permit2 transfers.
 */
export function toBase(human: string, decimals: number): bigint {
  checkDecimals(decimals);
  if (!DECIMAL.test(human)) throw new RangeError(`toBase: ${JSON.stringify(human)} is not a decimal amount`);
  const [whole = "", fraction = ""] = human.split(".");
  const scaled = `${whole}${fraction.slice(0, decimals).padEnd(decimals, "0")}`;
  return scaled === "" ? 0n : BigInt(scaled);
}

/**
 * Base units as a decimal string, at any size and with no exponent notation: `Number` prints
 * 1e-18 for a wei, and the route's JSON must stay parseable as a decimal. A negative prints its
 * sign, though `toBase` never accepts one — a display helper has to be total.
 */
export function toHuman(base: bigint, decimals: number): string {
  checkDecimals(decimals);
  const negative = base < 0n;
  const digits = (negative ? -base : base).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}
