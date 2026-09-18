import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, SignMessage, TokenPair, VoteDir } from "@/lib/types";
import { queryHarness, render, screen, waitFor } from "@/test/dom";
import { AppStateProvider } from "@/context/AppState";
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
    pairs: vi.fn<() => Promise<TokenPair[]>>(),
  },
}));

vi.mock("wagmi", () => ({ useAccount: () => h.account }));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: vi.fn() }) }));
vi.mock("@/lib/suits", () => ({ useIsSuitHolder: () => false }));
// `AppState.tsx` imports this as "./DataSource"; Vitest keys mocks by resolved path, and the `@/`
// alias resolves to the same file, so the spelling here does not have to match the import's.
vi.mock("@/context/DataSource", () => ({ useDataSource: () => h.ds }));
// `QuoteChips` reads `window.matchMedia`, which jsdom does not implement, and it has nothing to
// do with the loading branch under test — swapped out rather than polyfilling a global for it.
vi.mock("@/components/QuoteChips", () => ({ default: () => null }));

function show() {
  const { wrapper: QueryWrapper } = queryHarness();
  return render(
    <QueryWrapper>
      <AppStateProvider>
        <WatchlistPage />
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

  it("shows the empty copy once the session probe resolves to signed-out", async () => {
    h.ds.session.mockResolvedValue(null);
    show();

    await waitFor(() => expect(screen.getByText("Nothing on your watchlist yet.")).toBeTruthy());
    expect(screen.queryByLabelText("Loading pairs")).toBeNull();
  });
});
