import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, TokenPair } from "@/lib/types";
import { fireEvent, queryHarness, render, screen, waitFor, within } from "@/test/dom";
import { AppStateProvider } from "@/context/AppState";
import MarketsPage from "./page";

const HOUR = 3_600_000;
const addr = (c: string) => `0x${c.repeat(40)}` as Address;

const h = vi.hoisted(() => ({
  ds: {
    session: vi.fn<() => Promise<string | null>>(),
    watchlist: vi.fn<() => Promise<string[]>>(),
    votes: vi.fn<() => Promise<Record<string, never>>>(),
    pairs: vi.fn<(scope?: "sv") => Promise<TokenPair[]>>(),
  },
}));

// The real AppStateProvider owns the filters the chips set, so its wallet and Suits reads are stubbed as on /watchlist.
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useAccountEffect: () => undefined,
  useSignMessage: () => ({ signMessageAsync: vi.fn(), isPending: false }),
}));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: vi.fn(), connectModalOpen: false }) }));
vi.mock("@/lib/suits", () => ({ useIsSuitHolder: () => false, gateEnabled: () => false, useSuitsAccess: () => ({ status: "idle" }) }));
vi.mock("@/context/DataSource", () => ({ useDataSource: () => h.ds }));
// QuoteChips reads window.matchMedia, which jsdom lacks, and has nothing to do with which list the table shows.
vi.mock("@/components/QuoteChips", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));

function row(ticker: string, id: Address, over: Partial<TokenPair> = {}): TokenPair {
  return {
    id, ticker, name: `${ticker} token`, address: id, quote: "USDG", origin: "SV", tradeable: true, priceUsd: 0.00001,
    priceQuote: 0.00001, change1h: null, change24h: null, vol24h: 0, mcap: 10_000, fdv: 10_000, liquidity: 0, holders: 1,
    createdAt: Date.now() - HOUR, bull: 0, bear: 0, poolId: addr("0"), hook: "None", hookAddress: addr("0"), feeTier: "1.00%",
    ...over,
  };
}

// The default list: the 500 most recently traded tokens, where an old launch nobody bought is gone.
const TRADED = row("TRADED", addr("a"), { origin: "LONG", vol24h: 5_000 });
const FRESH = row("FRESH", addr("b"));
// The Suits list adds what the default list lost: a delisted launch, and a launch whose listed pool is another origin's.
const DELISTED = row("DELISTED", addr("c"), { createdAt: Date.now() - 10 * 24 * HOUR });
const ELSEWHERE = row("ELSEWHERE", addr("d"), { origin: "Uniswap" });

function show() {
  const { wrapper: QueryWrapper } = queryHarness();
  return render(
    <QueryWrapper>
      <AppStateProvider>
        <MarketsPage />
      </AppStateProvider>
    </QueryWrapper>,
  );
}

const originChip = (name: string) => within(screen.getByRole("group", { name: "Launchpad" })).getByRole("button", { name });
const suitsChip = () => originChip("SUITS");

describe("MarketsPage and the Suits tab (amended 30 Sep 2026)", () => {
  beforeEach(() => {
    h.ds.session.mockReset().mockResolvedValue(null);
    h.ds.watchlist.mockReset().mockResolvedValue([]);
    h.ds.votes.mockReset().mockResolvedValue({});
    h.ds.pairs.mockReset().mockImplementation(async (scope) => (scope === "sv" ? [FRESH, DELISTED, ELSEWHERE] : [TRADED, FRESH]));
  });

  it("reads its rows from the Suits list once the SUITS chip is on, every launch included", async () => {
    show();
    await waitFor(() => expect(screen.getByText("TRADED")).toBeTruthy());
    expect(screen.queryByText("DELISTED")).toBeNull();
    expect(h.ds.pairs).toHaveBeenCalledTimes(1);

    fireEvent.click(suitsChip());
    await waitFor(() => expect(screen.getByText("DELISTED")).toBeTruthy());
    expect(h.ds.pairs).toHaveBeenLastCalledWith("sv");
    expect(screen.getByText("FRESH")).toBeTruthy();
    expect(screen.getByText("ELSEWHERE")).toBeTruthy();
    expect(screen.queryByText("TRADED")).toBeNull();
    expect(screen.getByText("3 pairs")).toBeTruthy();
  });

  it("keeps the presets working on the Suits rows", async () => {
    show();
    fireEvent.click(suitsChip());
    await waitFor(() => expect(screen.getByText("DELISTED")).toBeTruthy());
    fireEvent.click(within(screen.getByRole("group", { name: "Preset" })).getByRole("button", { name: "New" }));
    // New keeps the last seven days: the ten-day-old launch drops out, the one-hour-old ones stay.
    await waitFor(() => expect(screen.queryByText("DELISTED")).toBeNull());
    expect(screen.getByText("FRESH")).toBeTruthy();
  });

  it("shows the Suits list's own loading state, even with the default list already in hand", async () => {
    h.ds.pairs.mockImplementation((scope) => (scope === "sv" ? new Promise<TokenPair[]>(() => {}) : Promise.resolve([TRADED, FRESH])));
    show();
    await waitFor(() => expect(screen.getByText("TRADED")).toBeTruthy());
    fireEvent.click(suitsChip());
    await waitFor(() => expect(screen.getByLabelText("Loading pairs")).toBeTruthy());
    expect(screen.queryByText("TRADED")).toBeNull();
  });

  it("shows the Suits list's own error, and the default table again once All is picked", async () => {
    h.ds.pairs.mockImplementation((scope) => (scope === "sv" ? Promise.reject(new Error("/api/pairs?scope=sv: 503")) : Promise.resolve([TRADED, FRESH])));
    show();
    await waitFor(() => expect(screen.getByText("TRADED")).toBeTruthy());
    fireEvent.click(suitsChip());
    await waitFor(() => expect(screen.getByText("Couldn't load pairs.")).toBeTruthy());
    expect(screen.getByText("/api/pairs?scope=sv: 503")).toBeTruthy();

    fireEvent.click(originChip("All"));
    await waitFor(() => expect(screen.getByText("TRADED")).toBeTruthy());
    expect(screen.queryByText("Couldn't load pairs.")).toBeNull();
  });

  // Review Focus 16: before the first launch, the generic "no pairs match" sentence read as broken.
  it("says 'No launches yet' with a link to /launch when the Suits list itself is empty", async () => {
    h.ds.pairs.mockImplementation(async (scope) => (scope === "sv" ? [] : [TRADED]));
    show();
    fireEvent.click(suitsChip());
    await waitFor(() => expect(screen.getByText("No launches yet.")).toBeTruthy());
    expect(screen.queryByText("No pairs on SUITS match All.")).toBeNull();
    expect(screen.getByRole("link", { name: "Launch a token" }).getAttribute("href")).toBe("/launch");
  });

  // The Suits list is not empty here (DELISTED exists); only the "New" preset filters it to zero
  // rows, so the usual reset-minded sentence must stay: launches exist, they just do not match today.
  it("keeps the usual empty sentence, with a reset, when a preset filters an existing Suits list to zero", async () => {
    h.ds.pairs.mockImplementation(async (scope) => (scope === "sv" ? [DELISTED] : [TRADED]));
    show();
    fireEvent.click(suitsChip());
    await waitFor(() => expect(screen.getByText("DELISTED")).toBeTruthy());
    fireEvent.click(within(screen.getByRole("group", { name: "Preset" })).getByRole("button", { name: "New" }));
    await waitFor(() => expect(screen.getByText("No pairs on SUITS match New.")).toBeTruthy());
    expect(screen.queryByText("No launches yet.")).toBeNull();
    expect(screen.getByRole("button", { name: "Show all pairs" })).toBeTruthy();
  });

  // Fix round 1: only SV changed its word. Every other origin reads in the sentence as it always did.
  it("keeps every other origin's own name in the sentence: Pons, not PONS", async () => {
    show();
    await waitFor(() => expect(screen.getByText("TRADED")).toBeTruthy());
    fireEvent.click(originChip("PONS"));
    await waitFor(() => expect(screen.getByText("No pairs on Pons match All.")).toBeTruthy());
  });
});
