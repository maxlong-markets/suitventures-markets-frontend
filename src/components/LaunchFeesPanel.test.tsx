import { beforeEach, describe, expect, it, vi } from "vitest";
import { LaunchFailedError } from "@/lib/launch";
import type { Address, LaunchInfo, TokenPair } from "@/lib/types";
import { act, fireEvent, queryHarness, render, screen, waitFor, within } from "@/test/dom";
import LaunchFeesPanel from "./LaunchFeesPanel";

const TOKEN = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as Address;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const PAYOUT = "0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2" as Address;
const STRANGER = "0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1" as Address;
const RESCUE = "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1" as Address;
const TX = `0x${"11".repeat(32)}` as `0x${string}`;
const E18 = 10n ** 18n;
// robinhoodChain.id (src/lib/chain.ts); hardcoded here so the mock factory below (hoisted above imports)
// never has to reach for the real module.
const CHAIN_ID = 4663;

const h = vi.hoisted(() => ({
  state: { address: "0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1" as string | undefined, isConnected: true, addToast: vi.fn(() => 7), updateToast: vi.fn() },
  fees: {} as Record<string, unknown>,
  refetch: vi.fn(),
  collect: vi.fn(),
  claim: vi.fn(),
  change: vi.fn(),
  chainId: 4663 as number | undefined,
  switchChain: vi.fn(),
  openConnectModal: vi.fn(),
}));
vi.mock("@/context/AppState", () => ({ useAppState: () => h.state }));
vi.mock("@/hooks/useLaunchpad", () => ({ useLaunchFees: () => ({ ...h.fees, refetch: h.refetch }) }));
vi.mock("wagmi", () => ({
  usePublicClient: () => ({ id: "public" }),
  useWalletClient: () => ({ data: { id: "wallet" } }),
  useAccount: () => ({ chainId: h.chainId }),
  useSwitchChain: () => ({ switchChain: h.switchChain }),
}));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: h.openConnectModal }) }));
vi.mock("@/lib/launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/launch")>()),
  collectLaunchFees: h.collect,
  claimOwed: h.claim,
  changePayout: h.change,
}));

const pair = { id: TOKEN, ticker: "CHALK", quote: "USDG", address: TOKEN } as TokenPair;
const launch = {
  payout: PAYOUT, quoteAddress: USDG, quoteDecimals: 6, creatorShareBps: 7000,
  feesCollected: { tokenToPayout: String(770n * E18), tokenToPlatform: String(330n * E18), quoteToPayout: "7000000", quoteToPlatform: "3000000" },
  feesCollectedAt: 1_999_999_000,
} as unknown as LaunchInfo;
const NOW_MS = 2_000_000_000_000;
const ok = () => ({ hash: TX, confirmation: Promise.resolve() });
/**
 * Drains the microtask queue a few times over. `run()` awaits the write call and then its
 * confirmation, each already-resolved, so each `await` still costs one real tick; fake timers never
 * touch the microtask queue (only setTimeout/setInterval/Date), so this is safe under either.
 */
async function flushMicrotasks() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}
function show() {
  const { client, wrapper: QueryWrapper } = queryHarness();
  const utils = render(
    <QueryWrapper>
      <LaunchFeesPanel pair={pair} launch={launch} now={NOW_MS} />
    </QueryWrapper>,
  );
  return { ...utils, client };
}

beforeEach(() => {
  h.state.address = STRANGER;
  h.state.isConnected = true;
  h.state.addToast.mockClear();
  h.state.updateToast.mockClear();
  h.fees = {
    uncollected: { tokenFees: 1000n * E18, quoteFees: 10_000_000n, tokenToPayout: 700n * E18, quoteToPayout: 7_000_000n, tokenToFeeWallet: 300n * E18, quoteToFeeWallet: 3_000_000n },
    uncollectedFailed: false,
    owedToken: 0n,
    owedQuote: 0n,
  };
  h.refetch.mockReset();
  h.collect.mockReset().mockImplementation(async () => ok());
  h.claim.mockReset().mockImplementation(async () => ok());
  h.change.mockReset().mockImplementation(async () => ok());
  h.chainId = CHAIN_ID;
  h.switchChain.mockReset();
  h.openConnectModal.mockReset();
});

describe("LaunchFeesPanel (spec 7.3)", () => {
  it("shows a stranger the uncollected split, what was collected so far, and Collect; no payout change and nothing owed", () => {
    show();
    const uncollected = within(screen.getByRole("region", { name: "Uncollected fees" }));
    expect(uncollected.getByText("700 CHALK · 7 USDG")).toBeTruthy();
    expect(uncollected.getByText("300 CHALK · 3 USDG")).toBeTruthy();
    const collected = within(screen.getByRole("region", { name: "Collected so far" }));
    expect(collected.getByText("770 CHALK · 7 USDG")).toBeTruthy();
    expect(collected.getByText("330 CHALK · 3 USDG")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Collect fees" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Change payout" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Owed to you" })).toBeNull();
  });

  it("collects for anyone, with the usual toasts, and re-reads the fees after", async () => {
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
    });
    await waitFor(() => expect(h.state.updateToast).toHaveBeenCalledWith(7, { kind: "confirmed", message: "Fees collected for CHALK" }));
    expect(h.collect).toHaveBeenCalledWith(TOKEN, { wallet: { id: "wallet" }, publicClient: { id: "public" }, account: STRANGER });
    expect(h.refetch).toHaveBeenCalled();
  });

  it("disables Collect with a reason when both amounts are zero", () => {
    h.fees = { ...h.fees, uncollected: { tokenFees: 0n, quoteFees: 0n, tokenToPayout: 0n, quoteToPayout: 0n, tokenToFeeWallet: 0n, quoteToFeeWallet: 0n } };
    show();
    expect((screen.getByRole("button", { name: "Collect fees" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Nothing to collect yet.")).toBeTruthy();
  });

  it("says it could not read the uncollected fees and keeps Collect usable, never showing zeros (Review Focus 5)", () => {
    h.fees = { ...h.fees, uncollected: undefined, uncollectedFailed: true };
    show();
    expect(screen.getByText("Could not read the uncollected fees just now.")).toBeTruthy();
    expect(screen.queryByText("Nothing to collect yet.")).toBeNull();
    expect((screen.getByRole("button", { name: "Collect fees" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows an owed balance with a Claim per currency, to an address that defaults to the wallet and can be changed", async () => {
    h.fees = { ...h.fees, owedToken: 5n * E18, owedQuote: 2_500_000n };
    show();
    const owed = within(screen.getByRole("region", { name: "Owed to you" }));
    expect(owed.getByText("5 CHALK")).toBeTruthy();
    expect(owed.getByText("2.5 USDG")).toBeTruthy();
    expect((owed.getByLabelText("Send to") as HTMLInputElement).value).toBe(STRANGER);
    await act(async () => {
      fireEvent.click(owed.getByRole("button", { name: "Claim USDG" }));
    });
    expect(h.claim).toHaveBeenLastCalledWith(USDG, STRANGER, expect.anything());
    fireEvent.change(owed.getByLabelText("Send to"), { target: { value: RESCUE } });
    await act(async () => {
      fireEvent.click(owed.getByRole("button", { name: "Claim CHALK" }));
    });
    expect(h.claim).toHaveBeenLastCalledWith(TOKEN, RESCUE, expect.anything());
  });

  it("shows a refused write's own words", async () => {
    h.collect.mockRejectedValueOnce(new LaunchFailedError("Nothing to collect yet.", "NothingToCollect"));
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Nothing to collect yet."));
  });

  it("refuses a bad or zero payout address with a plain reason, before any wallet call", async () => {
    h.state.address = PAYOUT;
    show();
    const input = screen.getByLabelText("New payout address");
    const button = () => screen.getByRole("button", { name: "Change payout" }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: "0x0000000000000000000000000000000000000000" } });
    expect(screen.getByText("The zero address cannot receive fees.")).toBeTruthy();
    expect(button().disabled).toBe(true);
    // Mixed case with a wrong checksum: viem's strict check refuses it.
    fireEvent.change(input, { target: { value: "0xE1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1" } });
    expect(screen.getByText("That is not a valid address.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(button());
    });
    expect(h.change).not.toHaveBeenCalled();
  });

  it("refuses a bad or zero claim address with a plain reason, before any wallet call", async () => {
    h.fees = { ...h.fees, owedQuote: 2_500_000n };
    show();
    const owed = within(screen.getByRole("region", { name: "Owed to you" }));
    fireEvent.change(owed.getByLabelText("Send to"), { target: { value: "0x0000000000000000000000000000000000000000" } });
    expect(owed.getByText("The zero address cannot receive fees.")).toBeTruthy();
    fireEvent.change(owed.getByLabelText("Send to"), { target: { value: "0x12" } });
    expect(owed.getByText("That is not a valid address.")).toBeTruthy();
    const claim = owed.getByRole("button", { name: "Claim USDG" }) as HTMLButtonElement;
    expect(claim.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(claim);
    });
    expect(h.claim).not.toHaveBeenCalled();
  });
});

describe("LaunchFeesPanel naming (Review Focus 2)", () => {
  it("titles the panel Pool fees, using the same words as the Info tab", () => {
    show();
    expect(screen.getByText("Pool fees")).toBeTruthy();
    expect(screen.queryByText("Launch fees")).toBeNull();
  });
});

describe("LaunchFeesPanel wallet gating (Review Focus 8)", () => {
  it("reads Connect wallet on Collect with no wallet connected, and opens the connect modal instead of collecting", () => {
    h.state.isConnected = false;
    h.state.address = undefined;
    show();
    const button = screen.getByRole("button", { name: "Connect wallet" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(h.openConnectModal).toHaveBeenCalled();
    expect(h.collect).not.toHaveBeenCalled();
  });

  it("reads Switch to Robinhood Chain on Collect on the wrong network, and switches instead of collecting", () => {
    h.chainId = 1;
    show();
    const button = screen.getByRole("button", { name: "Switch to Robinhood Chain" });
    fireEvent.click(button);
    expect(h.switchChain).toHaveBeenCalledWith({ chainId: CHAIN_ID });
    expect(h.collect).not.toHaveBeenCalled();
  });

  it("reads Switch to Robinhood Chain on Claim on the wrong network, and switches instead of claiming", () => {
    h.chainId = 1;
    h.fees = { ...h.fees, owedQuote: 2_500_000n };
    show();
    const owed = within(screen.getByRole("region", { name: "Owed to you" }));
    fireEvent.click(owed.getByRole("button", { name: "Switch to Robinhood Chain" }));
    expect(h.switchChain).toHaveBeenCalledWith({ chainId: CHAIN_ID });
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("reads Switch to Robinhood Chain on Change payout on the wrong network, and switches instead of opening the confirm step", () => {
    h.state.address = PAYOUT;
    h.chainId = 1;
    show();
    const section = within(screen.getByRole("region", { name: "Change payout" }));
    fireEvent.click(section.getByRole("button", { name: "Switch to Robinhood Chain" }));
    expect(h.switchChain).toHaveBeenCalledWith({ chainId: CHAIN_ID });
    expect(section.queryByText("This is permanent.", { exact: false })).toBeNull();
  });
});

describe("LaunchFeesPanel what Collect does (Review Focus 11)", () => {
  it("says in one line what Collect sends and who pays the gas", () => {
    show();
    expect(
      screen.getByText("Sends the fees gathered so far to the payout address and to MaxLong. Whoever presses this pays the gas."),
    ).toBeTruthy();
  });

  it("labels the payout rows 'To you' for the payout address, and 'To payout' for a stranger", () => {
    const { unmount } = show();
    const uncollectedStranger = within(screen.getByRole("region", { name: "Uncollected fees" }));
    expect(uncollectedStranger.getByText("To payout")).toBeTruthy();
    expect(uncollectedStranger.queryByText("To you")).toBeNull();
    unmount();

    h.state.address = PAYOUT;
    show();
    const uncollected = within(screen.getByRole("region", { name: "Uncollected fees" }));
    expect(uncollected.getByText("To you")).toBeTruthy();
    const collected = within(screen.getByRole("region", { name: "Collected so far" }));
    expect(collected.getByText("To you")).toBeTruthy();
  });

  it("gives a stranger a quiet Collect button and the payout address a loud one", () => {
    const { unmount } = show();
    const strangerButton = screen.getByRole("button", { name: "Collect fees" });
    expect(strangerButton.className).toContain("border-hairline-btn");
    expect(strangerButton.className).not.toContain("bg-chalk");
    unmount();

    h.state.address = PAYOUT;
    show();
    const payoutButton = screen.getByRole("button", { name: "Collect fees" });
    expect(payoutButton.className).toContain("bg-chalk");
  });
});

describe("LaunchFeesPanel after Collect (Review Focus 12)", () => {
  it("shows what was just collected at once, so the total never looks like it vanished", async () => {
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
    });
    await waitFor(() =>
      expect(screen.getByText("Just collected: 1,000 CHALK · 10 USDG. Totals update within about two minutes.")).toBeTruthy(),
    );
  });

  it("invalidates the pair query right after Collect confirms, so the token's own data is asked again", async () => {
    const { client } = show();
    const spy = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
    });
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["pair", TOKEN] })));
  });

  it("keeps asking every 10 seconds, and stops after two minutes", async () => {
    vi.useFakeTimers();
    try {
      const { client } = show();
      const spy = vi.spyOn(client, "invalidateQueries");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
        await flushMicrotasks();
      });
      expect(spy).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/Just collected/)).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(110_000);
      });
      expect(screen.queryByText(/Just collected/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops early once the store's own feesCollectedAt moves past what it was at collect time", async () => {
    vi.useFakeTimers();
    try {
      const { client } = show();
      // queryHarness()'s client uses gcTime 0 for test isolation; a query seeded below with no
      // observer would otherwise be garbage-collected on the very next fake timer tick, racing this
      // test's own setup rather than the component under test.
      client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
        await flushMicrotasks();
      });
      expect(screen.getByText(/Just collected/)).toBeTruthy();
      // The store folded the collect: its own copy of the pair now carries a newer feesCollectedAt.
      client.setQueryData(["pair", TOKEN], { ...pair, launch: { ...launch, feesCollectedAt: launch.feesCollectedAt + 60 } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(screen.queryByText(/Just collected/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LaunchFeesPanel change payout confirm step (Review Focus 13)", () => {
  it("opens a confirm step showing the full new address and the word permanent, before any wallet call", () => {
    h.state.address = PAYOUT;
    show();
    fireEvent.change(screen.getByLabelText("New payout address"), { target: { value: RESCUE } });
    fireEvent.click(screen.getByRole("button", { name: "Change payout" }));
    expect(screen.getByText(RESCUE)).toBeTruthy();
    expect(screen.getByText("This is permanent.", { exact: false })).toBeTruthy();
    expect(h.change).not.toHaveBeenCalled();
  });

  it("sends the write only once Confirm is pressed", async () => {
    h.state.address = PAYOUT;
    show();
    fireEvent.change(screen.getByLabelText("New payout address"), { target: { value: RESCUE } });
    fireEvent.click(screen.getByRole("button", { name: "Change payout" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });
    expect(h.change).toHaveBeenCalledWith(TOKEN, RESCUE, expect.objectContaining({ account: PAYOUT }));
  });

  it("cancels back to the input without ever asking the wallet", () => {
    h.state.address = PAYOUT;
    show();
    fireEvent.change(screen.getByLabelText("New payout address"), { target: { value: RESCUE } });
    fireEvent.click(screen.getByRole("button", { name: "Change payout" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(RESCUE)).toBeNull();
    expect(screen.getByLabelText("New payout address")).toBeTruthy();
    expect(h.change).not.toHaveBeenCalled();
  });
});
