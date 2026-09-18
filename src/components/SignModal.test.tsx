import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "@/lib/types";
import { short } from "@/lib/format";
import { act, fireEvent, render, screen, waitFor } from "@/test/dom";
import SignModal from "./SignModal";

const WALLET = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" as Address;

const h = vi.hoisted(() => ({
  state: {
    signModal: { kind: "star" as "star" | "vote" },
    address: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" as string | undefined,
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
    h.state.completeSign.mockReset().mockResolvedValue(undefined);
    h.state.cancelSign.mockReset();
    h.signMessageAsync.mockClear();
  });

  it("shows what is about to be signed without inventing a message", () => {
    render(<SignModal />);
    expect(screen.getByText(`Sign in to SuitVentures Markets · ${short(WALLET)} · Chain 4663`)).toBeTruthy();
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
});
