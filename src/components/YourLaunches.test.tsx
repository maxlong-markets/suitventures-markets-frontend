import { beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "@/hooks/useMarketsData";
import type { Address, TokenPair } from "@/lib/types";
import { queryHarness, render, screen, waitFor } from "@/test/dom";
import YourLaunches from "./YourLaunches";

const HOUR = 3_600_000;
const WALLET = "0xC1c1C1c1c1C1C1c1c1C1c1C1c1c1C1C1c1c1c1c1" as Address; // mixed case, as wagmi hands it over
const CREATOR = WALLET.toLowerCase() as Address; // lowercase, as the store keeps it
const STRANGER = "0x2222222222222222222222222222222222222222" as Address;

const h = vi.hoisted(() => ({
  live: true,
  account: { address: undefined as string | undefined, isConnected: false },
  pairs: vi.fn<(scope?: "sv") => Promise<TokenPair[]>>(),
}));

vi.mock("@/lib/launch/address", () => ({ hasLaunchpad: () => h.live }));
vi.mock("@/context/AppState", () => ({ useAppState: () => h.account }));
vi.mock("@/context/DataSource", () => ({ useDataSource: () => ({ pairs: h.pairs }) }));

function launch(ticker: string, id: string, creator: Address, over: Partial<TokenPair> = {}): TokenPair {
  return {
    id, ticker, name: `${ticker} token`, address: id as Address, quote: "USDG", origin: "SV", tradeable: true, priceUsd: 0.00001,
    priceQuote: 0.00001, change1h: null, change24h: null, vol24h: 0, mcap: 0, fdv: 0, liquidity: 0, holders: 1,
    createdAt: Date.now() - HOUR, bull: 0, bear: 0, poolId: "0x01", hook: "None",
    hookAddress: "0x0000000000000000000000000000000000000000", feeTier: "1.00%", launchCreator: creator, ...over,
  };
}

// Newest first, as GET /api/pairs?scope=sv answers.
const NEWEST = launch("CHALK", `0x${"a".repeat(40)}`, CREATOR, { mcap: 12_345, createdAt: Date.now() - 2 * HOUR });
const THEIRS = launch("OTHER", `0x${"b".repeat(40)}`, STRANGER, { mcap: 99_000 });
const OLDER = launch("TAPE", `0x${"c".repeat(40)}`, CREATOR, { createdAt: Date.now() - 3 * 24 * HOUR });

function show() {
  const { client, wrapper } = queryHarness();
  const view = render(<YourLaunches />, { wrapper });
  /** Waits until the Suits list has answered or failed, so "nothing" is checked after the answer rather than before it. */
  const settled = () => waitFor(() => expect(["success", "error"]).toContain(client.getQueryState(keys.pairsSv)?.status));
  return { ...view, settled };
}

describe("YourLaunches (amended 30 Sep 2026)", () => {
  beforeEach(() => {
    h.live = true;
    h.account = { address: WALLET, isConnected: true };
    h.pairs.mockReset().mockResolvedValue([NEWEST, THEIRS, OLDER]);
  });

  it("lists only the connected wallet's launches, newest first, each linking to its token page", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your launches" })).toBeTruthy());
    expect(h.pairs).toHaveBeenCalledWith("sv");
    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([`/t/${NEWEST.id}`, `/t/${OLDER.id}`]);
    expect(links[0]!.textContent).toContain("CHALK");
    expect(links[0]!.textContent).toContain("CHALK token");
    expect(links[0]!.textContent).toContain("2h ago");
    expect(links[0]!.textContent).toContain("Mcap $12.3K");
    // A market cap of zero is left out rather than printed as $0.
    expect(links[1]!.textContent).toContain("TAPE");
    expect(links[1]!.textContent).toContain("3d ago");
    expect(links[1]!.textContent).not.toContain("Mcap");
    expect(screen.queryByText("OTHER")).toBeNull();
  });

  it("renders nothing, and asks for nothing, while no wallet is connected", async () => {
    h.account = { address: undefined, isConnected: false };
    const { container } = show();
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
    expect(h.pairs).not.toHaveBeenCalled();
  });

  it("renders nothing while the list is loading", async () => {
    h.pairs.mockReturnValue(new Promise<TokenPair[]>(() => {}));
    const { container } = show();
    await waitFor(() => expect(h.pairs).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when nobody has launched yet", async () => {
    h.pairs.mockResolvedValue([]);
    const { container, settled } = show();
    await settled();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when no launch is this wallet's", async () => {
    h.pairs.mockResolvedValue([THEIRS]);
    const { container, settled } = show();
    await settled();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the list cannot be read", async () => {
    h.pairs.mockRejectedValue(new Error("/api/pairs?scope=sv: 503"));
    const { container, settled } = show();
    await settled();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing at all, and asks for nothing, while the launchpad is not live", async () => {
    h.live = false;
    const { container } = show();
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
    expect(h.pairs).not.toHaveBeenCalled();
  });
});
