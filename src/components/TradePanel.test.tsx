import { beforeEach, describe, expect, it, vi } from "vitest";
import { SwapRejectedError, SwapUnconfirmedError } from "@/lib/swap";
import type { Address, Quote, SwapCall, TokenPair } from "@/lib/types";
import { fireEvent, queryHarness, render, screen, waitFor } from "@/test/dom";
import TradePanel from "./TradePanel";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x000000000000000000000000000000000000000a" as Address;
const QUOTE_ADDRESS = "0x000000000000000000000000000000000000000b" as Address;

const CALL: SwapCall = {
  poolKey: {
    currency0: TOKEN,
    currency1: QUOTE_ADDRESS,
    fee: 3000,
    tickSpacing: 60,
    hooks: "0x0000000000000000000000000000000000000000" as Address,
  },
  zeroForOne: false,
  amountIn: "100000000",
  amountOutMin: "980000000000000000000",
  tokenIn: QUOTE_ADDRESS,
  tokenOut: TOKEN,
  tokenInDecimals: 6,
  tokenOutDecimals: 18,
};

const PRICED: Quote = {
  payAmount: 100,
  receiveAmount: 1000,
  priceImpactPct: 0.004,
  routerFeePct: 0.5,
  poolFeePct: 0.3,
  minReceived: 990,
  routable: true,
  call: CALL,
};

const pair = {
  id: TOKEN,
  ticker: "AI",
  name: "Artificial Inu",
  address: TOKEN,
  quote: "NVDA",
  origin: "LONG",
  tradeable: true,
  priceUsd: 0.1943,
  priceQuote: 0.000866,
  change1h: 0,
  change24h: 0,
  vol24h: 0,
  mcap: 0,
  fdv: 0,
  liquidity: 1_000_000,
  holders: 0,
  createdAt: 0,
  bull: 0,
  bear: 0,
  poolId: "0x000000000000000000000000000000000000000c",
  hook: "",
  feeTier: "0.30%",
} as TokenPair;

const h = vi.hoisted(() => ({
  state: {
    address: "0x1111111111111111111111111111111111111111",
    isConnected: true,
    isHolder: false,
    addToast: vi.fn(() => 1),
    updateToast: vi.fn(),
  },
  // The widened PairBalances (ruling 12): floats for display, exact strings for "Max". The
  // token balance is a string no double round-trips (I3): mutating the fixture rounding away
  // from the exact string must fail the Max test.
  balances: {
    quote: 1250,
    token: 1_234_567.123456789012345678,
    quoteBase: BigInt("1250000000"),
    tokenBase: BigInt("1234567123456789012345678"),
    quoteText: "1250",
    tokenText: "1234567.123456789012345678",
  },
  quote: undefined as Quote | undefined,
  quoteError: false,
  // keepPreviousData's two flags (I1): both false by default, so every existing test — which
  // never sets them — exercises the settled-quote path exactly as before.
  quoteIsPlaceholderData: false,
  quoteIsFetching: false,
  router: true,
  launchpadUrlValue: undefined as string | undefined,
  wallet: { id: "wallet-client" } as unknown,
  publicClient: { id: "public-client" } as unknown,
  executeSwap: vi.fn(),
  invalidate: vi.fn(),
  seenQuoteParams: vi.fn(),
}));

vi.mock("@/context/AppState", () => ({ useAppState: () => h.state }));
vi.mock("@/hooks/useTokenBalance", () => ({
  usePairBalances: () => h.balances,
  invalidatePairBalances: h.invalidate,
}));
vi.mock("@/hooks/useMarketsData", () => ({
  useSwapQuote: (params: unknown) => {
    h.seenQuoteParams(params);
    return {
      data: h.quote,
      isError: h.quoteError,
      isPlaceholderData: h.quoteIsPlaceholderData,
      isFetching: h.quoteIsFetching,
    };
  },
}));
vi.mock("wagmi", () => ({
  usePublicClient: () => h.publicClient,
  useWalletClient: () => ({ data: h.wallet }),
}));
vi.mock("@/lib/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain")>()),
  hasRouter: () => h.router,
  launchpadUrl: () => h.launchpadUrlValue,
}));
// importOriginal, not a hand-enumerated factory (I4/I5): the real error classes flow through
// unmocked, so `instanceof` inside the panel's catch sees the same classes this file imports
// from "@/lib/swap" below, and any future export never silently becomes undefined here.
vi.mock("@/lib/swap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swap")>()),
  executeSwap: h.executeSwap,
}));

function show() {
  const { wrapper } = queryHarness();
  return render(<TradePanel pair={pair} />, { wrapper });
}

function typeAmount(value: string): void {
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value } });
}

function buyButton(): HTMLElement {
  return screen.getByRole("button", { name: "Buy AI" });
}

describe("TradePanel", () => {
  beforeEach(() => {
    h.state.address = "0x1111111111111111111111111111111111111111";
    h.state.isConnected = true;
    h.state.isHolder = false;
    h.state.addToast.mockClear();
    h.state.addToast.mockReturnValue(1);
    h.state.updateToast.mockClear();
    h.balances = {
      quote: 1250,
      token: 1_234_567.123456789012345678,
      quoteBase: BigInt("1250000000"),
      tokenBase: BigInt("1234567123456789012345678"),
      quoteText: "1250",
      tokenText: "1234567.123456789012345678",
    };
    h.quote = PRICED;
    h.quoteError = false;
    h.quoteIsPlaceholderData = false;
    h.quoteIsFetching = false;
    h.router = true;
    h.launchpadUrlValue = undefined;
    h.wallet = { id: "wallet-client" };
    h.publicClient = { id: "public-client" };
    h.executeSwap.mockReset();
    h.invalidate.mockReset();
    h.seenQuoteParams.mockClear();
  });

  it("shows the not-routed card when the pool itself is not tradeable", () => {
    // The list-level flag, exactly as before the quote-route milestone (Task 6 review, I2) —
    // a per-amount `routable: false` no longer decides this.
    const { wrapper } = queryHarness();
    render(<TradePanel pair={{ ...pair, tradeable: false }} />, { wrapper });
    expect(screen.getByText("Not routed")).toBeTruthy();
    expect(screen.queryByLabelText("Amount")).toBeNull();
  });

  it("renders the not-routed card without a trade link when the origin has no launchpad URL yet", () => {
    h.launchpadUrlValue = undefined;
    const { wrapper } = queryHarness();
    render(<TradePanel pair={{ ...pair, tradeable: false }} />, { wrapper });
    expect(screen.getByText("Not routed")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders a trade link to the launchpad when launchpadUrl resolves one", () => {
    h.launchpadUrlValue = "https://longmarkets.example/token/0xabc";
    const { wrapper } = queryHarness();
    render(<TradePanel pair={{ ...pair, tradeable: false }} />, { wrapper });
    const link = screen.getByRole("link", { name: /Trade on LONG/ });
    expect(link.getAttribute("href")).toBe("https://longmarkets.example/token/0xabc");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });

  it("keeps the form and explains it inline when this amount can't be routed", () => {
    h.quote = { ...PRICED, routable: false, call: undefined };
    show();
    typeAmount("100");
    // The form survives: the input the user needs to shrink the amount is still there.
    expect(screen.queryByText("Not routed")).toBeNull();
    expect(screen.getByLabelText("Amount")).toBeTruthy();
    expect(
      screen.getByText("This amount can't be routed through the pool. Try a smaller amount."),
    ).toBeTruthy();
    expect(buyButton().hasAttribute("disabled")).toBe(true);
  });

  it("disables trading with the deploy notice while the router address is unset", () => {
    h.router = false;
    show();
    expect(screen.getByText("Trading goes live when the router is deployed")).toBeTruthy();
    expect(buyButton().hasAttribute("disabled")).toBe(true);
  });

  it("asks for a wallet before anything else", () => {
    h.state.isConnected = false;
    show();
    expect(screen.getByText("Connect a wallet to trade.")).toBeTruthy();
    expect(buyButton().hasAttribute("disabled")).toBe(true);
  });

  it("asks for an amount once a wallet is connected", () => {
    show();
    expect(screen.getByText("Enter an amount.")).toBeTruthy();
  });

  it("refuses an amount the balance cannot cover", () => {
    h.quote = { ...PRICED, payAmount: 5000 };
    show();
    typeAmount("5000");
    expect(screen.getByText("Insufficient NVDA balance.")).toBeTruthy();
    expect(buyButton().hasAttribute("disabled")).toBe(true);
  });

  it("disables the button when the quote route failed", () => {
    h.quoteError = true;
    show();
    typeAmount("100");
    expect(screen.getByText("Quote unavailable. Try again.")).toBeTruthy();
  });

  it("disables the button while no call block has come back", () => {
    h.quote = { ...PRICED, call: undefined };
    show();
    typeAmount("100");
    expect(screen.getByText("Fetching a quote…")).toBeTruthy();
    expect(buyButton().hasAttribute("disabled")).toBe(true);
  });

  it("refuses to arm the button when the settled quote's amountOutMin has floored to zero (I2)", () => {
    // The honest-zero ruling: routable stays true, but a zero minimum is exactly what
    // checkUint128 in swap.ts refuses at submit — receiveAmount itself can still read as a
    // nonzero (sub-cent) number, so this must not depend on receiveAmount alone.
    h.quote = { ...PRICED, call: { ...CALL, amountOutMin: "0" } };
    show();
    typeAmount("0.000001");
    expect(screen.getByText("Too small to receive anything. Increase the amount.")).toBeTruthy();
    expect(buyButton().hasAttribute("disabled")).toBe(true);
  });

  it("also refuses when the settled quote's receiveAmount itself is zero (I2)", () => {
    h.quote = { ...PRICED, receiveAmount: 0 };
    show();
    typeAmount("0.000001");
    expect(screen.getByText("Too small to receive anything. Increase the amount.")).toBeTruthy();
    expect(buyButton().hasAttribute("disabled")).toBe(true);
  });

  it("never submits a stale quote while the next one is still in flight", async () => {
    // `useSwapQuote`'s placeholderData keeps the previous amount's call block on screen while a
    // new one is in flight (Task 6 review, I1); editing the amount down must never let a click
    // reach executeSwap with the old, larger amount's call.
    const CALL_1000: SwapCall = { ...CALL, amountIn: "1000000000" };
    const CALL_100: SwapCall = { ...CALL, amountIn: "100000000" };
    h.executeSwap.mockResolvedValue({
      hash: "0xdeadbeef",
      confirmation: Promise.resolve({
        amountOut: BigInt("987650000000000000000"),
        fee: BigInt("500000"),
        holderRate: false,
      }),
    });
    h.quote = { ...PRICED, call: CALL_1000 };
    const { rerender } = show();
    typeAmount("1000");

    // The amount changes to 100, but the quote query is still settling: react-query reports
    // both flags while it holds the 1000 call block as placeholder data.
    h.quoteIsPlaceholderData = true;
    h.quoteIsFetching = true;
    typeAmount("100");
    rerender(<TradePanel pair={pair} />);
    fireEvent.click(buyButton());
    expect(h.executeSwap).not.toHaveBeenCalled();

    // The 100 quote settles: only now does the button go live, and only with the 100 call.
    h.quote = { ...PRICED, call: CALL_100 };
    h.quoteIsPlaceholderData = false;
    h.quoteIsFetching = false;
    rerender(<TradePanel pair={pair} />);
    fireEvent.click(buyButton());
    await waitFor(() => expect(h.executeSwap).toHaveBeenCalledTimes(1));
    expect(h.executeSwap.mock.calls[0][0].call).toBe(CALL_100);
  });

  it("fills Max with the balance exactly, to the last wei", () => {
    show();
    // Sell, so the pay asset is the 18-decimal token whose balance no double holds exactly.
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    // The 100 % button is labelled "Max"; 25/50/75 keep their display rounding.
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    // Not rounded, and not merely "not a whole number" — the exact string, to the last digit.
    // The router's fee comes out of the input, so the whole balance is spendable (spec section 5).
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe(
      "1234567.123456789012345678",
    );
  });

  it("asks the route with the typed text, never a parsed float", () => {
    show();
    typeAmount("125000.123456789012345678");
    const last = h.seenQuoteParams.mock.calls.at(-1)?.[0] as { amount: unknown };
    expect(last.amount).toBe("125000.123456789012345678");
  });

  it("shows the 0% router fee for a Suit holder", () => {
    h.state.isHolder = true;
    h.quote = { ...PRICED, routerFeePct: 0 };
    show();
    expect(screen.getByText("0% · Suit holder")).toBeTruthy();
  });

  it("shows 0.5% for everyone else", () => {
    show();
    expect(screen.getByText("0.5%")).toBeTruthy();
  });

  it("sends the route's call block and the wallet clients verbatim", async () => {
    h.executeSwap.mockResolvedValue({
      hash: "0xdeadbeef",
      confirmation: Promise.resolve({
        amountOut: BigInt("987650000000000000000"),
        fee: BigInt("500000"),
        holderRate: false,
      }),
    });
    show();
    typeAmount("100");
    fireEvent.click(buyButton());
    await waitFor(() => expect(h.executeSwap).toHaveBeenCalledTimes(1));
    const [req, deps] = h.executeSwap.mock.calls[0];
    expect(req.call).toBe(CALL);
    // No dead fields, and no second source of truth for the signer (Task 4 review, Important
    // 3): the request carries only what executeSwap reads, and deps.account is the one signer.
    expect(req).toEqual({ slippagePct: 0.5, call: CALL });
    expect(deps).toEqual({
      wallet: h.wallet,
      publicClient: h.publicClient,
      account: WALLET,
    });
  });

  it("reports the Trade event's amountOut in the confirmed toast, not the quote's", async () => {
    h.executeSwap.mockResolvedValue({
      hash: "0xdeadbeef",
      confirmation: Promise.resolve({
        amountOut: BigInt("987650000000000000000"),
        fee: BigInt("500000"),
        holderRate: false,
      }),
    });
    show();
    typeAmount("100");
    fireEvent.click(buyButton());
    await waitFor(() =>
      expect(h.state.updateToast).toHaveBeenCalledWith(1, {
        kind: "confirmed",
        message: "Bought 987.65 AI for 100 NVDA",
      }),
    );
    expect(h.state.addToast).toHaveBeenCalledWith({
      kind: "pending",
      message: "Buying 1,000 AI for 100 NVDA",
    });
    expect(h.state.updateToast).toHaveBeenCalledWith(1, { hash: "0xdeadbeef" });
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it("renders the swap client's own message when the wallet rejects", async () => {
    h.executeSwap.mockRejectedValue(
      new SwapRejectedError("Cancelled in wallet. Nothing was spent."),
    );
    show();
    typeAmount("100");
    fireEvent.click(buyButton());
    await waitFor(() =>
      expect(h.state.updateToast).toHaveBeenCalledWith(1, {
        kind: "failed",
        message: "Cancelled in wallet. Nothing was spent.",
      }),
    );
  });

  it("never reports a broadcast-but-unconfirmed swap as a failure, and keeps the amount", async () => {
    h.executeSwap.mockResolvedValue({
      hash: "0xdeadbeef",
      confirmation: Promise.reject(
        new SwapUnconfirmedError(
          "Sent, but we could not confirm it. Check the transaction before trying again.",
        ),
      ),
    });
    show();
    typeAmount("100");
    fireEvent.click(buyButton());
    await waitFor(() => expect(h.state.updateToast).toHaveBeenCalledWith(1, { hash: "0xdeadbeef" }));
    await waitFor(() => {
      const patch = h.state.updateToast.mock.calls.at(-1)?.[1] as { message: string };
      expect(patch.message).toMatch(/could not confirm/i);
    });
    const patch = h.state.updateToast.mock.calls.at(-1)?.[1] as { kind: string; message: string };
    // The exact hazard C1 exists to close: this wording invites a duplicate swap.
    expect(patch.message).not.toMatch(/nothing was spent/i);
    expect(patch.kind).not.toBe("failed");
    // Nothing here reads as "start over": the amount the user typed is still in the box.
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("100");
  });

  it("falls back to the generic failure for an error it does not know", async () => {
    h.executeSwap.mockRejectedValue(new Error("boom"));
    show();
    typeAmount("100");
    fireEvent.click(buyButton());
    await waitFor(() =>
      expect(h.state.updateToast).toHaveBeenCalledWith(1, {
        kind: "failed",
        message: "Swap failed. Nothing was spent.",
      }),
    );
  });
});
