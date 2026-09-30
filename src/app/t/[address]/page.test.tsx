import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex, TokenPair } from "@/lib/types";
import { clearTtlCache } from "@/lib/envio/cache";
import { render, screen } from "@/test/dom";
import TokenPage, { generateMetadata } from "./page";

const ADDRESS = `0x${"22".repeat(20)}`;
const TX = `0x${"33".repeat(32)}` as Hex;

/** A real render of TokenFacts (unmocked in this file) reads every field `buildRows` touches, so
 *  a sparse `{id, ticker}` stub crashes on the first missing number; this fixture is complete. */
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

const h = vi.hoisted(() => ({
  pair: vi.fn<(id: string) => Promise<TokenPair | null>>(),
  tokenViewProps: vi.fn(),
}));

vi.mock("@/lib/market/backend", () => ({ getBackend: () => ({ pair: h.pair }) }));
// pairLookup.ts (fix round 1, finding 3) imports `isAddress` from the same file as these two
// error classes; both are `server-only`-marked modules this suite never otherwise touches, so a
// minimal stand-in keeps them from throwing on import without pretending to model either one.
vi.mock("@/lib/db/client", () => ({ DbUnavailableError: class DbUnavailableError extends Error {} }));
vi.mock("@/lib/envio/client", () => ({ EnvioUnavailableError: class EnvioUnavailableError extends Error {} }));
// GatedSection and TokenView each have their own test file; here they are opaque markers, so
// this suite exercises only what page.tsx itself decides: the order its two sections come in,
// what `launchedTx` it hands to TokenFacts, and what `serverHadPair` it hands to TokenView (fix
// round 1, findings 1 and 5): the mock records its own props so that wiring is checkable here.
vi.mock("@/components/GatedSection", () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="app-slot">{children}</div>,
}));
vi.mock("@/components/TokenView", () => ({
  default: (props: { serverHadPair: boolean }) => {
    h.tokenViewProps(props);
    return <div data-testid="token-view">TokenView</div>;
  },
}));
// TokenFacts (real, unmocked, since it is the component under test here) renders
// PublicFactsSection for a found pair, which reads these two the same way GatedSection does; see
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
    h.tokenViewProps.mockReset();
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

  // Fix round 1, findings 1 and 5: TokenView needs to know whether this same read already had
  // the pair, so it can leave its own "No token" message to TokenFacts and skip a needless
  // refresh once the client catches up. On the old code TokenView took no such prop at all.
  it("tells TokenView the server found no pair", async () => {
    h.pair.mockResolvedValue(null);
    await renderPage(ADDRESS);
    expect(h.tokenViewProps).toHaveBeenCalledWith(expect.objectContaining({ serverHadPair: false }));
  });

  it("tells TokenView the server found the pair", async () => {
    h.pair.mockResolvedValue(FOUND);
    await renderPage(ADDRESS);
    expect(h.tokenViewProps).toHaveBeenCalledWith(expect.objectContaining({ serverHadPair: true }));
  });
});

describe("generateMetadata (B1c)", () => {
  beforeEach(() => {
    clearTtlCache();
    h.pair.mockReset();
  });

  // Fix round 1, finding 12: the old note here claimed both cases below fail on the pre-B1c
  // code, but only the second one does. `generateMetadata` on that code always answered "Unknown
  // token" for a null pair regardless of `launched`, which is exactly this first case's own
  // expectation, so it already passed there; it is not a regression test, only a pin. The second
  // case is the real regression test: that code never read `searchParams` at all, so it could
  // only ever answer "Unknown token" too, and fails against "Indexing your token" here.
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

// Should fix 9, and fix round 1 finding 3: `getPair` wraps `lookupPair`
// (src/app/api/_lib/pairLookup.ts) in React's `cache()`, so `generateMetadata` and the page body
// share one backend read per request; see page.tsx's doc comment on `getPair`. React's
// per-request cache scope is set up by Next's own render pipeline and is not present when this
// suite calls `generateMetadata`/`TokenPage` directly, so it cannot observe that dedup here (the
// same limitation the official docs note for `cache()` outside a component tree); `cache.test.ts`'s
// "still dedupes two concurrent calls" case is what exercises the underlying in-flight sharing
// this relies on regardless of which caller asks, and `pairLookup.test.ts` covers `lookupPair`
// itself, including the cross-route case the quote route shares this same memo with.
describe("getPair and the null memo (should fix 9, fix round 1 finding 3)", () => {
  beforeEach(() => {
    clearTtlCache();
    h.pair.mockReset();
  });

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
