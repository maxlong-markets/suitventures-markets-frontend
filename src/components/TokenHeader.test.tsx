import { describe, expect, it, vi } from "vitest";
import type { LaunchInfo, TokenPair } from "@/lib/types";
import { render, screen } from "@/test/dom";
import TokenHeader from "./TokenHeader";

vi.mock("@/context/AppState", () => ({
  useAppState: () => ({ stars: new Set(), toggleStar: vi.fn(), votes: {}, vote: vi.fn(), votePending: new Set() }),
}));

const pair = {
  id: "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a", ticker: "CHALK", name: "Tailor's Chalk", address: "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a",
  quote: "USDG", origin: "SV", tradeable: true, priceUsd: 0.000005, priceQuote: 0.000005, change1h: null, change24h: null, vol24h: 0, mcap: 0,
  fdv: 0, liquidity: 0, holders: 1, createdAt: 0, bull: 0, bear: 0, poolId: "0x01", hook: "None", hookAddress: "0x0000000000000000000000000000000000000000",
  feeTier: "1.00%",
} as TokenPair;

describe("TokenHeader (spec 7.3)", () => {
  it("adds a LAUNCHED HERE chip beside the SV badge for a token launched here", () => {
    render(<TokenHeader pair={{ ...pair, launch: { creator: "0xc1" } as unknown as LaunchInfo }} />);
    expect(screen.getByText("SV")).toBeTruthy();
    expect(screen.getByText("LAUNCHED HERE")).toBeTruthy();
  });
  it("shows no chip otherwise", () => {
    render(<TokenHeader pair={{ ...pair, origin: "LONG", launch: null }} />);
    expect(screen.queryByText("LAUNCHED HERE")).toBeNull();
  });
});
