import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex, SignMessage, TokenPair, VoteDir, VoteResult } from "@/lib/types";
import { keys, usePairs } from "@/hooks/useMarketsData";
import { act, fireEvent, queryHarness, render, screen, waitFor } from "@/test/dom";
import { AppStateProvider, useAppState, type AppState } from "./AppState";

/** Checksummed, as wagmi reports it; the server's copy below is lowercase, as the cookie carries it. */
const WALLET = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" as Address;
const LOWER = WALLET.toLowerCase() as Address;
const TOKEN = "0x000000000000000000000000000000000000000a";

/** Only the four fields the vote flow reads; the rest of a pair never reaches these assertions. */
const pairRow = (bull: number, bear: number): TokenPair => ({ id: TOKEN, ticker: "AI", bull, bear }) as TokenPair;

const h = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, isConnected: false },
  openConnectModal: vi.fn(),
  ds: {
    session: vi.fn<() => Promise<string | null>>(),
    signIn: vi.fn<(sign: SignMessage, address: string) => Promise<string>>(),
    signOut: vi.fn<() => Promise<void>>(),
    watchlist: vi.fn<() => Promise<string[]>>(),
    setWatch: vi.fn<(id: string, on: boolean) => Promise<void>>(),
    votes: vi.fn<() => Promise<Record<string, VoteDir>>>(),
    vote: vi.fn<(id: string, dir: VoteDir) => Promise<VoteResult>>(),
    pairs: vi.fn<() => Promise<TokenPair[]>>(),
  },
}));

vi.mock("wagmi", () => ({ useAccount: () => h.account }));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: h.openConnectModal }) }));
vi.mock("@/lib/suits", () => ({ useIsSuitHolder: () => false }));
// `AppState.tsx` imports this as "./DataSource"; Vitest keys mocks by resolved path, and the `@/`
// alias resolves to the same file, so the spelling here does not have to match the import's.
vi.mock("@/context/DataSource", () => ({ useDataSource: () => h.ds }));

/** The fake wallet: one signature, always accepted, recorded for the assertion. */
const sign: SignMessage = vi.fn(async () => "0xsignature" as Hex);

/**
 * The live context value, captured after each commit. `completeSign` returns a promise that
 * rejects when the wallet or the server refuses, and a rejection nobody holds is an unhandled
 * error Vitest 4 fails the whole run on — so the refusal case awaits it from here instead of
 * firing it from a click and dropping it.
 */
let api: AppState | null = null;

/** The one line a refused star or vote puts on screen; pinned here so the test fails if it drifts. */
const FAILED_TOAST = "failed:Couldn't save that. Try again.";

/**
 * Node reports a promise nobody held here. Vitest also fails the run on one, but a gated action is
 * fired and forgotten (`void run(...)`), so "the refusal was caught" is the assertion these two
 * cases are actually about — worth making locally rather than leaning on the runner.
 */
function watchUnhandled(): { seen: unknown[]; stop(): void } {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  return { seen, stop: () => void process.off("unhandledRejection", onUnhandled) };
}

/** One macrotask, which is when Node decides a rejection is going unhandled. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A promise the test settles by hand, so a request can be held in flight at an exact point. */
function deferred<T>(): { promise: Promise<T>; settle(value: T): void } {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/**
 * The two reads and the one write the vote flow touches, behind a store that answers like the
 * server does. `pairs` deliberately keeps answering the counts it was seeded with: that is the
 * thirty-second cache `_lib/counts.ts` reads through, and a client that leans on a refetch of the
 * list to show a vote is leaning on exactly this (the 23 Sep report).
 */
function fakeVotes(live: { bull: number; bear: number; voted?: VoteDir }, cached: [number, number] = [live.bull, live.bear]) {
  /** The toggle the store performs, exposed so a case can hold the request open around it. */
  const write = (dir: VoteDir): VoteResult => {
    if (live.voted) live[live.voted] -= 1;
    live.voted = live.voted === dir ? undefined : dir;
    if (live.voted) live[live.voted] += 1;
    return { dir: live.voted ?? null, bull: live.bull, bear: live.bear };
  };
  h.ds.pairs.mockImplementation(async () => [pairRow(cached[0], cached[1])]);
  h.ds.votes.mockImplementation(async () => (live.voted ? { [TOKEN]: live.voted } : {}));
  h.ds.vote.mockImplementation(async (_id, dir) => write(dir));
  /** Holds the next write open until `release()`, with the store still moving when it lands. */
  const hold = () => {
    const gate = deferred<void>();
    h.ds.vote.mockImplementationOnce(async (_id, dir) => {
      await gate.promise;
      return write(dir);
    });
    return () => gate.settle();
  };
  return { live, hold };
}

function Probe() {
  const s = useAppState();
  // The counts the token header renders come from the pairs list, so the list is what the vote
  // cases below watch: a vote that does not survive its own write shows up here as a number.
  const row = usePairs().data?.find((p) => p.id === TOKEN);
  useEffect(() => {
    api = s;
  });
  return (
    <div>
      <div data-testid="signed">{String(s.signed)}</div>
      <div data-testid="modal">{s.signModal?.kind ?? "none"}</div>
      <div data-testid="stars">{[...s.stars].join(",")}</div>
      <div data-testid="toasts">{s.toasts.map((t) => `${t.kind}:${t.message}`).join("|")}</div>
      <div data-testid="counts">{row ? `${row.bull}/${row.bear}` : "-"}</div>
      <div data-testid="voted">{s.votes[TOKEN] ?? "none"}</div>
      <button type="button" onClick={() => s.toggleStar(TOKEN)}>
        star
      </button>
      <button type="button" onClick={() => s.vote(TOKEN, "bull")}>
        vote
      </button>
      <button type="button" onClick={() => s.vote(TOKEN, "bear")}>
        vote bear
      </button>
      <button
        type="button"
        // The real `SignModal` awaits inside a try/catch; the button must not float a rejection
        // either, so every path out of a click is handled.
        onClick={() => {
          s.completeSign(sign, WALLET).catch(() => {});
        }}
      >
        complete
      </button>
    </div>
  );
}

function show() {
  const { client, wrapper: QueryWrapper } = queryHarness();
  // A factory, not a single element kept around: `rerender` with the very same element object
  // gives every fiber down to `Probe` referentially-equal props, which lets React bail out of
  // the subtree entirely — including the `useAccount()` call a wallet-switch test depends on. A
  // freshly built element each time has the same shape but a new identity, so nothing bails out.
  const buildTree = () => (
    <QueryWrapper>
      <AppStateProvider>
        <Probe />
      </AppStateProvider>
    </QueryWrapper>
  );
  const result = render(buildTree());
  return { ...result, client, rerenderApp: () => result.rerender(buildTree()) };
}

describe("AppStateProvider sign-in", () => {
  beforeEach(() => {
    api = null;
    h.account = { address: WALLET, isConnected: true };
    h.openConnectModal.mockClear();
    h.ds.session.mockReset().mockResolvedValue(null);
    h.ds.signIn.mockReset().mockResolvedValue(LOWER);
    h.ds.watchlist.mockReset().mockResolvedValue([TOKEN]);
    h.ds.votes.mockReset().mockResolvedValue({});
    h.ds.setWatch.mockReset().mockResolvedValue(undefined);
    h.ds.vote.mockReset().mockResolvedValue({ dir: "bull", bull: 1, bear: 0 });
    h.ds.pairs.mockReset().mockResolvedValue([pairRow(0, 0)]);
    (sign as ReturnType<typeof vi.fn>).mockClear();
  });

  it("seeds the session from the cookie, matching a lowercase address to a checksummed wallet", async () => {
    h.ds.session.mockResolvedValue(LOWER);
    show();
    await waitFor(() => expect(screen.getByTestId("signed").textContent).toBe("true"));
    // Signed in without a modal: the whole point of the cookie surviving a reload.
    expect(screen.getByTestId("modal").textContent).toBe("none");
    await waitFor(() => expect(h.ds.watchlist).toHaveBeenCalled());
  });

  it("leaves the user's lists alone until a session exists", async () => {
    show();
    await waitFor(() => expect(h.ds.session).toHaveBeenCalled());
    expect(h.ds.watchlist).not.toHaveBeenCalled();
    expect(h.ds.votes).not.toHaveBeenCalled();
  });

  it("opens the modal on a gated action and runs it once the sign-in lands", async () => {
    show();
    await waitFor(() => expect(h.ds.session).toHaveBeenCalled());

    fireEvent.click(screen.getByText("star"));
    expect(screen.getByTestId("modal").textContent).toBe("star");
    expect(h.ds.setWatch).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByText("complete"));
    });

    expect(h.ds.signIn).toHaveBeenCalledWith(sign, WALLET);
    await waitFor(() => expect(screen.getByTestId("signed").textContent).toBe("true"));
    expect(screen.getByTestId("modal").textContent).toBe("none");
    await waitFor(() => expect(h.ds.setWatch).toHaveBeenCalledWith(TOKEN, true));
    // The star is painted before the write settles and stays after the refetch.
    await waitFor(() => expect(screen.getByTestId("stars").textContent).toBe(TOKEN));
  });

  it("keeps the modal open and the session empty when the wallet or the server refuses", async () => {
    h.ds.signIn.mockRejectedValue(new Error("401"));
    show();
    await waitFor(() => expect(h.ds.session).toHaveBeenCalled());
    fireEvent.click(screen.getByText("star"));
    expect(screen.getByTestId("modal").textContent).toBe("star");

    // The rejection is awaited here rather than fired from the button and dropped: `completeSign`
    // must let the failure travel — that is how `SignModal` knows to stay open and show its line —
    // and a floating rejection is an unhandled error Vitest fails the run on.
    await act(async () => {
      await expect(api!.completeSign(sign, WALLET)).rejects.toThrow("401");
    });

    expect(screen.getByTestId("signed").textContent).toBe("false");
    expect(screen.getByTestId("modal").textContent).toBe("star");
    expect(h.ds.setWatch).not.toHaveBeenCalled();
  });

  it("asks for a wallet before a signature when nothing is connected", async () => {
    h.account = { address: undefined, isConnected: false };
    show();
    fireEvent.click(screen.getByText("star"));
    expect(h.openConnectModal).toHaveBeenCalled();
    expect(screen.getByTestId("modal").textContent).toBe("none");
  });

  it("drops the queued action on a refused sign-in, so a later successful sign-in does not run it", async () => {
    h.ds.signIn.mockRejectedValueOnce(new Error("401"));
    show();
    await waitFor(() => expect(h.ds.session).toHaveBeenCalled());

    fireEvent.click(screen.getByText("star"));
    expect(screen.getByTestId("modal").textContent).toBe("star");

    // First attempt: the wallet or the server refuses. The modal stays open for a retry, but the
    // queued star must not survive the refusal.
    await act(async () => {
      fireEvent.click(screen.getByText("complete"));
    });
    await waitFor(() => expect(h.ds.signIn).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("signed").textContent).toBe("false");
    expect(screen.getByTestId("modal").textContent).toBe("star");

    // Second attempt from the same still-open modal: the mocked signIn now resolves (the
    // one-time rejection above is already consumed), so the sign-in itself succeeds — but the
    // star queued before the refusal must not fire on its own.
    await act(async () => {
      fireEvent.click(screen.getByText("complete"));
    });
    await waitFor(() => expect(screen.getByTestId("signed").textContent).toBe("true"));
    expect(screen.getByTestId("modal").textContent).toBe("none");
    expect(h.ds.setWatch).not.toHaveBeenCalled();
  });

  it("drops a previous wallet's watchlist and votes the moment a different wallet connects", async () => {
    const WALLET_B = "0x1111111111111111111111111111111111111111" as Address;
    h.ds.session.mockResolvedValue(LOWER);
    h.ds.votes.mockResolvedValue({ [TOKEN]: "bull" });
    const { client, rerenderApp } = show();

    await waitFor(() => expect(screen.getByTestId("stars").textContent).toBe(TOKEN));
    await waitFor(() => expect(client.getQueryData(keys.votes)).toEqual({ [TOKEN]: "bull" }));

    // Wallet A disconnects and a different wallet, B, takes its place in the same tab. Nothing
    // about B has signed in yet, so B must not render a single answer that belongs to A.
    h.account = { address: WALLET_B, isConnected: true };
    rerenderApp();

    await waitFor(() => expect(client.getQueryData(keys.watchlist)).toBeUndefined());
    expect(client.getQueryData(keys.votes)).toBeUndefined();
    expect(screen.getByTestId("signed").textContent).toBe("false");
    expect(screen.getByTestId("stars").textContent).toBe("");
  });
});

/**
 * Review I2: a refused write used to fail silently. The star flipped back (the `finally`
 * invalidate did that much) and the rejection floated as `Uncaught (in promise)`, so the only
 * signal a 429, a 503 or an offline network gave the user was a star that would not stay put.
 */
describe("AppStateProvider refused writes", () => {
  beforeEach(() => {
    api = null;
    h.account = { address: WALLET, isConnected: true };
    h.openConnectModal.mockClear();
    h.ds.session.mockReset().mockResolvedValue(LOWER);
    h.ds.signIn.mockReset().mockResolvedValue(LOWER);
    h.ds.watchlist.mockReset().mockResolvedValue([TOKEN]);
    h.ds.votes.mockReset().mockResolvedValue({});
    h.ds.setWatch.mockReset().mockResolvedValue(undefined);
    h.ds.vote.mockReset().mockResolvedValue({ dir: "bull", bull: 1, bear: 0 });
    h.ds.pairs.mockReset().mockResolvedValue([pairRow(0, 0)]);
  });

  it("tells the user when a star is refused, puts the star back, and floats no rejection", async () => {
    h.ds.setWatch.mockRejectedValue(new Error("/api/me/watchlist: 429"));
    const unhandled = watchUnhandled();
    try {
      const { client } = show();
      await waitFor(() => expect(screen.getByTestId("stars").textContent).toBe(TOKEN));

      // The token starts starred, so this click unstars it: the optimistic write empties the
      // list before the refusal, which is what the invalidate below has to undo.
      fireEvent.click(screen.getByText("star"));
      expect(client.getQueryData(keys.watchlist)).toEqual([]);

      await waitFor(() => expect(screen.getByTestId("toasts").textContent).toBe(FAILED_TOAST));
      await waitFor(() => expect(screen.getByTestId("stars").textContent).toBe(TOKEN));
      await flush();
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it("tells the user when a vote is refused, restores the server's answer, and floats no rejection", async () => {
    h.ds.vote.mockRejectedValue(new Error("/api/me/votes: 503"));
    const unhandled = watchUnhandled();
    try {
      const { client } = show();
      await waitFor(() => expect(screen.getByTestId("signed").textContent).toBe("true"));
      await waitFor(() => expect(client.getQueryData(keys.votes)).toEqual({}));

      fireEvent.click(screen.getByText("vote"));
      expect(client.getQueryData(keys.votes)).toEqual({ [TOKEN]: "bull" }); // painted first

      await waitFor(() => expect(screen.getByTestId("toasts").textContent).toBe(FAILED_TOAST));
      await waitFor(() => expect(client.getQueryData(keys.votes)).toEqual({}));
      await flush();
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

});

/**
 * The 23 Sep report: "right after I vote, it doesn't show the vote ... I also don't have the option
 * to change my vote ... if you spam click the buttons it gets broken (sometimes -1, sometimes 0,
 * sometimes 2)". Three symptoms over one flow, and every case below is one of them.
 */
describe("AppStateProvider votes", () => {
  beforeEach(() => {
    api = null;
    h.account = { address: WALLET, isConnected: true };
    h.openConnectModal.mockClear();
    h.ds.session.mockReset().mockResolvedValue(LOWER);
    h.ds.signIn.mockReset().mockResolvedValue(LOWER);
    h.ds.watchlist.mockReset().mockResolvedValue([]);
    h.ds.votes.mockReset().mockResolvedValue({});
    h.ds.setWatch.mockReset().mockResolvedValue(undefined);
    h.ds.vote.mockReset();
    h.ds.pairs.mockReset();
    (sign as ReturnType<typeof vi.fn>).mockClear();
  });

  /**
   * Root cause 1. The write used to end by invalidating `keys.pairs`, and the list is served from
   * a counts cache that is up to thirty seconds old — so the refetch it asked for replaced the
   * vote the user had just cast with the number from before it.
   */
  it("paints the new count at once and keeps it while the list still answers the pre-vote number", async () => {
    fakeVotes({ bull: 3, bear: 1 });
    const { client } = show();
    await waitFor(() => expect(screen.getByTestId("counts").textContent).toBe("3/1"));

    fireEvent.click(screen.getByText("vote"));
    // The click's own tick, before any render: the cache is what the header reads a moment later.
    expect(client.getQueryData<TokenPair[]>(keys.pairs)?.[0]).toMatchObject({ bull: 4, bear: 1 });
    await waitFor(() => expect(h.ds.vote).toHaveBeenCalledWith(TOKEN, "bull"));

    await act(async () => {
      await flush();
    });
    expect(screen.getByTestId("counts").textContent).toBe("4/1"); // and still there once it settles
    expect(screen.getByTestId("voted").textContent).toBe("bull");
    expect(h.ds.pairs).toHaveBeenCalledTimes(1); // the stale list was never asked again
  });

  /**
   * Root cause 3. Every click used to fire its own toggle, and the server applied them in arrival
   * order: two clicks on one button cast and then cleared, which is where the 0 and the 2 in the
   * report came from. One write per token at a time, and the buttons say so.
   */
  it("ignores a second click while the first vote is in flight, and reports the token as pending", async () => {
    const store = fakeVotes({ bull: 3, bear: 1 });
    const release = store.hold();
    const { client } = show();
    await waitFor(() => expect(screen.getByTestId("counts").textContent).toBe("3/1"));

    fireEvent.click(screen.getByText("vote"));
    fireEvent.click(screen.getByText("vote")); // the same button again
    fireEvent.click(screen.getByText("vote bear")); // and the other one
    expect(h.ds.vote).toHaveBeenCalledTimes(1);
    // Not 5/1 from a double cast, not 3/2 from the second button, and not a 0 from the two racing.
    expect(client.getQueryData<TokenPair[]>(keys.pairs)?.[0]).toMatchObject({ bull: 4, bear: 1 });
    await waitFor(() => expect(api!.votePending.has(TOKEN)).toBe(true));

    await act(async () => {
      release();
      await flush();
    });
    await waitFor(() => expect(api!.votePending.has(TOKEN)).toBe(false));
    expect(screen.getByTestId("counts").textContent).toBe("4/1");
    expect(store.live).toMatchObject({ bull: 4, bear: 1, voted: "bull" }); // one toggle reached the store

    // The lock is for one request, not for the session: the next click goes through.
    fireEvent.click(screen.getByText("vote bear"));
    await waitFor(() => expect(h.ds.vote).toHaveBeenCalledTimes(2));
  });

  /**
   * Root cause 2, and the "no option to change my vote" half of the report: the optimistic delta
   * was applied to whatever number the cache held, and that number can predate the wallet's own
   * vote — `updated[prev] -= 1` on a zero is where the -1 came from.
   */
  it("switches to the other direction, clears on the same one, and never paints a negative count", async () => {
    // The book says this wallet leans bull; the list's counts are a cached moment without it.
    fakeVotes({ bull: 1, bear: 0, voted: "bull" }, [0, 0]);
    const { client } = show();
    await waitFor(() => expect(screen.getByTestId("voted").textContent).toBe("bull"));
    expect(screen.getByTestId("counts").textContent).toBe("0/0");

    fireEvent.click(screen.getByText("vote bear")); // switch
    expect(client.getQueryData<TokenPair[]>(keys.pairs)?.[0]).toMatchObject({ bull: 0, bear: 1 }); // never -1
    await waitFor(() => expect(h.ds.vote).toHaveBeenCalledWith(TOKEN, "bear"));
    await act(async () => {
      await flush();
    });
    expect(screen.getByTestId("voted").textContent).toBe("bear");
    expect(screen.getByTestId("counts").textContent).toBe("0/1"); // the server's own answer

    fireEvent.click(screen.getByText("vote bear")); // the same direction again clears it
    await act(async () => {
      await flush();
    });
    expect(screen.getByTestId("voted").textContent).toBe("none");
    expect(screen.getByTestId("counts").textContent).toBe("0/0");
  });

  /**
   * The first symptom as reported — "it doesn't show the vote immediately after I sign". The
   * session that lands enables the votes query, so its first read is in flight beside the POST the
   * same sign-in released, and it answers with the book from before the write.
   */
  it("leaves the vote on screen when the deferred sign-in's own votes read lands after the write", async () => {
    h.ds.session.mockResolvedValue(null); // nobody signed in yet: the vote is queued behind the modal
    const store = fakeVotes({ bull: 3, bear: 1 });
    const release = store.hold();
    // The read the session itself starts, held open so it can answer after the write commits.
    const read = deferred<Record<string, VoteDir>>();
    h.ds.votes.mockImplementationOnce(() => read.promise);

    show();
    await waitFor(() => expect(h.ds.session).toHaveBeenCalled());
    fireEvent.click(screen.getByText("vote"));
    expect(screen.getByTestId("modal").textContent).toBe("vote");
    expect(h.ds.vote).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByText("complete"));
    });
    await waitFor(() => expect(h.ds.vote).toHaveBeenCalledWith(TOKEN, "bull"));

    // The write commits, and only then the read that the session started answers — with the book
    // as it was before the vote. That order is what used to wipe the vote off the screen.
    await act(async () => {
      release();
      await flush();
      read.settle({});
      await flush();
    });

    await waitFor(() => expect(screen.getByTestId("voted").textContent).toBe("bull"));
    expect(screen.getByTestId("counts").textContent).toBe("4/1");
  });

  /**
   * Review M4: a token outside the 500-row pairs list lives under `keys.pair(id)`. The counts there
   * used to be repaired by an invalidate, which re-read the same stale cache; now the server's own
   * answer is written into the row, wherever the row lives.
   */
  it("writes the server's counts into the deep-linked token's own key as well as the list", async () => {
    fakeVotes({ bull: 3, bear: 1 });
    const { client } = show();
    await waitFor(() => expect(screen.getByTestId("signed").textContent).toBe("true"));
    // The harness collects a query nobody observes on the next tick (`gcTime: 0`); on the token
    // page `usePair` holds this row, so the row is held here too.
    client.setQueryDefaults(keys.pair(TOKEN), { gcTime: Infinity });
    client.setQueryData(keys.pair(TOKEN), pairRow(3, 1));

    fireEvent.click(screen.getByText("vote"));
    await waitFor(() => expect(h.ds.vote).toHaveBeenCalledWith(TOKEN, "bull"));
    await act(async () => {
      await flush();
    });

    expect(client.getQueryData<TokenPair>(keys.pair(TOKEN))).toMatchObject({ bull: 4, bear: 1 });
    expect(client.getQueryData<TokenPair[]>(keys.pairs)?.[0]).toMatchObject({ bull: 4, bear: 1 });
  });
});
