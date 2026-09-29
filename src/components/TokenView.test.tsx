import { afterEach, describe, expect, it, vi } from "vitest";
import { txUrl } from "@/lib/chain";
import type { Interval, LaunchInfo, TokenPair } from "@/lib/types";
import { act, fireEvent, render, screen } from "@/test/dom";
import TokenView from "./TokenView";

const PAIR_A = { id: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ticker: "AAA" } as TokenPair;
const PAIR_B = { id: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ticker: "BBB" } as TokenPair;

const h = vi.hoisted(() => ({
  pair: undefined as TokenPair | undefined,
  isPending: false,
  seenSelected: vi.fn(),
}));

vi.mock("@/hooks/useMarketsData", () => ({
  LAUNCH_WAIT_MAX_MS: 300_000,
  usePair: () => ({ pair: h.pair, isPending: h.isPending, dataUpdatedAt: 0 }),
}));
vi.mock("./TokenHeader", () => ({ default: () => null }));
vi.mock("./TradePanel", () => ({ default: () => null }));
vi.mock("./ActivityTabs", () => ({ default: () => null }));
vi.mock("./LaunchFeesPanel", () => ({ default: () => <div>the fee panel</div> }));
// A stand-in that only exercises the one contract TokenView owns: it reports whatever
// `selectedInterval` it was handed, and lets a test drive `onIntervalChange` like a tab click.
vi.mock("./CandleChart", () => ({
  default: ({
    selectedInterval,
    onIntervalChange,
  }: {
    selectedInterval: Interval | null;
    onIntervalChange: (interval: Interval) => void;
  }) => {
    h.seenSelected(selectedInterval);
    return (
      <button type="button" onClick={() => onIntervalChange("1h")}>
        pick-1h
      </button>
    );
  },
}));

describe("TokenView", () => {
  it("starts a token with no explicit interval pick, and keeps an explicit one until the token changes", () => {
    h.pair = PAIR_A;
    h.isPending = false;
    h.seenSelected.mockClear();
    const { rerender } = render(<TokenView address={PAIR_A.id} />);
    expect(h.seenSelected).toHaveBeenLastCalledWith(null);

    fireEvent.click(screen.getByRole("button", { name: "pick-1h" }));
    expect(h.seenSelected).toHaveBeenLastCalledWith("1h");

    // Re-rendering with the very same token must not disturb the explicit pick just made.
    rerender(<TokenView address={PAIR_A.id} />);
    expect(h.seenSelected).toHaveBeenLastCalledWith("1h");

    // A client-side navigation to a different token can reuse this component instance (Next does
    // not remount just because the dynamic segment changed) — the address prop changes, but so
    // does the resolved pair, and that must reset the pick rather than carry it to the new token.
    h.pair = PAIR_B;
    rerender(<TokenView address={PAIR_B.id} />);
    expect(h.seenSelected).toHaveBeenLastCalledWith(null);
  });
});

describe("TokenView and the instant launchpad (spec 7.3)", () => {
  const TX = `0x${"11".repeat(32)}` as `0x${string}`;
  afterEach(() => vi.useRealTimers());

  it("waits for a just-launched token with its transaction link, then falls back to the usual text after five minutes, link kept", () => {
    vi.useFakeTimers();
    h.pair = undefined;
    h.isPending = false;
    render(<TokenView address={PAIR_A.id} launchedTx={TX} />);
    expect(screen.getByText("Your token is live on chain. Its page fills in within about two minutes.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /View the launch transaction/ }).getAttribute("href")).toBe(txUrl(TX));
    act(() => {
      vi.advanceTimersByTime(300_000);
    });
    expect(screen.getByText(/No token at/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /View the launch transaction/ }).getAttribute("href")).toBe(txUrl(TX));
  });

  it("keeps today's text, with no link, without a launch", () => {
    h.pair = undefined;
    h.isPending = false;
    render(<TokenView address={PAIR_A.id} />);
    expect(screen.getByText(/No token at/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /View the launch transaction/ })).toBeNull();
  });

  it("shows the fee panel for a token launched here, and nothing for any other", () => {
    h.isPending = false;
    h.pair = { ...PAIR_A, launch: { creator: "0xc1" } as unknown as LaunchInfo } as TokenPair;
    const { rerender } = render(<TokenView address={PAIR_A.id} />);
    expect(screen.getByText("the fee panel")).toBeTruthy();
    h.pair = { ...PAIR_A, launch: null } as TokenPair;
    rerender(<TokenView address={PAIR_A.id} />);
    expect(screen.queryByText("the fee panel")).toBeNull();
  });
});
