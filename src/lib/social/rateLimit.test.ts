import { beforeEach, describe, expect, it } from "vitest";
import { WINDOW_SEC, WRITE_LIMIT, allowWrite, pruneRateLimit, rateLimitSize, resetRateLimit } from "./rateLimit";

const NOW = 1_789_000_000;
const W1 = `0x${"a".repeat(40)}`;
const W2 = `0x${"b".repeat(40)}`;

beforeEach(() => resetRateLimit());

describe("allowWrite", () => {
  it("allows sixty writes a minute and refuses the sixty-first", () => {
    expect(WRITE_LIMIT).toBe(60);
    expect(WINDOW_SEC).toBe(60);
    for (let i = 0; i < WRITE_LIMIT; i++) expect(allowWrite(W1, NOW)).toBe(true);
    expect(allowWrite(W1, NOW)).toBe(false);
    expect(allowWrite(W1, NOW)).toBe(false); // a refusal does not consume budget of its own
  });

  it("stays refused until the window has actually rolled past those writes", () => {
    for (let i = 0; i < WRITE_LIMIT; i++) allowWrite(W1, NOW);
    expect(allowWrite(W1, NOW + WINDOW_SEC - 1)).toBe(false);
    expect(allowWrite(W1, NOW + WINDOW_SEC)).toBe(true);
  });

  it("rolls rather than resetting: an old write leaving the window frees exactly one slot", () => {
    allowWrite(W1, NOW);
    for (let i = 1; i < WRITE_LIMIT; i++) allowWrite(W1, NOW + 30);
    expect(allowWrite(W1, NOW + 30)).toBe(false);
    expect(allowWrite(W1, NOW + 60)).toBe(true); // only the first write has aged out
    expect(allowWrite(W1, NOW + 60)).toBe(false);
  });

  it("counts every wallet on its own", () => {
    for (let i = 0; i < WRITE_LIMIT; i++) allowWrite(W1, NOW);
    expect(allowWrite(W1, NOW)).toBe(false);
    expect(allowWrite(W2, NOW)).toBe(true);
  });
});

describe("pruning", () => {
  it("forgets a wallet whose window has emptied and keeps one that is still inside it", () => {
    allowWrite(W1, NOW);
    allowWrite(W2, NOW + 40);
    expect(rateLimitSize()).toBe(2);
    pruneRateLimit(NOW + 61);
    expect(rateLimitSize()).toBe(1);
    pruneRateLimit(NOW + 200);
    expect(rateLimitSize()).toBe(0);
  });

  it("sweeps itself once it is tracking more wallets than it should", () => {
    for (let i = 0; i <= 5_000; i++) allowWrite(`0x${i.toString(16).padStart(40, "0")}`, NOW);
    expect(rateLimitSize()).toBe(5_001);
    expect(allowWrite(W1, NOW + WINDOW_SEC + 1)).toBe(true);
    expect(rateLimitSize()).toBe(1); // every wallet from the first minute is gone
  });
});
