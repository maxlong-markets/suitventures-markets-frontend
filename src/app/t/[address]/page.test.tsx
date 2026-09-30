import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex, TokenPair } from "@/lib/types";
import { clearTtlCache } from "@/lib/envio/cache";
import { render, screen } from "@/test/dom";
import TokenPage from "./page";

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
