import { beforeEach, describe, expect, it, vi } from "vitest";
import { addressUrl, txUrl, ZERO_ADDRESS } from "@/lib/chain";
import { ageHours, fmtAge, fmtAmt, fmtISODate, fmtUsd, fmtUsdOrDash, short } from "@/lib/format";
import type { Address, Holder, HoldersView, LaunchInfo, TokenPair, Trade } from "@/lib/types";
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
  hookAddress: "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544" as Address,
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

/** Unix seconds; `NOW_MS` below is the same instant in the milliseconds the tab is given. */
const AS_OF = 2_000_000_000;
const NOW_MS = 2_000_000_000_000;
const HOLDER: Holder = { wallet: WALLET, balance: 1_500, share: 12.5 };
const ready = (over: Partial<HoldersView> = {}): HoldersView => ({ holders: [HOLDER], count: 1, status: "ready", asOf: AS_OF, ...over });

const h = vi.hoisted(() => ({
  trades: [] as Trade[],
  tradesPending: false,
  holders: undefined as HoldersView | undefined,
  holdersPending: false,
  holdersError: false,
}));

vi.mock("@/hooks/useMarketsData", () => ({
  useTrades: () => ({ data: h.trades, isPending: h.tradesPending }),
  useHolders: () => ({ data: h.holders, isPending: h.holdersPending, isError: h.holdersError }),
}));

function show(tab: ActivityTab) {
  return render(
    <ActivityTabs pair={pair} now={NOW_MS} tab={tab} onTabChange={vi.fn()} />,
  );
}

describe("ActivityTabs", () => {
  beforeEach(() => {
    h.trades = [TRADE];
    h.tradesPending = false;
    h.holders = ready({ holders: [], count: 0 });
    h.holdersPending = false;
    h.holdersError = false;
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
    expect(hookLink.getAttribute("href")).toBe(addressUrl(pair.hookAddress));
    expect(hookLink.getAttribute("target")).toBe("_blank");
    expect(hookLink.getAttribute("rel")).toBe("noreferrer");

    const tokenLink = screen.getByRole("link", { name: short(pair.address) });
    expect(tokenLink.getAttribute("href")).toBe(addressUrl(pair.address));
    expect(tokenLink.getAttribute("target")).toBe("_blank");
    expect(tokenLink.getAttribute("rel")).toBe("noreferrer");

    // A v4 pool id is a bytes32, not an address — it must stay plain text.
    expect(screen.getByText(short(pair.poolId)).closest("a")).toBeNull();
  });

  it("names the pool's own rate 'Pool fee', not 'Fee tier' (Review Focus 2: one name for one thing)", () => {
    show("info");
    expect(screen.getByText("Pool fee")).toBeTruthy();
    expect(screen.queryByText("Fee tier")).toBeNull();
  });

  it("renders the hook label unlinked when the pool has no hook (the zero address)", () => {
    render(
      <ActivityTabs
        pair={{ ...pair, hookAddress: ZERO_ADDRESS }}
        now={NOW_MS}
        tab="info"
        onTabChange={vi.fn()}
      />,
    );
    expect(screen.getByText(pair.hook).closest("a")).toBeNull();
  });

  it("shows the quote-side liquidity in the quote asset without halving it (D43: liquidity is the quote side alone)", () => {
    show("info");
    const quoteUsd = pair.priceUsd / pair.priceQuote;
    expect(screen.getByText(`${fmtUsdOrDash(pair.liquidity)} · ${fmtAmt(pair.liquidity! / quoteUsd, 2)} ${pair.quote}`)).toBeTruthy();
  });
});

/** The four states of design section 1, each with the copy that table names. */
describe("ActivityTabs holders", () => {
  beforeEach(() => {
    h.trades = [TRADE];
    h.tradesPending = false;
    h.holders = ready();
    h.holdersPending = false;
    h.holdersError = false;
  });

  it("renders a ready list's rows and how old the list is", () => {
    h.holders = ready({ asOf: AS_OF - 7_200 }); // two hours before the tab's own `now`
    show("holders");
    expect(screen.getByText(short(WALLET))).toBeTruthy();
    expect(screen.getByText(fmtAmt(HOLDER.balance, 0))).toBeTruthy();
    expect(screen.getByText("12.50%")).toBeTruthy();
    expect(screen.getByText("As of 2h ago")).toBeTruthy();
  });

  it("reads a list brought to the head seconds ago as 'just now', not as 0m", () => {
    h.holders = ready({ asOf: AS_OF - 30 });
    show("holders");
    expect(screen.getByText("As of just now")).toBeTruthy();
  });

  it("says a ready list is empty rather than showing an age with no rows", () => {
    h.holders = ready({ holders: [], count: 0 });
    show("holders");
    expect(screen.getByText("No holders yet.")).toBeTruthy();
    expect(screen.queryByText(/^As of /)).toBeNull();
  });

  it("shows the skeleton and what is happening while the list is being built", () => {
    h.holders = { holders: [], count: 0, status: "building", asOf: null };
    const { container } = show("holders");
    expect(container.querySelector("[aria-busy]")).toBeTruthy();
    expect(screen.getByText("Building this token's holder list. A few minutes for a busy token.")).toBeTruthy();
  });

  it("says so in one line when the holders query failed, instead of a bare column header", () => {
    // Review 24 Sep 2026: a failed request rendered the header and nothing under it, which reads as "this
    // token has no holders" rather than "we could not ask".
    h.holders = undefined;
    h.holdersPending = false;
    h.holdersError = true;
    const { container } = show("holders");
    expect(screen.getByText("Holder list unavailable right now.")).toBeTruthy();
    expect(container.querySelector("[aria-busy]")).toBeNull();
  });

  it("explains a token too large to fold, with no skeleton to wait on", () => {
    h.holders = { holders: [], count: 0, status: "skipped", asOf: null };
    const { container } = show("holders");
    expect(screen.getByText("Holder list unavailable for a token this large.")).toBeTruthy();
    expect(container.querySelector("[aria-busy]")).toBeNull();
  });

  it("shows the skeleton alone while the first request is still in flight", () => {
    h.holders = undefined;
    h.holdersPending = true;
    const { container } = show("holders");
    expect(container.querySelector("[aria-busy]")).toBeTruthy();
    expect(screen.queryByText(/Building this token/)).toBeNull();
  });
});

describe("ActivityTabs: the launch rows (spec 7.3)", () => {
  const CREATOR = "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1" as Address;
  const PAYOUT = "0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2" as Address;
  const LAUNCH_TX = `0x${"33".repeat(32)}` as `0x${string}`;
  const LAUNCHED_AT = 1_999_990_000; // seconds; NOW_MS is 2_000_000_000_000
  const launch: LaunchInfo = {
    creator: CREATOR, payout: PAYOUT, quoteAddress: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address, quoteDecimals: 6,
    tokenIsCurrency0: false, openTick: 398_400, openingValuation: "4995430000", firstBuyIn: "99500000", firstBuyTokens: "19000000000000000000000000",
    creatorShareBps: 7000, launchedAt: LAUNCHED_AT, launchBlock: 100, launchTx: LAUNCH_TX, hidden: false, imageCid: "bafyimg",
    description: "", website: "https://chalk.test", x: "https://x.com/chalk", telegram: "https://t.me/chalks", routerFee: "500000",
    feesCollected: { tokenToPayout: "0", tokenToPlatform: "0", quoteToPayout: "0", quoteToPlatform: "0" }, feesCollectedAt: 0,
  };
  const launched: TokenPair = { ...pair, ticker: "CHALK", quote: "USDG", origin: "SV", priceUsd: 0.000005, priceQuote: 0.000005, launch };
  const info = (p: TokenPair) => render(<ActivityTabs pair={p} now={NOW_MS} tab="info" onTabChange={vi.fn()} />);

  it("lists creator, payout, opening valuation in USD, the gross first buy and the launch, then the links, with no fee split", () => {
    info(launched);
    expect(screen.getByRole("link", { name: short(CREATOR) }).getAttribute("href")).toBe(addressUrl(CREATOR));
    expect(screen.getByRole("link", { name: short(PAYOUT) }).getAttribute("href")).toBe(addressUrl(PAYOUT));
    expect(screen.getByText(fmtUsd(4995.43))).toBeTruthy();
    expect(screen.getByText(`${fmtAmt(100)} USDG · ${fmtAmt(19_000_000)} CHALK`)).toBeTruthy(); // 99.5 net plus the 0.5 router fee
    const at = LAUNCHED_AT * 1000;
    expect(screen.getByRole("link", { name: `${fmtISODate(at)} · ${fmtAge(ageHours(at, NOW_MS))} ago` }).getAttribute("href")).toBe(txUrl(LAUNCH_TX));
    // The owner's ruling of 30 Sep 2026: the split between the creator and MaxLong is not shown anywhere.
    expect(screen.queryByText("Pool fee share")).toBeNull();
    expect(screen.queryByText("Fee share")).toBeNull();
    expect(screen.queryByText(/MaxLong/)).toBeNull();
    expect(screen.getByRole("link", { name: "https://chalk.test" }).getAttribute("href")).toBe("https://chalk.test");
    expect(screen.getByRole("link", { name: "https://x.com/chalk" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://t.me/chalks" })).toBeTruthy();
  });

  it("says None without a first buy, and shows no split whatever the launch's fee share is", () => {
    info({ ...launched, launch: { ...launch, creatorShareBps: 6500, firstBuyIn: "0", firstBuyTokens: "0", routerFee: "0" } });
    expect(screen.queryByText(/% payout/)).toBeNull();
    expect(screen.queryByText(/MaxLong/)).toBeNull();
    expect(screen.getByText("None")).toBeTruthy();
  });

  it("shows the opening valuation in the quote when the quote has no USD price (Review Focus 2), and no links for a hidden launch", () => {
    info({ ...launched, stale: true, priceUsd: 0, launch: { ...launch, hidden: true, website: "", x: "", telegram: "" } });
    expect(screen.getByText(`${fmtAmt(4995.43)} USDG`)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "https://chalk.test" })).toBeNull();
    expect(screen.queryByText("Website")).toBeNull();
  });
});
