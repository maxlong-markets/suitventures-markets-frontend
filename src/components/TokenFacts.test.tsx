import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex, LaunchInfo, TokenPair } from "@/lib/types";
import type { SuitsAccess } from "@/lib/suits";
import { fmtInt, fmtISODate, fmtPct, fmtPrice, fmtUsd } from "@/lib/format";
import { fireEvent, render, screen } from "@/test/dom";
import TokenFacts from "./TokenFacts";

const ADDRESS = "0x1234567890123456789012345678901234567890" as Address;
const TX = `0x${"11".repeat(32)}` as Hex;

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

// TokenFactsDetails (the native <details> wrapper around the rows) reads the gate the same way
// GatedSection and TokenGate do: `useAppState()` for the wallet, `useSuitsAccess` for the read.
// Defaults here (gate on, status "idle") make `open` true, so every test below that only cares
// about the facts themselves, not the disclosure, finds its text regardless of open/closed.
const h = vi.hoisted(() => ({
  address: undefined as string | undefined,
  access: { status: "idle" } as SuitsAccess,
  gateEnabled: vi.fn(() => true),
}));

vi.mock("@/context/AppState", () => ({ useAppState: () => ({ address: h.address }) }));
vi.mock("@/lib/suits", () => ({
  useSuitsAccess: () => h.access,
  gateEnabled: h.gateEnabled,
}));

beforeEach(() => {
  h.address = undefined;
  h.access = { status: "idle" };
  h.gateEnabled.mockReset().mockReturnValue(true);
});

describe("TokenFacts", () => {
  it("renders every fact with its value", () => {
    render(<TokenFacts pair={BASE_PAIR} address={ADDRESS} />);
    // The ticker and the name each appear more than once by design: the heading, the summary
    // line, and their own fact row.
    expect(screen.getAllByText("AI").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Artificial Inu").length).toBeGreaterThanOrEqual(2);
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

  it("renders its own unknown-token state when pair is null, rather than a 404 page, as the page's one h1", () => {
    const { container } = render(<TokenFacts pair={null} address={ADDRESS} />);
    expect(screen.getByText(/No token at/)).toBeTruthy();
    // Fix round 1 finding 8: the page always has exactly one <h1>, even with no pair.
    expect(container.querySelectorAll("h1").length).toBe(1);
    expect(container.querySelector("h1")?.textContent).toContain("No token at");
  });

  it("keeps exactly one h1 on the page, in the server HTML", () => {
    const { container } = render(<TokenFacts pair={BASE_PAIR} address={ADDRESS} />);
    expect(container.querySelectorAll("h1").length).toBe(1);
    expect(container.querySelector("h1")?.textContent).toContain("AI");
  });
});

describe("TokenFacts: staying silent for a fresh launch (amended 30 Sep 2026, corrected fix round 1 finding 8, re-review finding 1)", () => {
  it("shows nothing visible while a fresh launch is not indexed yet, but keeps one hidden h1 in a section that closes the lock card below it", () => {
    const { container } = render(<TokenFacts pair={null} address={ADDRESS} launchedTx={TX} />);
    expect(screen.queryByText(/No token at/)).toBeNull();
    // The page still needs exactly one <h1>; TokenView (above, not rendered here) has none of its
    // own while it waits, so this one is server-rendered but visually hidden, on old code this
    // whole render was `null`, so this h1 did not exist at all.
    const h1 = container.querySelector("h1");
    expect(h1).not.toBeNull();
    expect(h1?.textContent).toBe("Indexing your token");
    expect(h1?.className).toContain("sr-only");
    expect(container.querySelectorAll("h1").length).toBe(1);
    // Re-review finding 1: the hidden heading needs its own bordered section, or nothing closes
    // GatedSection's lock card from below for a visitor the gate does not admit while the wait is
    // in progress. So the only content is the section and the h1 inside it: two elements, not one.
    expect(container.querySelectorAll("*").length).toBe(2);
    expect(container.querySelector("section")?.className).toContain("border-t");
  });

  it("keeps the unknown-token message when there is no launch in play", () => {
    render(<TokenFacts pair={null} address={ADDRESS} />);
    expect(screen.getByText("No token at 0x1234…7890.")).toBeTruthy();
  });
});

describe("TokenFacts: 1h/24h change colour (amended 30 Sep 2026)", () => {
  it("colours a positive change up and a negative change down", () => {
    const pair = { ...BASE_PAIR, change1h: 2.5, change24h: -3.1 };
    render(<TokenFacts pair={pair} address={ADDRESS} />);
    expect(screen.getByText(fmtPct(2.5)).className).toContain("text-up");
    expect(screen.getByText(fmtPct(-3.1)).className).toContain("text-down");
  });

  it("colours a zero change neutral, not up or down", () => {
    const pair = { ...BASE_PAIR, change1h: 0, change24h: 5.25 };
    render(<TokenFacts pair={pair} address={ADDRESS} />);
    const zero = screen.getByText("0.00%");
    expect(zero.className).not.toContain("text-up");
    expect(zero.className).not.toContain("text-down");
    expect(zero.className).toContain("text-ink-50");
  });

  // Fix round 1 finding 11: asserts the actual neutral class, not just the absence of up/down,
  // which also passed on the old code (no tone class of any kind on this element at all).
  it("colours a dash neutral for a missing change", () => {
    const pair = { ...BASE_PAIR, change1h: null, change24h: 5.25 };
    render(<TokenFacts pair={pair} address={ADDRESS} />);
    const dash = screen.getByText("—");
    expect(dash.className).toContain("text-ink-50");
  });
});

// Amended 30 Sep 2026, corrected fix round 1 findings 2 and 10, then corrected again the same
// day: a second review pointed out the pool is open (the hook is zero), so other liquidity can
// sit alongside the launch's own, and the launch's locked liquidity earns only its share of the
// pool's fee, not the fee in full. The sentence for a launch on its own pool now says the pool
// takes the tier on every trade, that the launch's locked liquidity earns that fee, and only then
// splits what it earns between the creator's payout address and MaxLong.
describe("TokenFacts: the pool fee tier sentence", () => {
  it("explains a launched-here pool as a split, computed from creatorShareBps", () => {
    const pair: TokenPair = {
      ...BASE_PAIR,
      origin: "SV",
      feeTier: "1.00%",
      launch: { creatorShareBps: 7000 } as unknown as LaunchInfo,
    };
    render(<TokenFacts pair={pair} address={ADDRESS} />);
    expect(
      screen.getByText(
        "1.00% of every trade. The launch's locked liquidity earns this fee, and 70% of what it earns goes to the creator's payout address and 30% to MaxLong.",
      ),
    ).toBeTruthy();
  });

  it("computes the split for a creator share other than 70%", () => {
    const pair: TokenPair = {
      ...BASE_PAIR,
      origin: "SV",
      feeTier: "0.50%",
      launch: { creatorShareBps: 6543 } as unknown as LaunchInfo,
    };
    render(<TokenFacts pair={pair} address={ADDRESS} />);
    expect(
      screen.getByText(
        "0.50% of every trade. The launch's locked liquidity earns this fee, and 65.43% of what it earns goes to the creator's payout address and 34.57% to MaxLong.",
      ),
    ).toBeTruthy();
  });

  it("reads as a plain sentence when the creator's share is 0%", () => {
    const pair: TokenPair = {
      ...BASE_PAIR,
      origin: "SV",
      feeTier: "1.00%",
      launch: { creatorShareBps: 0 } as unknown as LaunchInfo,
    };
    render(<TokenFacts pair={pair} address={ADDRESS} />);
    expect(
      screen.getByText(
        "1.00% of every trade. The launch's locked liquidity earns this fee, and all of what it earns goes to MaxLong.",
      ),
    ).toBeTruthy();
  });

  it("reads as a plain sentence when the creator's share is 100%", () => {
    const pair: TokenPair = {
      ...BASE_PAIR,
      origin: "SV",
      feeTier: "1.00%",
      launch: { creatorShareBps: 10_000 } as unknown as LaunchInfo,
    };
    render(<TokenFacts pair={pair} address={ADDRESS} />);
    expect(
      screen.getByText(
        "1.00% of every trade. The launch's locked liquidity earns this fee, and all of what it earns goes to the creator's payout address.",
      ),
    ).toBeTruthy();
  });

  // Fix round 1 finding 2: a token launched here can later be listed through a different, traded
  // pool of another origin while still carrying its old `launch` block (dbBackend.pair's
  // `coalesce(listed_pool_id, launch pool_id)`). That pool's own fee does not go where the
  // launch's did, so the split must not print for it. On the old code (`if (pair.launch)` alone)
  // both of these would have printed the launch's 70/30 split instead.
  it("does not claim the launch's split for a launched token now listed through another origin's fixed-fee pool", () => {
    const pair: TokenPair = {
      ...BASE_PAIR,
      origin: "Uniswap",
      feeTier: "0.30%",
      launch: { creatorShareBps: 7000 } as unknown as LaunchInfo,
    };
    render(<TokenFacts pair={pair} address={ADDRESS} />);
    expect(screen.getByText("The pool charges 0.30% on every trade.")).toBeTruthy();
    expect(screen.queryByText(/creator's payout address/)).toBeNull();
    expect(screen.queryByText(/MaxLong/)).toBeNull();
  });

  it("does not claim the launch's split for a launched token now listed through another origin's dynamic-fee pool", () => {
    const pair: TokenPair = {
      ...BASE_PAIR,
      origin: "Uniswap",
      feeTier: "Dynamic",
      launch: { creatorShareBps: 7000 } as unknown as LaunchInfo,
    };
    render(<TokenFacts pair={pair} address={ADDRESS} />);
    expect(
      screen.getByText("The pool's hook sets the fee on each trade, so it can differ from one trade to the next."),
    ).toBeTruthy();
    expect(screen.queryByText(/creator's payout address/)).toBeNull();
    expect(screen.queryByText(/MaxLong/)).toBeNull();
  });

  it("explains a dynamic fee without naming a percentage", () => {
    const pair: TokenPair = { ...BASE_PAIR, feeTier: "Dynamic", launch: undefined };
    render(<TokenFacts pair={pair} address={ADDRESS} />);
    expect(
      screen.getByText("The pool's hook sets the fee on each trade, so it can differ from one trade to the next."),
    ).toBeTruthy();
  });

  it("explains a plain fixed tier without saying who receives it", () => {
    const pair: TokenPair = { ...BASE_PAIR, feeTier: "0.30%", launch: undefined };
    render(<TokenFacts pair={pair} address={ADDRESS} />);
    expect(screen.getByText("The pool charges 0.30% on every trade.")).toBeTruthy();
  });
});

describe("TokenFacts: the details disclosure (amended 30 Sep 2026, corrected fix round 1 finding 4)", () => {
  it("is open when disconnected (idle) with the gate on", () => {
    h.gateEnabled.mockReturnValue(true);
    h.access = { status: "idle" };
    const { container } = render(<TokenFacts pair={BASE_PAIR} address={ADDRESS} />);
    expect(container.querySelector("details")?.open).toBe(true);
  });

  // Fix round 1 finding 4: on the old formula (`access.status !== "granted"`) this was open,
  // which is exactly the flash a holder saw on every hard load and every account switch.
  it("is closed while the Suits check is still running", () => {
    h.gateEnabled.mockReturnValue(true);
    h.access = { status: "checking" };
    const { container } = render(<TokenFacts pair={BASE_PAIR} address={ADDRESS} />);
    expect(container.querySelector("details")?.open).toBe(false);
  });

  it("is open once a connected wallet is turned away", () => {
    h.gateEnabled.mockReturnValue(true);
    h.access = { status: "denied", count: 0n };
    const { container } = render(<TokenFacts pair={BASE_PAIR} address={ADDRESS} />);
    expect(container.querySelector("details")?.open).toBe(true);
  });

  it("is open when the check failed", () => {
    h.gateEnabled.mockReturnValue(true);
    h.access = { status: "error", retry: () => {} };
    const { container } = render(<TokenFacts pair={BASE_PAIR} address={ADDRESS} />);
    expect(container.querySelector("details")?.open).toBe(true);
  });

  it("is closed when the gate is off, even while access is denied", () => {
    h.gateEnabled.mockReturnValue(false);
    h.access = { status: "denied", count: 0n };
    const { container } = render(<TokenFacts pair={BASE_PAIR} address={ADDRESS} />);
    expect(container.querySelector("details")?.open).toBe(false);
  });

  it("is closed once access is granted", () => {
    h.gateEnabled.mockReturnValue(true);
    h.access = { status: "granted", count: 1n };
    const { container } = render(<TokenFacts pair={BASE_PAIR} address={ADDRESS} />);
    expect(container.querySelector("details")?.open).toBe(false);
  });

  it("carries the ticker and name and reads Token details in the summary", () => {
    render(<TokenFacts pair={BASE_PAIR} address={ADDRESS} />);
    expect(screen.getByText("Token details")).toBeTruthy();
    const summary = screen.getByText("Token details").closest("summary");
    expect(summary?.textContent).toContain("AI");
    expect(summary?.textContent).toContain("Artificial Inu");
  });

  // Fix round 1 finding 7: the summary had about 2.2:1 contrast (opacity-70 compounded with
  // ink-40), a row under 24px tall, and nothing stopping "Token details" from breaking across two
  // lines once a long name squeezed it. On the old code the opacity/transition classes below were
  // present and `min-h-[40px]` was absent, so these fail there.
  it("has no opacity dimming, a summary at least 40px tall, and Token details that cannot wrap", () => {
    render(<TokenFacts pair={BASE_PAIR} address={ADDRESS} />);
    const summary = screen.getByText("Token details").closest("summary")!;
    expect(summary.className).not.toContain("opacity-70");
    expect(summary.className).not.toContain("hover:opacity-100");
    expect(summary.className).not.toContain("transition-opacity");
    expect(summary.className).toContain("min-h-[40px]");
    const label = screen.getByText("Token details");
    expect(label.className).toContain("flex-none");
    const name = screen.getByText("Artificial Inu", { selector: "summary span" });
    expect(name.className).toContain("min-w-0");
    expect(name.className).toContain("truncate");
  });

  // Re-review finding 3: ink-50 (about 4.2:1) was still just under AA's 4.5:1 for 10px text; the
  // label moved to ink-55 (about 4.8:1). On the round-1 code this fails, since the class there is
  // ink-50.
  it("gives the Token details label AA-passing contrast", () => {
    render(<TokenFacts pair={BASE_PAIR} address={ADDRESS} />);
    expect(screen.getByText("Token details").className).toContain("text-ink-55");
  });

  // Re-review finding 4: a ticker from an origin other than the launchpad has no length cap, and
  // with `flex-none` on both the label and the ticker, nothing but a long ticker itself gave way,
  // pushing the row past a phone's width. On the round-1 code (`flex-none` on the ticker) this
  // fails, since a `flex-none` element never gets `min-w-0` or `truncate`.
  it("lets a long ticker truncate rather than pushing the summary past the page edge", () => {
    render(<TokenFacts pair={BASE_PAIR} address={ADDRESS} />);
    const ticker = screen.getByText("AI", { selector: "summary span" });
    expect(ticker.className).toContain("min-w-0");
    expect(ticker.className).toContain("truncate");
    expect(ticker.className).not.toContain("flex-none");
  });

  it("keeps a manual toggle across a re-render that leaves access unchanged", () => {
    h.gateEnabled.mockReturnValue(true);
    h.access = { status: "denied", count: 0n };
    const { container, rerender } = render(<TokenFacts pair={BASE_PAIR} address={ADDRESS} />);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(true);

    // The viewer closes it by hand.
    fireEvent.click(container.querySelector("summary")!);
    expect(details.open).toBe(false);

    // A later render with the very same access status (nothing granted, nothing changed) must
    // not snap it back open.
    rerender(<TokenFacts pair={{ ...BASE_PAIR }} address={ADDRESS} />);
    expect(details.open).toBe(false);
  });
});
