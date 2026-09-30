import { describe, expect, it } from "vitest";
import { MockDataSource } from "./mock";

const HIGH_VOLUME = "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984";
const HIGH_TRADES = "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544";
const LOWEST = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";

describe("MockDataSource.pairs (amended 30 Sep 2026)", () => {
  it("answers only the launches for the Suits list, and the whole seed otherwise", async () => {
    const ds = new MockDataSource({ latencyMs: 0 });
    const all = await ds.pairs();
    const suits = await ds.pairs("sv");
    expect(suits.length).toBeGreaterThan(0);
    expect(suits.map((p) => p.id)).toEqual(all.filter((p) => p.origin === "SV").map((p) => p.id));
    expect(all.some((p) => p.origin !== "SV")).toBe(true);
  });
});

describe("MockDataSource.traders", () => {
  it("ranks the top wallet differently by volume and by trades, so the board's toggle visibly does something", async () => {
    const ds = new MockDataSource({ latencyMs: 0 });
    const byVolume = await ds.traders("volume");
    const byTrades = await ds.traders("trades");
    expect(byVolume.map((t) => t.wallet)).toEqual([HIGH_VOLUME, HIGH_TRADES, LOWEST]);
    expect(byTrades.map((t) => t.wallet)).toEqual([HIGH_TRADES, HIGH_VOLUME, LOWEST]);
  });

  it("sorts a fresh copy on every call rather than mutating the fixture in place", async () => {
    const ds = new MockDataSource({ latencyMs: 0 });
    // If `traders()` ever sorted the module-level array itself instead of a spread copy, asking
    // for "trades" here would leave the fixture in that order, and the "volume" call right after
    // would inherit it instead of computing its own — and vice versa below.
    await ds.traders("trades");
    const byVolume = await ds.traders("volume");
    expect(byVolume.map((t) => t.wallet)).toEqual([HIGH_VOLUME, HIGH_TRADES, LOWEST]);

    await ds.traders("volume");
    const byTrades = await ds.traders("trades");
    expect(byTrades.map((t) => t.wallet)).toEqual([HIGH_TRADES, HIGH_VOLUME, LOWEST]);
  });
});
