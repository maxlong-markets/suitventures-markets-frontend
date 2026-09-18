import { beforeEach, describe, expect, it, vi } from "vitest";
import { addressUrl } from "@/lib/chain";
import { StoreUnavailableError } from "@/lib/data/envio";
import { fmtInt, fmtUsd, short } from "@/lib/format";
import type { Address, TraderRow } from "@/lib/types";
import { fireEvent, render, screen, within } from "@/test/dom";
import TradersBoard from "./TradersBoard";

/**
 * No figure here may collide with a rank cell (`1`, `2`, `3`) inside its own row, or `getByText`
 * throws "found multiple elements" — which is why the third row's `tokens` is 5 rather than 3.
 */
const ROWS: TraderRow[] = [
  { wallet: "0x1111111111111111111111111111111111111111" as Address, volumeUsd: 1_284_500, trades: 96, tokens: 7 },
  { wallet: "0x2222222222222222222222222222222222222222" as Address, volumeUsd: 742_300, trades: 318, tokens: 12 },
  { wallet: "0x3333333333333333333333333333333333333333" as Address, volumeUsd: 118_900, trades: 41, tokens: 5 },
];

const h = vi.hoisted(() => ({
  rows: [] as TraderRow[],
  isPending: false,
  isError: false,
  error: undefined as unknown,
  seenBy: vi.fn(),
}));

vi.mock("@/hooks/useMarketsData", () => ({
  useTraders: (by: string) => {
    h.seenBy(by);
    return { data: h.rows, isPending: h.isPending, isError: h.isError, error: h.error };
  },
}));

describe("TradersBoard", () => {
  beforeEach(() => {
    h.rows = ROWS;
    h.isPending = false;
    h.isError = false;
    h.error = undefined;
    h.seenBy.mockClear();
  });

  it("ranks three wallets, each linked to the explorer, with its own volume, trades and tokens", () => {
    render(<TradersBoard />);
    for (const [i, row] of ROWS.entries()) {
      const link = screen.getByRole("link", { name: short(row.wallet) });
      expect(link.getAttribute("href")).toBe(addressUrl(row.wallet));
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noreferrer");
      // Every figure is read inside the row this wallet's own link sits in, so a mis-ordered board
      // fails here instead of reading "some 1 is somewhere on the page" — and a board-wide
      // `getByText(fmtInt(tokens))` would anyway throw on a count that some rank cell also renders.
      const rowEl = link.parentElement as HTMLElement;
      expect(rowEl.children[0]?.textContent).toBe(String(i + 1));
      expect(within(rowEl).getByText(fmtUsd(row.volumeUsd))).toBeTruthy();
      expect(within(rowEl).getByText(fmtInt(row.trades))).toBeTruthy();
      expect(within(rowEl).getByText(fmtInt(row.tokens))).toBeTruthy();
    }
  });

  it("starts on volume and switches the ordering it asks for", () => {
    render(<TradersBoard />);
    expect(h.seenBy).toHaveBeenLastCalledWith("volume");
    const trades = screen.getByRole("button", { name: "Trades" });
    expect(trades.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(trades);
    expect(h.seenBy).toHaveBeenLastCalledWith("trades");
    expect(screen.getByRole("button", { name: "Trades" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "24h volume" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("shows a skeleton while loading and keeps the toggle usable", () => {
    h.isPending = true;
    h.rows = [];
    render(<TradersBoard />);
    expect(document.querySelector("[aria-busy]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Trades" })).toBeTruthy();
  });

  it("says the board is empty rather than showing a bare table", () => {
    h.rows = [];
    render(<TradersBoard />);
    expect(screen.getByText("No trades in the last 24 hours.")).toBeTruthy();
  });

  it("explains a missing market store in plain words", () => {
    h.isError = true;
    h.error = new StoreUnavailableError("traders board needs the market store");
    h.rows = [];
    render(<TradersBoard />);
    expect(screen.getByText("The traders board needs the market store.")).toBeTruthy();
    expect(screen.queryByText("Couldn't load the traders board.")).toBeNull();
  });

  it("says something different when the request simply failed", () => {
    h.isError = true;
    h.error = new Error("/api/traders: 500");
    h.rows = [];
    render(<TradersBoard />);
    expect(screen.getByText("Couldn't load the traders board.")).toBeTruthy();
    expect(screen.queryByText("The traders board needs the market store.")).toBeNull();
  });
});
