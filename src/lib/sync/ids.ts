export type IndexerInterval = "m1" | "m5" | "m15" | "h1" | "d1";
export const INTERVALS: readonly IndexerInterval[] = ["m1", "m5", "m15", "h1", "d1"];
export const INTERVAL_SECONDS: Record<IndexerInterval, number> = { m1: 60, m5: 300, m15: 900, h1: 3600, d1: 86400 };

// Ids are the indexer's, lowercase: a pool id is 0x + 64 hex, a swap id `txHash-logIndex`.
const CANDLE_ID = /^(0x[0-9a-f]{64})-(m1|m5|m15|h1|d1)-(\d+)$/;
const SWAP_ID = /^(0x[0-9a-f]{64})-(\d+)$/;

export function bucketStart(ts: number, interval: IndexerInterval): number {
  const s = INTERVAL_SECONDS[interval];
  return Math.floor(ts / s) * s;
}

export function candleId(poolId: string, interval: IndexerInterval, bucket: number): string {
  return `${poolId}-${interval}-${bucket}`;
}

/** Throws Error(`bad candle id ${id}`) unless the id is 0x + 64 hex, "-", an interval, "-", digits. */
export function parseCandleId(id: string): { poolId: string; interval: IndexerInterval; bucket: number } {
  const m = CANDLE_ID.exec(id);
  if (!m) throw new Error(`bad candle id ${id}`);
  return { poolId: m[1], interval: m[2] as IndexerInterval, bucket: Number(m[3]) };
}

/** Throws Error(`bad swap id ${id}`) unless the id is 0x + 64 hex, "-", digits. */
export function parseSwapId(id: string): { txHash: string; logIndex: number } {
  const m = SWAP_ID.exec(id);
  if (!m) throw new Error(`bad swap id ${id}`);
  return { txHash: m[1], logIndex: Number(m[2]) };
}

/** The h1 and d1 candle ids for the buckets containing `since` and `now`, for every pool, deduplicated, in input order. */
export function openBucketIds(poolIds: readonly string[], since: number, now: number): string[] {
  const ids = new Set<string>();
  for (const poolId of poolIds) {
    for (const interval of ["h1", "d1"] as const) {
      ids.add(candleId(poolId, interval, bucketStart(since, interval)));
      ids.add(candleId(poolId, interval, bucketStart(now, interval)));
    }
  }
  return [...ids];
}
