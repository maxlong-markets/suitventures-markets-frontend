import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex, SignMessage, VoteDir } from "@/lib/types";
import { keys } from "@/hooks/useMarketsData";
import { act, fireEvent, queryHarness, render, screen, waitFor } from "@/test/dom";
import { AppStateProvider, useAppState, type AppState } from "./AppState";

/** Checksummed, as wagmi reports it; the server's copy below is lowercase, as the cookie carries it. */
const WALLET = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" as Address;
const LOWER = WALLET.toLowerCase() as Address;
const TOKEN = "0x000000000000000000000000000000000000000a";

const h = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, isConnected: false },
  openConnectModal: vi.fn(),
  ds: {
    session: vi.fn<() => Promise<string | null>>(),
    signIn: vi.fn<(sign: SignMessage, address: string) => Promise<string>>(),
    signOut: vi.fn<() => Promise<void>>(),
    watchlist: vi.fn<() => Promise<string[]>>(),
    setWatch: vi.fn<(id: string, on: boolean) => Promise<void>>(),
    votes: vi.fn<() => Promise<Record<string, VoteDir>>>(),
    vote: vi.fn<(id: string, dir: VoteDir) => Promise<VoteDir | null>>(),
  },
}));

vi.mock("wagmi", () => ({ useAccount: () => h.account }));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: h.openConnectModal }) }));
vi.mock("@/lib/suits", () => ({ useIsSuitHolder: () => false }));
// `AppState.tsx` imports this as "./DataSource"; Vitest keys mocks by resolved path, and the `@/`
// alias resolves to the same file, so the spelling here does not have to match the import's.
vi.mock("@/context/DataSource", () => ({ useDataSource: () => h.ds }));

/** The fake wallet: one signature, always accepted, recorded for the assertion. */
const sign: SignMessage = vi.fn(async () => "0xsignature" as Hex);

/**
 * The live context value, captured after each commit. `completeSign` returns a promise that
 * rejects when the wallet or the server refuses, and a rejection nobody holds is an unhandled
 * error Vitest 4 fails the whole run on — so the refusal case awaits it from here instead of
 * firing it from a click and dropping it.
 */
let api: AppState | null = null;

function Probe() {
  const s = useAppState();
  useEffect(() => {
    api = s;
  });
  return (
    <div>
      <div data-testid="signed">{String(s.signed)}</div>
      <div data-testid="modal">{s.signModal?.kind ?? "none"}</div>
      <div data-testid="stars">{[...s.stars].join(",")}</div>
      <button type="button" onClick={() => s.toggleStar(TOKEN)}>
        star
      </button>
      <button
        type="button"
        // The real `SignModal` awaits inside a try/catch; the button must not float a rejection
        // either, so every path out of a click is handled.
        onClick={() => {
          s.completeSign(sign, WALLET).catch(() => {});
        }}
      >
        complete
      </button>
    </div>
  );
}

function show() {
  const { client, wrapper: QueryWrapper } = queryHarness();
  // A factory, not a single element kept around: `rerender` with the very same element object
  // gives every fiber down to `Probe` referentially-equal props, which lets React bail out of
  // the subtree entirely — including the `useAccount()` call a wallet-switch test depends on. A
  // freshly built element each time has the same shape but a new identity, so nothing bails out.
  const buildTree = () => (
    <QueryWrapper>
      <AppStateProvider>
        <Probe />
      </AppStateProvider>
    </QueryWrapper>
  );
  const result = render(buildTree());
  return { ...result, client, rerenderApp: () => result.rerender(buildTree()) };
}

describe("AppStateProvider sign-in", () => {
  beforeEach(() => {
    api = null;
    h.account = { address: WALLET, isConnected: true };
    h.openConnectModal.mockClear();
    h.ds.session.mockReset().mockResolvedValue(null);
    h.ds.signIn.mockReset().mockResolvedValue(LOWER);
    h.ds.watchlist.mockReset().mockResolvedValue([TOKEN]);
    h.ds.votes.mockReset().mockResolvedValue({});
    h.ds.setWatch.mockReset().mockResolvedValue(undefined);
    h.ds.vote.mockReset().mockResolvedValue("bull");
    (sign as ReturnType<typeof vi.fn>).mockClear();
  });

  it("seeds the session from the cookie, matching a lowercase address to a checksummed wallet", async () => {
    h.ds.session.mockResolvedValue(LOWER);
    show();
    await waitFor(() => expect(screen.getByTestId("signed").textContent).toBe("true"));
    // Signed in without a modal: the whole point of the cookie surviving a reload.
    expect(screen.getByTestId("modal").textContent).toBe("none");
    await waitFor(() => expect(h.ds.watchlist).toHaveBeenCalled());
  });

  it("leaves the user's lists alone until a session exists", async () => {
    show();
    await waitFor(() => expect(h.ds.session).toHaveBeenCalled());
    expect(h.ds.watchlist).not.toHaveBeenCalled();
    expect(h.ds.votes).not.toHaveBeenCalled();
  });

  it("opens the modal on a gated action and runs it once the sign-in lands", async () => {
    show();
    await waitFor(() => expect(h.ds.session).toHaveBeenCalled());

    fireEvent.click(screen.getByText("star"));
    expect(screen.getByTestId("modal").textContent).toBe("star");
    expect(h.ds.setWatch).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByText("complete"));
    });

    expect(h.ds.signIn).toHaveBeenCalledWith(sign, WALLET);
    await waitFor(() => expect(screen.getByTestId("signed").textContent).toBe("true"));
    expect(screen.getByTestId("modal").textContent).toBe("none");
    await waitFor(() => expect(h.ds.setWatch).toHaveBeenCalledWith(TOKEN, true));
    // The star is painted before the write settles and stays after the refetch.
    await waitFor(() => expect(screen.getByTestId("stars").textContent).toBe(TOKEN));
  });

  it("keeps the modal open and the session empty when the wallet or the server refuses", async () => {
    h.ds.signIn.mockRejectedValue(new Error("401"));
    show();
    await waitFor(() => expect(h.ds.session).toHaveBeenCalled());
    fireEvent.click(screen.getByText("star"));
    expect(screen.getByTestId("modal").textContent).toBe("star");

    // The rejection is awaited here rather than fired from the button and dropped: `completeSign`
    // must let the failure travel — that is how `SignModal` knows to stay open and show its line —
    // and a floating rejection is an unhandled error Vitest fails the run on.
    await act(async () => {
      await expect(api!.completeSign(sign, WALLET)).rejects.toThrow("401");
    });

    expect(screen.getByTestId("signed").textContent).toBe("false");
    expect(screen.getByTestId("modal").textContent).toBe("star");
    expect(h.ds.setWatch).not.toHaveBeenCalled();
  });

  it("asks for a wallet before a signature when nothing is connected", async () => {
    h.account = { address: undefined, isConnected: false };
    show();
    fireEvent.click(screen.getByText("star"));
    expect(h.openConnectModal).toHaveBeenCalled();
    expect(screen.getByTestId("modal").textContent).toBe("none");
  });

  it("drops the queued action on a refused sign-in, so a later successful sign-in does not run it", async () => {
    h.ds.signIn.mockRejectedValueOnce(new Error("401"));
    show();
    await waitFor(() => expect(h.ds.session).toHaveBeenCalled());

    fireEvent.click(screen.getByText("star"));
    expect(screen.getByTestId("modal").textContent).toBe("star");

    // First attempt: the wallet or the server refuses. The modal stays open for a retry, but the
    // queued star must not survive the refusal.
    await act(async () => {
      fireEvent.click(screen.getByText("complete"));
    });
    await waitFor(() => expect(h.ds.signIn).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("signed").textContent).toBe("false");
    expect(screen.getByTestId("modal").textContent).toBe("star");

    // Second attempt from the same still-open modal: the mocked signIn now resolves (the
    // one-time rejection above is already consumed), so the sign-in itself succeeds — but the
    // star queued before the refusal must not fire on its own.
    await act(async () => {
      fireEvent.click(screen.getByText("complete"));
    });
    await waitFor(() => expect(screen.getByTestId("signed").textContent).toBe("true"));
    expect(screen.getByTestId("modal").textContent).toBe("none");
    expect(h.ds.setWatch).not.toHaveBeenCalled();
  });

  it("drops a previous wallet's watchlist and votes the moment a different wallet connects", async () => {
    const WALLET_B = "0x1111111111111111111111111111111111111111" as Address;
    h.ds.session.mockResolvedValue(LOWER);
    h.ds.votes.mockResolvedValue({ [TOKEN]: "bull" });
    const { client, rerenderApp } = show();

    await waitFor(() => expect(screen.getByTestId("stars").textContent).toBe(TOKEN));
    await waitFor(() => expect(client.getQueryData(keys.votes)).toEqual({ [TOKEN]: "bull" }));

    // Wallet A disconnects and a different wallet, B, takes its place in the same tab. Nothing
    // about B has signed in yet, so B must not render a single answer that belongs to A.
    h.account = { address: WALLET_B, isConnected: true };
    rerenderApp();

    await waitFor(() => expect(client.getQueryData(keys.watchlist)).toBeUndefined());
    expect(client.getQueryData(keys.votes)).toBeUndefined();
    expect(screen.getByTestId("signed").textContent).toBe("false");
    expect(screen.getByTestId("stars").textContent).toBe("");
  });
});
