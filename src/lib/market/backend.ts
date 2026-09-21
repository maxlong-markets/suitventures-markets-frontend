import type { PublicClient } from "viem";
import { createChainClient } from "@/lib/chain/onchain";
import type { PairsScope } from "@/lib/envio/pairs";
import type { IndexerInterval } from "@/lib/sync/ids";
import type { Candle, Holder, QuoteAsset, TokenPair, Trade } from "@/lib/types";
import { getDb } from "@/lib/db/client";
import { createDbBackend } from "./dbBackend";
import type { PoolKeyRow } from "./poolKey";

export type HealthReport = {
  ok: boolean; backend: "db" | "envio";
  lag: number | null; // node head minus the chain cursor, in blocks (Task 6); null without a chainHead callback
  quotes: { id: string; ageSec: number; stale: boolean }[];
  db?: { latencyMs: number };
  sync?: { lastOkAgeSec: number | null; lastError: string | null };
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
   *   tradeable. This method prefers the primary pool when it is sane, and falls back to the
   *   token's best sane pool — highest swap count, ties broken deterministically — only when the
   *   primary is not.
   * `quoteId` (C2) is the pair's quote asset, lowercase — the same one `TokenPair.quote` names for
   * the pool this token is presented in. A token can carry more than one pool in different quote
   * assets, and only a candidate whose own quote matches this one is a trading pool for this
   * request: the caller would otherwise label, balance-check and gate on one asset while signing a
   * Permit2 for another. Both rule steps above are restricted to candidates whose quote matches,
   * enforced in the one shared place a candidate becomes a `PoolKeyRow` (`poolKeyRow`).
   * Null when the token has no sane pool at all, or none of its sane pools carry this quote asset.
   */
  poolKey(tokenId: string, quoteId: string): Promise<PoolKeyRow | null>;
  health(): Promise<HealthReport>;
}

let instance: MarketBackend | null = null;

/**
 * Turns a chain RPC client's own head into the `chainHead` callback `createDbBackend`'s `health()` wants
 * (Task 6 review, MAJOR-1): the node's own block number, never a vendor's — the spec's failure-handling table
 * is explicit that health reports blocks behind the node's own head. `getBlockNumber()` resolves a `bigint`;
 * `HealthReport.lag` is a plain `number` of blocks, so this is the one place that conversion happens. A named,
 * exported function so the conversion is unit-testable without a live RPC (see backend.test.ts).
 */
export function chainHeadFrom(client: Pick<PublicClient, "getBlockNumber">): () => Promise<number> {
  return async () => Number(await client.getBlockNumber());
}

/**
 * Always the db backend now (Task 6: Envio was decommissioned 21 Sep 2026, and `MARKET_DATA_BACKEND` is no
 * longer read anywhere — there is nothing left to roll back to). Wires a live `chainHead` (Task 6 review,
 * MAJOR-1) from the chain RPC client, so health's `lag` is real rather than always null: at most one
 * `eth_blockNumber` call every 5 s (health/route.ts's `ttlCache` TTL), and `dbBackend.ts`'s `health()` already
 * catches a throw from this callback and degrades to `lag: null`, so a flaky public RPC never fails the whole
 * health check — it only loses the one signal. No `topHolders` callback is wired in yet: the holders endpoint
 * still serves the stored rows only (see the task-6 report's "Concerns" for why). Memoised per process, the
 * chain client included — `getBackend()` builds at most one of each.
 */
export function getBackend(): MarketBackend {
  if (instance) return instance;
  instance = createDbBackend(getDb(), { chainHead: chainHeadFrom(createChainClient()) });
  return instance;
}

export function resetBackend(): void {
  instance = null;
}
