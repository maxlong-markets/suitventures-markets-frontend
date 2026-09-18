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
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQueryClient } from "@tanstack/react-query";
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
import { useIsSuitHolder } from "@/lib/suits";
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

export type GateKind = "star" | "vote";
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

  signModal: { kind: GateKind } | null;
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

export function AppStateProvider({ children }: { children: ReactNode }) {
  const ds = useDataSource();
  const qc = useQueryClient();
  const { address, isConnected } = useAccount();
  const isHolder = useIsSuitHolder(address);
  const { openConnectModal } = useConnectModal();

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

  // --- session + gate ---------------------------------------------------
  const [session, setSession] = useState<{ address: Address } | null>(null);
  // True until the cookie probe below settles, one way or the other. `watchlistLoading` folds
  // this in so `/watchlist` shows its loading state rather than the signed-out empty copy for
  // the one render where "not signed in yet" and "still probing" would otherwise look the same
  // (Task 4 review F6).
  const [sessionLoading, setSessionLoading] = useState(true);
  const signed = sameAddress(session?.address, address);
  const [signModal, setSignModal] = useState<{ kind: GateKind } | null>(null);
  const pendingRef = useRef<{ kind: GateKind; run: GatedAction } | null>(null);

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
      .catch(() => undefined)
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

  const gate = useCallback(
    (kind: GateKind, run: GatedAction) => {
      if (!isConnected || !address) {
        pendingRef.current = { kind, run };
        openConnectModal?.();
        return;
      }
      if (!sameAddress(session?.address, address)) {
        pendingRef.current = { kind, run };
        setSignModal({ kind });
        return;
      }
      void run({ address });
    },
    [address, isConnected, openConnectModal, session],
  );

  // A wallet connected while an action was waiting: continue to the signature.
  useEffect(() => {
    if (!isConnected || !address || !pendingRef.current) return;
    if (sameAddress(session?.address, address)) {
      const { run } = pendingRef.current;
      pendingRef.current = null;
      void run({ address });
    } else {
      setSignModal({ kind: pendingRef.current.kind });
    }
  }, [isConnected, address, session]);

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
        pendingRef.current = null;
        throw err;
      }
      setSession({ address: signedAddress });
      setSignModal(null);
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) void pending.run({ address: signedAddress });
    },
    [ds],
  );

  const cancelSign = useCallback(() => {
    pendingRef.current = null;
    setSignModal(null);
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
        } finally {
          // Also the rollback: a refused write is followed by the server's own answer.
          void qc.invalidateQueries({ queryKey: keys.watchlist });
        }
      });
    },
    [ds, gate, qc],
  );

  // --- votes -----------------------------------------------------------
  const votesQuery = useVotes(signed);
  const votes = useMemo(() => votesQuery.data ?? {}, [votesQuery.data]);

  const vote = useCallback(
    (id: string, dir: VoteDir) => {
      gate("vote", async () => {
        const book = qc.getQueryData<Record<string, VoteDir>>(keys.votes) ?? {};
        const prev = book[id];
        const next = { ...book };
        if (prev === dir) delete next[id];
        else next[id] = dir;
        qc.setQueryData(keys.votes, next);
        qc.setQueryData<TokenPair[]>(keys.pairs, (old) =>
          old?.map((p) => {
            if (p.id !== id) return p;
            const updated = { ...p };
            if (prev) updated[prev] -= 1;
            if (prev !== dir) updated[dir] += 1;
            return updated;
          }),
        );
        try {
          await ds.vote(id, dir);
        } finally {
          void qc.invalidateQueries({ queryKey: keys.votes });
          void qc.invalidateQueries({ queryKey: keys.pairs });
        }
      });
    },
    [ds, gate, qc],
  );

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
      signModal,
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
      signModal,
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
