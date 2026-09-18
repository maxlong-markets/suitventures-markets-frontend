import { beforeEach, describe, expect, it, vi } from "vitest";
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

const h = vi.hoisted(() => {
  // The panel's own error classes, defined here so the test never depends on how
  // src/lib/swap.ts builds them; `instanceof` inside the panel sees exactly these.
  class SwapFailedError extends Error {}
  class SwapRejectedError extends Error {}
  return {
    SwapFailedError,
    SwapRejectedError,
    state: {
      address: "0x1111111111111111111111111111111111111111",
      isConnected: true,
      isHolder: false,
      addToast: vi.fn(() => 1),
      updateToast: vi.fn(),
    },
    // The widened PairBalances (ruling 12): floats for display, exact strings for "Max".
    balances: {
      quote: 1250,
      token: 125_000.7,
      quoteBase: BigInt("1250000000"),
      tokenBase: BigInt("125000700000000000000000"),
      quoteText: "1250",
      tokenText: "125000.7",
    },
    quote: undefined as Quote | undefined,
    quoteError: false,
    router: true,
    wallet: { id: "wallet-client" } as unknown,
    publicClient: { id: "public-client" } as unknown,
    executeSwap: vi.fn(),
    invalidate: vi.fn(),
    seenQuoteParams: vi.fn(),
  };
});

vi.mock("@/context/AppState", () => ({ useAppState: () => h.state }));
vi.mock("@/hooks/useTokenBalance", () => ({
  usePairBalances: () => h.balances,
  invalidatePairBalances: h.invalidate,
}));
vi.mock("@/hooks/useMarketsData", () => ({
  useSwapQuote: (params: unknown) => {
    h.seenQuoteParams(params);
    return { data: h.quote, isError: h.quoteError };
  },
}));
vi.mock("wagmi", () => ({
  usePublicClient: () => h.publicClient,
  useWalletClient: () => ({ data: h.wallet }),
}));
vi.mock("@/lib/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain")>()),
  hasRouter: () => h.router,
}));
vi.mock("@/lib/swap", () => ({
  executeSwap: h.executeSwap,
  SwapFailedError: h.SwapFailedError,
  SwapRejectedError: h.SwapRejectedError,
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
      token: 125_000.7,
      quoteBase: BigInt("1250000000"),
      tokenBase: BigInt("125000700000000000000000"),
      quoteText: "1250",
      tokenText: "125000.7",
    };
    h.quote = PRICED;
    h.quoteError = false;
    h.router = true;
    h.wallet = { id: "wallet-client" };
    h.publicClient = { id: "public-client" };
    h.executeSwap.mockReset();
    h.invalidate.mockReset();
    h.seenQuoteParams.mockClear();
  });

  it("shows the not-routed card when the route could not simulate the pool", () => {
    h.quote = { ...PRICED, routable: false, call: undefined };
    show();
    expect(screen.getByText("Not routed")).toBeTruthy();
    expect(screen.queryByLabelText("Amount")).toBeNull();
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

  it("fills Max with the balance exactly, to the last wei", () => {
    show();
    // Sell, so the pay asset is the 18-decimal token whose balance no double holds exactly.
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    // The 100 % button is labelled "Max"; 25/50/75 keep their display rounding.
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    // Not "125001": rounding Max up trips the insufficient-balance guard, rounding it down
    // leaves dust behind. The router's fee comes out of the input, so the whole balance is
    // spendable (spec section 5).
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("125000.7");
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
    expect(req).toMatchObject({ ticker: "AI", side: "buy", account: WALLET, isSuitHolder: false });
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
      new h.SwapRejectedError("Cancelled in wallet. Nothing was spent."),
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
