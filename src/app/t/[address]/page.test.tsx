import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex, TokenPair } from "@/lib/types";
import { clearTtlCache } from "@/lib/envio/cache";
import { render, screen } from "@/test/dom";
import TokenPage, { generateMetadata } from "./page";

const ADDRESS = `0x${"22".repeat(20)}`;
const TX = `0x${"33".repeat(32)}` as Hex;

const h = vi.hoisted(() => ({
  pair: vi.fn<(id: string) => Promise<TokenPair | null>>(),
}));

vi.mock("@/lib/market/backend", () => ({ getBackend: () => ({ pair: h.pair }) }));
// GatedSection and TokenView each have their own test file; here they are opaque markers, so
// this suite exercises only what page.tsx itself decides: the order its two sections come in,
// and what `launchedTx` it hands to TokenFacts.
vi.mock("@/components/GatedSection", () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="app-slot">{children}</div>,
}));
vi.mock("@/components/TokenView", () => ({
  default: () => <div data-testid="token-view">TokenView</div>,
}));
// TokenFacts (real, unmocked, since it is the component under test here) renders
// TokenFactsDetails for a found pair, which reads these two the same way GatedSection does; see
// TokenFacts.test.tsx and GatedSection.test.tsx for the same pattern.
vi.mock("@/context/AppState", () => ({ useAppState: () => ({ address: undefined }) }));
vi.mock("@/lib/suits", () => ({ useSuitsAccess: () => ({ status: "idle" }), gateEnabled: () => true }));

/** `TokenPage` is an async Server Component: call and await it like any async function, then
 *  hand the resolved element (ordinary React from here on) to `render`. */
async function renderPage(address: string, searchParams: Record<string, string> = {}) {
  const element = await TokenPage({
    params: Promise.resolve({ address }),
    searchParams: Promise.resolve(searchParams),
  });
  return render(element);
}

describe("TokenPage", () => {
  beforeEach(() => {
    clearTtlCache();
    h.pair.mockReset();
  });

  it("renders the app before the public facts block (amended 30 Sep 2026)", async () => {
    h.pair.mockResolvedValue(null);
    const { container } = await renderPage(ADDRESS);
    const html = container.innerHTML;
    const appAt = html.indexOf('data-testid="app-slot"');
    const factsAt = html.indexOf("No token at");
    expect(appAt).toBeGreaterThanOrEqual(0);
    expect(factsAt).toBeGreaterThan(appAt);
  });

  it("shows the unknown-token message when there is no pair and no fresh launch", async () => {
    h.pair.mockResolvedValue(null);
    await renderPage(ADDRESS);
    expect(screen.getByText(/No token at/)).toBeTruthy();
  });

  it("does not show the unknown-token message when the page was opened from a fresh launch, leaving TokenView to say so", async () => {
    h.pair.mockResolvedValue(null);
    await renderPage(ADDRESS, { launched: TX });
    expect(screen.queryByText(/No token at/)).toBeNull();
    expect(screen.getByTestId("token-view")).toBeTruthy();
  });
});

// B1c, amended 30 Sep 2026: on the old code `generateMetadata` destructured only `{ params }`
// and always answered "Unknown token" for a null pair, so both cases below would have failed
// with `title: "Unknown token"` regardless of `launched`.
describe("generateMetadata (B1c)", () => {
  beforeEach(() => {
    clearTtlCache();
    h.pair.mockReset();
  });

  it("titles a genuinely unknown token page Unknown token", async () => {
    h.pair.mockResolvedValue(null);
    const meta = await generateMetadata({
      params: Promise.resolve({ address: ADDRESS }),
      searchParams: Promise.resolve({}),
    });
    expect(meta.title).toBe("Unknown token");
  });

  it("titles a page opened from a fresh launch as being indexed, not unknown", async () => {
    h.pair.mockResolvedValue(null);
    const meta = await generateMetadata({
      params: Promise.resolve({ address: ADDRESS }),
      searchParams: Promise.resolve({ launched: TX }),
    });
    expect(meta.title).toBe("Indexing your token");
  });
});

// Should fix 9: `getPair` is wrapped in React's `cache()` so `generateMetadata` and the page body
// share one backend read per request; see page.tsx's doc comment on `getPair`. React's per-request
// cache scope is set up by Next's own render pipeline and is not present when this suite calls
// `generateMetadata`/`TokenPage` directly, so it cannot observe that dedup here (the fork-free
// unit-test cost of the same limitation the official docs note for `cache()` outside a component
// tree); `cache.test.ts`'s "still dedupes two concurrent calls" case is what exercises the
// underlying in-flight sharing this relies on regardless of which caller asks.
describe("getPair and the null memo (should fix 9)", () => {
  beforeEach(() => {
    clearTtlCache();
    h.pair.mockReset();
  });

  const FOUND: TokenPair = {
    id: ADDRESS,
    ticker: "AI",
    name: "Artificial Inu",
    address: ADDRESS as TokenPair["address"],
    quote: "NVDA",
    origin: "LONG",
    tradeable: true,
    priceUsd: 0.01,
    priceQuote: 0.0001,
    change1h: 1,
    change24h: -1,
    vol24h: 100,
    mcap: 100,
    fdv: 100,
    liquidity: 100,
    holders: 1,
    createdAt: Date.now(),
    bull: 0,
    bear: 0,
    poolId: "0x0000000000000000000000000000000000000001" as TokenPair["address"],
    hook: "",
    hookAddress: "0x0000000000000000000000000000000000000000" as TokenPair["address"],
    feeTier: "0.30%",
  };

  it("does not answer a stale not-found once the backend actually has the token", async () => {
    h.pair.mockResolvedValueOnce(null);
    await renderPage(ADDRESS, { launched: TX });
    expect(h.pair).toHaveBeenCalledTimes(1);

    h.pair.mockResolvedValueOnce(FOUND);
    // A second, separate request for the same address (a creator's own reload) must ask the
    // backend again rather than being answered out of a lingering "not found".
    const { container } = await renderPage(ADDRESS, { launched: TX });
    expect(h.pair).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Artificial Inu");
  });
});
