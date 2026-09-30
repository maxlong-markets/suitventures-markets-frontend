import { describe, expect, it } from "vitest";
import type { Address, TokenPair } from "@/lib/types";
import { fmtInt, fmtISODate, fmtPct, fmtPrice, fmtUsd } from "@/lib/format";
import { render, screen } from "@/test/dom";
import TokenFacts from "./TokenFacts";

const ADDRESS = "0x1234567890123456789012345678901234567890" as Address;

const BASE_PAIR: TokenPair = {
  id: ADDRESS,
  ticker: "AI",
  name: "Artificial Inu",
  address: ADDRESS,
  quote: "NVDA",
  origin: "LONG",
  tradeable: true,
  priceUsd: 0.01234,
  priceQuote: 0.0000551,
  change1h: 1.23,
  change24h: -4.56,
  vol24h: 1_234_567,
  mcap: 9_876_543,
  fdv: 12_345_678,
  liquidity: 456_789,
  holders: 1_234,
  createdAt: Date.now() - 3 * 24 * 3_600_000,
  bull: 10,
  bear: 3,
  poolId: "0x000000000000000000000000000000000000000c" as Address,
  hook: "",
  hookAddress: "0x0000000000000000000000000000000000000000" as Address,
  feeTier: "0.30%",
};

describe("TokenFacts", () => {
  it("renders every fact with its value", () => {
    render(<TokenFacts pair={BASE_PAIR} address={ADDRESS} />);
    // The ticker and the name each appear twice by design — once in the heading, once in
    // their own fact row.
    expect(screen.getAllByText("AI").length).toBe(2);
    expect(screen.getAllByText("Artificial Inu").length).toBe(2);
    expect(screen.getByText(ADDRESS)).toBeTruthy();
    expect(screen.getByText("NVDA")).toBeTruthy();
    expect(screen.getByText("LONG")).toBeTruthy();
    expect(screen.getByText(fmtPrice(BASE_PAIR.priceUsd))).toBeTruthy();
    expect(screen.getByText(fmtPct(BASE_PAIR.change1h!))).toBeTruthy();
    expect(screen.getByText(fmtPct(BASE_PAIR.change24h!))).toBeTruthy();
    expect(screen.getByText(fmtUsd(BASE_PAIR.vol24h))).toBeTruthy();
    expect(screen.getByText(fmtUsd(BASE_PAIR.mcap))).toBeTruthy();
    expect(screen.getByText(fmtUsd(BASE_PAIR.fdv))).toBeTruthy();
    expect(screen.getByText(fmtUsd(BASE_PAIR.liquidity!))).toBeTruthy();
    expect(screen.getByText(fmtInt(BASE_PAIR.holders))).toBeTruthy();
    expect(screen.getByText(BASE_PAIR.feeTier)).toBeTruthy();
    // Age's value string also carries the ISO date, which is deterministic from `createdAt`
    // alone — the relative half ("3d") depends on the component's own `Date.now()` call, a few
    // ms after this test's, so only the date fragment is asserted to keep the test un-flaky.
    expect(screen.getByText(new RegExp(fmtISODate(BASE_PAIR.createdAt)))).toBeTruthy();
  });

  it("renders a dash rather than null or NaN for nullable fields", () => {
    const pair: TokenPair = { ...BASE_PAIR, change1h: null, change24h: null, liquidity: null };
    const { container } = render(<TokenFacts pair={pair} address={ADDRESS} />);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
    expect(container.textContent).not.toMatch(/null|NaN/i);
  });

  it("emits JSON-LD that parses and carries the ticker and address", () => {
    const { container } = render(<TokenFacts pair={BASE_PAIR} address={ADDRESS} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const ld = JSON.parse(script!.textContent!) as Record<string, unknown>;
    expect(ld["@type"]).toBe("Product");
    expect(ld.identifier).toBe(BASE_PAIR.address);
    expect(ld.url).toBe(`https://www.maxlong.markets/t/${BASE_PAIR.id}`);
    // No paywall markup: nothing indexable is withheld. A visitor without a Suit gets
    // GatedSection's lock card in place of the chart, not the real thing hidden by CSS, so there
    // is nothing to declare — and isAccessibleForFree is a CreativeWork property, not Product's.
    expect(ld.isAccessibleForFree).toBeUndefined();
    expect(ld.hasPart).toBeUndefined();
    expect((ld.additionalProperty as { value: string }).value).toBe(BASE_PAIR.ticker);
  });

  it("renders dashes, not zeros, for USD fields on a stale pair", () => {
    const pair: TokenPair = { ...BASE_PAIR, stale: true, priceUsd: 0, vol24h: 0, mcap: 0, fdv: 0 };
    render(<TokenFacts pair={pair} address={ADDRESS} />);
    // Four stale-gated USD facts (price, 24h volume, market cap, FDV); liquidity is a separate
    // nullable field and stays a real number here, so it must not be among the dashes.
    expect(screen.getAllByText("—")).toHaveLength(4);
    expect(screen.queryByText(fmtUsd(0))).toBeNull();
    expect(screen.queryByText(fmtPrice(0))).toBeNull();
    expect(screen.getByText(fmtUsd(pair.liquidity!))).toBeTruthy();
  });

  it("names the origin with the table's word: SUITS for a token launched here (amended 30 Sep 2026)", () => {
    render(<TokenFacts pair={{ ...BASE_PAIR, origin: "SV" }} address={ADDRESS} />);
    expect(screen.getByText("SUITS")).toBeTruthy();
    expect(screen.queryByText("SV")).toBeNull();
  });

  it("renders its own unknown-token state when pair is null, rather than a 404 page", () => {
    render(<TokenFacts pair={null} address={ADDRESS} />);
    expect(screen.getByText(/No token at/)).toBeTruthy();
  });
});
