import { decodeEventLog, type Hex } from "viem";
import { LAUNCH_TOPIC0, LAUNCHPAD_EVENTS_ABI, POOL_MANAGER, POOL_MANAGER_EVENTS_ABI, TOPIC0 } from "./abi";
import type { ChainEvent, ChainEventBase } from "./types";

/**
 * What `hypersyncSource.ts` hands to `decodeLog` for one log, once its block's timestamp and its transaction's sender
 * are known (HyperSync answers those separately from the log itself; joining them is the source's job, not this one's).
 * `address` is the emitting contract: since the launchpad joined the query (instant launchpad design, section 5.2) a log
 * is routed by address first and topic0 second.
 */
export type RawLog = {
  address: string;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  /** topic0 first, then whichever of topic1..topic3 the log carries, in order. */
  topics: string[];
  data: string;
  timestamp: number;
  txFrom: string | null;
};

export type DecodeOptions = {
  /** The launchpad's address. Null or absent: only PoolManager logs decode, exactly as before the launchpad. */
  launchpad?: string | null;
};

/**
 * Decodes one log into the `ChainEvent` its address and topic0 name, or `null` for a log this reader does not track: a
 * PoolManager topic0 outside the three, a launchpad topic0 outside the three activity events, or any other emitter. The
 * HyperSync query already filters by address and topic, so null is a defensive fallback, not the common case.
 *
 * Every address, pool id and hash comes back lowercase (types.ts's convention). Ticks, fees and bps come back `number`;
 * every other on-chain integer comes back `bigint`, exactly how viem decodes these widths, never routed through `number`.
 */
export function decodeLog(raw: RawLog, opts: DecodeOptions = {}): ChainEvent | null {
  const topic0 = raw.topics[0]?.toLowerCase();
  if (!topic0) return null;

  const topics = raw.topics as [Hex, ...Hex[]];
  const data = raw.data as Hex;
  const base: ChainEventBase = {
    block: raw.blockNumber,
    logIndex: raw.logIndex,
    timestamp: raw.timestamp,
    txHash: raw.txHash.toLowerCase(),
    txFrom: raw.txFrom ? raw.txFrom.toLowerCase() : null,
  };

  const address = raw.address.toLowerCase();
  if (address === POOL_MANAGER) return decodePoolManagerLog(topic0, topics, data, base);
  const launchpad = opts.launchpad?.toLowerCase();
  if (launchpad && address === launchpad) return decodeLaunchpadLog(topic0, topics, data, base);
  return null;
}

function decodePoolManagerLog(topic0: string, topics: [Hex, ...Hex[]], data: Hex, base: ChainEventBase): ChainEvent | null {
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

/** The launchpad's three activity events (spec 4.2). A setting event, or any other topic0, is null. */
function decodeLaunchpadLog(topic0: string, topics: [Hex, ...Hex[]], data: Hex, base: ChainEventBase): ChainEvent | null {
  if (topic0 === LAUNCH_TOPIC0.launched) {
    const { args } = decodeEventLog({ abi: LAUNCHPAD_EVENTS_ABI, eventName: "Launched", topics, data });
    const d = args.data;
    return {
      ...base,
      kind: "launched",
      token: args.token.toLowerCase(),
      creator: args.creator.toLowerCase(),
      quote: args.quote.toLowerCase(),
      poolId: d.poolId.toLowerCase(),
      payout: d.payout.toLowerCase(),
      hook: d.hook.toLowerCase(),
      tokenIsCurrency0: d.tokenIsCurrency0,
      openTick: d.openTick,
      openingValuation: d.openingValuation,
      liquidity: d.liquidity,
      tokensInPool: d.tokensInPool,
      firstBuyIn: d.firstBuyIn,
      firstBuyTokens: d.firstBuyTokens,
      routerFee: d.routerFee,
      creationFee: d.creationFee,
      creatorShareBps: d.creatorShareBps,
      name: d.name,
      symbol: d.symbol,
      metadataUri: d.metadataUri,
    };
  }

  if (topic0 === LAUNCH_TOPIC0.feesCollected) {
    const { args } = decodeEventLog({ abi: LAUNCHPAD_EVENTS_ABI, eventName: "FeesCollected", topics, data });
    return {
      ...base,
      kind: "launchFees",
      token: args.token.toLowerCase(),
      payout: args.payout.toLowerCase(),
      tokenFees: args.tokenFees,
      quoteFees: args.quoteFees,
      tokenToPayout: args.tokenToPayout,
      quoteToPayout: args.quoteToPayout,
    };
  }

  if (topic0 === LAUNCH_TOPIC0.payoutChanged) {
    const { args } = decodeEventLog({ abi: LAUNCHPAD_EVENTS_ABI, eventName: "PayoutChanged", topics, data });
    return {
      ...base,
      kind: "payoutChanged",
      token: args.token.toLowerCase(),
      previous: args.previous.toLowerCase(),
      payout: args.payout.toLowerCase(),
    };
  }

  return null;
}
