import type { CandleInterval } from "../types";

export const INTERVALS: CandleInterval[] = ["m1", "m5", "m15", "h1", "d1"];

export const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  m1: 60,
  m5: 300,
  m15: 900,
  h1: 3600,
  d1: 86400,
};

export function bucketStart(timestamp: number, interval: CandleInterval): number {
  const s = INTERVAL_SECONDS[interval];
  return Math.floor(timestamp / s) * s;
}

export function candleId(poolId: string, interval: CandleInterval, bucket: number): string {
  return `${poolId}-${interval}-${bucket}`;
}
