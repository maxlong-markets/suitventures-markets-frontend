import { createHyperSyncSource } from "@/lib/chain/hypersyncSource";
import { QUOTES } from "@/lib/chain/math/quotes";
import { createChainClient, type QuoteFeedConfig } from "@/lib/chain/onchain";
import type { ChainRunDeps } from "@/lib/chain/run";
import { getDb, type Db } from "@/lib/db/client";
import { createQuoter, type Quoter } from "@/lib/quote/quoter";
import type { EnvioSource } from "./source";
import type { SyncJob } from "./state";

/**
 * Envio was decommissioned 21 Sep 2026 (Task 6, `.superpowers/sdd/2026-09-21-chain-reader/task-6-brief.md`):
 * no production path builds a real EnvioSource anymore. Every method here is unreachable — nightly.ts dropped
 * its EnvioSource parameter along with the tokens/pools phases it used it for, and the market job has no
 * production caller left (src/app/api/internal/sync/route.ts now runs the chain job instead). This stub
 * exists only so the untouched src/app/api/internal/sync/nightly/route.ts, which still destructures `source`
 * from `syncDeps("nightly")` and forwards it into `runSync` positionally, keeps type-checking and running: it
 * satisfies EnvioSource's shape without ever calling `createEnvioSource` or touching the network, and says so
 * loudly if something somehow does call one of its methods.
 */
function deadEnvioSource(): EnvioSource {
  // async, not a plain throwing function: every EnvioSource method is typed to return a Promise, and a caller
  // that awaits it (as every real one does) must see a rejection, not a synchronous throw escaping the await.
  const fail =
    (methodName: string) =>
    async (): Promise<never> => {
      throw new Error(`Envio was decommissioned 21 Sep 2026 (Task 6): ${methodName}() should be unreachable`);
    };
  return {
    quotes: fail("quotes"),
    poolsSince: fail("poolsSince"),
    poolsCreatedSince: fail("poolsCreatedSince"),
    swapsFor: fail("swapsFor"),
    candlesFor: fail("candlesFor"),
    tokensById: fail("tokensById"),
    topHolders: fail("topHolders"),
    topHoldersBatch: fail("topHoldersBatch"),
    chainMeta: fail("chainMeta"),
    tokensPage: fail("tokensPage"),
    poolsPage: fail("poolsPage"),
    swapsPage: fail("swapsPage"),
    candlesPage: fail("candlesPage"),
    get queries() {
      return 0;
    },
  };
}

/**
 * `quoter` is only ever set for "nightly" (its probe phase, nightly.ts); the market job — kept only for
 * src/lib/sync/run.ts's own tests of runSync's generic machinery, which build their own FakeSource rather
 * than going through this factory — has no use for one. The chain job has its own shape entirely: see
 * ChainDeps/chainDeps below.
 */
export type SyncDeps = { db: Db; source: EnvioSource; quoter?: Quoter };
type Factory = (job: SyncJob) => SyncDeps;
let override: Factory | null = null;

/**
 * "market" and "nightly" get the process Db and a dead EnvioSource stub (see deadEnvioSource above) — neither
 * job's own logic reads a source anymore. "chain" is not handled here at all; see chainDeps below.
 */
export function syncDeps(job: SyncJob): SyncDeps {
  if (override) return override(job);
  const deps: SyncDeps = { db: getDb(), source: deadEnvioSource() };
  return job === "nightly" ? { ...deps, quoter: createQuoter() } : deps;
}
/** Tests only: substitute PGlite and a FakeSource (the factory may ignore the job); null restores the defaults. */
export function setSyncDeps(factory: Factory | null): void {
  override = factory;
}

/** What src/app/api/internal/sync/route.ts runs the chain job against: the process Db plus runChainSync's own ChainRunDeps. */
export type ChainDeps = { db: Db } & ChainRunDeps;
type ChainFactory = () => ChainDeps;
let chainOverride: ChainFactory | null = null;

/** QUOTES (54 rows, 24 with a Chainlink proxy — src/lib/chain/math/quotes.ts) narrowed to the fields readQuotePrices wants. */
const CHAIN_QUOTES: QuoteFeedConfig[] = QUOTES.map((q) => ({
  address: q.address,
  chainlinkProxy: q.chainlinkProxy,
  chainlinkDecimals: q.chainlinkDecimals,
}));

/** The real factory: the process Db, a real HyperSync source, a real chain RPC client, and the quote allowlist. */
export function chainDeps(): ChainDeps {
  if (chainOverride) return chainOverride();
  return { db: getDb(), source: createHyperSyncSource(), client: createChainClient(), quotes: CHAIN_QUOTES };
}
/** Tests only: substitute PGlite, a fake LogSource and a fake chain client; null restores the default. */
export function setChainDeps(factory: ChainFactory | null): void {
  chainOverride = factory;
}
