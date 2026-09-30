import { beforeEach, describe, expect, it, vi } from "vitest";
import { robinhoodChain, txUrl } from "@/lib/chain";
import {
  LAUNCH_MESSAGES, LaunchExistsError, LaunchFailedError, LaunchRejectedError, LaunchUnconfirmedError, messageForRevert,
} from "@/lib/launch";
import { UPLOAD_MESSAGES, UploadError } from "@/lib/launch/client";
import { estimateFirstBuyTokens, minFirstBuyTokens } from "@/lib/launch/math";
import type { Address, QuoteAsset } from "@/lib/types";
import { act, fireEvent, render, screen, waitFor, within } from "@/test/dom";
import LaunchForm from "./LaunchForm";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const OTHER_WALLET = "0x2222222222222222222222222222222222222222" as Address;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const AMC = "0x05a3d1cd21d0c88145e82600e62e7e496e0f222b" as Address;
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" as Address;
const TOKEN = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as Address;
const TX = `0x${"11".repeat(32)}` as `0x${string}`;
const SNAPPED = 4_995_430_000n; // $4,995.43
const ANSWER = { imageCid: "bafyimg", metadataCid: "bafymeta", metadataUri: "ipfs://bafymeta" };

const QUOTES: QuoteAsset[] = [
  { symbol: "NVDA", name: "NVIDIA", address: NVDA, decimals: 18, usdPrice: 120, pairs: 3, vol24h: 900, stale: false },
  { symbol: "AMC", name: "AMC Entertainment", address: AMC, decimals: 18, usdPrice: 0, pairs: 1, vol24h: 10, stale: true },
  { symbol: "USDG", name: "Global Dollar", address: USDG, decimals: 6, usdPrice: 1, pairs: 5, vol24h: 100, stale: false },
];

const h = vi.hoisted(() => ({
  state: {
    address: "0x1111111111111111111111111111111111111111" as string | undefined,
    isConnected: true,
    signed: true,
    withSignIn: vi.fn(),
    dropSession: vi.fn(),
    addToast: vi.fn(() => 1),
    updateToast: vi.fn(),
  },
  settings: {} as Record<string, unknown>,
  bounds: {} as Record<string, { min: bigint; max: bigint; creationFee: bigint }>,
  opening: { token: "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a", openTick: -398_400, snapped: 4_995_430_000n as bigint | undefined, pending: false },
  balance: 1_000_000_000n as bigint | undefined,
  quotes: [] as unknown[],
  upload: vi.fn(),
  execute: vi.fn(),
  push: vi.fn(),
  refetch: vi.fn(),
  chainId: 46630 as number | undefined,
  wallet: { id: "wallet" } as unknown,
}));

vi.mock("@/context/AppState", () => ({ useAppState: () => h.state }));
vi.mock("@/hooks/useMarketsData", () => ({ useQuotes: () => ({ data: h.quotes }) }));
vi.mock("@/hooks/useLaunchpad", () => ({
  useLaunchSettings: () => h.settings,
  useCurrencyConfig: (quote?: string) => {
    const b = quote ? h.bounds[quote.toLowerCase()] : undefined;
    return b ? { ...b, refetch: h.refetch } : undefined;
  },
  useOpening: () => h.opening,
  useTokenBalanceOf: () => h.balance,
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ chainId: h.chainId }),
  usePublicClient: () => ({ id: "public" }),
  useWalletClient: () => ({ data: h.wallet }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/lib/launch/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/launch/client")>()), uploadLaunchAssets: h.upload }));
vi.mock("@/lib/launch", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/launch")>()), executeLaunch: h.execute }));

beforeEach(() => {
  h.state.address = WALLET;
  h.state.isConnected = true;
  h.state.signed = true;
  h.state.withSignIn.mockReset();
  h.state.dropSession.mockReset();
  h.state.addToast.mockClear();
  h.state.updateToast.mockClear();
  h.settings = {
    allowed: true, launchesToday: 0, dailyLimit: 5, routerFeeBps: 50, creatorShareBps: 7000, firstBuyCapBps: 2000,
    hook: "0x0000000000000000000000000000000000000000",
  };
  // jsdom has no object URLs; the form's image preview needs both.
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  h.bounds = {
    [USDG]: { min: 5_000_000_000n, max: 10_000_000_000_000n, creationFee: 0n },
    [AMC]: { min: 50n * 10n ** 18n, max: 100_000n * 10n ** 18n, creationFee: 0n },
  };
  h.opening = { token: TOKEN, openTick: -398_400, snapped: SNAPPED, pending: false };
  h.balance = 1_000_000_000n; // 1,000 USDG
  h.quotes = QUOTES;
  h.upload.mockReset().mockResolvedValue(ANSWER);
  h.execute.mockReset().mockResolvedValue({ hash: TX, confirmation: Promise.resolve({ token: TOKEN }) });
  h.push.mockReset();
  h.refetch.mockReset();
  h.chainId = robinhoodChain.id;
  h.wallet = { id: "wallet" };
});

function fill(o: { name?: string; symbol?: string } = {}) {
  fireEvent.change(screen.getByLabelText("Image"), { target: { files: [new File([new Uint8Array(10)], "logo.png", { type: "image/png" })] } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: o.name ?? "Tailor's Chalk" } });
  fireEvent.change(screen.getByLabelText("Symbol"), { target: { value: o.symbol ?? "CHALK" } });
}
const launch = () => screen.getByRole("button", { name: "Launch" });
const press = async () => {
  await act(async () => {
    fireEvent.click(launch());
  });
};

describe("LaunchForm: the button's reasons, first match wins (spec 7.2)", () => {
  it("asks for a wallet, then a Suit, then a launch left today, then the fields", () => {
    h.state.isConnected = false;
    h.state.address = undefined;
    const { rerender } = render(<LaunchForm />);
    expect(screen.getByText("Connect a wallet to launch.")).toBeTruthy();
    expect((launch() as HTMLButtonElement).disabled).toBe(true);
    h.state.isConnected = true;
    h.state.address = WALLET;
    h.settings = { ...h.settings, allowed: false };
    rerender(<LaunchForm />);
    expect(screen.getByText("Launching is open to Suits holders.")).toBeTruthy();
    h.settings = { ...h.settings, allowed: true, launchesToday: 5 };
    rerender(<LaunchForm />);
    expect(screen.getByText("You have used today's launches.")).toBeTruthy();
    h.settings = { ...h.settings, launchesToday: 2 };
    rerender(<LaunchForm />);
    expect(screen.getByText("Add an image, a name and a symbol.")).toBeTruthy();
    expect(screen.getByText("3 of 5 left today. The count resets at 00:00 UTC.")).toBeTruthy();
  });

  it("waits for every setting the contract answers, never assuming 0 (fee, cap, share or hook unread)", () => {
    for (const key of ["routerFeeBps", "firstBuyCapBps", "creatorShareBps", "hook", "launchesToday", "dailyLimit"]) {
      h.settings = { allowed: true, launchesToday: 0, dailyLimit: 5, routerFeeBps: 50, creatorShareBps: 7000, firstBuyCapBps: 2000, hook: "0x0000000000000000000000000000000000000000", [key]: undefined };
      const { unmount } = render(<LaunchForm />);
      fill();
      expect(screen.getByText("Reading the launchpad's settings.")).toBeTruthy();
      expect((launch() as HTMLButtonElement).disabled).toBe(true);
      unmount();
    }
  });

  it("waits while the opening read is pending, so a click never uses a stale snapped valuation", async () => {
    h.opening = { token: TOKEN, openTick: -398_400, snapped: SNAPPED, pending: true };
    render(<LaunchForm />);
    fill();
    expect(screen.getByText("Working out the opening price.")).toBeTruthy();
    expect((launch() as HTMLButtonElement).disabled).toBe(true);
    await press();
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("refuses to launch while the launchpad has a hook set, as the contracts README promises", () => {
    h.settings = { ...h.settings, hook: "0x00000000000000000000000000000000000000c0" };
    render(<LaunchForm />);
    fill();
    expect(screen.getByText("Launches are paused while a hook is set.")).toBeTruthy();
    expect((launch() as HTMLButtonElement).disabled).toBe(true);
  });

  it("counts the name in bytes: 8 rockets fit, 9 do not (Review Focus 1)", () => {
    render(<LaunchForm />);
    fill({ name: "🚀".repeat(8) });
    expect(screen.getByText("32/32 bytes")).toBeTruthy();
    expect((launch() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "🚀".repeat(9) } });
    expect(screen.getByText("36/32 bytes")).toBeTruthy();
    expect(screen.getByText("The name fits 32 bytes and the symbol 11.")).toBeTruthy();
  });

  it("refuses a valuation outside the currency's bounds, a first buy above the balance, then one above the cap", () => {
    render(<LaunchForm />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("Custom valuation"), { target: { value: "1000" } });
    expect(screen.getByText("Pick a valuation between $5,000 and $10,000,000.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "$5,000" }));
    fireEvent.change(screen.getByLabelText("First buy"), { target: { value: "2000" } });
    expect(screen.getByText("The first buy is more than your balance.")).toBeTruthy();
    h.balance = 10_000_000_000n; // 10,000 USDG
    fireEvent.change(screen.getByLabelText("First buy"), { target: { value: "1999" } });
    expect(screen.getByText("The first buy is above the cap.")).toBeTruthy();
  });

  it("reads the fee share from the contract, never a fixed 70 %, and shows the snapped opening in USD", () => {
    h.settings = { ...h.settings, creatorShareBps: 6500 };
    render(<LaunchForm />);
    expect(screen.getByText("65 % of trading fees to your payout address")).toBeTruthy();
    expect(["$5,000", "$10,000", "$25,000", "$100,000"].every((label) => screen.getByRole("button", { name: label }))).toBe(true);
    expect(screen.getByText("Opens at $4,995 · $0.000004995 per token")).toBeTruthy();
    expect(screen.getByText("Gas only")).toBeTruthy();
    expect(screen.getByText("Buys worth about 41 % of the opening valuation double the price, plus the 1 % pool fee.")).toBeTruthy();
  });

  it("works in the currency's own units when it has no USD price (Review Focus 2)", () => {
    render(<LaunchForm />);
    fill(); // so the first failing reason is the valuation's
    fireEvent.click(screen.getByRole("button", { name: /Currency/ }));
    const options = screen.getAllByRole("option");
    expect(options[0]!.textContent).toContain("USDG"); // USDG first, then by 24 h volume
    expect(options[1]!.textContent).toContain("NVDA");
    const amc = screen.getByRole("option", { name: /AMC/ });
    expect(amc.textContent).toContain("No USD price");
    fireEvent.click(amc);
    expect(["50 AMC", "100 AMC", "250 AMC", "1,000 AMC"].every((label) => screen.getByRole("button", { name: label }))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("Custom valuation"), { target: { value: "10" } });
    expect(screen.getByText("Pick a valuation between 50 AMC and 100,000 AMC.")).toBeTruthy();
  });

  it("names the wrong network instead of an enabled button that does nothing", () => {
    h.chainId = 1;
    h.wallet = undefined;
    render(<LaunchForm />);
    fill();
    expect(screen.getByText("Switch your wallet to Robinhood Chain.")).toBeTruthy();
    expect((launch() as HTMLButtonElement).disabled).toBe(true);
  });

  it("waits for the wallet client on the right network", () => {
    h.wallet = undefined;
    render(<LaunchForm />);
    fill();
    expect(screen.getByText("Connecting to your wallet.")).toBeTruthy();
    expect((launch() as HTMLButtonElement).disabled).toBe(true);
  });

  it("says a currency the launchpad has not set up is not open, with no presets", () => {
    h.bounds[NVDA] = { min: 0n, max: 0n, creationFee: 0n };
    render(<LaunchForm />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: /Currency/ }));
    fireEvent.click(screen.getByRole("option", { name: /NVDA/ }));
    expect(screen.getByText("This currency is not open for launches.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "$0" })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Opening valuation" })).getAllByRole("button")).toHaveLength(1);
    expect((launch() as HTMLButtonElement).disabled).toBe(true);
  });

  it("lays the valuation cells out as equal shrinkable columns, so five fit a phone", () => {
    render(<LaunchForm />);
    const group = screen.getByRole("group", { name: "Opening valuation" });
    expect(group.className).toContain("grid");
    expect(group.style.gridTemplateColumns).toBe("repeat(5, minmax(0, 1fr))");
    for (const cell of within(group).getAllByRole("button")) expect(cell.className).toContain("min-w-0");
    expect(screen.getByLabelText("Image").className).toContain("min-w-0");
  });

  it("puts the reason in a polite live region", () => {
    render(<LaunchForm />);
    const line = screen.getByText("Add an image, a name and a symbol.");
    expect(line.getAttribute("role")).toBe("status");
    expect(line.getAttribute("aria-live")).toBe("polite");
  });

  it("clamps a converted USD valuation one raw unit above the maximum down to it, and refuses one further out", async () => {
    render(<LaunchForm />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("Custom valuation"), { target: { value: "10000000.000002" } });
    expect(screen.getByText("Pick a valuation between $5,000 and $10,000,000.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Custom valuation"), { target: { value: "10000000.000001" } });
    expect((launch() as HTMLButtonElement).disabled).toBe(false);
    await press();
    await waitFor(() => expect(h.execute).toHaveBeenCalled());
    expect(h.execute.mock.calls[0]![0].valuation).toBe(10_000_000_000_000n);
  });

  it("treats a USD valuation that rounds to zero raw units as no valuation", () => {
    render(<LaunchForm />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("Custom valuation"), { target: { value: "0.0000001" } });
    expect(screen.getByText("Pick a valuation between $5,000 and $10,000,000.")).toBeTruthy();
    expect((launch() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("LaunchForm: submitting (spec 7.2's steps)", () => {
  it("uploads, launches with the requested valuation and a zero floor without a first buy, then opens the token page", async () => {
    render(<LaunchForm />);
    fill();
    await press();
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(`/t/${TOKEN}?launched=${TX}`));
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.upload.mock.calls[0]![0]).toEqual({ name: "Tailor's Chalk", symbol: "CHALK", description: "", website: "", x: "", telegram: "" });
    expect(h.execute.mock.calls[0]![0]).toMatchObject({
      name: "Tailor's Chalk", symbol: "CHALK", metadataUri: "ipfs://bafymeta", quote: USDG, valuation: 5_000_000_000n,
      firstBuy: 0n, minFirstBuyTokens: 0n, payout: WALLET, creationFee: 0n,
      token: TOKEN, // the preview's predicted address, which the wallet code checks for code before sending
    });
    expect(h.state.addToast).toHaveBeenCalledWith({ kind: "pending", message: "Launching CHALK", hash: TX });
    expect(h.state.updateToast).toHaveBeenCalledWith(1, { kind: "confirmed", message: "Launched CHALK" });
  });

  it("sends the first buy's estimate less 0.5 % as the floor", async () => {
    render(<LaunchForm />);
    fill();
    fireEvent.change(screen.getByLabelText("First buy"), { target: { value: "100" } });
    await press();
    await waitFor(() => expect(h.execute).toHaveBeenCalled());
    expect(h.execute.mock.calls[0]![0]).toMatchObject({
      firstBuy: 100_000_000n,
      minFirstBuyTokens: minFirstBuyTokens(estimateFirstBuyTokens(100_000_000n, SNAPPED, 50)),
    });
  });

  it("shows a simulated revert by name, and a mined one replayed by the wallet code", async () => {
    h.execute.mockRejectedValueOnce(new LaunchFailedError(messageForRevert("DailyLimitReached"), "DailyLimitReached"));
    render(<LaunchForm />);
    fill();
    await press();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("You have used today's launches."));
    h.execute.mockImplementationOnce(async () => {
      const confirmation = Promise.reject(new LaunchFailedError(messageForRevert("FirstBuyTooSmall"), "FirstBuyTooSmall"));
      confirmation.catch(() => {});
      return { hash: TX, confirmation };
    });
    await press();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The first buy would get fewer tokens than shown. Review and try again."));
    expect(h.state.updateToast).toHaveBeenLastCalledWith(1, { kind: "failed", message: "The first buy would get fewer tokens than shown. Review and try again." });
    expect(h.push).not.toHaveBeenCalled();
  });

  it("re-reads the currency's fees after PermitMismatch before asking for a review", async () => {
    h.execute.mockRejectedValueOnce(new LaunchFailedError(messageForRevert("PermitMismatch"), "PermitMismatch"));
    render(<LaunchForm />);
    fill();
    await press();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The fees changed. Review and try again."));
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  it("shows the wallet code's wrong-network line verbatim", async () => {
    h.execute.mockRejectedValueOnce(new LaunchFailedError(LAUNCH_MESSAGES.wrongChain));
    render(<LaunchForm />);
    fill();
    await press();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Switch your wallet to Robinhood Chain and try again. Nothing was sent."));
    expect(h.refetch).not.toHaveBeenCalled();
  });

  it("keeps the salt after any other revert", async () => {
    h.execute.mockRejectedValueOnce(new LaunchFailedError(messageForRevert("Expired"), "Expired"));
    render(<LaunchForm />);
    fill();
    await press();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    await press();
    await waitFor(() => expect(h.push).toHaveBeenCalled());
    expect(h.execute.mock.calls[1]![0].salt).toBe(h.execute.mock.calls[0]![0].salt);
  });

  it("draws a new salt after PoolAlreadyInitialized, and reuses the upload on the retry", async () => {
    h.execute.mockRejectedValueOnce(new LaunchFailedError(messageForRevert("PoolAlreadyInitialized"), "PoolAlreadyInitialized"));
    render(<LaunchForm />);
    fill();
    await press();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    await press();
    await waitFor(() => expect(h.push).toHaveBeenCalled());
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(h.execute.mock.calls[1]![0].salt).not.toBe(h.execute.mock.calls[0]![0].salt);
    expect(h.upload).toHaveBeenCalledTimes(1);
  });

  it("sends one upload and one launch however many times Launch is pressed while one is in flight (Review Focus 4)", async () => {
    h.execute.mockReturnValue(new Promise(() => {})); // the wallet never answers
    render(<LaunchForm />);
    fill();
    const button = launch();
    // Three clicks in one tick: React has not re-rendered the pending button yet, so only the in-flight guard stops them.
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(h.execute).toHaveBeenCalledTimes(1));
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Launch" })).toBeNull(); // the pending button names the current step instead
  });

  it("signs in first when there is no session, then carries on by itself once signed", async () => {
    h.state.signed = false;
    const { rerender } = render(<LaunchForm />);
    fill();
    await press();
    expect(h.state.withSignIn).toHaveBeenCalledWith("launch", expect.any(Function), expect.any(Function));
    expect(h.upload).not.toHaveBeenCalled();
    expect(screen.getByText("Sign in")).toBeTruthy();
    h.state.signed = true;
    await act(async () => {
      rerender(<LaunchForm />);
    });
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(`/t/${TOKEN}?launched=${TX}`));
    expect(h.upload).toHaveBeenCalledTimes(1);
  });

  it("drops the queued launch and its steps when the sign modal is closed without signing, so a later sign-in resumes nothing", async () => {
    h.state.signed = false;
    const { rerender } = render(<LaunchForm />);
    fill();
    await press();
    expect(screen.getByText("Sign in")).toBeTruthy();
    const onCancel = h.state.withSignIn.mock.calls[0]![2] as () => void;
    act(() => onCancel()); // what AppState's cancelSign calls
    expect(screen.queryByText("Sign in")).toBeNull();
    h.state.signed = true;
    await act(async () => {
      rerender(<LaunchForm />);
    });
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("queues one sign-in however often Launch is pressed while it waits", async () => {
    h.state.signed = false;
    render(<LaunchForm />);
    fill();
    await press();
    await press();
    expect(h.state.withSignIn).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Sign in")).toBeTruthy();
  });

  it("leaves no step spinning when the resumed launch can no longer go ahead", async () => {
    h.state.signed = false;
    const { rerender } = render(<LaunchForm />);
    fill();
    await press();
    expect(screen.getByText("Sign in")).toBeTruthy();
    h.wallet = undefined; // the wallet client went away while the signature was pending
    h.state.signed = true;
    await act(async () => {
      rerender(<LaunchForm />);
    });
    expect(screen.queryByText("Sign in")).toBeNull();
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("ignores a late cancel once the launch has started", async () => {
    h.state.signed = false;
    h.execute.mockReturnValue(new Promise(() => {}));
    const { rerender } = render(<LaunchForm />);
    fill();
    await press();
    const onCancel = h.state.withSignIn.mock.calls[0]![2] as () => void;
    h.state.signed = true;
    await act(async () => {
      rerender(<LaunchForm />);
    });
    await waitFor(() => expect(h.execute).toHaveBeenCalled());
    act(() => onCancel());
    const steps = screen.getByRole("status", { name: "Launch steps" });
    expect(within(steps).getByText("Sign in")).toBeTruthy();
  });

  it("stays locked after a confirmed launch until the token page opens", async () => {
    render(<LaunchForm />);
    fill();
    const button = launch();
    await press();
    await waitFor(() => expect(h.push).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Launch" })).toBeNull();
    const locked = screen.getByRole("button", { name: "Launched" });
    expect(locked).toBe(button); // the same element throughout, so keyboard focus is never lost
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(locked);
    });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  // UX review, blocker B2.
  it("drops the expired session when the upload answers 401, and the next Launch signs in again and carries on by itself", async () => {
    h.upload.mockRejectedValueOnce(new UploadError(UPLOAD_MESSAGES.signIn, "not-signed-in"));
    const { rerender } = render(<LaunchForm />);
    fill();
    await press();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Your sign-in has expired. Press Launch to sign in again."));
    expect(h.state.dropSession).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
    h.state.signed = false; // what AppState reports once the session is dropped
    rerender(<LaunchForm />);
    expect(launch().getAttribute("aria-disabled")).toBe("false");
    await press();
    expect(h.state.withSignIn).toHaveBeenCalledWith("launch", expect.any(Function), expect.any(Function));
    expect(screen.getByText("Sign in")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull(); // the old line goes once the new attempt starts
    h.state.signed = true; // the signature landed
    await act(async () => {
      rerender(<LaunchForm />);
    });
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(`/t/${TOKEN}?launched=${TX}`));
    expect(h.upload).toHaveBeenCalledTimes(2);
  });

  it("keeps the session on any other upload refusal", async () => {
    h.upload.mockRejectedValueOnce(new UploadError(UPLOAD_MESSAGES.limit, "upload-limit"));
    render(<LaunchForm />);
    fill();
    await press();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(UPLOAD_MESSAGES.limit));
    expect(h.state.dropSession).not.toHaveBeenCalled();
  });

  // UX review, blocker B3: the same salt again would deploy onto a live token, revert, and read "Launch failed".
  it("stays locked after a launch it could not confirm, with the transaction and the token page one tap away", async () => {
    h.execute.mockImplementationOnce(async () => {
      const confirmation = Promise.reject(new LaunchUnconfirmedError(LAUNCH_MESSAGES.unconfirmed));
      confirmation.catch(() => {});
      return { hash: TX, confirmation };
    });
    render(<LaunchForm />);
    fill();
    const button = launch();
    await press();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(LAUNCH_MESSAGES.unconfirmed));
    expect(screen.getByRole("link", { name: "View the transaction ↗" }).getAttribute("href")).toBe(txUrl(TX));
    expect(screen.getByRole("link", { name: "Open the token page" }).getAttribute("href")).toBe(`/t/${TOKEN}?launched=${TX}`);
    expect(h.state.updateToast).toHaveBeenLastCalledWith(1, { kind: "unconfirmed", message: LAUNCH_MESSAGES.unconfirmed });
    const locked = screen.getByRole("button", { name: "Sent" });
    expect(locked).toBe(button); // the same element, so keyboard focus is never lost
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("button", { name: "Launch" })).toBeNull();
    await act(async () => {
      fireEvent.click(locked);
    });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("points to the token page instead of launching again when the predicted address is already live", async () => {
    h.execute.mockRejectedValueOnce(new LaunchExistsError(LAUNCH_MESSAGES.alreadyLive, TOKEN));
    render(<LaunchForm />);
    fill();
    await press();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(LAUNCH_MESSAGES.alreadyLive));
    expect(h.execute.mock.calls[0]![0].token).toBe(TOKEN);
    expect(screen.getByRole("link", { name: "Open the token page" }).getAttribute("href")).toBe(`/t/${TOKEN}`);
    expect(screen.queryByRole("link", { name: /transaction/ })).toBeNull(); // no hash is known for an earlier press
    const locked = screen.getByRole("button", { name: "Already live" });
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(locked);
    });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  // UX review, should fix 15.
  it("never reuses an upload made while another wallet was connected", async () => {
    h.execute.mockRejectedValueOnce(new LaunchRejectedError(LAUNCH_MESSAGES.rejected));
    const { rerender } = render(<LaunchForm />);
    fill();
    await press();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(LAUNCH_MESSAGES.rejected));
    h.state.address = OTHER_WALLET;
    rerender(<LaunchForm />);
    await press();
    await waitFor(() => expect(h.push).toHaveBeenCalled());
    expect(h.upload).toHaveBeenCalledTimes(2);
    expect(h.execute.mock.calls[1]![1]).toMatchObject({ account: OTHER_WALLET });
  });

  it("lists Approve only when the wallet code reports it", async () => {
    h.execute.mockImplementation(async (_input: unknown, _deps: unknown, onStep: (s: string) => void) => {
      onStep("sign");
      return new Promise(() => {});
    });
    const { unmount } = render(<LaunchForm />);
    fill();
    fireEvent.change(screen.getByLabelText("First buy"), { target: { value: "100" } });
    await press();
    let steps = screen.getByRole("status", { name: "Launch steps" });
    await waitFor(() => expect(within(steps).getByText("Sign the payment")).toBeTruthy());
    expect(within(steps).queryByText("Approve")).toBeNull();
    unmount();

    h.execute.mockImplementation(async (_input: unknown, _deps: unknown, onStep: (s: string) => void) => {
      onStep("approve");
      return new Promise(() => {});
    });
    render(<LaunchForm />);
    fill();
    fireEvent.change(screen.getByLabelText("First buy"), { target: { value: "100" } });
    await press();
    steps = screen.getByRole("status", { name: "Launch steps" });
    await waitFor(() => expect(within(steps).getByText("Approve")).toBeTruthy());
    expect([...steps.querySelectorAll("li")].map((li) => li.textContent?.replace(/^[✓\d]*/, ""))).toEqual([
      "Upload", "Approve", "Sign the payment", "Confirm in wallet", "Launching",
    ]);
  });
});
