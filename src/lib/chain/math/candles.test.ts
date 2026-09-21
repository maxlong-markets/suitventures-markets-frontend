import { describe, it, expect } from "vitest";
import { bucketStart, candleId, INTERVALS, INTERVAL_SECONDS } from "./candles";

describe("candles", () => {
  it("has the five intervals in order", () => {
    expect(INTERVALS).toEqual(["m1", "m5", "m15", "h1", "d1"]);
    expect(INTERVAL_SECONDS.d1).toBe(86400);
  });
  it("floors timestamps to the bucket start", () => {
    expect(bucketStart(1757683327, "m1")).toBe(1757683320);
    expect(bucketStart(1757683327, "h1")).toBe(1757682000);
    expect(bucketStart(1757683327, "d1")).toBe(1757635200);
  });
  it("builds ids as pool-interval-bucket", () => {
    expect(candleId("0xabc", "m5", 1757683200)).toBe("0xabc-m5-1757683200");
  });
});
