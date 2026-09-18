import { beforeEach, describe, expect, it, vi } from "vitest";
import { addressUrl } from "@/lib/chain";
import { fmtAmt, short } from "@/lib/format";
import type { Address, Holder, TokenPair, Trade } from "@/lib/types";
import { render, screen, within } from "@/test/dom";
import ActivityTabs, { type ActivityTab } from "./ActivityTabs";

const TOKEN = "0x000000000000000000000000000000000000000a" as Address;
const POOL = "0x000000000000000000000000000000000000000c" as Address;
const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const TX = "0x2222222222222222222222222222222222222222222222222222222222222222" as Address;

const pair: TokenPair = {
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
  poolId: POOL,
  hook: "Doppler shared v4 hook",
  feeTier: "0.30%",
};

const TRADE: Trade = {
  t: 1_726_000_000_000,
  side: "buy",
  amount: 1234,
  priceUsd: 0.5,
  wallet: WALLET,
  tx: TX,
};

const h = vi.hoisted(() => ({
  trades: [] as Trade[],
  tradesPending: false,
  holders: [] as Holder[],
  holdersPending: false,
}));

vi.mock("@/hooks/useMarketsData", () => ({
  useTrades: () => ({ data: h.trades, isPending: h.tradesPending }),
  useHolders: () => ({ data: h.holders, isPending: h.holdersPending }),
}));

function show(tab: ActivityTab) {
  return render(
    <ActivityTabs pair={pair} now={2_000_000_000_000} tab={tab} onTabChange={vi.fn()} />,
  );
}

describe("ActivityTabs", () => {
  beforeEach(() => {
    h.trades = [TRADE];
    h.tradesPending = false;
    h.holders = [];
    h.holdersPending = false;
  });

  it("shows a short wallet under the amount cell at the default (phone) width", () => {
    show("trades");
    // The amount line ("1,234 AI") sits in its own div; its parent is the shared
    // `text-right` wrapper that also holds the phone-only wallet caption — the row's
    // *tablet-and-up* Wallet column is a separate, sibling grid cell entirely, so scoping
    // the query to the amount cell's own subtree (spec section 4: "under the amount cell")
    // is what tells the two apart.
    const amountLine = screen.getByText(`${fmtAmt(TRADE.amount, 0)} ${pair.ticker}`);
    const amountCell = amountLine.parentElement;
    expect(amountCell).not.toBeNull();
    expect(within(amountCell as HTMLElement).getByText(short(WALLET))).toBeTruthy();
  });

  it("links the hook and token rows to the explorer on the info tab", () => {
    show("info");

    const hookLink = screen.getByRole("link", { name: pair.hook });
    expect(hookLink.getAttribute("href")).toBe(addressUrl(pair.hook));
    expect(hookLink.getAttribute("target")).toBe("_blank");
    expect(hookLink.getAttribute("rel")).toBe("noreferrer");

    const tokenLink = screen.getByRole("link", { name: short(pair.address) });
    expect(tokenLink.getAttribute("href")).toBe(addressUrl(pair.address));
    expect(tokenLink.getAttribute("target")).toBe("_blank");
    expect(tokenLink.getAttribute("rel")).toBe("noreferrer");

    // A v4 pool id is a bytes32, not an address — it must stay plain text.
    expect(screen.getByText(short(pair.poolId)).closest("a")).toBeNull();
  });
});
