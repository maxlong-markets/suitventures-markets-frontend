import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  retryWait: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/hooks/useMarketsData", () => ({
  LAUNCH_WAIT_MAX_MS: 300_000,
  usePair: () => ({ pair: h.pair, isPending: h.isPending, dataUpdatedAt: 0, retryWait: h.retryWait }),
}));
// B1a: TokenView asks the router to refresh the server-rendered parts once the wait finds the
// token, rather than reading anything from the server itself.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
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
  beforeEach(() => {
    h.retryWait.mockReset();
    h.refresh.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  // B1b, amended 30 Sep 2026: the timeout no longer reuses "No token at ..." (that reads as a
  // bad address, not a late indexer) and now offers Retry. On the old code this test's
  // post-timeout assertion (`getByText(/No token at/)`) is exactly what should fix 9's B1b
  // deliberately removes from this branch, so it fails there; Retry and its call to `retryWait`
  // do not exist on the old code at all.
  it("waits for a just-launched token, then offers Retry with the honest reason after five minutes, link kept", () => {
    vi.useFakeTimers();
    h.pair = undefined;
    h.isPending = false;
    render(<TokenView address={PAIR_A.id} launchedTx={TX} />);
    expect(screen.getByText("Your token is live on chain. Its page fills in within about two minutes.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /View the launch transaction/ }).getAttribute("href")).toBe(txUrl(TX));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    act(() => {
      vi.advanceTimersByTime(300_000);
    });
    expect(screen.getByText("Your token is on chain, but the site's data is running late.")).toBeTruthy();
    expect(screen.queryByText(/No token at/)).toBeNull();
    expect(screen.getByRole("link", { name: /View the launch transaction/ }).getAttribute("href")).toBe(txUrl(TX));

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(h.retryWait).toHaveBeenCalledTimes(1);
    // Retry restarts the same countdown: the waiting copy is back, and the timed-out one is gone.
    expect(screen.getByText("Your token is live on chain. Its page fills in within about two minutes.")).toBeTruthy();
    expect(screen.queryByText("Your token is on chain, but the site's data is running late.")).toBeNull();
  });

  it("keeps today's text, with no link and no Retry, without a launch", () => {
    h.pair = undefined;
    h.isPending = false;
    render(<TokenView address={PAIR_A.id} />);
    expect(screen.getByText(/No token at/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /View the launch transaction/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  // B1a: on the old TokenView (no router.refresh call at all) `h.refresh` is never invoked, so
  // this fails at the first assertion.
  it("refreshes the server-rendered parts exactly once, when the wait finds the token", () => {
    h.pair = undefined;
    h.isPending = false;
    const { rerender } = render(<TokenView address={PAIR_A.id} launchedTx={TX} />);
    expect(h.refresh).not.toHaveBeenCalled();

    h.pair = { ...PAIR_A, launch: null } as TokenPair;
    rerender(<TokenView address={PAIR_A.id} launchedTx={TX} />);
    expect(h.refresh).toHaveBeenCalledTimes(1);

    // A later re-render with a *new* object for the same token (react-query hands back a fresh
    // reference on every background refetch, even when the data has not changed) still carries
    // the same `pair.id`, and must not refresh a second time: this is what the ref guard is for,
    // not React's own effect-dependency skip, since the object reference here does change.
    h.pair = { ...PAIR_A, launch: null } as TokenPair;
    rerender(<TokenView address={PAIR_A.id} launchedTx={TX} />);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("never refreshes when there is no launch in play", () => {
    h.pair = undefined;
    h.isPending = false;
    const { rerender } = render(<TokenView address={PAIR_A.id} />);
    h.pair = { ...PAIR_A, launch: null } as TokenPair;
    rerender(<TokenView address={PAIR_A.id} />);
    expect(h.refresh).not.toHaveBeenCalled();
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
