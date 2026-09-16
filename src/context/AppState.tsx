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
import type { Address, TokenPair, VoteDir } from "@/lib/types";
import { useIsSuitHolder } from "@/lib/suits";
import { keys, useVotes, useWatchlist } from "@/hooks/useMarketsData";
import { useDataSource } from "./DataSource";

export type ToastKind = "pending" | "confirmed" | "failed";
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  hash?: string;
}

export type GateKind = "star" | "vote";
interface GateContext {
  address: Address;
  signature: string;
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
  completeSign(signature: string): void;
  cancelSign(): void;

  toasts: Toast[];
  addToast(t: Omit<Toast, "id">): number;
  updateToast(id: number, patch: Partial<Omit<Toast, "id">>): void;
  dismissToast(id: number): void;
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

  // --- session signature + gate ---------------------------------------
  const [session, setSession] = useState<{
    address: Address;
    signature: string;
  } | null>(null);
  const signed = Boolean(session && address && session.address === address);
  const [signModal, setSignModal] = useState<{ kind: GateKind } | null>(null);
  const pendingRef = useRef<{ kind: GateKind; run: GatedAction } | null>(null);

  const gate = useCallback(
    (kind: GateKind, run: GatedAction) => {
      if (!isConnected || !address) {
        pendingRef.current = { kind, run };
        openConnectModal?.();
        return;
      }
      if (!session || session.address !== address) {
        pendingRef.current = { kind, run };
        setSignModal({ kind });
        return;
      }
      void run({ address, signature: session.signature });
    },
    [address, isConnected, openConnectModal, session],
  );

  // A wallet connected while an action was waiting: continue to the signature.
  useEffect(() => {
    if (!isConnected || !address || !pendingRef.current) return;
    if (session && session.address === address) {
      const { run } = pendingRef.current;
      pendingRef.current = null;
      void run({ address, signature: session.signature });
    } else {
      setSignModal({ kind: pendingRef.current.kind });
    }
  }, [isConnected, address, session]);

  const completeSign = useCallback(
    (signature: string) => {
      if (!address) return;
      setSession({ address, signature });
      setSignModal(null);
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) void pending.run({ address, signature });
    },
    [address],
  );

  const cancelSign = useCallback(() => {
    pendingRef.current = null;
    setSignModal(null);
  }, []);

  // --- watchlist -------------------------------------------------------
  const watchlistQuery = useWatchlist(address);
  const stars = useMemo(
    () => new Set(watchlistQuery.data ?? []),
    [watchlistQuery.data],
  );

  const toggleStar = useCallback(
    (id: string) => {
      gate("star", async ({ address: addr, signature }) => {
        const key = keys.watchlist(addr);
        const current = qc.getQueryData<string[]>(key) ?? [];
        const on = !current.includes(id);
        qc.setQueryData<string[]>(key, (old = []) =>
          on ? [...old.filter((t) => t !== id), id] : old.filter((t) => t !== id),
        );
        try {
          await ds.setWatch(addr, id, on, signature);
        } finally {
          void qc.invalidateQueries({ queryKey: key });
        }
      });
    },
    [ds, gate, qc],
  );

  // --- votes -----------------------------------------------------------
  const votesQuery = useVotes(address);
  const votes = useMemo(() => votesQuery.data ?? {}, [votesQuery.data]);

  const vote = useCallback(
    (id: string, dir: VoteDir) => {
      gate("vote", async ({ address: addr, signature }) => {
        const voteKey = keys.votes(addr);
        const book = qc.getQueryData<Record<string, VoteDir>>(voteKey) ?? {};
        const prev = book[id];
        const next = { ...book };
        if (prev === dir) delete next[id];
        else next[id] = dir;
        qc.setQueryData(voteKey, next);
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
          await ds.vote(addr, id, dir, signature);
        } finally {
          void qc.invalidateQueries({ queryKey: voteKey });
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
      watchlistLoading: Boolean(address) && watchlistQuery.isPending,
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
