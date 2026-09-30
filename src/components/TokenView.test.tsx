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
vi.mock("./TradePanel", () => ({ default: () => <div>the trade panel</div> }));
vi.mock("./TokenDetailsCard", () => ({ default: () => <div>the details card</div> }));
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
    const { rerender } = render(<TokenView address={PAIR_A.id} serverHadPair={true} />);
    expect(h.seenSelected).toHaveBeenLastCalledWith(null);

    fireEvent.click(screen.getByRole("button", { name: "pick-1h" }));
    expect(h.seenSelected).toHaveBeenLastCalledWith("1h");

    // Re-rendering with the very same token must not disturb the explicit pick just made.
    rerender(<TokenView address={PAIR_A.id} serverHadPair={true} />);
    expect(h.seenSelected).toHaveBeenLastCalledWith("1h");

    // A client-side navigation to a different token can reuse this component instance (Next does
    // not remount just because the dynamic segment changed) — the address prop changes, but so
    // does the resolved pair, and that must reset the pick rather than carry it to the new token.
    h.pair = PAIR_B;
    rerender(<TokenView address={PAIR_B.id} serverHadPair={true} />);
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

  // B1b, amended 30 Sep 2026, extended per fix round 1 finding 6: the timeout no longer reuses
  // "No token at ..." (that reads as a bad address, not a late indexer) and now offers Retry, and
  // Retry must actually restart the five-minute countdown, not just swap the copy back once.
  // Advancing 299_999 ms then 1 ms more proves the timer itself was rescheduled; the old version
  // of this test only checked the copy right after the click, which would still have passed even
  // if `waitAttempt` were dropped from the effect's dependency array and the timer never re-armed.
  it("waits for a just-launched token, then offers Retry with the honest reason after five minutes, link kept, and Retry actually restarts the countdown", () => {
    vi.useFakeTimers();
    h.pair = undefined;
    h.isPending = false;
    render(<TokenView address={PAIR_A.id} launchedTx={TX} serverHadPair={false} />);
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

    // Fix round 1 finding 6: the countdown must actually be running again, not just the copy.
    act(() => {
      vi.advanceTimersByTime(299_999);
    });
    expect(screen.getByText("Your token is live on chain. Its page fills in within about two minutes.")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Your token is on chain, but the site's data is running late.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  // Fix round 1 finding 1: a plain unknown address, when the server's own read also found
  // nothing, gets its "No token at ..." message from TokenFacts (the server-rendered block below
  // this one), not repeated here. On the old code (no `serverHadPair` prop at all, so this case
  // could not even be expressed) TokenView always printed its own copy, which is exactly the
  // duplicate a holder or a gate-off visitor saw.
  it("suppresses its own message when there is no launch and the server also had no pair", () => {
    h.pair = undefined;
    h.isPending = false;
    const { container } = render(<TokenView address={PAIR_A.id} serverHadPair={false} />);
    expect(screen.queryByText(/No token at/)).toBeNull();
    expect(screen.queryByRole("link", { name: /View the launch transaction/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    // Only the back link: nothing else of its own, leaving the one message to TokenFacts.
    expect(container.textContent).toBe("← Markets");
  });

  // The other half of finding 1: when the server DID have the pair but this component's own,
  // independent client-side read still does not, that is a genuinely different fact from
  // whatever TokenFacts is showing (which found the pair), so it is still worth saying here.
  it("still shows its own message when the server had the pair but this client's own read does not", () => {
    h.pair = undefined;
    h.isPending = false;
    render(<TokenView address={PAIR_A.id} serverHadPair={true} />);
    expect(screen.getByText(/No token at/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /View the launch transaction/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  // B1a: on the old TokenView (no router.refresh call at all) `h.refresh` is never invoked, so
  // this fails at the first assertion.
  it("refreshes the server-rendered parts exactly once, when the wait finds the token", () => {
    h.pair = undefined;
    h.isPending = false;
    const { rerender } = render(<TokenView address={PAIR_A.id} launchedTx={TX} serverHadPair={false} />);
    expect(h.refresh).not.toHaveBeenCalled();

    h.pair = { ...PAIR_A, launch: null } as TokenPair;
    rerender(<TokenView address={PAIR_A.id} launchedTx={TX} serverHadPair={false} />);
    expect(h.refresh).toHaveBeenCalledTimes(1);

    // A later re-render with a *new* object for the same token (react-query hands back a fresh
    // reference on every background refetch, even when the data has not changed) still carries
    // the same `pair.id`, and must not refresh a second time: this is what the ref guard is for,
    // not React's own effect-dependency skip, since the object reference here does change.
    h.pair = { ...PAIR_A, launch: null } as TokenPair;
    rerender(<TokenView address={PAIR_A.id} launchedTx={TX} serverHadPair={false} />);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  // Fix round 1 finding 5: a shared or reloaded `?launched=` link whose server render already
  // found the token needs no refresh (TokenFacts and the tab title are already right); firing one
  // anyway is one needless server render on every such view. On the old code (no `serverHadPair`
  // guard) this would have refreshed once, same as the case above.
  it("does not refresh when the server already had the pair, even as the client catches up", () => {
    h.pair = undefined;
    h.isPending = false;
    const { rerender } = render(<TokenView address={PAIR_A.id} launchedTx={TX} serverHadPair={true} />);
    h.pair = { ...PAIR_A, launch: null } as TokenPair;
    rerender(<TokenView address={PAIR_A.id} launchedTx={TX} serverHadPair={true} />);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  // Re-review finding 2: a plain link (no `?launched=`) whose server render missed the token
  // needs the same refresh once this component's own client read finds it, or the app renders
  // fully above a facts block still saying "No token at ..." under a tab still reading "Unknown
  // token", uncorrected until a reload. On the pre-fix code (the effect bailed on `!launchedTx`
  // unconditionally) `h.refresh` was never called here; this is the flip of that old expectation.
  it("refreshes exactly once when a plain link's client read finds a token the server did not have", () => {
    h.pair = undefined;
    h.isPending = false;
    const { rerender } = render(<TokenView address={PAIR_A.id} serverHadPair={false} />);
    expect(h.refresh).not.toHaveBeenCalled();

    h.pair = { ...PAIR_A, launch: null } as TokenPair;
    rerender(<TokenView address={PAIR_A.id} serverHadPair={false} />);
    expect(h.refresh).toHaveBeenCalledTimes(1);

    // Still just once on a later re-render with a fresh object for the same token.
    h.pair = { ...PAIR_A, launch: null } as TokenPair;
    rerender(<TokenView address={PAIR_A.id} serverHadPair={false} />);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("puts the details card right under the trade panel, ahead of the fee panel", () => {
    h.isPending = false;
    h.pair = { ...PAIR_A, launch: { creator: "0xc1" } as unknown as LaunchInfo } as TokenPair;
    render(<TokenView address={PAIR_A.id} serverHadPair={true} />);
    const trade = screen.getByText("the trade panel");
    const details = screen.getByText("the details card");
    const fees = screen.getByText("the fee panel");
    expect(trade.nextElementSibling).toBe(details);
    expect(details.nextElementSibling).toBe(fees);
    expect(trade.parentElement).toBe(details.parentElement);
  });

  it("shows the details card for a token that was not launched here too", () => {
    h.isPending = false;
    h.pair = { ...PAIR_A, launch: null } as TokenPair;
    render(<TokenView address={PAIR_A.id} serverHadPair={true} />);
    expect(screen.getByText("the details card")).toBeTruthy();
  });

  it("shows the fee panel for a token launched here, and nothing for any other", () => {
    h.isPending = false;
    h.pair = { ...PAIR_A, launch: { creator: "0xc1" } as unknown as LaunchInfo } as TokenPair;
    const { rerender } = render(<TokenView address={PAIR_A.id} serverHadPair={true} />);
    expect(screen.getByText("the fee panel")).toBeTruthy();
    h.pair = { ...PAIR_A, launch: null } as TokenPair;
    rerender(<TokenView address={PAIR_A.id} serverHadPair={true} />);
    expect(screen.queryByText("the fee panel")).toBeNull();
  });
});
