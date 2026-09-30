import type { Denom, Quote, Side, TokenPair } from "./types";

/**
 * The pool fee in percent, for display and the local estimate. A pool with a fixed tier says what it charges
 * (`feeTier` reads "1.00%"), so a token launched here shows its real 1 % before any amount is typed. Only a dynamic
 * fee, which the pool's hook sets on each trade, falls back to the estimate by origin.
 */
export function poolFeePctFor(pair: TokenPair): number {
  const fixed = /^(\d+(?:\.\d+)?)\s*%$/.exec(pair.feeTier ?? "");
  if (fixed) return Number(fixed[1]);
  return pair.origin === "Pons" ? 1.0 : 0.3;
}

/** Local approximation until the V4 Quoter lands in M2: constant-product impact against half the pool. */
export function localQuote(pair: TokenPair, side: Side, amount: number, denom: Denom, isSuitHolder: boolean, slippagePct: number): Quote {
  const pn = pair.priceQuote;
  const quoteUsd = pair.priceQuote > 0 ? pair.priceUsd / pair.priceQuote : 0;
  const buy = side === "buy";
  let pay: number;
  let receive: number;
  if (buy) {
    if (denom === "quote") { pay = amount; receive = pn > 0 ? amount / pn : 0; } else { receive = amount; pay = amount * pn; }
  } else if (denom === "token") { pay = amount; receive = amount * pn; } else { receive = amount; pay = pn > 0 ? amount / pn : 0; }
  const payUsd = pay * (buy ? quoteUsd : pair.priceUsd);
  const liquidity = pair.liquidity ?? 0;
  const impact = liquidity > 0 ? (payUsd / (liquidity / 2)) * 100 : 0;
  const poolFee = poolFeePctFor(pair);
  return {
    payAmount: pay, receiveAmount: receive, priceImpactPct: impact,
    routerFeePct: isSuitHolder ? 0 : 0.5, poolFeePct: poolFee,
    minReceived: receive * (1 - slippagePct / 100 - poolFee / 100),
  };
}
