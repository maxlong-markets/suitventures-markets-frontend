import { describe, expect, it } from "vitest";
import type { TransferEvent } from "@/lib/chain/types";
import { foldTransfers, ZERO_ADDRESS } from "./fold";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";

/** The same address as `addr`, upper-cased — provably one address in two spellings, unlike a hand-typed literal. */
const upper = (addr: string) => `0x${addr.slice(2).toUpperCase()}`;

/** One Transfer. `block` is fixed and `logIndex` defaults to 0: the fold is a sum, so position never changes its answer. */
const transfer = (from: string, to: string, value: bigint, logIndex = 0): TransferEvent => ({
  block: 100,
  logIndex,
  from,
  to,
  value,
});

describe("foldTransfers", () => {
  it("credits only `to` for a mint from the zero address", () => {
    const deltas = foldTransfers([transfer(ZERO_ADDRESS, A, 1000n)]);
    expect([...deltas]).toEqual([[A, 1000n]]);
  });

  it("debits only `from` for a burn to the zero address", () => {
    const deltas = foldTransfers([transfer(A, ZERO_ADDRESS, 250n)]);
    expect([...deltas]).toEqual([[A, -250n]]);
  });

  it("debits the sender and credits the recipient of a plain transfer", () => {
    const deltas = foldTransfers([transfer(A, B, 7n)]);
    expect([...deltas]).toEqual([
      [A, -7n],
      [B, 7n],
    ]);
  });

  // Design section 4, step 4: the builder upserts the deltas and deletes the touched rows that reached zero,
  // so a wallet the slice left exactly where it found it must not be in the map at all — otherwise applySlice
  // writes a row it would delete in the same statement.
  it("leaves out a wallet whose net change over the slice is zero", () => {
    const passedThrough = foldTransfers([transfer(A, B, 5n, 0), transfer(B, C, 5n, 1)]);
    expect(passedThrough.has(B)).toBe(false);
    expect([...passedThrough]).toEqual([
      [A, -5n],
      [C, 5n],
    ]);

    const roundTrip = foldTransfers([transfer(A, B, 5n, 0), transfer(B, A, 5n, 1)]);
    expect(roundTrip.size).toBe(0);
  });

  it("ignores a zero-value transfer entirely", () => {
    expect(foldTransfers([transfer(A, B, 0n)]).size).toBe(0);
  });

  it("folds mixed-case addresses to lowercase keys, so one wallet is one entry", () => {
    const deltas = foldTransfers([transfer(ZERO_ADDRESS, A, 2n, 0), transfer(ZERO_ADDRESS, upper(A), 3n, 1)]);
    expect([...deltas]).toEqual([[A, 5n]]);

    const both = foldTransfers([transfer(upper(A), upper(B), 3n)]);
    expect([...both.keys()]).toEqual([A, B]);
  });

  // 10^30 is past 2^53, where a number would already have dropped the low digits: balances of an 18-decimal
  // token reach this size, so every sum here stays bigint.
  it("adds values as bigint well beyond 2^53", () => {
    const huge = 10n ** 30n;
    const deltas = foldTransfers([transfer(ZERO_ADDRESS, A, huge, 0), transfer(ZERO_ADDRESS, A, huge + 1n, 1)]);
    expect(deltas.get(A)).toBe(2_000_000_000_000_000_000_000_000_000_001n);
  });

  it("folds an empty slice to an empty map", () => {
    expect(foldTransfers([]).size).toBe(0);
  });
});
