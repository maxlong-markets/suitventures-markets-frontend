import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GateKind } from "@/context/AppState";
import type { Address } from "@/lib/types";
import { short } from "@/lib/format";
import { act, fireEvent, render, screen, waitFor } from "@/test/dom";
import SignModal from "./SignModal";

const WALLET = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" as Address;

const h = vi.hoisted(() => ({
  state: {
    signModal: { kind: "star" } as { kind: GateKind; for?: string },
    address: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" as string | undefined,
    signed: false,
    completeSign: vi.fn<(sign: (m: string) => Promise<string>, address: string) => Promise<void>>(),
    cancelSign: vi.fn(),
  },
  signMessageAsync: vi.fn(async () => "0xsignature"),
}));

vi.mock("@/context/AppState", () => ({ useAppState: () => h.state }));
vi.mock("wagmi", () => ({
  useSignMessage: () => ({ signMessageAsync: h.signMessageAsync, isPending: false }),
}));

describe("SignModal", () => {
  beforeEach(() => {
    h.state.signModal = { kind: "star" };
    h.state.address = WALLET;
    h.state.signed = false;
    h.state.completeSign.mockReset().mockResolvedValue(undefined);
    h.state.cancelSign.mockReset();
    h.signMessageAsync.mockClear();
  });

  it("shows what is about to be signed without inventing a message", () => {
    render(<SignModal />);
    expect(screen.getByText(`Sign in to MaxLong Markets · ${short(WALLET)} · Chain 4663`)).toBeTruthy();
    expect(screen.getByText("Sign to save your watchlist")).toBeTruthy();
  });

  it("hands a signer and the address to completeSign, and signs nothing itself", async () => {
    render(<SignModal />);
    await act(async () => {
      fireEvent.click(screen.getByText("Sign message"));
    });
    expect(h.state.completeSign).toHaveBeenCalledTimes(1);
    const [sign, address] = h.state.completeSign.mock.calls[0];
    expect(address).toBe(WALLET);
    // The modal builds no text: the message it signs is the one it is handed.
    expect(h.signMessageAsync).not.toHaveBeenCalled();
    await sign("the server's message");
    expect(h.signMessageAsync).toHaveBeenCalledWith({ message: "the server's message" });
  });

  it("stays open with one plain line when the sign-in fails", async () => {
    h.state.completeSign.mockRejectedValue(new Error("401"));
    render(<SignModal />);
    await act(async () => {
      fireEvent.click(screen.getByText("Sign message"));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Sign-in didn't complete. Nothing was saved."));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("renders nothing without a gate or without a wallet", () => {
    h.state.address = undefined;
    const { container } = render(<SignModal />);
    expect(container.firstChild).toBeNull();
  });

  it("says what a launch sign-in is for", () => {
    h.state.signModal = { kind: "launch" };
    render(<SignModal />);
    expect(screen.getByText("Sign to launch a token")).toBeTruthy();
    expect(screen.getByText(/ties your uploads to this address/)).toBeTruthy();
  });

  it("says what the connect-time sign-in is for", () => {
    h.state.signModal = { kind: "connect", for: WALLET.toLowerCase() };
    render(<SignModal />);
    expect(screen.getByText("Sign in to MaxLong Markets")).toBeTruthy();
    expect(screen.getByText(/watchlist, votes and launch images/)).toBeTruthy();
  });

  it("shows nothing for a connect-time ask once the wallet is signed in", () => {
    h.state.signModal = { kind: "connect", for: WALLET };
    h.state.signed = true;
    const { container } = render(<SignModal />);
    expect(container.firstChild).toBeNull();
  });

  it("shows nothing for a connect-time ask meant for another wallet", () => {
    h.state.signModal = { kind: "connect", for: "0x1111111111111111111111111111111111111111" };
    const { container } = render(<SignModal />);
    expect(container.firstChild).toBeNull();
  });
});
