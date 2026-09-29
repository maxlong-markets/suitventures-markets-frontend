import { beforeEach, describe, expect, it, vi } from "vitest";
import { LaunchFailedError } from "@/lib/launch";
import type { Address, LaunchInfo, TokenPair } from "@/lib/types";
import { act, fireEvent, render, screen, waitFor, within } from "@/test/dom";
import LaunchFeesPanel from "./LaunchFeesPanel";

const TOKEN = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as Address;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const PAYOUT = "0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2" as Address;
const STRANGER = "0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1" as Address;
const RESCUE = "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1" as Address;
const TX = `0x${"11".repeat(32)}` as `0x${string}`;
const E18 = 10n ** 18n;

const h = vi.hoisted(() => ({
  state: { address: "0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1" as string | undefined, isConnected: true, addToast: vi.fn(() => 7), updateToast: vi.fn() },
  fees: {} as Record<string, unknown>,
  refetch: vi.fn(),
  collect: vi.fn(),
  claim: vi.fn(),
  change: vi.fn(),
}));
vi.mock("@/context/AppState", () => ({ useAppState: () => h.state }));
vi.mock("@/hooks/useLaunchpad", () => ({ useLaunchFees: () => ({ ...h.fees, refetch: h.refetch }) }));
vi.mock("wagmi", () => ({ usePublicClient: () => ({ id: "public" }), useWalletClient: () => ({ data: { id: "wallet" } }) }));
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
const show = () => render(<LaunchFeesPanel pair={pair} launch={launch} now={NOW_MS} />);

beforeEach(() => {
  h.state.address = STRANGER;
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

  it("lets the current payout change it, and says the change is permanent for this wallet", async () => {
    h.state.address = PAYOUT;
    show();
    expect(screen.getByText("Once you hand the payout on, only the new address can change it.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("New payout address"), { target: { value: RESCUE } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Change payout" }));
    });
    expect(h.change).toHaveBeenCalledWith(TOKEN, RESCUE, expect.objectContaining({ account: PAYOUT }));
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
