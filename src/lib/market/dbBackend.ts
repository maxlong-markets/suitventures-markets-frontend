import type { Db } from "@/lib/db/client";
import { ttlCache } from "@/lib/envio/cache";
import { PAIRS_LIMIT, PAIRS_TTL, type PairsScope } from "@/lib/envio/pairs";
import type { BalanceRow, CandleRow, QuotePriceRow, QuoteRow, SwapRow, WindowRow } from "@/lib/envio/queries";
import { isStale, shapeCandles, shapeHolders, shapeQuotes, shapeTrades, usdMap, windowStats } from "@/lib/envio/shape";
import { refreshRow, requestBuild, STALE_SEC } from "@/lib/holders/store";
import { nowSec } from "@/lib/time";
import type { HoldersStatus } from "@/lib/types";
import type { HealthReport, MarketBackend } from "./backend";
import { PAIR_SELECT, pairFromRow, type PairRow } from "./dbShape";
import { poolKeyRow, type PoolKeyParts } from "./poolKey";

const SYNC_OK_WITHIN_SEC = 300;
const HOLDERS_SHOWN = 10;
const TRADES_LIMIT = 50;
const CANDLES_LIMIT = 300;
/** The same window as `loadWindowRows` in pairs.ts: h1 candles from a day before the 24h bucket. */
const windowSince = (now: number) => Math.floor((now - 86400) / 3600) * 3600 - 86400;
/** Only the message reaches the log: a driver error can carry a connection string. */
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

type QuoteCols = { usd_price: number | null; usd_updated_at: number | null; aggregator: string | null };
type ListedRow = { symbol: string; pool_id: string; quote_id: string } & QuoteCols;
type TokenCols = { decimals: number; total_supply: string; holders_count: number };
type StateRow = { job: string; cursor: number; phase: string; last_ok_at: number | null; last_error: string | null; last_report: Record<string, unknown> | string | null };
type PoolKeyCols = {
  pool_id: string; hooks: string; fee: number; tick_spacing: number; token_is_currency0: boolean; price_quote: number;
  token_address: string; token_decimals: number; quote_address: string; quote_decimals: number;
};
/** A public route: a stored error (indexer or driver text) is cut to this many characters; the full text goes to the log. */
const LAST_ERROR_SHOWN = 120;

function shortError(job: string, text: string | null): string | null {
  if (text === null || text.length <= LAST_ERROR_SHOWN) return text;
  console.warn(`${job} last_error: ${text}`);
  return text.slice(0, LAST_ERROR_SHOWN);
}

/** usdMap() for one stored quote: null without a feed row or when the feed is stale. */
function quoteUsd(q: QuoteCols, now: number): number | null {
  if (q.usd_price === null || q.usd_updated_at === null) return null;
  return isStale({ updatedAt: q.usd_updated_at, aggregator: q.aggregator ?? "" }, now) ? null : q.usd_price;
}

const ORDER = `order by p.last_swap_at desc nulls last, p.id limit ${PAIRS_LIMIT}`;
const PAIRS_SQL: Record<PairsScope, string> = {
  all: `${PAIR_SELECT} ${ORDER}`,
  // A token's origin equals its pools' origin (the indexer keeps them equal); tokens_origin_listed carries this.
  launchpad: `${PAIR_SELECT} where t.origin in ('LONG', 'Pons') ${ORDER}`,
};
const WINDOW_SQL = `select pool_id, t, open, close, volume_quote as "volumeQuote" from market.candles
  where pool_id = any($1::text[]) and interval = 'h1' and t >= $2 order by t`;
const LISTED_SQL = `select t.symbol, p.id as pool_id, p.quote_id, q.usd_price, q.usd_updated_at, q.aggregator
  from market.tokens t join market.pools p on p.id = t.listed_pool_id join market.quotes q on q.id = p.quote_id where t.id = $1`;
const TOKEN_SQL = `select decimals, total_supply::text as total_supply, holders_count from market.tokens where id = $1`;
const CANDLES_SQL = `select t, open, high, low, close, volume_quote as "volumeQuote" from market.candles
  where pool_id = $1 and interval = $2 order by t desc limit ${CANDLES_LIMIT}`;
const TRADES_SQL = `select ts as timestamp, side, amount_token as "amountToken", price_quote as "priceQuote", wallet, tx_hash as "txHash"
  from market.swaps where pool_id = $1 order by ts desc limit ${TRADES_LIMIT}`;
// `order by b.balance`, qualified: an unqualified `balance` here would bind to the `balance::text` output alias and
// sort the digits as text — a 22-digit balance starting with 9 above a 29-digit one — which is exactly what the
// first live list showed on 24 Sep 2026. The qualified name is the numeric column.
const HOLDERS_SQL = `select b.holder, b.balance::text as balance from market.token_balances b
  where b.token_id = $1 and b.balance > 0 order by b.balance desc limit ${HOLDERS_SHOWN}`;
/**
 * The trading pool for `poolKey()` (MarketBackend.poolKey's own doc comment carries the full "two
 * meanings" story): the token's primary pool, `primary_pool_id`, when it prices sanely and carries
 * the requested quote asset — no dependency on `listed_pool_id` and no requirement that the pool
 * has ever swapped, because a freshly launched token can have liquidity and zero trades and still
 * be perfectly tradeable. `p.quote_id = $2` (C2) is restricted here, not only checked afterwards
 * through `poolKeyRow`: a token can carry more than one pool in different quote assets, and this
 * is what stops a sane primary in the *wrong* asset from ever being handed back as if it were the
 * requested one. `POOL_KEY_FALLBACK_SQL` below is reached only when this misses: `primary_pool_id`
 * is null, that pool is parked at a tick boundary (`price_quote` outside the sane window), or it
 * simply is not quoted in the asset asked for. envioBackend's `poolKey()` implements this same
 * first step, unconditionally, over `primaryPool` — except the quote_id restriction, which Hasura
 * cannot express on an object relation, so it is checked there through `poolKeyRow` instead.
 */
const POOL_KEY_SQL = `select p.id as pool_id, p.hooks, p.fee, p.tick_spacing, p.token_is_currency0, p.price_quote,
  t.address as token_address, t.decimals as token_decimals, q.address as quote_address, q.decimals as quote_decimals
  from market.tokens t join market.pools p on p.id = t.primary_pool_id join market.quotes q on q.id = p.quote_id
  where t.id = $1 and p.quote_id = $2 and p.price_quote > 1e-24 and p.price_quote < 1e18`;
/**
 * Step two of the same rule: the sane pool with the most swaps, ties broken by the lowest id —
 * deterministic, and independent of `listed_pool_id` / `LISTED_POOL` (`writers.ts`, spec section 6,
 * untouched), which lists the *market table's* pool and requires `swap_count > 0`. The two rules
 * agree whenever the primary pool has traded; they can differ only for a sane, untraded primary,
 * which this rule finds already in step one above while the market table does not list the token
 * at all. `p.quote_id = $2` restricts the candidate set the same way as step one (C2): without it,
 * a higher-swap-count pool in the wrong quote asset would win the ordering and crowd out a lower-
 * swap-count pool that actually carries the one requested, even though the latter is the only
 * correct answer.
 */
const POOL_KEY_FALLBACK_SQL = `select p.id as pool_id, p.hooks, p.fee, p.tick_spacing, p.token_is_currency0, p.price_quote,
  t.address as token_address, t.decimals as token_decimals, q.address as quote_address, q.decimals as quote_decimals
  from market.pools p join market.tokens t on t.id = p.token_id join market.quotes q on q.id = p.quote_id
  where p.token_id = $1 and p.quote_id = $2 and p.price_quote > 1e-24 and p.price_quote < 1e18
  order by p.swap_count desc, p.id limit 1`;

/** Either query's row, shaped for `poolKeyRow` — factored out so poolKey() can try it twice. */
function poolKeyParts(row: PoolKeyCols): PoolKeyParts {
  return {
    poolId: row.pool_id,
    hooks: row.hooks,
    fee: row.fee,
    tickSpacing: row.tick_spacing,
    tokenIsCurrency0: row.token_is_currency0,
    priceQuote: row.price_quote,
    tokenAddress: row.token_address,
    tokenDecimals: row.token_decimals,
    quoteAddress: row.quote_address,
    quoteDecimals: row.quote_decimals,
  };
}
const QUOTES_SQL = `select id, address, symbol, name, decimals, usd_price, usd_updated_at, aggregator from market.quotes order by id`;
// "chain", not "market" (Task 6): the chain reader's sync_state row is what health now watches for lastOkAgeSec/lastError.
// "holders" joined them 23 Sep 2026 — the top-holder builder's own row, for its cycle report (design section 8).
const STATE_SQL = `select job, cursor, phase, last_ok_at, last_error, last_report from market.sync_state where job in ('chain', 'nightly', 'holders')`;
const QUOTE_AGES_SQL = `select id, usd_updated_at, aggregator from market.quotes where usd_updated_at is not null order by id`;
/**
 * The balances table's footprint (top-holders design section 8). `reltuples` is the planner's estimate rather
 * than a count(*), which on a million-row table is the difference between a health check and a scan; it is -1
 * on a table that has never been analysed, so it is clamped at 0 rather than reported as a negative row count.
 * `pg_total_relation_size` covers the indexes and toast too, which is what the 1 GB ceiling is measured against.
 */
const HOLDERS_TABLE_SQL = `select greatest(coalesce(reltuples, 0), 0)::bigint as rows, pg_total_relation_size('market.token_balances')::bigint as bytes
  from pg_class where oid = 'market.token_balances'::regclass`;

export type DbBackendOpts = {
  /** The node's own current block height, for health's `lag` (node head minus the chain cursor, in blocks).
   * Absent by default, which reports `lag: null` rather than guessing at a vendor's number. */
  chainHead?: () => Promise<number>;
  /** Hostnames of the server's RPC endpoints, echoed on health as-is (never URLs). */
  rpc?: { primary: string; backup: string | null };
  now?: () => number;
};

/**
 * A job's stored `last_report` narrowed to exactly the numeric fields asked for, or null when the report is
 * missing, unparseable, or lacks any one of them. The null-on-missing discipline both cycle helpers below
 * share: a report from an older build, or an empty default, must not surface as zeros that read like
 * "nothing resolved". Every caller passes "at" first, so the shaping can turn it into an age.
 */
function reportNumbers<K extends string>(stored: Record<string, unknown> | string | null, keys: readonly K[]): Record<K, number> | null {
  let report = stored;
  if (typeof report === "string") {
    // A report written double-encoded (the first build of this, 23 Sep 2026) is a JSON string holding the object.
    try { report = JSON.parse(report) as Record<string, unknown>; } catch { return null; }
  }
  if (!report || typeof report !== "object") return null;
  const out = {} as Record<K, number>;
  for (const key of keys) {
    const value = report[key];
    if (typeof value !== "number") return null;
    out[key] = value;
  }
  return out;
}

/** The chain job's stored `last_report` (written by runChainSync through finishRun, 23 Sep 2026) as health's `sync.lastCycle`. */
function lastCycleFrom(stored: Record<string, unknown> | string | null, at: number): NonNullable<HealthReport["sync"]>["lastCycle"] | null {
  const n = reportNumbers(stored, ["at", "blocks", "trades", "holderPairs", "holderDeltaApplied", "holderReadsUnknown"] as const);
  if (!n) return null;
  const { at: reportedAt, ...rest } = n;
  return { ageSec: at - reportedAt, ...rest };
}

/**
 * The top-holder builder's stored `last_report` (cycleReport() in src/lib/holders/run.ts) as health's
 * `holders.lastCycle` — the same fields under the same names, with `at` turned into an age. Its
 * `coverageRecomputed` flag is deliberately not surfaced: it says which invocation paid for the coverage
 * query, not anything about the lists, and health is about pace, progress and cost (design section 8).
 */
function holdersCycleFrom(stored: Record<string, unknown> | string | null, at: number): NonNullable<HealthReport["holders"]>["lastCycle"] {
  const n = reportNumbers(stored, ["at", "coverage", "due", "tokensTouched", "tokensReady", "tokensSkipped", "slices", "requests", "transfers", "errors", "spacingMs"] as const);
  if (!n) return null;
  const { at: reportedAt, ...rest } = n;
  return { ageSec: at - reportedAt, ...rest };
}

/** SQL readers with M1's semantics (spec section 8). `now` is injectable for the tests. */
export function createDbBackend(db: Db, opts: DbBackendOpts = {}): MarketBackend {
  const now = opts.now ?? nowSec;
  async function shapeRows(rows: PairRow[], at: number) {
    if (rows.length === 0) return [];
    const win = await db.query<WindowRow>(WINDOW_SQL, [rows.map((r) => r.pool_id), windowSince(at)]);
    const stats = windowStats(win, at);
    return rows.map((r) => pairFromRow(r, stats.get(r.pool_id), at));
  }
  const listed = async (id: string) => (await db.query<ListedRow>(LISTED_SQL, [id]))[0] ?? null;

  const backend: MarketBackend = {
    kind: "db",
    // The memo lives here under its own key: quotes() reuses the pair set exactly as M1 does, and the
    // Envio backend's `pairs:${scope}` entry stays separate so the parity script can hold both in one process.
    pairs: (scope) => ttlCache(`pairs:db:${scope}`, PAIRS_TTL * 1000, async () => shapeRows(await db.query<PairRow>(PAIRS_SQL[scope]), now())),
    async pair(id) {
      const rows = await db.query<PairRow>(`${PAIR_SELECT} where t.id = $1`, [id]);
      return (await shapeRows(rows, now()))[0] ?? null;
    },
    async quotes() {
      const at = now();
      const [rows, pairs] = await Promise.all([db.query<QuoteRow & QuoteCols>(QUOTES_SQL), backend.pairs("all")]);
      const prices: QuotePriceRow[] = rows.flatMap((q) =>
        q.usd_price === null || q.usd_updated_at === null ? [] : [{ id: q.id, usdPrice: q.usd_price, updatedAt: q.usd_updated_at, aggregator: q.aggregator ?? "" }],
      );
      return shapeQuotes(rows, pairs, usdMap(prices, at), prices, at);
    },
    async candles(id, interval) {
      const l = await listed(id);
      if (!l) return [];
      const rows = await db.query<CandleRow>(CANDLES_SQL, [l.pool_id, interval]);
      const usd = quoteUsd(l, now()); // one current USD price per quote, as in M1
      return shapeCandles(rows, () => usd);
    },
    async trades(id) {
      const l = await listed(id);
      if (!l) return [];
      return shapeTrades(await db.query<SwapRow>(TRADES_SQL, [l.pool_id]), quoteUsd(l, now()), l.symbol);
    },
    async holders(id) {
      const token = (await db.query<TokenCols>(TOKEN_SQL, [id]))[0];
      if (!token) return { holders: [], count: 0, status: "building", asOf: null };
      const at = now();
      let row = await refreshRow(db, id);
      // The tab's open is what queues a build (design section 5): no row, or a list stale by STALE_SEC, gets a
      // request stamp (throttled inside requestBuild); a skipped token is never re-queued.
      if (!row || (row.status !== "skipped" && row.refreshedAt < at - STALE_SEC)) {
        await requestBuild(db, id, at);
        row = row ?? (await refreshRow(db, id));
      }
      const status: HoldersStatus = row?.status === "ready" ? "ready" : row?.status === "skipped" ? "skipped" : "building";
      // Rows are served only behind `ready`: a half-folded list is a wrong list, not an early one.
      const rows = status === "ready" ? await db.query<BalanceRow>(HOLDERS_SQL, [id]) : [];
      return {
        holders: shapeHolders(rows, token.decimals, BigInt(token.total_supply)),
        count: token.holders_count,
        status,
        asOf: row && row.refreshedAt > 0 ? row.refreshedAt : null,
      };
    },
    async poolKey(tokenId, quoteId) {
      // The primary pool first, when it prices sanely and carries quoteId (POOL_KEY_SQL); the
      // wider fallback only when it does not. Both queries restrict on p.quote_id = $2 (C2), so a
      // sane primary or fallback candidate in a different quote asset is never returned in the
      // first place — poolKeyRow's own check is still run below, the one place both backends
      // share it, but is never expected to reject anything these queries already filtered out.
      const primaryRow = (await db.query<PoolKeyCols>(POOL_KEY_SQL, [tokenId, quoteId]))[0];
      const primary = primaryRow && poolKeyRow(poolKeyParts(primaryRow), quoteId);
      if (primary) return primary;
      const fallbackRow = (await db.query<PoolKeyCols>(POOL_KEY_FALLBACK_SQL, [tokenId, quoteId]))[0];
      return (fallbackRow && poolKeyRow(poolKeyParts(fallbackRow), quoteId)) || null;
    },
    async health(): Promise<HealthReport> {
      const at = now();
      const t0 = Date.now();
      let states: StateRow[];
      try {
        states = await db.query<StateRow>(STATE_SQL);
      } catch (err) {
        console.warn(`health check failed: ${message(err)}`);
        return { ok: false, backend: "db", lag: null, quotes: [], error: "database unavailable" };
      }
      const latencyMs = Date.now() - t0;
      const chain = states.find((s) => s.job === "chain");
      const nightly = states.find((s) => s.job === "nightly");
      const holdersState = states.find((s) => s.job === "holders");
      // Review 24 Sep 2026 (I4): STATE_SQL above answering is what proves the database is reachable; every
      // query after it is decoration beside the job rows, and one of them failing must not blank the whole
      // report. Each gets its own catch, a one-line warn and an empty answer — health's reason for existing
      // is to say whether the jobs are running, and that part still stands.
      let ages: { id: string; usd_updated_at: number; aggregator: string | null }[] = [];
      // An empty `quotes` makes the "no quote is stale" half of `ok` below vacuously true, which would turn a
      // broken query into a clean bill of health. The flag is what keeps the report answering AND honest.
      let quotesFailed = false;
      try {
        ages = await db.query<{ id: string; usd_updated_at: number; aggregator: string | null }>(QUOTE_AGES_SQL);
      } catch (err) {
        quotesFailed = true;
        console.warn(`health: quote ages unavailable: ${message(err)}`);
      }
      const quotes = ages.map((q) => ({ id: q.id, ageSec: at - q.usd_updated_at, stale: isStale({ updatedAt: q.usd_updated_at, aggregator: q.aggregator ?? "" }, at) }));
      // Task 6: lag is the node's own head minus the chain cursor, in blocks — never a vendor's number
      // (spec's failure-handling table). Optional and absent by default; see DbBackendOpts.chainHead.
      let lag: number | null = null;
      if (opts.chainHead) {
        try {
          lag = (await opts.chainHead()) - (chain?.cursor ?? 0);
        } catch (err) {
          console.warn(`chain head unavailable: ${message(err)}`); // informational: the store still serves
        }
      }
      const lastCycle = lastCycleFrom(chain?.last_report ?? null, at);
      const sync = {
        lastOkAgeSec: chain?.last_ok_at != null ? at - chain.last_ok_at : null,
        lastError: shortError("chain", chain?.last_error ?? null),
        ...(lastCycle ? { lastCycle } : {}),
      };
      const night = {
        lastOkAgeSec: nightly?.last_ok_at != null ? at - nightly.last_ok_at : null,
        lastError: shortError("nightly", nightly?.last_error ?? null),
        phase: nightly?.phase ?? "",
      };
      // Design section 8. Both halves are cheap: the report is a column already read above, and the size is an
      // estimate out of the catalog, never a count(*) over a table meant to reach a million rows. `rows` and
      // `bytes` come back as bigint — a string from the postgres driver, a number from PGlite — so both go
      // through Number(), the same way every other bigint this app reads does.
      // Its own try/catch for the same reason as the quote ages above (I4): a table renamed away or a catalog
      // permission change must cost the footprint line, never the builder's cycle beside it.
      let size: { rows: number | string; bytes: number | string } | undefined;
      try {
        size = (await db.query<{ rows: number | string; bytes: number | string }>(HOLDERS_TABLE_SQL))[0];
      } catch (err) {
        console.warn(`health: market.token_balances size unavailable: ${message(err)}`);
      }
      const holders = {
        lastError: shortError("holders", holdersState?.last_error ?? null),
        lastCycle: holdersCycleFrom(holdersState?.last_report ?? null, at),
        table: { rows: Number(size?.rows ?? 0), bytes: Number(size?.bytes ?? 0) },
      };
      const ok = sync.lastOkAgeSec !== null && sync.lastOkAgeSec <= SYNC_OK_WITHIN_SEC && !quotesFailed && quotes.every((q) => !q.stale);
      return { ok, backend: "db", lag, quotes, db: { latencyMs }, sync, nightly: night, holders, ...(opts.rpc ? { rpc: opts.rpc } : {}) };
    },
  };
  return backend;
}
