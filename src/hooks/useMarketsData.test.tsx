import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, TraderRow } from "@/lib/types";
import { queryHarness, renderHook, waitFor } from "@/test/dom";
import { keys, useTraders, useVotes, useWatchlist } from "./useMarketsData";

const ROW: TraderRow = {
  wallet: "0x1111111111111111111111111111111111111111" as Address,
  volumeUsd: 10,
  trades: 2,
  tokens: 1,
};

const h = vi.hoisted(() => ({
  ds: {
    traders: vi.fn<(by: string) => Promise<TraderRow[]>>(),
    watchlist: vi.fn<() => Promise<string[]>>(),
    votes: vi.fn<() => Promise<Record<string, never>>>(),
  },
}));

vi.mock("@/context/DataSource", () => ({ useDataSource: () => h.ds }));

describe("useMarketsData", () => {
  beforeEach(() => {
    h.ds.traders.mockReset().mockResolvedValue([ROW]);
    h.ds.watchlist.mockReset().mockResolvedValue([]);
    h.ds.votes.mockReset().mockResolvedValue({});
  });

  it("keys the traders board by its ordering and asks the source for that ordering", async () => {
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => useTraders("trades"), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([ROW]));
    expect(h.ds.traders).toHaveBeenCalledWith("trades");
    expect(keys.traders("trades")).toEqual(["traders", "trades"]);
    expect(keys.traders("volume")).not.toEqual(keys.traders("trades"));
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
