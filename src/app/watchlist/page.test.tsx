import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, SignMessage, TokenPair, VoteDir } from "@/lib/types";
import { fireEvent, queryHarness, render, screen, waitFor } from "@/test/dom";
import { AppStateProvider } from "@/context/AppState";
import SignModal from "@/components/SignModal";
import WatchlistPage from "./page";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;

const h = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, isConnected: true },
  ds: {
    session: vi.fn<() => Promise<string | null>>(),
    signIn: vi.fn<(sign: SignMessage, address: string) => Promise<string>>(),
    signOut: vi.fn<() => Promise<void>>(),
    watchlist: vi.fn<() => Promise<string[]>>(),
    setWatch: vi.fn<(id: string, on: boolean) => Promise<void>>(),
    votes: vi.fn<() => Promise<Record<string, VoteDir>>>(),
    vote: vi.fn<(id: string, dir: VoteDir) => Promise<VoteDir | null>>(),
    pairs: vi.fn<(scope?: "sv") => Promise<TokenPair[]>>(),
  },
}));

const addr = (c: string) => `0x${c.repeat(40)}` as Address;
function row(ticker: string, id: Address, over: Partial<TokenPair> = {}): TokenPair {
  return {
    id, ticker, name: `${ticker} token`, address: id, quote: "USDG", origin: "SV", tradeable: true, priceUsd: 0.00001,
    priceQuote: 0.00001, change1h: null, change24h: null, vol24h: 0, mcap: 10_000, fdv: 10_000, liquidity: 0, holders: 1,
    createdAt: Date.now(), bull: 0, bear: 0, poolId: addr("0"), hook: "None", hookAddress: addr("0"), feeTier: "1.00%",
    ...over,
  };
}

// `SignModal` renders beside the page below, so the sign-in panel's click can be observed as the
// dialog it actually opens rather than as a context field only this test can see.
vi.mock("wagmi", () => ({
  useAccount: () => h.account,
  useAccountEffect: () => undefined,
  useSignMessage: () => ({ signMessageAsync: vi.fn(), isPending: false }),
}));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: vi.fn() }) }));
// The connect modal never opens here, so the connect-time sign-in (gate off, nothing to admit) never enters the picture.
vi.mock("@/lib/suits", () => ({ useIsSuitHolder: () => false, gateEnabled: () => false, useSuitsAccess: () => ({ status: "idle" }) }));
// `AppState.tsx` imports this as "./DataSource"; Vitest keys mocks by resolved path, and the `@/`
// alias resolves to the same file, so the spelling here does not have to match the import's.
vi.mock("@/context/DataSource", () => ({ useDataSource: () => h.ds }));
// `QuoteChips` reads `window.matchMedia`, which jsdom does not implement, and it has nothing to
// do with the loading branch under test — swapped out rather than polyfilling a global for it.
vi.mock("@/components/QuoteChips", () => ({ default: () => null }));
// PairsTable's rows read useRouter() (PairsTable.tsx:148) for their click-through; earlier tests here
// never rendered a real row (pairs always resolved []), so this was never needed before Review Focus 17.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));

function show() {
  const { wrapper: QueryWrapper } = queryHarness();
  return render(
    <QueryWrapper>
      <AppStateProvider>
        <WatchlistPage />
        <SignModal />
      </AppStateProvider>
    </QueryWrapper>,
  );
}

describe("WatchlistPage", () => {
  beforeEach(() => {
    h.account = { address: WALLET, isConnected: true };
    h.ds.session.mockReset();
    h.ds.signIn.mockReset();
    h.ds.signOut.mockReset();
    h.ds.watchlist.mockReset().mockResolvedValue([]);
    h.ds.setWatch.mockReset();
    h.ds.votes.mockReset().mockResolvedValue({});
    h.ds.vote.mockReset();
    h.ds.pairs.mockReset().mockResolvedValue([]);
  });

  // Task 4 review F6: `watchlistLoading` used to go straight to `false` while the cookie probe
  // was still in flight (because `signed` starts false too), so the page showed the signed-out
  // empty copy for a signed-in user's very first render.
  it("shows the loading skeleton, not the empty copy, while the session cookie is still being probed", async () => {
    h.ds.session.mockReturnValue(new Promise<string | null>(() => {})); // never settles
    show();

    // Let the unrelated pairs query settle first, so the loading state left on screen is driven
    // only by the still-unresolved session probe, not by the pairs list also being in flight.
    await waitFor(() => expect(h.ds.pairs).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByLabelText("Loading pairs")).toBeTruthy());
    expect(screen.queryByText("Nothing on your watchlist yet.")).toBeNull();
  });

  /**
   * Review I5: once the probe settled, a connected wallet that had not signed in *here* was told
   * "Nothing on your watchlist yet" — false, since the list lives on the server behind a session
   * and the only sign-in affordance in the app was the star gate on another page.
   */
  it("invites a connected but not-signed-in wallet to sign in, and opens the sign-in modal", async () => {
    h.ds.session.mockResolvedValue(null);
    show();

    await waitFor(() => expect(screen.getByText("Sign in to load your watchlist.")).toBeTruthy());
    expect(screen.queryByText("Nothing on your watchlist yet.")).toBeNull();
    expect(screen.queryByLabelText("Loading pairs")).toBeNull();
    expect(h.ds.watchlist).not.toHaveBeenCalled(); // nothing to ask for without a session

    fireEvent.click(screen.getByText("Sign In"));
    // The panel's button runs the same gate a star does, with nothing queued behind it.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Sign to save your watchlist")).toBeTruthy();
  });

  it("shows the empty copy only once a signed-in wallet's watchlist comes back empty", async () => {
    h.ds.session.mockResolvedValue(WALLET);
    show();

    await waitFor(() => expect(screen.getByText("Nothing on your watchlist yet.")).toBeTruthy());
    expect(screen.queryByText("Sign in to load your watchlist.")).toBeNull();
    expect(screen.queryByLabelText("Loading pairs")).toBeNull();
    expect(h.ds.watchlist).toHaveBeenCalled();
  });

  // Review Focus 17: a starred launch nobody bought can fall out of the default 500-row list, and used
  // to disappear from the watchlist with no note. The Suits list (every launch) is merged in by id.
  it("shows a starred launch that is missing from the default 500-row list, merged from the Suits list", async () => {
    const LAUNCH_ONLY = row("GHOST", addr("7"));
    h.ds.session.mockResolvedValue(WALLET);
    h.ds.watchlist.mockResolvedValue([LAUNCH_ONLY.id]);
    h.ds.pairs.mockImplementation(async (scope) => (scope === "sv" ? [LAUNCH_ONLY] : []));
    show();

    await waitFor(() => expect(screen.getByText("GHOST")).toBeTruthy());
    expect(screen.getByText("1 token")).toBeTruthy();
  });

  it("does not duplicate a starred token that is in both the default list and the Suits list", async () => {
    const BOTH = row("DUAL", addr("8"));
    h.ds.session.mockResolvedValue(WALLET);
    h.ds.watchlist.mockResolvedValue([BOTH.id]);
    h.ds.pairs.mockImplementation(async (scope) => (scope === "sv" ? [BOTH] : [BOTH]));
    show();

    await waitFor(() => expect(screen.getByText("DUAL")).toBeTruthy());
    expect(screen.getByText("1 token")).toBeTruthy();
  });

  it("keeps the loading state up while the Suits list is still in flight, even once the default list and session settle", async () => {
    h.ds.session.mockResolvedValue(WALLET);
    h.ds.pairs.mockImplementation((scope) => (scope === "sv" ? new Promise<TokenPair[]>(() => {}) : Promise.resolve([])));
    show();

    await waitFor(() => expect(screen.getByLabelText("Loading pairs")).toBeTruthy());
    expect(screen.queryByText("Nothing on your watchlist yet.")).toBeNull();
  });
});
