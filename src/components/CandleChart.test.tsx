import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartCandles } from "@/hooks/useMarketsData";
import type { Address, Candle, Interval, TokenPair } from "@/lib/types";
import { fireEvent, render, screen } from "@/test/dom";
import CandleChart from "./CandleChart";

const CANDLE: Candle = { t: 1_700_000_000_000, o: 1, h: 1.1, l: 0.9, c: 1.05, v: 100 };

const PAIR = {
  id: "0x000000000000000000000000000000000000000a",
  ticker: "AI",
  name: "Artificial Inu",
  address: "0x000000000000000000000000000000000000000a" as Address,
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
  hookAddress: "0x0000000000000000000000000000000000000000",
  feeTier: "0.30%",
} as TokenPair;

const SETTLED_15M: ChartCandles = { interval: "15m", candles: [CANDLE], settled: true, empty: false };

const h = vi.hoisted(() => ({
  result: undefined as unknown,
  seenArgs: vi.fn(),
}));

vi.mock("@/hooks/useMarketsData", () => ({
  useChartCandles: (id: string, selected: Interval | null) => {
    h.seenArgs(id, selected);
    return h.result;
  },
}));

// The real chart is a canvas-based lightweight-charts instance, which jsdom cannot render;
// CandleChart's own markup (tabs, legend, empty state) never depends on it having loaded.
vi.mock("./CandleChartInner", () => ({ default: () => null }));

describe("CandleChart", () => {
  beforeEach(() => {
    h.result = SETTLED_15M;
    h.seenArgs.mockClear();
  });

  function show(selectedInterval: Interval | null = null, onIntervalChange = vi.fn()) {
    render(<CandleChart pair={PAIR} selectedInterval={selectedInterval} onIntervalChange={onIntervalChange} />);
    return onIntervalChange;
  }

  it("opens on 15m when the resolved data is 15-minute", () => {
    h.result = SETTLED_15M;
    show();
    expect(screen.getByRole("tab", { name: "15m" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "1h" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.queryByText(/No trades yet/)).toBeNull();
  });

  it("opens on 1h when the resolved data is hourly-only", () => {
    h.result = { interval: "1h", candles: [CANDLE], settled: true, empty: false } satisfies ChartCandles;
    show();
    expect(screen.getByRole("tab", { name: "1h" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "15m" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.queryByText(/No trades yet/)).toBeNull();
  });

  it("opens on 1d when the resolved data is daily-only", () => {
    h.result = { interval: "1d", candles: [CANDLE], settled: true, empty: false } satisfies ChartCandles;
    show();
    expect(screen.getByRole("tab", { name: "1d" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "15m" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.queryByText(/No trades yet/)).toBeNull();
  });

  it("renders a clear empty state, not a blank chart or a crash, when nothing exists at any interval", () => {
    h.result = { interval: "1d", candles: [], settled: true, empty: true } satisfies ChartCandles;
    show();
    expect(screen.getByText("No trades yet for AI. The chart fills in once it does.")).toBeTruthy();
  });

  it("never shows the empty state while the fallback is still resolving, only once settled", () => {
    h.result = { interval: "1h", candles: undefined, settled: false, empty: false } satisfies ChartCandles;
    show();
    expect(screen.queryByText(/No trades yet/)).toBeNull();
  });

  it("passes the token id and the caller's selection straight through to the fallback hook", () => {
    show("1h");
    expect(h.seenArgs).toHaveBeenCalledWith(PAIR.id, "1h");
  });

  it("reports a tab click to the caller — the switcher itself is untouched by the fallback", () => {
    const onIntervalChange = show(null);
    fireEvent.click(screen.getByRole("tab", { name: "1m" }));
    expect(onIntervalChange).toHaveBeenCalledWith("1m");
  });

  it("still shows the stale-quote notice ahead of an empty-candles state", () => {
    h.result = { interval: "1d", candles: [], settled: true, empty: true } satisfies ChartCandles;
    render(<CandleChart pair={{ ...PAIR, stale: true }} selectedInterval={null} onIntervalChange={vi.fn()} />);
    expect(screen.getByText(/No USD price feed for NVDA/)).toBeTruthy();
    expect(screen.queryByText(/No trades yet/)).toBeNull();
  });
});
