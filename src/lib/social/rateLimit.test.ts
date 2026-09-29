import { beforeEach, describe, expect, it } from "vitest";
import {
  CLIENT_LIMIT,
  MAX_KEYS,
  UPLOAD_CLIENT_LIMIT,
  WINDOW_SEC,
  WRITE_LIMIT,
  allowClient,
  allowUploadClient,
  allowWrite,
  clientLimitSize,
  pruneRateLimit,
  rateLimitSize,
  resetRateLimit,
} from "./rateLimit";

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

describe("allowClient", () => {
  it("allows twenty requests a minute per IP and refuses the twenty-first", () => {
    expect(CLIENT_LIMIT).toBe(20);
    for (let i = 0; i < CLIENT_LIMIT; i++) expect(allowClient(W1, NOW)).toBe(true);
    expect(allowClient(W1, NOW)).toBe(false);
  });

  it("tracks each client IP on its own budget, entirely separate from allowWrite's wallet map", () => {
    const ip = "203.0.113.5"; // IP-shaped, so a shared map would show up as a wallet-map hit too
    expect(allowClient(ip, NOW)).toBe(true);
    expect(rateLimitSize()).toBe(0); // the wallet map gained nothing
    expect(clientLimitSize()).toBe(1);
  });

  it("slides: the window rolling past the earlier hits frees the budget again", () => {
    for (let i = 0; i < CLIENT_LIMIT; i++) allowClient(W1, NOW);
    expect(allowClient(W1, NOW + WINDOW_SEC - 1)).toBe(false);
    expect(allowClient(W1, NOW + WINDOW_SEC)).toBe(true);
  });

  it("resetRateLimit clears the client budget too", () => {
    for (let i = 0; i < CLIENT_LIMIT; i++) allowClient(W1, NOW);
    expect(allowClient(W1, NOW)).toBe(false);
    resetRateLimit();
    expect(allowClient(W1, NOW)).toBe(true);
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

  it("sweeps at most once per window: a due-for-removal key survives a second sweep called too soon", () => {
    allowWrite(W1, NOW);
    allowWrite(W2, NOW + 30);
    pruneRateLimit(NOW + 61); // sweep #1: W1 (age 61) is gone, W2 (age 31) survives
    expect(rateLimitSize()).toBe(1);
    pruneRateLimit(NOW + 95); // only 34 s after sweep #1: throttled, must be a no-op
    expect(rateLimitSize()).toBe(1); // an unthrottled sweep here would drop W2 too (its age is now 65)
  });
});

describe("the ten-thousand-key cap", () => {
  const key = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;

  it("evicts the oldest key — not the newest — to make room for the (MAX_KEYS + 1)th", () => {
    for (let i = 0; i < MAX_KEYS + 1; i++) allowWrite(key(i), NOW);
    expect(rateLimitSize()).toBe(MAX_KEYS);
    // The first key was evicted: a fresh call for it gets a brand-new, full budget.
    let succeeded = 0;
    while (succeeded < WRITE_LIMIT && allowWrite(key(0), NOW)) succeeded++;
    expect(succeeded).toBe(WRITE_LIMIT);
    // The newest key kept its one hit from the flood: only WRITE_LIMIT - 1 more fit before it refuses.
    succeeded = 0;
    while (succeeded < WRITE_LIMIT && allowWrite(key(MAX_KEYS), NOW)) succeeded++;
    expect(succeeded).toBe(WRITE_LIMIT - 1);
  });

  it("moves a refreshed key to the newest position, so it survives the next eviction in its place", () => {
    for (let i = 0; i < MAX_KEYS; i++) allowWrite(key(i), NOW); // exactly at the cap; nothing evicted yet
    expect(rateLimitSize()).toBe(MAX_KEYS);
    allowWrite(key(0), NOW); // refresh the oldest key: this must move it to the newest position
    allowWrite(key(MAX_KEYS), NOW); // one more key: at cap again, so this evicts the *new* oldest
    expect(rateLimitSize()).toBe(MAX_KEYS);
    // key(0) survived with its two hits (the original flood hit, plus the refresh above).
    let succeeded = 0;
    while (succeeded < WRITE_LIMIT && allowWrite(key(0), NOW)) succeeded++;
    expect(succeeded).toBe(WRITE_LIMIT - 2);
    // key(1) is what got evicted instead: a fresh, full budget.
    succeeded = 0;
    while (succeeded < WRITE_LIMIT && allowWrite(key(1), NOW)) succeeded++;
    expect(succeeded).toBe(WRITE_LIMIT);
  });
});

describe("allowUploadClient (instant launchpad design, section 6 step 2)", () => {
  it("allows ten uploads a minute per client IP, in a key space of its own that never spends the sign-in budget", () => {
    expect(UPLOAD_CLIENT_LIMIT).toBe(10);
    for (let i = 0; i < UPLOAD_CLIENT_LIMIT; i += 1) expect(allowUploadClient("203.0.113.9", NOW)).toBe(true);
    expect(allowUploadClient("203.0.113.9", NOW)).toBe(false);
    expect(allowUploadClient("203.0.113.10", NOW)).toBe(true);
    expect(allowClient("203.0.113.9", NOW)).toBe(true);
    expect(clientLimitSize()).toBe(1); // only the sign-in call above landed in the sign-in map
    expect(allowUploadClient("203.0.113.9", NOW + WINDOW_SEC + 1)).toBe(true);
  });
});
