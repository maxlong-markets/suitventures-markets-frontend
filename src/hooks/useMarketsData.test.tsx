import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreUnavailableError } from "@/lib/data/envio";
import type { Address, Candle, HoldersView, Interval, TraderRow } from "@/lib/types";
import { queryHarness, renderHook, waitFor } from "@/test/dom";
import {
  HOLDERS_FAST_POLL_MS,
  HOLDERS_POLL_MS,
  HOLDERS_SLOW_POLL_MS,
  keys,
  useChartCandles,
  useHolders,
  useTraders,
  useVotes,
  useWatchlist,
} from "./useMarketsData";

const ROW: TraderRow = {
  wallet: "0x1111111111111111111111111111111111111111" as Address,
  volumeUsd: 10,
  trades: 2,
  tokens: 1,
};

const CANDLE: Candle = { t: 1_700_000_000_000, o: 1, h: 1.1, l: 0.9, c: 1.05, v: 100 };
const TOKEN = "0x000000000000000000000000000000000000000a";

const h = vi.hoisted(() => ({
  ds: {
    traders: vi.fn<(by: string) => Promise<TraderRow[]>>(),
    watchlist: vi.fn<() => Promise<string[]>>(),
    votes: vi.fn<() => Promise<Record<string, never>>>(),
    candles: vi.fn<(id: string, interval: Interval) => Promise<Candle[]>>(),
    holders: vi.fn<(id: string) => Promise<HoldersView>>(),
  },
}));

vi.mock("@/context/DataSource", () => ({ useDataSource: () => h.ds }));

/** Every interval empty unless a test's own `mockImplementation` says otherwise. */
function candlesAt(rows: Partial<Record<Interval, Candle[]>>) {
  h.ds.candles.mockImplementation((_id, interval) => Promise.resolve(rows[interval] ?? []));
}

describe("useMarketsData", () => {
  beforeEach(() => {
    h.ds.traders.mockReset().mockResolvedValue([ROW]);
    h.ds.watchlist.mockReset().mockResolvedValue([]);
    h.ds.votes.mockReset().mockResolvedValue({});
    h.ds.candles.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("keys the traders board by its ordering and asks the source for that ordering", async () => {
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => useTraders("trades"), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([ROW]));
    expect(h.ds.traders).toHaveBeenCalledWith("trades");
    expect(keys.traders("trades")).toEqual(["traders", "trades"]);
    expect(keys.traders("volume")).not.toEqual(keys.traders("trades"));
  });

  it("gives up after one try when the store is missing, rather than retrying a permanent condition", async () => {
    const { wrapper } = queryHarness();
    h.ds.traders.mockReset().mockRejectedValue(new StoreUnavailableError("traders board needs the market store"));
    const { result } = renderHook(() => useTraders("volume"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(h.ds.traders).toHaveBeenCalledTimes(1);
  });

  it("keeps the user's lists unfetched until the caller says a session exists", async () => {
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => ({ w: useWatchlist(false), v: useVotes(false) }), { wrapper });
    // `enabled: false` parks a query as pending with nothing in flight — the one observable
    // difference between "disabled" and "loading".
    await waitFor(() => expect(result.current.w.fetchStatus).toBe("idle"));
    expect(h.ds.watchlist).not.toHaveBeenCalled();
    expect(h.ds.votes).not.toHaveBeenCalled();
  });

  it("fetches them once it does, on keys that name no wallet", async () => {
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => ({ w: useWatchlist(true), v: useVotes(true) }), { wrapper });
    await waitFor(() => expect(result.current.w.data).toEqual([]));
    expect(h.ds.watchlist).toHaveBeenCalledTimes(1);
    expect(keys.watchlist).toEqual(["watchlist"]);
    expect(keys.votes).toEqual(["votes"]);
  });
});

describe("useChartCandles", () => {
  beforeEach(() => {
    h.ds.candles.mockReset();
  });

  it("opens on 15m when the token has 15-minute data, and asks for nothing else", async () => {
    candlesAt({ "15m": [CANDLE] });
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => useChartCandles(TOKEN, null), { wrapper });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current).toEqual({ interval: "15m", candles: [CANDLE], settled: true, empty: false });
    expect(h.ds.candles).toHaveBeenCalledTimes(1);
    expect(h.ds.candles).toHaveBeenCalledWith(TOKEN, "15m");
  });

  it("falls back to 1h when 15m is empty but 1h has data, still asking for nothing past 1h", async () => {
    candlesAt({ "1h": [CANDLE] });
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => useChartCandles(TOKEN, null), { wrapper });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current).toEqual({ interval: "1h", candles: [CANDLE], settled: true, empty: false });
    expect(h.ds.candles).toHaveBeenCalledTimes(2);
    expect(h.ds.candles).toHaveBeenCalledWith(TOKEN, "15m");
    expect(h.ds.candles).toHaveBeenCalledWith(TOKEN, "1h");
    expect(h.ds.candles).not.toHaveBeenCalledWith(TOKEN, "1d");
  });

  it("falls back to 1d when 15m and 1h are both empty but 1d has data", async () => {
    candlesAt({ "1d": [CANDLE] });
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => useChartCandles(TOKEN, null), { wrapper });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current).toEqual({ interval: "1d", candles: [CANDLE], settled: true, empty: false });
    expect(h.ds.candles).toHaveBeenCalledTimes(3);
    for (const iv of ["15m", "1h", "1d"] as const) expect(h.ds.candles).toHaveBeenCalledWith(TOKEN, iv);
    // 1m and 5m have even shorter retention than 15m (retention.ts), so an empty 15m already
    // implies they would be empty too — the cascade must never reach for them.
    expect(h.ds.candles).not.toHaveBeenCalledWith(TOKEN, "1m");
    expect(h.ds.candles).not.toHaveBeenCalledWith(TOKEN, "5m");
  });

  it("settles empty, not stuck loading, when nothing exists at any interval that was tried", async () => {
    candlesAt({});
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => useChartCandles(TOKEN, null), { wrapper });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current).toEqual({ interval: "1d", candles: [], settled: true, empty: true });
    expect(h.ds.candles).toHaveBeenCalledTimes(3);
  });

  it("leaves an explicit pick alone even when it is empty, and never probes the fallback order for it", async () => {
    candlesAt({ "15m": [CANDLE], "1h": [CANDLE], "1d": [CANDLE] }); // every fallback interval has data
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => useChartCandles(TOKEN, "5m"), { wrapper }); // but 5m, explicitly picked, does not
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current).toEqual({ interval: "5m", candles: [], settled: true, empty: true });
    expect(h.ds.candles).toHaveBeenCalledTimes(1);
    expect(h.ds.candles).toHaveBeenCalledWith(TOKEN, "5m");
  });

  it("shows an explicit pick's own data directly, with no cascade at all", async () => {
    candlesAt({ "1h": [CANDLE, CANDLE] });
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => useChartCandles(TOKEN, "1h"), { wrapper });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current).toEqual({ interval: "1h", candles: [CANDLE, CANDLE], settled: true, empty: false });
    expect(h.ds.candles).toHaveBeenCalledTimes(1);
  });
});

describe("useHolders", () => {
  // The poll-backoff case below freezes Date.now; restore it so the cases after it see a moving clock.
  afterEach(() => vi.restoreAllMocks());

  /**
   * Resolves `refetchInterval` exactly as React Query does — it is a function of the query — rather than
   * waiting five real seconds for a tick. The returned thunk can be called again after the clock moves,
   * which is what the fast-then-slow window below needs.
   */
  async function pollIntervalAt(status: HoldersView["status"]) {
    h.ds.holders.mockReset().mockResolvedValue({ holders: [], count: 0, status, asOf: null });
    const { client, wrapper } = queryHarness();
    const { result } = renderHook(() => useHolders(TOKEN), { wrapper });
    await waitFor(() => expect(result.current.data?.status).toBe(status));
    const query = client.getQueryCache().find({ queryKey: keys.holders(TOKEN) })!;
    // Through the observer, not the cache entry: `refetchInterval` is an observer option, and the
    // observer is what actually schedules the poll.
    const option = query.observers[0]!.options.refetchInterval;
    return () => (typeof option === "function" ? option(query) : option);
  }
  const pollInterval = async (status: HoldersView["status"]) => (await pollIntervalAt(status))();

  it("polls every 5 s while the list is being built (design section 1)", async () => {
    expect(await pollInterval("building")).toBe(5_000);
  });

  it("backs off to 30 s once a build has run past the fast window, instead of asking every 5 s forever", async () => {
    // Review 24 Sep 2026: a busy token takes minutes, not "under a minute", and a tab left open on one was
    // asking twelve times a minute for as long as it stayed open.
    expect([HOLDERS_POLL_MS, HOLDERS_SLOW_POLL_MS, HOLDERS_FAST_POLL_MS]).toEqual([5_000, 30_000, 120_000]);
    const clock = { t: 1_700_000_000_000 };
    vi.spyOn(Date, "now").mockImplementation(() => clock.t);
    const interval = await pollIntervalAt("building");
    expect(interval()).toBe(HOLDERS_POLL_MS);
    clock.t += HOLDERS_FAST_POLL_MS - 1;
    expect(interval()).toBe(HOLDERS_POLL_MS); // still inside the first two minutes
    clock.t += 1;
    expect(interval()).toBe(HOLDERS_SLOW_POLL_MS);
  });

  it("stops polling once the list is ready, and never polls a token that will not get one", async () => {
    expect(await pollInterval("ready")).toBe(false);
    expect(await pollInterval("skipped")).toBe(false);
  });
});
