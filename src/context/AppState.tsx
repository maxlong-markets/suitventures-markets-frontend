"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAccount, useAccountEffect } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQueryClient, type Query } from "@tanstack/react-query";
import {
  DEFAULT_FILTERS,
  applyPreset,
  toggleSort,
  type MarketFilters,
  type OriginFilter,
  type PresetKey,
  type SortKey,
} from "@/lib/markets";
import type { Address, SignMessage, TokenPair, VoteDir } from "@/lib/types";
import { gateEnabled, useIsSuitHolder, useSuitsAccess } from "@/lib/suits";
import { SessionsOffError } from "@/lib/session/errors";
import { keys, useVotes, useWatchlist } from "@/hooks/useMarketsData";
import { useDataSource } from "./DataSource";

/**
 * "unconfirmed": broadcast, but the receipt could not be read (`SwapUnconfirmedError`). It is
 * deliberately not "failed" — the transaction may well have landed, and telling the user nothing
 * was spent would invite a duplicate swap.
 */
export type ToastKind = "pending" | "confirmed" | "unconfirmed" | "failed";
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  hash?: string;
}

/** What a signature was asked for: one of the gated actions, or "connect", asked as soon as the connect modal hands over a wallet. */
export type GateKind = "star" | "vote" | "launch" | "connect";
/** The kinds an action can queue under; a connect-time ask queues nothing. */
export type ActionKind = Exclude<GateKind, "connect">;
/** What the sign modal is open for: an action's own prompt, or the connect-time ask, tied to the wallet it was asked of. */
export type SignRequest = { kind: ActionKind } | { kind: "connect"; for: Address };
interface GateContext {
  /** The signed-in address. M4's two gated actions no longer need it — the cookie is the
   *  identity — but the gate keeps handing it over for the ones that will. */
  address: Address;
}
type GatedAction = (ctx: GateContext) => void | Promise<void>;

export interface AppState {
  address?: Address;
  isConnected: boolean;
  isHolder: boolean;
  signed: boolean;

  filters: MarketFilters;
  toggleQuote(symbol: string): void;
  clearQuotes(): void;
  setOrigin(o: OriginFilter): void;
  setPreset(p: PresetKey): void;
  sortBy(key: SortKey): void;
  setQuery(q: string): void;
  resetFilters(): void;

  stars: ReadonlySet<string>;
  watchlistLoading: boolean;
  toggleStar(id: string): void;
  votes: Readonly<Record<string, VoteDir>>;
  vote(id: string, dir: VoteDir): void;
  /**
   * The tokens with a vote write in flight. `vote` ignores a click on one of them, so the buttons
   * have to say so — an ignored click that looked like a working one is what made spam-clicking
   * feel broken in the first place.
   */
  votePending: ReadonlySet<string>;

  signModal: SignRequest | null;
  /** Opens the connect or sign-in flow with nothing queued behind it; `/watchlist` uses it. */
  promptSignIn(): void;
  /**
   * The same connect-then-sign gate the star and the vote use, for any action: `run` fires once a session exists. The
   * launch form (instant launchpad design, section 7.2, submit step 1) passes a no-op and resumes itself when `signed`
   * flips, because its submit closes over the form's state. `onCancel` fires whenever the queued action is abandoned
   * (the sign modal closed, the signature refused, the connect modal closed with no wallet, or a newer gesture replacing
   * it), so the caller can drop what it queued.
   */
  withSignIn(kind: ActionKind, run: () => void, onCancel?: () => void): void;
  completeSign(sign: SignMessage, address: Address): Promise<void>;
  cancelSign(): void;

  toasts: Toast[];
  addToast(t: Omit<Toast, "id">): number;
  updateToast(id: number, patch: Partial<Omit<Toast, "id">>): void;
  dismissToast(id: number): void;
}

/**
 * The session's address comes from the server and is lowercase; wagmi's is checksummed. Comparing
 * them with `===` would call every signed-in wallet a stranger and re-open the modal for ever.
 */
function sameAddress(a?: string, b?: string): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

const AppStateContext = createContext<AppState | null>(null);

const CONFIRMED_TOAST_TTL = 7_000;

/**
 * One line for every refused star or vote — a 429 from the write budget, a 503 from the store, a
 * wallet at its row cap, an offline network. It names no status and no host: the user's only
 * move is the same in all four cases, and the `finally` invalidate has already put the true
 * state back underneath it (review I2).
 */
const WRITE_FAILED = "Couldn't save that. Try again.";

/** One frozen empty set, so "no vote is in flight" is the same value on every render. */
const NO_VOTES_PENDING: ReadonlySet<string> = new Set();

/** A query worth cancelling before an optimistic write: one that already holds what would be lost. */
const loaded = (query: Query) => query.state.data !== undefined;

export function AppStateProvider({ children }: { children: ReactNode }) {
  const ds = useDataSource();
  const qc = useQueryClient();
  const { address, isConnected } = useAccount();
  const isHolder = useIsSuitHolder(address);
  const { openConnectModal, connectModalOpen } = useConnectModal();

  // --- filters ---------------------------------------------------------
  const [filters, setFilters] = useState<MarketFilters>(DEFAULT_FILTERS);
  const toggleQuote = useCallback((symbol: string) => {
    setFilters((f) => ({
      ...f,
      quotes: f.quotes.includes(symbol)
        ? f.quotes.filter((q) => q !== symbol)
        : [...f.quotes, symbol],
    }));
  }, []);
  const clearQuotes = useCallback(
    () => setFilters((f) => ({ ...f, quotes: [] })),
    [],
  );
  const setOrigin = useCallback(
    (origin: OriginFilter) => setFilters((f) => ({ ...f, origin })),
    [],
  );
  const setPreset = useCallback(
    (p: PresetKey) => setFilters((f) => applyPreset(f, p)),
    [],
  );
  const sortBy = useCallback(
    (key: SortKey) => setFilters((f) => toggleSort(f, key)),
    [],
  );
  const setQuery = useCallback(
    (query: string) => setFilters((f) => ({ ...f, query })),
    [],
  );
  const resetFilters = useCallback(() => setFilters(DEFAULT_FILTERS), []);

  // --- toasts ----------------------------------------------------------
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const dismissToast = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);
  const addToast = useCallback((t: Omit<Toast, "id">) => {
    const id = ++toastId.current;
    setToasts((list) => [...list, { ...t, id }]);
    return id;
  }, []);
  const updateToast = useCallback(
    (id: number, patch: Partial<Omit<Toast, "id">>) => {
      setToasts((list) =>
        list.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      );
      if (patch.kind === "confirmed") {
        window.setTimeout(() => dismissToast(id), CONFIRMED_TOAST_TTL);
      }
    },
    [dismissToast],
  );

  // --- session + gate ---------------------------------------------------
  const [session, setSession] = useState<{ address: Address } | null>(null);
  // True until the cookie probe below settles, one way or the other. `watchlistLoading` folds
  // this in so `/watchlist` shows its loading state rather than the signed-out empty copy for
  // the one render where "not signed in yet" and "still probing" would otherwise look the same
  // (Task 4 review F6).
  const [sessionLoading, setSessionLoading] = useState(true);
  const signed = sameAddress(session?.address, address);
  const [signModal, setSignModal] = useState<SignRequest | null>(null);
  const pendingRef = useRef<{ kind: ActionKind; run: GatedAction; onCancel?: () => void } | null>(null);
  /** Armed when the connect modal hands over a wallet; consumed by the hand-over effect, or by whatever asks first. */
  const askOnHandOver = useRef(false);
  /** The probe met a 503: `SESSION_SECRET` is unset here, so no sign-in can succeed and none is asked unprompted. */
  const sessionsOff = useRef(false);
  /**
   * The holders-only gate's answer (D44). The connect-time ask waits for it and is dropped for a wallet it turns away,
   * so the lock screen never asks for a signature. This is the same `balanceOf` read `TokenGate` makes, so no request
   * is added; a read that failed counts as not admitted, and the gate still asks later for whatever needs a session.
   */
  const access = useSuitsAccess(address);
  const accessPending = gateEnabled() && access.status === "checking";
  const admitted = !gateEnabled() || access.status === "granted";

  // On load the cookie says whether this browser is already signed in, so a wallet that signed in
  // on another device sees its watchlist here without signing again. A failed probe means "not
  // signed in"; the functional update keeps a sign-in that raced ahead of it.
  useEffect(() => {
    let alive = true;
    void ds
      .session()
      .then((addr) => {
        if (alive && addr) setSession((s) => s ?? { address: addr });
      })
      .catch((err: unknown) => {
        if (alive && err instanceof SessionsOffError) sessionsOff.current = true;
      })
      .finally(() => {
        if (alive) setSessionLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [ds]);

  // Stars and votes belong to a session, not to a browser tab: the moment this wallet stops being
  // the signed-in one, the previous wallet's answers leave the cache rather than render for a frame.
  useEffect(() => {
    if (signed) return;
    qc.removeQueries({ queryKey: keys.watchlist });
    qc.removeQueries({ queryKey: keys.votes });
  }, [signed, qc]);

  /**
   * Every gated action is fired and forgotten, so this is where a rejection stops: without it a
   * refused write floats as `Uncaught (in promise)` and the user sees nothing but a star that
   * flips back (review I2). Both of today's actions also catch their own failure, so they can
   * toast while their `finally` restores the truth; this is the backstop for whatever is gated
   * next, and for a synchronous throw.
   */
  const fire = useCallback(
    (run: GatedAction, ctx: GateContext) => {
      const failed = () => addToast({ kind: "failed", message: WRITE_FAILED });
      try {
        // `run(ctx)` is called here rather than inside a `.then`, so its optimistic write still
        // lands in the same tick as the click; only the rejection is deferred. The `try` is for
        // a synchronous throw, which an async action cannot make but a plain one can.
        void Promise.resolve(run(ctx)).catch(failed);
      } catch {
        failed();
      }
    },
    [addToast],
  );

  const gate = useCallback(
    (kind: ActionKind, run: GatedAction, onCancel?: () => void) => {
      // A new gesture replaces whatever was queued: the replaced action is abandoned, so its owner is told
      // (a star pressed while a launch waits for its signature must never let that launch fire later).
      const replace = (next: { kind: ActionKind; run: GatedAction; onCancel?: () => void }) => {
        const previous = pendingRef.current;
        pendingRef.current = next;
        if (previous && previous !== next) previous.onCancel?.();
      };
      if (!isConnected || !address) {
        replace({ kind, run, onCancel });
        openConnectModal?.();
        return;
      }
      if (!sameAddress(session?.address, address)) {
        replace({ kind, run, onCancel });
        // This prompt is the one this wallet gets: a connect-time ask still waiting on the cookie probe stands down.
        askOnHandOver.current = false;
        setSignModal({ kind });
        return;
      }
      fire(run, { address });
    },
    [address, fire, isConnected, openConnectModal, session],
  );

  /**
   * The sign-in affordance `/watchlist` needs for a connected wallet that has not signed in here
   * (review I5): the same gate the star and the vote use, running nothing. Signing in is the whole
   * effect — `signed` flips, and the watchlist query it enables loads the wallet's real list.
   */
  const promptSignIn = useCallback(() => gate("star", () => {}), [gate]);

  const withSignIn = useCallback(
    (kind: ActionKind, run: () => void, onCancel?: () => void) => gate(kind, () => run(), onCancel),
    [gate],
  );

  // A wallet connected while an action was waiting: continue to the signature. A session found late (the cookie probe
  // settling after the action's dialog opened) fires the action and closes that dialog, which has nothing left to ask.
  useEffect(() => {
    if (!isConnected || !address) return;
    const pending = pendingRef.current;
    if (pending && sameAddress(session?.address, address)) {
      pendingRef.current = null;
      setSignModal(null);
      fire(pending.run, { address });
    } else if (pending) {
      setSignModal({ kind: pending.kind });
    }
  }, [isConnected, address, fire, session]);

  /**
   * The connect modal closed. With no wallet: the action queued behind it is abandoned (its owner is told). With a
   * wallet in hand: the signature is asked right here, so the launch form, the star and the vote find a session
   * instead of each asking in its own moment. It waits for the cookie probe, because a wallet that signed in here
   * within the last 7 days must not be asked again, and for the holders-only gate, so a wallet it turns away is never
   * asked. An action queued behind the connect owns the one prompt (the effect above), so the hand-over arms nothing
   * then. A reload's automatic reconnect never opens the connect modal, so it asks nothing here, and the gate still
   * asks later for whatever needs a session. Declining leaves the wallet connected and signed out, and the gate asks
   * again on the next gated action.
   */
  const connectWasOpen = useRef(false);
  useEffect(() => {
    if (connectModalOpen) {
      connectWasOpen.current = true;
      return;
    }
    if (connectWasOpen.current) {
      connectWasOpen.current = false;
      if (!isConnected) {
        const abandoned = pendingRef.current;
        pendingRef.current = null;
        abandoned?.onCancel?.();
        return;
      }
      askOnHandOver.current = !pendingRef.current;
    }
    if (!askOnHandOver.current || sessionLoading || accessPending) return;
    askOnHandOver.current = false;
    if (sessionsOff.current || !admitted || !isConnected || !address || pendingRef.current || sameAddress(session?.address, address)) return;
    setSignModal({ kind: "connect", for: address });
  }, [connectModalOpen, isConnected, sessionLoading, accessPending, admitted, address, session]);

  // The wallet left while a connect-time ask was open or still waiting: both are over. A wallet connected later gets
  // its own hand-over, or nothing, rather than a dialog left behind by the previous one.
  const onDisconnect = useCallback(() => {
    askOnHandOver.current = false;
    setSignModal((m) => (m?.kind === "connect" ? null : m));
  }, []);
  useAccountEffect({ onDisconnect });

  /**
   * Nonce, message, signature, cookie — all inside the data source. It throws when the wallet
   * refuses or the server does; `SignModal` catches that and shows its own line, so the modal
   * stays open on a failure and closes only on a session the server actually issued.
   */
  const completeSign = useCallback(
    async (sign: SignMessage, addr: Address) => {
      let signedAddress: Address;
      try {
        signedAddress = await ds.signIn(sign, addr);
      } catch (err) {
        // A refusal — the wallet's or the server's — drops the queued action rather than leaving
        // it to fire on some later, unrelated sign-in; only a fresh gesture may queue another one.
        const abandoned = pendingRef.current;
        pendingRef.current = null;
        abandoned?.onCancel?.();
        throw err;
      }
      setSession({ address: signedAddress });
      setSignModal(null);
      askOnHandOver.current = false;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) fire(pending.run, { address: signedAddress });
    },
    [ds, fire],
  );

  const cancelSign = useCallback(() => {
    // Closed without signing: the queued action is dropped, and its owner is told so it can undo what it showed. A
    // connect-time ask still waiting on the cookie probe is dropped too: one "no" is the answer to both.
    const pending = pendingRef.current;
    pendingRef.current = null;
    askOnHandOver.current = false;
    setSignModal(null);
    pending?.onCancel?.();
  }, []);

  // --- watchlist -------------------------------------------------------
  const watchlistQuery = useWatchlist(signed);
  const stars = useMemo(
    () => new Set(watchlistQuery.data ?? []),
    [watchlistQuery.data],
  );

  const toggleStar = useCallback(
    (id: string) => {
      gate("star", async () => {
        const current = qc.getQueryData<string[]>(keys.watchlist) ?? [];
        const on = !current.includes(id);
        qc.setQueryData<string[]>(keys.watchlist, (old = []) =>
          on ? [...old.filter((t) => t !== id), id] : old.filter((t) => t !== id),
        );
        try {
          await ds.setWatch(id, on);
        } catch {
          // The status is deliberately not read: 429, 503 and a dead network all leave the user
          // the same move, and the `finally` below is what puts the real list back.
          addToast({ kind: "failed", message: WRITE_FAILED });
        } finally {
          // Also the rollback: a refused write is followed by the server's own answer.
          void qc.invalidateQueries({ queryKey: keys.watchlist });
        }
      });
    },
    [addToast, ds, gate, qc],
  );

  // --- votes -----------------------------------------------------------
  const votesQuery = useVotes(signed);
  const votes = useMemo(() => votesQuery.data ?? {}, [votesQuery.data]);

  /**
   * The tokens whose vote write is in flight. The ref is the lock — a click handler reads it in
   * the tick it was written, where a state value would still be the previous render's — and the
   * state beside it is the same set for rendering.
   */
  const votingRef = useRef<Set<string>>(new Set());
  const [votePending, setVotePending] = useState<ReadonlySet<string>>(NO_VOTES_PENDING);
  const markVoting = useCallback((id: string, on: boolean) => {
    if (on) votingRef.current.add(id);
    else votingRef.current.delete(id);
    setVotePending(votingRef.current.size === 0 ? NO_VOTES_PENDING : new Set(votingRef.current));
  }, []);

  const vote = useCallback(
    (id: string, dir: VoteDir) => {
      gate("vote", async () => {
        // One write per token at a time. Every click used to fire its own toggle and the server
        // applied them in arrival order, so two clicks on one button cast and then cleared it:
        // that is the 0, and a click on each button is the 2 (report of 23 Sep). Queueing the
        // second toggle would be the same race with more steps, so the click is dropped instead —
        // and `votePending` is what tells the user that, rather than a button that does nothing.
        if (votingRef.current.has(id)) return;
        markVoting(id, true);

        // Every step after the lock is inside the try, so nothing the `finally` has to undo — the
        // lock above all — can be left behind by a throw on the way in. That is why the snapshot
        // is declared out here and filled in there.
        let prevBook: Record<string, VoteDir> | undefined;
        let prevPairs: TokenPair[] | undefined;
        let prevPair: TokenPair | null | undefined;
        try {
          // Before the optimistic write, never after: a read of one of these three that is already
          // in flight resolves with the state from before this vote and lands on top of it. The
          // votes book above all — `useVotes` is enabled the moment the session lands, so its
          // first fetch races the very write that same sign-in released. Cancelling reverts each
          // query to the state it had before its fetch, which is the state snapshotted just below.
          //
          // The two count queries are cancelled only where they already hold data: the write below
          // patches rows it finds and writes nothing where there are none, so a first load has
          // nothing to clobber and a page to deliver. The book has no such exemption — an empty
          // book is a book, and the optimistic write replaces it outright.
          void qc.cancelQueries({ queryKey: keys.votes });
          void qc.cancelQueries({ queryKey: keys.pairs, predicate: loaded });
          void qc.cancelQueries({ queryKey: keys.pair(id), predicate: loaded });

          prevBook = qc.getQueryData<Record<string, VoteDir>>(keys.votes);
          prevPairs = qc.getQueryData<TokenPair[]>(keys.pairs);
          prevPair = qc.getQueryData<TokenPair | null>(keys.pair(id));

          // A token is listed, deep-linked, or both; the counts live under whichever key holds it.
          const eachRow = (fn: (row: TokenPair) => TokenPair) => {
            qc.setQueryData<TokenPair[]>(keys.pairs, (old) => old?.map((p) => (p.id === id ? fn(p) : p)));
            qc.setQueryData<TokenPair | null>(keys.pair(id), (old) => (old ? fn(old) : old));
          };

          const prev = prevBook?.[id];
          const next = { ...(prevBook ?? {}) };
          if (prev === dir) delete next[id];
          else next[id] = dir;
          qc.setQueryData(keys.votes, next);
          // The number this delta lands on can be up to thirty seconds old and may already count
          // this wallet's vote, or not yet count one it cast elsewhere — so the decrement is
          // clamped: a count of people is never negative, and this one is only an estimate until
          // the answer below replaces it. Unclamped, a click against a stale zero painted -1.
          eachRow((row) => {
            const updated = { ...row };
            if (prev) updated[prev] = Math.max(0, updated[prev] - 1);
            if (prev !== dir) updated[dir] += 1;
            return updated;
          });

          const written = await ds.vote(id, dir);
          // The server's own answer, with this write already in it, put exactly where the estimate
          // was. Asking the read path for it instead is what broke: those counts come from a
          // thirty-second cache, so the refetch answered with the count from before the vote.
          qc.setQueryData<Record<string, VoteDir>>(keys.votes, (old) => {
            const book = { ...(old ?? {}) };
            if (written.dir) book[id] = written.dir;
            else delete book[id];
            return book;
          });
          eachRow((row) => ({ ...row, bull: written.bull, bear: written.bear }));
        } catch {
          // The snapshot, not a refetch: the counts a refetch brings back are the stale ones, and
          // the status is deliberately not read — 429, 503 and a dead network leave the user the
          // same move (review I2).
          //
          // `?? {}` is load-bearing: `setQueryData` ignores an `undefined` value, so restoring a
          // book that had not loaded yet would restore nothing and leave the refused vote
          // highlighted until the settle refetch. An empty book is also exactly what the screen
          // showed while the read was still out, since `votes` below reads `data ?? {}`. The two
          // count rows need no such fallback: the write above patches rows it finds and writes
          // nothing where there are none, so an absent snapshot means nothing was changed.
          qc.setQueryData(keys.votes, prevBook ?? {});
          qc.setQueryData(keys.pairs, prevPairs);
          qc.setQueryData(keys.pair(id), prevPair);
          addToast({ kind: "failed", message: WRITE_FAILED });
        } finally {
          markVoting(id, false);
          // The book, and only the book. It is the one thing this write cannot state on its own —
          // another tab may have voted on another token — and reading it after the commit is
          // correct. The counts are not invalidated: the list is served from that thirty-second
          // cache, and asking it again is what painted the vote away (review M4 is answered by
          // writing the server's counts into `keys.pair(id)` above, not by a refetch).
          void qc.invalidateQueries({ queryKey: keys.votes });
        }
      });
    },
    [addToast, ds, gate, markVoting, qc],
  );

  const value = useMemo<AppState>(
    () => ({
      address,
      isConnected,
      isHolder,
      signed,
      filters,
      toggleQuote,
      clearQuotes,
      setOrigin,
      setPreset,
      sortBy,
      setQuery,
      resetFilters,
      stars,
      watchlistLoading: sessionLoading || (signed && watchlistQuery.isPending),
      toggleStar,
      votes,
      vote,
      votePending,
      signModal,
      promptSignIn,
      withSignIn,
      completeSign,
      cancelSign,
      toasts,
      addToast,
      updateToast,
      dismissToast,
    }),
    [
      address,
      isConnected,
      isHolder,
      signed,
      filters,
      toggleQuote,
      clearQuotes,
      setOrigin,
      setPreset,
      sortBy,
      setQuery,
      resetFilters,
      stars,
      sessionLoading,
      watchlistQuery.isPending,
      toggleStar,
      votes,
      vote,
      votePending,
      signModal,
      promptSignIn,
      withSignIn,
      completeSign,
      cancelSign,
      toasts,
      addToast,
      updateToast,
      dismissToast,
    ],
  );

  return (
    <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
  );
}

export function useAppState(): AppState {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used inside AppStateProvider");
  return ctx;
}
