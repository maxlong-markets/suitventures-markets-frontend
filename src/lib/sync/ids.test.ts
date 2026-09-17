import { describe, expect, it } from "vitest";
import { bucketStart, candleId, INTERVAL_SECONDS, INTERVALS, openBucketIds, parseCandleId, parseSwapId } from "./ids";

const POOL = "0x" + "ab".repeat(32);
const POOL2 = "0x" + "cd".repeat(32);
const TX = "0x" + "12".repeat(32);

describe("ids", () => {
  it("knows the indexer's intervals", () => {
    expect(INTERVALS).toEqual(["m1", "m5", "m15", "h1", "d1"]);
    expect(INTERVAL_SECONDS).toEqual({ m1: 60, m5: 300, m15: 900, h1: 3600, d1: 86400 });
  });
  it("floors timestamps to bucket starts", () => {
    expect(bucketStart(3_661, "m1")).toBe(3_660);
    expect(bucketStart(3_661, "h1")).toBe(3_600);
    expect(bucketStart(90_000, "d1")).toBe(86_400);
    expect(bucketStart(86_400, "d1")).toBe(86_400);
  });
  it("formats and parses candle ids", () => {
    const id = candleId(POOL, "m15", 900);
    expect(id).toBe(`${POOL}-m15-900`);
    expect(parseCandleId(id)).toEqual({ poolId: POOL, interval: "m15", bucket: 900 });
    for (const bad of ["", POOL, `${POOL}-h2-900`, `${POOL}-h1-`, `${POOL}-h1-9x`, `${POOL.toUpperCase()}-h1-900`, "0x12-h1-900"]) {
      expect(() => parseCandleId(bad)).toThrow(`bad candle id ${bad}`);
    }
  });
  it("parses swap ids", () => {
    expect(parseSwapId(`${TX}-7`)).toEqual({ txHash: TX, logIndex: 7 });
    for (const bad of [TX, `${TX}-`, `${TX}-1-2`, `${TX}-a`, "0x12-1"]) {
      expect(() => parseSwapId(bad)).toThrow(`bad swap id ${bad}`);
    }
  });
  it("lists the open h1 and d1 buckets once per pool, in input order", () => {
    // since and now in the same hour of the same day: one h1 and one d1 id per pool, a repeated pool once.
    expect(openBucketIds([POOL, POOL2, POOL], 90_010, 90_100)).toEqual([
      `${POOL}-h1-90000`, `${POOL}-d1-86400`, `${POOL2}-h1-90000`, `${POOL2}-d1-86400`,
    ]);
    // Different hours of one day: two h1 ids and one d1 id.
    expect(openBucketIds([POOL], 90_010, 93_700)).toEqual([`${POOL}-h1-90000`, `${POOL}-h1-93600`, `${POOL}-d1-86400`]);
    // Different days: four ids.
    expect(openBucketIds([POOL], 86_000, 90_100)).toEqual([`${POOL}-h1-82800`, `${POOL}-h1-90000`, `${POOL}-d1-0`, `${POOL}-d1-86400`]);
    expect(openBucketIds([], 0, 1)).toEqual([]);
  });
});
