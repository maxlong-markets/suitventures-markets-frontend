import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex, type Log } from "viem";
import { LAUNCHPAD_EVENTS_ABI, POOL_MANAGER } from "@/lib/chain/abi";
import { LaunchFailedError } from "@/lib/launch";
import type { Address, LaunchInfo, TokenPair } from "@/lib/types";
import { act, fireEvent, queryHarness, render, screen, waitFor, within } from "@/test/dom";
import LaunchFeesPanel from "./LaunchFeesPanel";

const TOKEN = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as Address;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const PAYOUT = "0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2" as Address;
const STRANGER = "0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1" as Address;
// Its own checksum (getAddress(RESCUE) === RESCUE): the confirm step now shows and sends the checksummed
// form (Review round 1, finding 6), so a constant that already is one keeps every existing assertion valid.
const RESCUE = "0xE1E1E1e1E1E1e1e1E1E1E1e1e1e1E1E1E1E1e1e1" as Address;
// Deliberately mixed case in its own checksum, unlike RESCUE's mostly-uppercase one, so the "shown
// checksummed" test can tell a checksummed display apart from the raw lowercase paste.
const LOWERCASE_TEST = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Address;
const LAUNCHPAD = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a" as Address;
const TX = `0x${"11".repeat(32)}` as Hex;
const E18 = 10n ** 18n;
// robinhoodChain.id (src/lib/chain.ts); hardcoded here so the mock factory below (hoisted above imports)
// never has to reach for the real module.
const CHAIN_ID = 4663;
// LaunchFeesPanel.tsx's own CONFIRM_GUARD_MS: how long Confirm stays disabled after the step opens.
const CONFIRM_GUARD_MS = 300;

const h = vi.hoisted(() => ({
  state: { address: "0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1" as string | undefined, isConnected: true, addToast: vi.fn(() => 7), updateToast: vi.fn() },
  fees: {} as Record<string, unknown>,
  refetch: vi.fn(),
  collect: vi.fn(),
  claim: vi.fn(),
  change: vi.fn(),
  chainId: 4663 as number | undefined,
  isReconnecting: false,
  walletClientData: { id: "wallet" } as { id: string } | undefined,
  walletClientRefetch: vi.fn(),
  switchChain: vi.fn<(variables: { chainId: number }, options?: { onSuccess?: () => void; onError?: (err: unknown) => void }) => void>(),
  openConnectModal: vi.fn(),
  getTransactionReceipt: vi.fn(),
  launchpad: "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a" as string | undefined,
}));
vi.mock("@/context/AppState", () => ({ useAppState: () => h.state }));
vi.mock("@/hooks/useLaunchpad", () => ({ useLaunchFees: () => ({ ...h.fees, refetch: h.refetch }) }));
vi.mock("wagmi", () => ({
  usePublicClient: () => ({ id: "public", getTransactionReceipt: h.getTransactionReceipt }),
  useWalletClient: () => ({ data: h.walletClientData, refetch: h.walletClientRefetch }),
  useAccount: () => ({ chainId: h.chainId, isReconnecting: h.isReconnecting }),
  useSwitchChain: () => ({ switchChain: h.switchChain }),
}));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: h.openConnectModal }) }));
vi.mock("@/lib/launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/launch")>()),
  collectLaunchFees: h.collect,
  claimOwed: h.claim,
  changePayout: h.change,
}));
// A getter, like src/lib/launch.test.ts's own mock of this module: vi.mock factories are hoisted above
// every other top-level statement, so this can only read a value that was itself created through vi.hoisted.
vi.mock("@/lib/launch/address", () => ({
  get LAUNCHPAD_ADDRESS() {
    return h.launchpad;
  },
}));

const pair = { id: TOKEN, ticker: "CHALK", quote: "USDG", address: TOKEN } as TokenPair;
const launch = {
  payout: PAYOUT, quoteAddress: USDG, quoteDecimals: 6, creatorShareBps: 7000,
  feesCollected: { tokenToPayout: String(770n * E18), tokenToPlatform: String(330n * E18), quoteToPayout: "7000000", quoteToPlatform: "3000000" },
  feesCollectedAt: 1_999_999_000,
} as unknown as LaunchInfo;
const NOW_MS = 2_000_000_000_000;
const ok = () => ({ hash: TX, confirmation: Promise.resolve() });

/** One FeesCollected log, built with viem so the encoding is the real one (mirrors src/lib/launch.test.ts's own
 * launchedLog for the sibling Launched event); `address` defaults to the mocked launchpad. */
const FEES_COLLECTED_NONINDEXED = LAUNCHPAD_EVENTS_ABI[1].inputs.filter((i) => !i.indexed);
function feesCollectedLog(
  args: { token: Address; payout: Address; tokenFees: bigint; quoteFees: bigint; tokenToPayout: bigint; quoteToPayout: bigint },
  address: Address = LAUNCHPAD,
): Log {
  const topics = encodeEventTopics({ abi: LAUNCHPAD_EVENTS_ABI, eventName: "FeesCollected", args: { token: args.token, payout: args.payout } });
  const data = encodeAbiParameters(FEES_COLLECTED_NONINDEXED, [args.tokenFees, args.quoteFees, args.tokenToPayout, args.quoteToPayout]);
  return {
    address, topics: topics as [Hex, ...Hex[]], data, blockHash: `0x${"00".repeat(32)}`, blockNumber: 77n, logIndex: 0,
    transactionHash: TX, transactionIndex: 0, removed: false,
  };
}
/** Matches h.fees.uncollected below: 700/300 CHALK, 7/3 USDG, so tests that don't care about the exact
 * split can reuse the same figures the panel already shows for "Uncollected fees". */
const DEFAULT_COLLECTED_LOG = feesCollectedLog({ token: TOKEN, payout: PAYOUT, tokenFees: 1000n * E18, quoteFees: 10_000_000n, tokenToPayout: 700n * E18, quoteToPayout: 7_000_000n });

/**
 * Drains the microtask queue several times over. `run()` awaits the write call, its confirmation, and (for
 * Collect) a receipt read, each already-resolved but each still costing a real tick; fake timers never touch
 * the microtask queue (only setTimeout/setInterval/Date), so this is safe under either.
 */
async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
function show() {
  const { client, wrapper: QueryWrapper } = queryHarness();
  const utils = render(
    <QueryWrapper>
      <LaunchFeesPanel pair={pair} launch={launch} now={NOW_MS} />
    </QueryWrapper>,
  );
  return {
    ...utils,
    client,
    /**
     * Re-renders the same tree inside the same QueryClientProvider, so a change to one of the `h.*` mocks
     * (which are not themselves reactive) is picked up on the next render pass. `launch` defaults to the
     * one this panel was first shown with; a test can pass a fresh object to stand in for what TokenView's
     * own usePair, subscribed to the same query this panel invalidates, would pass down once the store
     * catches up. This panel is rendered standalone here, with no such parent to do that on its own.
     */
    rerender: (next: { launch?: LaunchInfo } = {}) =>
      utils.rerender(
        <QueryWrapper>
          <LaunchFeesPanel pair={pair} launch={next.launch ?? launch} now={NOW_MS} />
        </QueryWrapper>,
      ),
  };
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
  h.isReconnecting = false;
  h.walletClientData = { id: "wallet" };
  h.walletClientRefetch.mockReset();
  h.switchChain.mockReset();
  h.openConnectModal.mockReset();
  h.getTransactionReceipt.mockReset().mockResolvedValue({ status: "success", logs: [DEFAULT_COLLECTED_LOG] });
  h.launchpad = LAUNCHPAD;
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
    expect(h.state.addToast).toHaveBeenCalledWith({ kind: "pending", message: "Collecting CHALK fees" });
    await waitFor(() => expect(h.state.updateToast).toHaveBeenCalledWith(7, { kind: "confirmed", message: "CHALK fees collected" }));
    expect(h.collect).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ publicClient: expect.objectContaining({ id: "public" }), account: STRANGER }));
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

describe("LaunchFeesPanel Collect is never enabled but inert (Review round 1, finding 1)", () => {
  it("collects even while the uncollected read is still loading", async () => {
    h.fees = { ...h.fees, uncollected: undefined, uncollectedFailed: false };
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
    });
    expect(h.collect).toHaveBeenCalled();
  });

  it("collects even while the uncollected read has failed", async () => {
    h.fees = { ...h.fees, uncollected: undefined, uncollectedFailed: true };
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
    });
    expect(h.collect).toHaveBeenCalled();
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
    expect(h.switchChain).toHaveBeenCalledWith({ chainId: CHAIN_ID }, expect.anything());
    expect(h.collect).not.toHaveBeenCalled();
  });

  it("reads Switch to Robinhood Chain on Claim on the wrong network, and switches instead of claiming", () => {
    h.chainId = 1;
    h.fees = { ...h.fees, owedQuote: 2_500_000n };
    show();
    const owed = within(screen.getByRole("region", { name: "Owed to you" }));
    fireEvent.click(owed.getByRole("button", { name: "Switch to Robinhood Chain" }));
    expect(h.switchChain).toHaveBeenCalledWith({ chainId: CHAIN_ID }, expect.anything());
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("reads Switch to Robinhood Chain on Change payout on the wrong network, and switches instead of opening the confirm step", () => {
    h.state.address = PAYOUT;
    h.chainId = 1;
    show();
    const section = within(screen.getByRole("region", { name: "Change payout" }));
    fireEvent.click(section.getByRole("button", { name: "Switch to Robinhood Chain" }));
    expect(h.switchChain).toHaveBeenCalledWith({ chainId: CHAIN_ID }, expect.anything());
    expect(section.queryByText("This is permanent.", { exact: false })).toBeNull();
  });
});

describe("LaunchFeesPanel connecting and reconnecting (Review round 1, finding 3 and 7)", () => {
  it("shows a disabled Connecting to your wallet state while wagmi is reconnecting, never an inert Connect wallet", () => {
    h.state.isConnected = false;
    h.state.address = undefined;
    h.isReconnecting = true;
    show();
    const button = screen.getByRole("button", { name: "Connecting to your wallet…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(h.openConnectModal).not.toHaveBeenCalled();
  });

  it("shows a disabled Connecting to your wallet state when the network is right but the wallet client has not resolved yet", () => {
    h.walletClientData = undefined;
    show();
    const button = screen.getByRole("button", { name: "Connecting to your wallet…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(h.collect).not.toHaveBeenCalled();
  });

  it("refetches the wallet client once the chain id reads Robinhood again after a switch", () => {
    h.chainId = 1;
    const { rerender } = show();
    expect(h.walletClientRefetch).not.toHaveBeenCalled();
    h.chainId = CHAIN_ID;
    rerender();
    expect(h.walletClientRefetch).toHaveBeenCalled();
  });

  it("shows a plain message when the wallet refuses to switch", () => {
    h.chainId = 1;
    h.switchChain.mockImplementation((_vars, options) => options?.onError?.(new Error("rejected")));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Switch to Robinhood Chain" }));
    expect(screen.getByRole("alert").textContent).toBe("Your wallet did not switch. Switch to Robinhood Chain in your wallet and try again.");
  });
});

describe("LaunchFeesPanel what Collect does (Review Focus 11)", () => {
  it("says in one line what Collect sends and who pays the gas", () => {
    show();
    expect(
      screen.getByText("Sends the fees gathered so far to the payout address and to MaxLong. Whoever presses this pays the gas."),
    ).toBeTruthy();
  });

  // Review round 1, finding 4: "Collected so far" sums every payout the token has ever had, so it always
  // reads "To payout"; only "Uncollected fees" (paid to the CURRENT payout on the next Collect) says "To you".
  it("labels the uncollected row 'To you' for the payout address; Collected so far always reads 'To payout'", () => {
    const { unmount } = show();
    const uncollectedStranger = within(screen.getByRole("region", { name: "Uncollected fees" }));
    expect(uncollectedStranger.getByText("To payout")).toBeTruthy();
    expect(uncollectedStranger.queryByText("To you")).toBeNull();
    const collectedStranger = within(screen.getByRole("region", { name: "Collected so far" }));
    expect(collectedStranger.getByText("To payout")).toBeTruthy();
    unmount();

    h.state.address = PAYOUT;
    show();
    const uncollected = within(screen.getByRole("region", { name: "Uncollected fees" }));
    expect(uncollected.getByText("To you")).toBeTruthy();
    const collected = within(screen.getByRole("region", { name: "Collected so far" }));
    expect(collected.getByText("To payout")).toBeTruthy();
    expect(collected.queryByText("To you")).toBeNull();
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

describe("LaunchFeesPanel Just collected reads the receipt (Review round 1, finding 2)", () => {
  it("shows the real split from the transaction's own FeesCollected event, not a pre-click guess", async () => {
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
      await flushMicrotasks();
    });
    expect(h.getTransactionReceipt).toHaveBeenCalledWith({ hash: TX });
    await waitFor(() =>
      expect(screen.getByText("Just collected: 700 CHALK · 7 USDG to the payout, 300 CHALK · 3 USDG to MaxLong.")).toBeTruthy(),
    );
  });

  it("reads 'to you' when the viewer is the payout address", async () => {
    h.state.address = PAYOUT;
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
      await flushMicrotasks();
    });
    await waitFor(() =>
      expect(screen.getByText("Just collected: 700 CHALK · 7 USDG to you, 300 CHALK · 3 USDG to MaxLong.")).toBeTruthy(),
    );
  });

  it("says only that the collection went through when the receipt cannot be read", async () => {
    h.getTransactionReceipt.mockReset().mockRejectedValue(new Error("network"));
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
      await flushMicrotasks();
    });
    await waitFor(() => expect(screen.getByText("Collected. Totals update shortly.")).toBeTruthy());
    expect(screen.queryByText(/Just collected/)).toBeNull();
  });

  it("says only that the collection went through when the receipt has no matching event", async () => {
    h.getTransactionReceipt.mockReset().mockResolvedValue({ status: "success", logs: [] });
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
      await flushMicrotasks();
    });
    await waitFor(() => expect(screen.getByText("Collected. Totals update shortly.")).toBeTruthy());
  });
});

describe("LaunchFeesPanel post-collect refresh (Review round 1, finding 8 and 9)", () => {
  it("invalidates the pair query right after Collect confirms", async () => {
    const { client } = show();
    const spy = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
    });
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["pair", TOKEN] })));
  });

  it("keeps asking every 10 seconds, stays at 13 invalidates past the cap, and keeps the line up because the store never caught up (finding 8)", async () => {
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
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200_000); // well past the 13-tick cap
      });
      expect(spy).toHaveBeenCalledTimes(13);
      // The cap stopped the polling (no more invalidates above), but the line's own visibility is a
      // render-time comparison against launch.feesCollectedAt (unchanged here), not a timer: it stays up
      // rather than vanish the way item 12 was meant to fix in the first place.
      expect(screen.getByText(/Just collected/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling once the store's own feesCollectedAt moves past what it was at collect time, and the line hides once that reaches this panel's own launch prop", async () => {
    vi.useFakeTimers();
    try {
      const { client, rerender } = show();
      // queryHarness()'s client uses gcTime 0 for test isolation; a query seeded below with no
      // observer would otherwise be garbage-collected on the very next fake timer tick, racing this
      // test's own setup rather than the component under test.
      client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
      const spy = vi.spyOn(client, "invalidateQueries");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
        await flushMicrotasks();
      });
      expect(screen.getByText(/Just collected/)).toBeTruthy();
      const updatedLaunch = { ...launch, feesCollectedAt: launch.feesCollectedAt + 60 };
      // The store folded the collect: its own copy of the pair now carries a newer feesCollectedAt.
      client.setQueryData(["pair", TOKEN], { ...pair, launch: updatedLaunch });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      const stoppedAt = spy.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(spy).toHaveBeenCalledTimes(stoppedAt); // no further polling once caught up

      // In the real app, TokenView's own usePair (subscribed to the same query this panel just
      // invalidated) would now re-render this panel with a fresh `launch` prop; simulated here since
      // this test renders the panel standalone, with no such parent above it.
      rerender({ launch: updatedLaunch });
      expect(screen.queryByText(/Just collected/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves no timer running once the panel unmounts mid-poll", async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = show();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
        await flushMicrotasks();
      });
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves no timer running when the panel unmounts before the collection even confirms (finding 9)", async () => {
    vi.useFakeTimers();
    try {
      let resolveConfirmation: () => void = () => {};
      h.collect.mockReset().mockImplementation(async () => ({
        hash: TX,
        confirmation: new Promise<void>((resolve) => {
          resolveConfirmation = resolve;
        }),
      }));
      const { unmount } = show();
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
      await flushMicrotasks();
      unmount();
      await act(async () => {
        resolveConfirmation();
        await flushMicrotasks();
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LaunchFeesPanel refuses addresses that would waste the fee stream (Review round 1, finding 6)", () => {
  beforeEach(() => {
    h.state.address = PAYOUT;
  });

  it("refuses the current payout address again", () => {
    show();
    fireEvent.change(screen.getByLabelText("New payout address"), { target: { value: PAYOUT } });
    expect(screen.getByText("That is already the payout address.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Change payout" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses the token's own address", () => {
    show();
    fireEvent.change(screen.getByLabelText("New payout address"), { target: { value: TOKEN } });
    expect(screen.getByText("Fees sent to a token contract can never be moved.")).toBeTruthy();
  });

  it("refuses the currency's own address", () => {
    show();
    fireEvent.change(screen.getByLabelText("New payout address"), { target: { value: USDG } });
    expect(screen.getByText("Fees sent to a token contract can never be moved.")).toBeTruthy();
  });

  it("refuses the launchpad contract", () => {
    show();
    fireEvent.change(screen.getByLabelText("New payout address"), { target: { value: LAUNCHPAD } });
    expect(screen.getByText("That is the launchpad contract. It cannot receive fees.")).toBeTruthy();
  });

  it("refuses the pool manager", () => {
    show();
    fireEvent.change(screen.getByLabelText("New payout address"), { target: { value: POOL_MANAGER } });
    expect(screen.getByText("That is the pool manager contract. It cannot receive fees.")).toBeTruthy();
  });

  it("shows the confirm step's address checksummed, never the raw lowercase paste", () => {
    show();
    fireEvent.change(screen.getByLabelText("New payout address"), { target: { value: LOWERCASE_TEST } });
    fireEvent.click(screen.getByRole("button", { name: "Change payout" }));
    expect(screen.getByText(getAddress(LOWERCASE_TEST))).toBeTruthy();
    expect(screen.queryByText(LOWERCASE_TEST)).toBeNull();
  });
});

describe("LaunchFeesPanel change payout confirm step (Review Focus 13, round 1 findings 5 and 10)", () => {
  beforeEach(() => {
    h.state.address = PAYOUT;
  });

  function openConfirm() {
    fireEvent.change(screen.getByLabelText("New payout address"), { target: { value: RESCUE } });
    fireEvent.click(screen.getByRole("button", { name: "Change payout" }));
  }

  // Review round 1, finding 13: round 1's rewrite of this describe block, needed because one click no
  // longer writes, dropped the only check on this line. Restored here, on the form before Change payout
  // is even pressed.
  it("warns before Change payout is pressed that a handover is permanent", () => {
    show();
    expect(screen.getByText("Once you hand the payout on, only the new address can change it.")).toBeTruthy();
  });

  it("opens a confirm step showing the full checksummed address and the word permanent, before any wallet call", () => {
    show();
    openConfirm();
    expect(screen.getByText(RESCUE)).toBeTruthy();
    expect(screen.getByText("This is permanent.", { exact: false })).toBeTruthy();
    expect(h.change).not.toHaveBeenCalled();
  });

  it("focuses the prompt when the confirm step opens, and announces it as a labelled group with Cancel before Confirm", () => {
    show();
    openConfirm();
    expect(document.activeElement?.id).toBe("payout-confirm-prompt");
    const group = screen.getByRole("group");
    expect(group.getAttribute("aria-labelledby")).toBe("payout-confirm-prompt");
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Confirm"]);
  });

  it("ignores a Confirm press for a short guard window after opening, so a double click meant for Change payout cannot land on it (finding 10)", async () => {
    vi.useFakeTimers();
    try {
      show();
      openConfirm();
      const confirmButton = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
      expect(confirmButton.disabled).toBe(true);
      fireEvent.click(confirmButton);
      expect(h.change).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
      });
      expect(confirmButton.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the write only once Confirm is pressed, after the guard window", async () => {
    vi.useFakeTimers();
    try {
      show();
      openConfirm();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
        await flushMicrotasks();
      });
      expect(h.change).toHaveBeenCalledWith(TOKEN, RESCUE, expect.objectContaining({ account: PAYOUT }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels back to the input without ever asking the wallet, and returns focus to it", () => {
    show();
    openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(RESCUE)).toBeNull();
    const input = screen.getByLabelText("New payout address");
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(h.change).not.toHaveBeenCalled();
  });

  it("on success, stops treating the viewer as the payout at once: closes the step, clears the field, drops To you and the loud Collect button (finding 5)", async () => {
    vi.useFakeTimers();
    try {
      show();
      openConfirm();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
        await flushMicrotasks();
      });
      expect(screen.queryByRole("group")).toBeNull();
      expect(screen.queryByRole("button", { name: "Change payout" })).toBeNull();
      const uncollected = within(screen.getByRole("region", { name: "Uncollected fees" }));
      expect(uncollected.queryByText("To you")).toBeNull();
      const collectButton = screen.getByRole("button", { name: "Collect fees" });
      expect(collectButton.className).not.toContain("bg-chalk");
    } finally {
      vi.useRealTimers();
    }
  });
});
