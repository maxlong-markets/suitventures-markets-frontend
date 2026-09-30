import { describe, expect, it, vi } from "vitest";
import type { TokenPair } from "@/lib/types";
import { render, screen } from "@/test/dom";
import PairsTable from "./PairsTable";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));

const pair = (over: Partial<TokenPair>): TokenPair => ({
  id: "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a", ticker: "CHALK", name: "Tailor's Chalk", address: "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a",
  quote: "USDG", origin: "SV", tradeable: true, priceUsd: 0.000005, priceQuote: 0.000005, change1h: null, change24h: null, vol24h: 0,
  mcap: 5_000, fdv: 5_000, liquidity: 0, holders: 1, createdAt: 0, bull: 0, bear: 0, poolId: "0x01", hook: "None",
  hookAddress: "0x0000000000000000000000000000000000000000", feeTier: "1.00%", ...over,
});

function show(rows: TokenPair[]) {
  render(
    <PairsTable
      rows={rows}
      loading={false}
      now={3_600_000}
      stars={new Set()}
      onToggleStar={vi.fn()}
      sortKey="vol"
      sortDir="desc"
      onSort={vi.fn()}
      empty={{ title: "No pairs match.", sub: "" }}
    />,
  );
}

describe("PairsTable origin badge (amended 30 Sep 2026)", () => {
  it("prints SUITS on a token launched here, in the badge and the phone line", () => {
    show([pair({})]);
    expect(screen.getByText("SUITS")).toBeTruthy();
    expect(screen.getByText(/Tailor's Chalk · USDG · SUITS/)).toBeTruthy();
    expect(screen.queryByText("SV")).toBeNull();
  });

  it("keeps every other origin's own name in capitals", () => {
    show([pair({ origin: "Pons", ticker: "PNS" })]);
    expect(screen.getByText("PONS")).toBeTruthy();
  });
});
