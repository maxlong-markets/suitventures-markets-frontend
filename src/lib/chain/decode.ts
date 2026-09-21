import { decodeEventLog, type Hex } from "viem";
import { POOL_MANAGER_EVENTS_ABI, TOPIC0 } from "./abi";
import type { ChainEvent } from "./types";

/**
 * What `hypersyncSource.ts` hands to `decodeLog` for one PoolManager log, once its block's
 * timestamp and its transaction's sender are known (HyperSync answers those separately from the
 * log itself; joining them is the source's job, not this one's).
 */
export type RawLog = {
  blockNumber: number;
  logIndex: number;
  txHash: string;
  /** topic0 first, then whichever of topic1..topic3 the log carries, in order. */
  topics: string[];
  data: string;
  timestamp: number;
  txFrom: string | null;
};

/**
 * Decodes one PoolManager log into the `ChainEvent` its topic0 names, or `null` for a topic0
 * this reader does not track (the HyperSync query already filters to the three tracked topics,
 * so this is a defensive fallback, not the common case).
 *
 * Every address, pool id and hash comes back lowercase (types.ts's convention: compared lowercase
 * everywhere). `fee`, `tick`, `tickSpacing`, `tickLower` and `tickUpper` come back `number`;
 * every other on-chain integer (amounts, `liquidity`, `liquidityDelta`, `sqrtPriceX96`) comes back
 * `bigint` — exactly how viem decodes these ABI widths, never routed through `number`.
 */
export function decodeLog(raw: RawLog): ChainEvent | null {
  const topic0 = raw.topics[0]?.toLowerCase();
  if (!topic0) return null;

  const topics = raw.topics as [Hex, ...Hex[]];
  const data = raw.data as Hex;
  const base = {
    block: raw.blockNumber,
    logIndex: raw.logIndex,
    timestamp: raw.timestamp,
    txHash: raw.txHash.toLowerCase(),
    txFrom: raw.txFrom ? raw.txFrom.toLowerCase() : null,
  };

  if (topic0 === TOPIC0.initialize) {
    const { args } = decodeEventLog({ abi: POOL_MANAGER_EVENTS_ABI, eventName: "Initialize", topics, data });
    return {
      ...base,
      kind: "initialize",
      poolId: args.id.toLowerCase(),
      currency0: args.currency0.toLowerCase(),
      currency1: args.currency1.toLowerCase(),
      fee: args.fee,
      tickSpacing: args.tickSpacing,
      hooks: args.hooks.toLowerCase(),
      sqrtPriceX96: args.sqrtPriceX96,
      tick: args.tick,
    };
  }

  if (topic0 === TOPIC0.swap) {
    const { args } = decodeEventLog({ abi: POOL_MANAGER_EVENTS_ABI, eventName: "Swap", topics, data });
    return {
      ...base,
      kind: "swap",
      poolId: args.id.toLowerCase(),
      amount0: args.amount0,
      amount1: args.amount1,
      sqrtPriceX96: args.sqrtPriceX96,
      liquidity: args.liquidity,
      tick: args.tick,
      fee: args.fee,
    };
  }

  if (topic0 === TOPIC0.modifyLiquidity) {
    const { args } = decodeEventLog({ abi: POOL_MANAGER_EVENTS_ABI, eventName: "ModifyLiquidity", topics, data });
    return {
      ...base,
      kind: "modifyLiquidity",
      poolId: args.id.toLowerCase(),
      tickLower: args.tickLower,
      tickUpper: args.tickUpper,
      liquidityDelta: args.liquidityDelta,
    };
  }

  return null;
}
