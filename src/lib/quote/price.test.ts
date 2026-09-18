import { describe, expect, it } from "vitest";
import type { PoolKeyRow } from "@/lib/market/poolKey";
import type { Address } from "@/lib/types";
import { NotRoutableError, type Quoter, type QuoterCall } from "./quoter";
import { priceSwap, type PriceRequest, type PriceResult } from "./price";

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const QUOTE = "0x2222222222222222222222222222222222222222" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * The token is currency0, so a buy (paying the quote asset) is one-for-zero and a sell is
 * zero-for-one; both directions are exercised. The quote asset carries 6 decimals and the token 18,
 * so a decimals mix-up cannot pass. At the stored price one token costs 0.5 quote.
 */
const POOL: PoolKeyRow = {
  poolId: `0x${"ab".repeat(32)}` as Address,
  currency0: TOKEN,
  currency1: QUOTE,
  fee: 3000,
  tickSpacing: 60,
  hooks: ZERO,
  tokenIsCurrency0: true,
  priceQuote: 0.5,
  tokenAddress: TOKEN,
  tokenDecimals: 18,
  quoteAddress: QUOTE,
  quoteDecimals: 6,
};

type Answer = bigint | Error;
type Recorded = { fn: "exactIn" | "exactOut"; zeroForOne: boolean; exactAmount: bigint; poolId: Address };

/** Answers in order; an Error entry is thrown instead of returned, so a revert is one list entry. */
function fakeQuoter(answers: Answer[]): { quoter: Quoter; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let i = 0;
  const next = (fn: "exactIn" | "exactOut", call: QuoterCall): bigint => {
    calls.push({ fn, zeroForOne: call.zeroForOne, exactAmount: call.exactAmount, poolId: call.poolKey.poolId });
    const answer = answers[i++];
    if (answer === undefined) throw new Error(`the fake quoter has no answer for call ${i}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return {
    calls,
    quoter: {
      exactIn: async (call) => next("exactIn", call),
      exactOut: async (call) => next("exactOut", call),
    },
  };
}

const req = (over: Partial<PriceRequest> = {}): PriceRequest => ({
  side: "buy",
  amount: "100",
  denom: "quote",
  slippageBps: 100,
  holder: false,
  pool: POOL,
  ...over,
});

/** Narrows and fails loudly, so a routable:false regression does not read as a missing field. */
function routable(result: PriceResult) {
  if (!result.routable) throw new Error("expected a routable quote");
  return result;
}

describe("priceSwap", () => {
  it("buys with the quote asset, taking the 0.5 % fee off the input before the swap", async () => {
    const { quoter, calls } = fakeQuoter([199n * 10n ** 18n]);
    const res = routable(await priceSwap(quoter, req()));
    // 100 quote in, 0.5 quote of fee, 99.5 quote reaching the pool.
    expect(calls).toEqual([
      { fn: "exactIn", zeroForOne: false, exactAmount: 99_500_000n, poolId: POOL.poolId },
    ]);
    expect(res.routerFeePct).toBe(0.5);
    expect(res.poolFeePct).toBe(0.3);
    expect([Number(res.payAmount), Number(res.receiveAmount), Number(res.minReceived), Number(res.routerFeeAmount)])
      .toEqual([100, 199, 197.01, 0.5]);
    expect(res.call).toEqual({
      poolKey: { currency0: TOKEN, currency1: QUOTE, fee: 3000, tickSpacing: 60, hooks: ZERO },
      zeroForOne: false,
      amountIn: "100000000",
      amountOutMin: "197010000000000000000",
      tokenIn: QUOTE,
      tokenOut: TOKEN,
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
    });
    // 99.5 quote for 199 tokens is exactly the stored 0.5: impact is measured on what the pool saw,
    // not on what the wallet paid. Computing it on amountIn would read about +0.5 % here.
    expect(res.priceImpactPct).toBeCloseTo(0, 6);
  });

  it("charges a Suits holder nothing, so the whole input reaches the pool", async () => {
    const { quoter, calls } = fakeQuoter([200n * 10n ** 18n]);
    const res = routable(await priceSwap(quoter, req({ holder: true })));
    expect(calls[0].exactAmount).toBe(100_000_000n);
    expect(res.routerFeePct).toBe(0);
    expect(Number(res.routerFeeAmount)).toBe(0);
    expect(Number(res.receiveAmount)).toBe(200);
    expect(res.call.amountIn).toBe("100000000");
    expect(res.priceImpactPct).toBeCloseTo(0, 6);
  });

  it("sells the pair token, which is currency0, so the swap is zero-for-one", async () => {
    const { quoter, calls } = fakeQuoter([49_750_000n]);
    const res = routable(await priceSwap(quoter, req({ side: "sell", denom: "token" })));
    expect(calls).toEqual([
      { fn: "exactIn", zeroForOne: true, exactAmount: 99_500_000_000_000_000_000n, poolId: POOL.poolId },
    ]);
    expect(res.call.tokenIn).toBe(TOKEN);
    expect(res.call.tokenOut).toBe(QUOTE);
    expect(res.call.tokenInDecimals).toBe(18);
    expect(res.call.tokenOutDecimals).toBe(6);
    expect([Number(res.payAmount), Number(res.receiveAmount)]).toEqual([100, 49.75]);
    expect(res.call.amountOutMin).toBe("49252500");
    expect(res.priceImpactPct).toBeCloseTo(0, 6);
  });

  it("inverts a buy typed in the token: exact-output, gross up past the fee, then re-quote exact-in", async () => {
    // The pool needs 99.6 quote net for the 200 tokens asked; grossed up that is 100.100503 quote,
    // whose net of 99.600001 buys a shade more than the 200 typed — and that is what is reported.
    const { quoter, calls } = fakeQuoter([99_600_000n, 200_001_000_000_000_000_000n]);
    const res = routable(await priceSwap(quoter, req({ side: "buy", denom: "token", amount: "200" })));
    expect(calls).toEqual([
      { fn: "exactOut", zeroForOne: false, exactAmount: 200n * 10n ** 18n, poolId: POOL.poolId },
      { fn: "exactIn", zeroForOne: false, exactAmount: 99_600_001n, poolId: POOL.poolId },
    ]);
    // ceil(99_600_000 * 10000 / 9950) = 100_100_503; floor(100_100_503 * 50 / 10000) = 500_502.
    expect(res.call.amountIn).toBe("100100503");
    expect(Number(res.routerFeeAmount)).toBe(0.500502);
    expect(Number(res.payAmount)).toBe(100.100503);
    expect(Number(res.receiveAmount)).toBe(200.001);
    expect(res.call.amountOutMin).toBe("198000990000000000000");
  });

  it("inverts a sell typed in the quote asset the same way", async () => {
    const { quoter, calls } = fakeQuoter([100n * 10n ** 18n, 50_000_100n]);
    const res = routable(await priceSwap(quoter, req({ side: "sell", denom: "quote", amount: "50" })));
    expect(calls[0]).toEqual({ fn: "exactOut", zeroForOne: true, exactAmount: 50_000_000n, poolId: POOL.poolId });
    // ceil(100e18 * 10000 / 9950) = 100502512562814070352, whose net is 100000000000000000001 — never
    // below the 100e18 the pool asked for, because the gross-up ceilings and the fee floors.
    expect(res.call.amountIn).toBe("100502512562814070352");
    expect(calls[1]).toEqual({
      fn: "exactIn",
      zeroForOne: true,
      exactAmount: 100_000_000_000_000_000_001n,
      poolId: POOL.poolId,
    });
    expect(Number(res.receiveAmount)).toBe(50.0001);
  });

  it("reports not routable when the quoter refuses the pool, on either leg", async () => {
    const direct = fakeQuoter([new NotRoutableError("pool cannot be routed")]);
    expect(await priceSwap(direct.quoter, req())).toEqual({ routable: false });

    const inverted = fakeQuoter([new NotRoutableError("pool cannot be routed")]);
    expect(await priceSwap(inverted.quoter, req({ denom: "token" }))).toEqual({ routable: false });
    expect(inverted.calls).toHaveLength(1); // the exact-out leg failed; no second call was made
  });

  it("lets a failure that is not a routability verdict through", async () => {
    const { quoter } = fakeQuoter([new Error("rpc unreachable")]);
    await expect(priceSwap(quoter, req())).rejects.toThrow("rpc unreachable");
  });

  it("refuses an amount of zero before asking the quoter", async () => {
    const { quoter, calls } = fakeQuoter([]);
    await expect(priceSwap(quoter, req({ amount: "0" }))).rejects.toBeInstanceOf(RangeError);
    await expect(priceSwap(quoter, req({ amount: "0.0", denom: "token" }))).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a pool row whose key does not carry the pay asset", async () => {
    const { quoter, calls } = fakeQuoter([]);
    const broken: PoolKeyRow = { ...POOL, currency0: ZERO, currency1: ZERO };
    await expect(priceSwap(quoter, req({ pool: broken }))).rejects.toThrow(/pool key/);
    expect(calls).toHaveLength(0);
  });
});
