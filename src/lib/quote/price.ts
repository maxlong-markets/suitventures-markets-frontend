import type { PoolKeyRow } from "@/lib/market/poolKey";
import type { Address, Denom, Origin, Side } from "@/lib/types";
import {
  HOLDER_FEE_BPS,
  ROUTER_FEE_BPS,
  feeFor,
  grossUp,
  priceImpactPct,
  toBase,
  toHuman,
  withSlippage,
} from "./math";
import { NotRoutableError, type Quoter } from "./quoter";

/** v4's dynamic-fee sentinel (shape.ts's feeTierLabel renders this exact value "Dynamic"). */
const DYNAMIC_FEE_FLAG = 0x800000;

export type PriceRequest = {
  side: Side;
  amount: string;
  denom: Denom;
  slippageBps: number;
  holder: boolean;
  pool: PoolKeyRow;
  /**
   * The listed pair's origin (I1): `PoolKeyRow` carries no origin of its own, and the only use
   * for one here is the display-only dynamic-fee estimate below, so the route passes it through
   * rather than widening the pool row every backend and fixture builds.
   */
  origin: Origin;
};

export type SwapCall = {
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  zeroForOne: boolean;
  amountIn: string;
  amountOutMin: string;
  tokenIn: Address;
  tokenOut: Address;
  tokenInDecimals: number;
  tokenOutDecimals: number;
};

export type PriceResult =
  | { routable: false }
  | {
      routable: true;
      payAmount: string;
      receiveAmount: string;
      minReceived: string;
      routerFeePct: 0 | 0.5;
      routerFeeAmount: string;
      poolFeePct: number;
      priceImpactPct: number;
      call: SwapCall;
    };

/** Which way round the trade runs, decided once and used by both legs. */
type Direction = {
  tokenIn: Address;
  tokenOut: Address;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  zeroForOne: boolean;
  feeBps: number;
  /** true when `amount` names the asset leaving the wallet, false when it names the one arriving. */
  typedThePaySide: boolean;
};

/** What the quoter settled: the amounts the call block and the display are both built from. */
type Priced = { amountIn: bigint; fee: bigint; net: bigint; amountOut: bigint };

function direction(req: PriceRequest): Direction {
  const { pool, side, denom, holder } = req;
  // A buy pays the quote asset and receives the pair token; a sell is the other way round.
  const buy = side === "buy";
  const tokenIn = buy ? pool.quoteAddress : pool.tokenAddress;
  const tokenOut = buy ? pool.tokenAddress : pool.quoteAddress;
  const zeroForOne = tokenIn === pool.currency0;
  if (!zeroForOne && tokenIn !== pool.currency1) {
    // Every address in the store is lowercase, so this is a broken row, not a user mistake.
    // The message names no address: rule 4.
    throw new Error("pool key does not carry the pay asset");
  }
  return {
    tokenIn,
    tokenOut,
    tokenInDecimals: buy ? pool.quoteDecimals : pool.tokenDecimals,
    tokenOutDecimals: buy ? pool.tokenDecimals : pool.quoteDecimals,
    zeroForOne,
    feeBps: holder ? HOLDER_FEE_BPS : ROUTER_FEE_BPS,
    typedThePaySide: denom === (buy ? "quote" : "token"),
  };
}

/**
 * The router is exact-input only, so a number typed on the receive side is inverted:
 * `quoteExactOutputSingle` gives the net input the pool needs, the gross-up puts the fee back on top,
 * and the amount reported to the user is a fresh exact-in quote of that gross amount's net — the
 * amount they will really receive, not the one they typed. The gross-up ceilings and the fee floors,
 * so the re-quoted net is never below what the pool asked for.
 */
async function quote(q: Quoter, req: PriceRequest, d: Direction): Promise<Priced> {
  const { pool } = req;
  if (d.typedThePaySide) {
    const amountIn = toBase(req.amount, d.tokenInDecimals);
    if (amountIn <= 0n) throw new RangeError("amount must be greater than zero");
    const { fee, net } = feeFor(amountIn, d.feeBps);
    const amountOut = await q.exactIn({ poolKey: pool, zeroForOne: d.zeroForOne, exactAmount: net });
    return { amountIn, fee, net, amountOut };
  }
  const wanted = toBase(req.amount, d.tokenOutDecimals);
  if (wanted <= 0n) throw new RangeError("amount must be greater than zero");
  const needed = await q.exactOut({ poolKey: pool, zeroForOne: d.zeroForOne, exactAmount: wanted });
  const amountIn = grossUp(needed, d.feeBps);
  const { fee, net } = feeFor(amountIn, d.feeBps);
  const amountOut = await q.exactIn({ poolKey: pool, zeroForOne: d.zeroForOne, exactAmount: net });
  return { amountIn, fee, net, amountOut };
}

/**
 * One priced swap, with no I/O of its own: the `Quoter` is the only seam, so the whole brain runs
 * against a fake in tests and against `simulateContract` in the route.
 */
export async function priceSwap(q: Quoter, req: PriceRequest): Promise<PriceResult> {
  const { pool, holder, slippageBps, origin } = req;
  const d = direction(req);
  const priced = await quote(q, req, d).catch((err: unknown) => {
    // Contract rule 5: only the quoter's own verdict means "not routable". Anything else is a
    // failure to ask, and the route must answer 503 rather than pretend the pool is dead.
    if (err instanceof NotRoutableError) return null;
    throw err;
  });
  if (!priced) return { routable: false };

  const amountOutMin = withSlippage(priced.amountOut, slippageBps);
  return {
    routable: true,
    payAmount: toHuman(priced.amountIn, d.tokenInDecimals),
    receiveAmount: toHuman(priced.amountOut, d.tokenOutDecimals),
    minReceived: toHuman(amountOutMin, d.tokenOutDecimals),
    routerFeePct: holder ? 0 : 0.5,
    routerFeeAmount: toHuman(priced.fee, d.tokenInDecimals),
    // A v4 fee is hundredths of a basis point: 3000 is 0.30 % — except the dynamic-fee sentinel,
    // which is not a fee at all and reads as "838.86 %" if divided like one (I1). The Quoter's
    // amounts above already include whatever the hook actually charged, so this figure is
    // display only, never a value anything computes with: for a dynamic pool it is the same M1
    // estimate by origin that src/lib/quote.ts's poolFeePctFor renders elsewhere in the app.
    poolFeePct: (pool.fee & DYNAMIC_FEE_FLAG) !== 0 ? (origin === "Pons" ? 1.0 : 0.3) : pool.fee / 10_000,
    // Measured on `net`: the pool never saw the router's fee, so the fee is not price impact.
    priceImpactPct: priceImpactPct(
      priced.net,
      priced.amountOut,
      d.tokenInDecimals,
      d.tokenOutDecimals,
      pool.priceQuote,
      req.side === "buy",
    ),
    call: {
      poolKey: {
        currency0: pool.currency0,
        currency1: pool.currency1,
        fee: pool.fee,
        tickSpacing: pool.tickSpacing,
        hooks: pool.hooks,
      },
      zeroForOne: d.zeroForOne,
      amountIn: priced.amountIn.toString(),
      amountOutMin: amountOutMin.toString(),
      tokenIn: d.tokenIn,
      tokenOut: d.tokenOut,
      tokenInDecimals: d.tokenInDecimals,
      tokenOutDecimals: d.tokenOutDecimals,
    },
  };
}
