import type { PairsScope } from "@/lib/envio/pairs";
import type { IndexerInterval } from "@/lib/sync/ids";
import type { Candle, Holder, QuoteAsset, TokenPair, Trade } from "@/lib/types";
import { getDb } from "@/lib/db/client";
import { createEnvioSource } from "@/lib/sync/envioSource";
import { createDbBackend } from "./dbBackend";
import { createEnvioBackend } from "./envioBackend";
import type { PoolKeyRow } from "./poolKey";

export type HealthReport = {
  ok: boolean; backend: "db" | "envio";
  lag: number | null; // indexer block lag as in M1
  quotes: { id: string; ageSec: number; stale: boolean }[];
  db?: { latencyMs: number };
  sync?: { lastOkAgeSec: number | null; cursorAgeSec: number | null; lastError: string | null };
  nightly?: { lastOkAgeSec: number | null; lastError: string | null; phase: string }; // phase "" is a finished re-pull
  error?: string;
};

/** Every reader throws on failure except `health()`, which reports it: the health route memoises outcomes, never exceptions. */
export interface MarketBackend {
  readonly kind: "db" | "envio";
  pairs(scope: PairsScope): Promise<TokenPair[]>;
  pair(id: string): Promise<TokenPair | null>;
  quotes(): Promise<QuoteAsset[]>;
  candles(id: string, interval: IndexerInterval): Promise<Candle[]>;
  trades(id: string): Promise<Trade[]>;
  holders(id: string): Promise<{ holders: Holder[]; count: number }>;
  /**
   * A v4 PoolKey to trade against, the direction flag and both assets' decimals. Two different
   * meanings of "the token's pool" meet here, and this method answers the trading one:
   * - **Listed, for market data** — the table, the chart, the trade list. Decided by
   *   `listed_pool_id` / `recomputeListedPools`'s `LISTED_POOL` (spec section 6), which requires
   *   `swap_count > 0`. A product decision this method does not own or change.
   * - **Routable, for trading** — a looser bar: any pool with a sane price, swapped or not,
   *   because a freshly launched token can have liquidity and zero trades and still be perfectly
   *   tradeable. This method prefers the listed pool when one exists (so a quote routes through
   *   the same pool the rest of the app shows), and falls back to the token's best sane pool —
   *   highest swap count, ties broken deterministically — only when nothing is listed.
   * Null only when the token has no sane pool at all.
   */
  poolKey(tokenId: string): Promise<PoolKeyRow | null>;
  health(): Promise<HealthReport>;
}

let instance: MarketBackend | null = null;

/** `envio` when MARKET_DATA_BACKEND === "envio" or no DATABASE_URL; otherwise `db`. Memoised per process. */
export function getBackend(): MarketBackend {
  if (instance) return instance;
  const envio = process.env.MARKET_DATA_BACKEND === "envio" || !process.env.DATABASE_URL;
  // No retry on the read path: a holders refresh or a health probe answers now; stored rows are the fallback.
  instance = envio ? createEnvioBackend() : createDbBackend(getDb(), createEnvioSource({ retry: false }));
  return instance;
}

export function resetBackend(): void {
  instance = null;
}
