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
  // Should fix 10 (launch UX review, amended 30 Sep 2026): SUITS and LAUNCHED HERE said the same
  // thing, and both together made this row wider than a phone screen, scrolling the whole page
  // sideways. On the old code this test's own assertion was the opposite
  // (`expect(screen.getByText("LAUNCHED HERE")).toBeTruthy()`) for this exact pair, so it fails
  // there.
  it("drops the LAUNCHED HERE chip when the origin badge already reads SUITS", () => {
    render(<TokenHeader pair={{ ...pair, origin: "SV", launch: { creator: "0xc1" } as unknown as LaunchInfo }} />);
    expect(screen.getByText("SUITS")).toBeTruthy();
    expect(screen.queryByText("SV")).toBeNull();
    expect(screen.queryByText("LAUNCHED HERE")).toBeNull();
  });
  it("keeps the LAUNCHED HERE chip beside a different origin's badge", () => {
    render(<TokenHeader pair={{ ...pair, origin: "Uniswap", launch: { creator: "0xc1" } as unknown as LaunchInfo }} />);
    expect(screen.getByText("UNISWAP")).toBeTruthy();
    expect(screen.getByText("LAUNCHED HERE")).toBeTruthy();
  });
  it("shows no chip otherwise", () => {
    render(<TokenHeader pair={{ ...pair, origin: "LONG", launch: null }} />);
    expect(screen.queryByText("LAUNCHED HERE")).toBeNull();
  });
  it("prints every other origin's badge in capitals", () => {
    render(<TokenHeader pair={{ ...pair, origin: "Pons", launch: null }} />);
    expect(screen.getByText("PONS")).toBeTruthy();
  });
  // Should fix 10: nothing clips overflow between this row and <body>, so once the row is wider
  // than the viewport nothing stops the whole page scrolling sideways; wrapping is what keeps it
  // in bounds instead. On the old code (no `flex-wrap`) this assertion fails.
  it("lets the identity row wrap instead of forcing one unbroken line", () => {
    render(<TokenHeader pair={{ ...pair, origin: "SV", launch: { creator: "0xc1" } as unknown as LaunchInfo }} />);
    const row = screen.getByText("SUITS").closest("div");
    expect(row?.className).toContain("flex-wrap");
    expect(row?.className).not.toContain("whitespace-nowrap");
  });
});
