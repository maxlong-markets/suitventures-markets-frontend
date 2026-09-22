import { describe, expect, it } from "vitest";
import { holderDelta } from "./holders";

describe("holderDelta", () => {
  it("is +1 when a wallet goes from zero to non-zero (a new holder)", () => {
    expect(holderDelta(0n, 1n)).toBe(1);
    expect(holderDelta(0n, 1_000_000_000_000_000_000n)).toBe(1);
  });

  it("is -1 when a wallet goes from non-zero to zero (no longer a holder)", () => {
    expect(holderDelta(500n, 0n)).toBe(-1);
    expect(holderDelta(1n, 0n)).toBe(-1);
  });

  it("is 0 when a wallet stays a holder (a partial sell or a top-up)", () => {
    expect(holderDelta(500n, 100n)).toBe(0); // partial sell
    expect(holderDelta(500n, 900n)).toBe(0); // top-up buy
    expect(holderDelta(500n, 500n)).toBe(0); // unchanged
  });

  it("is 0 when a wallet stays a non-holder (zero to zero)", () => {
    expect(holderDelta(0n, 0n)).toBe(0);
  });

  it("never guesses: it is never called for a balance that could not be read — that is the caller's 'unknown' bucket, not this function's concern", () => {
    // Documentation-as-test: holderDelta is total over any two bigints and has no notion of
    // "unknown" at all — see run.ts's computeHolderDeltas, which counts an absent readBalances
    // entry as unknown and never calls this function for it. This test just pins that the
    // function itself never throws for the extreme ends of its domain, matching "pure and total."
    expect(holderDelta(0n, 0n)).toBe(0);
    expect(() => holderDelta(2n ** 200n, 0n)).not.toThrow();
  });

  it("treats a negative 'after' the same as zero (defensive: a real ERC-20 balance can never go negative, but the rule must not misbehave if one ever does)", () => {
    expect(holderDelta(0n, -5n)).toBe(0); // not a holder before, "negative" is still not a holder
    expect(holderDelta(500n, -5n)).toBe(-1); // was a holder, no longer
  });
});
