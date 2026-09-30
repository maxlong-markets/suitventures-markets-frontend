import { describe, expect, it } from "vitest";
import type { TokenPair } from "@/lib/types";
import { render, screen, within } from "@/test/dom";
import TokenDetailsCard from "./TokenDetailsCard";

const NOW = 1_800_000_000_000;
const PAIR = {
  id: "0xa", ticker: "AI", name: "Artificial Inu", address: "0x1234567890123456789012345678901234567890", quote: "NVDA", origin: "LONG",
  tradeable: true, priceUsd: 0.01234, priceQuote: 0.0000551, change1h: 1.23, change24h: -4.56, vol24h: 1_234_567, mcap: 9_876_543,
  fdv: 12_345_678, liquidity: 456_789, holders: 1_234, createdAt: NOW - 3 * 24 * 3_600_000, bull: 0, bear: 0, poolId: "0x1", hook: "",
  hookAddress: "0x0", feeTier: "0.30%",
} as unknown as TokenPair;

describe("TokenDetailsCard (30 Sep 2026)", () => {
  it("shows the six key figures at once, in a card titled Token details", () => {
    render(<TokenDetailsCard pair={PAIR} now={NOW} />);
    const card = within(screen.getByRole("region", { name: "Token details" }));
    for (const label of ["1h change", "24h change", "24h volume", "FDV", "Liquidity", "Holders"]) {
      expect(card.getByText(label).closest("details")).toBeNull();
    }
    expect(card.getByText("1,234")).toBeTruthy();
  });

  it("keeps everything else behind All details, closed until asked for", () => {
    const { container } = render(<TokenDetailsCard pair={PAIR} now={NOW} />);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toContain("All details");
    for (const label of ["Ticker", "Name", "Token address", "Quote asset", "Origin", "Price (USD)", "Market cap", "Age", "Pool fee tier"]) {
      expect(screen.getByText(label).closest("details")).toBe(details);
    }
    expect(screen.getByText("The pool charges 0.30% on every trade.")).toBeTruthy();
  });

  it("colours a gain up and a loss down", () => {
    render(<TokenDetailsCard pair={PAIR} now={NOW} />);
    expect(screen.getByText("1h change").nextElementSibling?.className).toContain("text-up");
    expect(screen.getByText("24h change").nextElementSibling?.className).toContain("text-down");
  });
});
