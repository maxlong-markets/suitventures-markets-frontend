import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex, type Log } from "viem";
import { LAUNCHPAD_EVENTS_ABI } from "@/lib/chain/abi";
import { LaunchFailedError } from "@/lib/launch";
import type { Address, LaunchInfo, TokenPair } from "@/lib/types";
import { act, fireEvent, queryHarness, render, screen, waitFor, within } from "@/test/dom";
import LaunchFeesPanel from "./LaunchFeesPanel";

const TOKEN = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as Address;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const PAYOUT = "0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2" as Address;
const CREATOR = "0xb3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3" as Address;
const STRANGER = "0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1" as Address;
// Its own checksum (getAddress(RESCUE) === RESCUE), for the claim address a wallet might paste.
const RESCUE = "0xE1E1E1e1E1E1e1e1E1E1E1e1e1e1E1E1E1E1e1e1" as Address;
const LAUNCHPAD = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a" as Address;
const TX = `0x${"11".repeat(32)}` as Hex;
const E18 = 10n ** 18n;
// robinhoodChain.id (src/lib/chain.ts); hardcoded here so the mock factory below (hoisted above imports)
// never has to reach for the real module.
const CHAIN_ID = 4663;

const h = vi.hoisted(() => ({
  state: { address: "0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2" as string | undefined, isConnected: true, addToast: vi.fn(() => 7), updateToast: vi.fn() },
  fees: {} as Record<string, unknown>,
  refetch: vi.fn(),
  collect: vi.fn(),
  claim: vi.fn(),
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
  // A new object on every render, as TanStack's query result is.
  useWalletClient: () => ({ data: h.walletClientData, refetch: h.walletClientRefetch }),
  useAccount: () => ({ chainId: h.chainId, isReconnecting: h.isReconnecting }),
  useSwitchChain: () => ({ switchChain: h.switchChain }),
}));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: h.openConnectModal }) }));
vi.mock("@/lib/launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/launch")>()),
  collectLaunchFees: h.collect,
  claimOwed: h.claim,
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
  creator: CREATOR, payout: PAYOUT, quoteAddress: USDG, quoteDecimals: 6, creatorShareBps: 7000,
  feesCollected: { tokenToPayout: String(770n * E18), tokenToPlatform: String(330n * E18), quoteToPayout: "7000000", quoteToPlatform: "3000000" },
  feesCollectedAt: 1_999_999_000,
} as unknown as LaunchInfo;
const NOW_MS = 2_000_000_000_000;
const ok = () => ({ hash: TX, confirmation: Promise.resolve() });

/** One FeesCollected log, built with viem so the encoding is the real one; `address` defaults to the mocked launchpad. */
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
/** Matches h.fees.uncollected below: 700 CHALK and 7 USDG to the payout address. */
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
     * (which are not themselves reactive) is picked up on the next render pass. A test can pass a fresh
     * `launch` to stand in for what TokenView's own usePair would pass down once the store catches up.
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
  h.state.address = PAYOUT;
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
  h.chainId = CHAIN_ID;
  h.isReconnecting = false;
  h.walletClientData = { id: "wallet" };
  h.walletClientRefetch.mockReset();
  h.switchChain.mockReset();
  h.openConnectModal.mockReset();
  h.getTransactionReceipt.mockReset().mockResolvedValue({ status: "success", logs: [DEFAULT_COLLECTED_LOG] });
  h.launchpad = LAUNCHPAD;
});

describe("LaunchFeesPanel is for the coin's owner only (30 Sep 2026)", () => {
  it("shows nothing to a wallet that is neither the payout address nor the creator", () => {
    h.state.address = STRANGER;
    show();
    expect(screen.queryByText("Pool fees")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows nothing with no wallet connected", () => {
    h.state.address = undefined;
    h.state.isConnected = false;
    show();
    expect(screen.queryByText("Pool fees")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the payout address its own side only: no MaxLong line and no Change payout", () => {
    show();
    expect(screen.getByText("Pool fees")).toBeTruthy();
    const uncollected = within(screen.getByRole("region", { name: "Uncollected fees" }));
    expect(uncollected.getByText("To you")).toBeTruthy();
    expect(uncollected.getByText("700 CHALK · 7 USDG")).toBeTruthy();
    const collected = within(screen.getByRole("region", { name: "Collected so far" }));
    expect(collected.getByText("To payout")).toBeTruthy();
    expect(collected.getByText("770 CHALK · 7 USDG")).toBeTruthy();
    // MaxLong's share, 300 and 330 CHALK in the fixtures, is nowhere on the panel.
    expect(screen.queryByText(/MaxLong/)).toBeNull();
    expect(screen.queryByText(/300 CHALK/)).toBeNull();
    expect(screen.queryByText(/330 CHALK/)).toBeNull();
    expect(screen.queryByText(/Change payout/i)).toBeNull();
    expect(screen.queryByLabelText("New payout address")).toBeNull();
    expect(screen.queryByRole("region", { name: "Owed to you" })).toBeNull();
    expect((screen.getByRole("button", { name: "Collect fees" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("shows the creator the panel too, reading To payout when the fees go to another address", () => {
    h.state.address = CREATOR;
    show();
    const uncollected = within(screen.getByRole("region", { name: "Uncollected fees" }));
    expect(uncollected.getByText("To payout")).toBeTruthy();
    expect(uncollected.queryByText("To you")).toBeNull();
    expect(screen.getByRole("button", { name: "Collect fees" })).toBeTruthy();
  });

  it("matches the owner without regard to the address's case", () => {
    h.state.address = getAddress(PAYOUT);
    show();
    expect(screen.getByText("Pool fees")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Uncollected fees" })).getByText("To you")).toBeTruthy();
  });

  it("titles the panel Pool fees, using the same words as the Info tab", () => {
    show();
    expect(screen.getByText("Pool fees")).toBeTruthy();
    expect(screen.queryByText("Launch fees")).toBeNull();
  });
});

describe("LaunchFeesPanel Collect", () => {
  it("collects, with the usual toasts, and re-reads the fees after", async () => {
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
    });
    expect(h.state.addToast).toHaveBeenCalledWith({ kind: "pending", message: "Collecting CHALK fees" });
    await waitFor(() => expect(h.state.updateToast).toHaveBeenCalledWith(7, { kind: "confirmed", message: "CHALK fees collected" }));
    expect(h.collect).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ publicClient: expect.objectContaining({ id: "public" }), account: PAYOUT }));
    expect(h.refetch).toHaveBeenCalled();
  });

  it("disables Collect with a reason when both amounts are zero", () => {
    h.fees = { ...h.fees, uncollected: { tokenFees: 0n, quoteFees: 0n, tokenToPayout: 0n, quoteToPayout: 0n, tokenToFeeWallet: 0n, quoteToFeeWallet: 0n } };
    show();
    expect((screen.getByRole("button", { name: "Collect fees" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Nothing to collect yet.")).toBeTruthy();
  });

  it("says it could not read the uncollected fees and keeps Collect usable, never showing zeros", () => {
    h.fees = { ...h.fees, uncollected: undefined, uncollectedFailed: true };
    show();
    expect(screen.getByText("Could not read the uncollected fees just now.")).toBeTruthy();
    expect(screen.queryByText("Nothing to collect yet.")).toBeNull();
    expect((screen.getByRole("button", { name: "Collect fees" }) as HTMLButtonElement).disabled).toBe(false);
  });

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

  it("shows a refused write's own words", async () => {
    h.collect.mockRejectedValueOnce(new LaunchFailedError("Nothing to collect yet.", "NothingToCollect"));
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Nothing to collect yet."));
  });
});

describe("LaunchFeesPanel owed amounts", () => {
  it("shows an owed balance with a Claim per currency, to an address that defaults to the wallet and can be changed", async () => {
    h.fees = { ...h.fees, owedToken: 5n * E18, owedQuote: 2_500_000n };
    show();
    const owed = within(screen.getByRole("region", { name: "Owed to you" }));
    expect(owed.getByText("5 CHALK")).toBeTruthy();
    expect(owed.getByText("2.5 USDG")).toBeTruthy();
    expect((owed.getByLabelText("Send to") as HTMLInputElement).value).toBe(PAYOUT);
    await act(async () => {
      fireEvent.click(owed.getByRole("button", { name: "Claim USDG" }));
    });
    expect(h.claim).toHaveBeenLastCalledWith(USDG, PAYOUT, expect.anything());
    fireEvent.change(owed.getByLabelText("Send to"), { target: { value: RESCUE } });
    await act(async () => {
      fireEvent.click(owed.getByRole("button", { name: "Claim CHALK" }));
    });
    expect(h.claim).toHaveBeenLastCalledWith(TOKEN, RESCUE, expect.anything());
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

describe("LaunchFeesPanel wallet states", () => {
  it("reads Connect wallet when the owner's wallet is known but not connected, and opens the connect modal instead of collecting", () => {
    h.state.isConnected = false;
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
    fireEvent.click(screen.getByRole("button", { name: "Switch to Robinhood Chain" }));
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

  it("shows a disabled Connecting to your wallet state while wagmi is reconnecting, never an inert Connect wallet", () => {
    h.state.isConnected = false;
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

  // The mocked query result is a new object on every render, as TanStack's is. Depending on it refetched on every
  // render on Robinhood Chain, which built a new client, re-rendered and refetched again: an endless loop for every
  // connected viewer. On that code this fails at the first assertion, since the mount itself refetched.
  it("refetches once per switch, and never on a plain render on Robinhood Chain", () => {
    const { rerender } = show();
    rerender();
    rerender();
    expect(h.walletClientRefetch).not.toHaveBeenCalled();
    h.chainId = 1;
    rerender();
    h.chainId = CHAIN_ID;
    rerender();
    rerender();
    rerender();
    expect(h.walletClientRefetch).toHaveBeenCalledTimes(1);
  });

  it("shows a plain message when the wallet refuses to switch, and drops it once the wallet is on Robinhood Chain", () => {
    h.chainId = 1;
    h.switchChain.mockImplementation((_vars, options) => options?.onError?.(new Error("rejected")));
    const { rerender } = show();
    fireEvent.click(screen.getByRole("button", { name: "Switch to Robinhood Chain" }));
    expect(screen.getByRole("alert").textContent).toBe("Your wallet did not switch. Switch to Robinhood Chain in your wallet and try again.");
    h.chainId = CHAIN_ID;
    rerender();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Collect fees" })).toBeTruthy();
  });
});

describe("LaunchFeesPanel Just collected reads the receipt", () => {
  const collect = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
      await flushMicrotasks();
    });
  };

  it("shows what the transaction paid the payout address, from its own FeesCollected event, and nothing about MaxLong", async () => {
    show();
    await collect();
    expect(h.getTransactionReceipt).toHaveBeenCalledWith({ hash: TX });
    await waitFor(() => expect(screen.getByText("Just collected: 700 CHALK · 7 USDG to you.")).toBeTruthy());
    expect(screen.queryByText(/MaxLong/)).toBeNull();
  });

  it("says only that the collection went through when the receipt cannot be read", async () => {
    h.getTransactionReceipt.mockReset().mockRejectedValue(new Error("network"));
    show();
    await collect();
    await waitFor(() => expect(screen.getByText("Collected. Totals update shortly.")).toBeTruthy());
    expect(screen.queryByText(/Just collected/)).toBeNull();
  });

  it("says only that the collection went through when the receipt has no matching event", async () => {
    h.getTransactionReceipt.mockReset().mockResolvedValue({ status: "success", logs: [] });
    show();
    await collect();
    await waitFor(() => expect(screen.getByText("Collected. Totals update shortly.")).toBeTruthy());
  });

  const OTHER_CONTRACT = "0x00000000000000000000000000000000000000f2" as Address;
  const OTHER_TOKEN = "0x00000000000000000000000000000000000000f1" as Address;
  /** The same event from a contract that is not the launchpad: anyone can emit one. */
  const spoofed = () =>
    feesCollectedLog({ token: TOKEN, payout: PAYOUT, tokenFees: 9n * E18, quoteFees: 9_000_000n, tokenToPayout: 9n * E18, quoteToPayout: 9_000_000n }, OTHER_CONTRACT);
  /** A real launchpad event for a different token, as a batched transaction could carry. */
  const anotherTokens = () =>
    feesCollectedLog({ token: OTHER_TOKEN, payout: PAYOUT, tokenFees: 5n * E18, quoteFees: 5_000_000n, tokenToPayout: 5n * E18, quoteToPayout: 5_000_000n });

  // Amounts unlike the mocked uncollected read (700 and 7), so a figure taken from anywhere but this token's own
  // launchpad log cannot pass. Dropping either filter in readPaid shows the 9s or the 5s instead.
  it("reads this token's log from the launchpad only, past a spoofed log and another token's", async () => {
    const real = feesCollectedLog({ token: TOKEN, payout: PAYOUT, tokenFees: 200n * E18, quoteFees: 20_000_000n, tokenToPayout: 140n * E18, quoteToPayout: 14_000_000n });
    h.getTransactionReceipt.mockReset().mockResolvedValue({ status: "success", logs: [spoofed(), anotherTokens(), real] });
    show();
    await collect();
    await waitFor(() => expect(screen.getByText("Just collected: 140 CHALK · 14 USDG to you.")).toBeTruthy());
  });

  it("shows no figure when the only logs are a spoofed one and another token's", async () => {
    h.getTransactionReceipt.mockReset().mockResolvedValue({ status: "success", logs: [spoofed(), anotherTokens()] });
    show();
    await collect();
    await waitFor(() => expect(screen.getByText("Collected. Totals update shortly.")).toBeTruthy());
    expect(screen.queryByText(/Just collected/)).toBeNull();
  });

  it("says 'to you' by the address the transaction paid, not by who is looking", async () => {
    // The creator presses Collect; the fees went to the payout address, which is another wallet.
    h.state.address = CREATOR;
    const { unmount } = show();
    await collect();
    await waitFor(() => expect(screen.getByText("Just collected: 700 CHALK · 7 USDG to the payout.")).toBeTruthy());
    unmount();

    // The same creator, on a collection that paid the creator's own address.
    const paidCreator = feesCollectedLog({ token: TOKEN, payout: CREATOR, tokenFees: 1000n * E18, quoteFees: 10_000_000n, tokenToPayout: 700n * E18, quoteToPayout: 7_000_000n });
    h.getTransactionReceipt.mockReset().mockResolvedValue({ status: "success", logs: [paidCreator] });
    show();
    await collect();
    await waitFor(() => expect(screen.getByText("Just collected: 700 CHALK · 7 USDG to you.")).toBeTruthy());
  });

  // StrictMode, which the App Router turns on in development, mounts, unmounts and mounts again. A mounted flag that
  // was only ever set to false then silenced every update after a confirmed write: no line at all on that code.
  it("still reports a collection under StrictMode's mount, unmount and mount again", async () => {
    const { wrapper: QueryWrapper } = queryHarness();
    render(
      <StrictMode>
        <QueryWrapper>
          <LaunchFeesPanel pair={pair} launch={launch} now={NOW_MS} />
        </QueryWrapper>
      </StrictMode>,
    );
    await collect();
    await waitFor(() => expect(screen.getByText(/Just collected: 700 CHALK/)).toBeTruthy());
  });
});

describe("LaunchFeesPanel post-collect refresh", () => {
  it("invalidates the pair query right after Collect confirms", async () => {
    const { client } = show();
    const spy = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collect fees" }));
    });
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["pair", TOKEN] })));
  });

  it("keeps asking every 10 seconds, stays at 13 invalidates past the cap, and keeps the line up because the store never caught up", async () => {
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
      // The cap stopped the polling, but the line's own visibility is a render-time comparison against
      // launch.feesCollectedAt (unchanged here), not a timer: it stays up.
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
      // observer would otherwise be garbage-collected on the very next fake timer tick.
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

      // In the real app, TokenView's own usePair would now re-render this panel with a fresh `launch` prop.
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

  it("leaves no timer running when the panel unmounts before the collection even confirms", async () => {
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
