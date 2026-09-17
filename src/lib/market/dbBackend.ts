import type { Db } from "@/lib/db/client";
import { ttlCache } from "@/lib/envio/cache";
import { PAIRS_LIMIT, PAIRS_TTL, type PairsScope } from "@/lib/envio/pairs";
import type { BalanceRow, CandleRow, QuotePriceRow, QuoteRow, SwapRow, WindowRow } from "@/lib/envio/queries";
import { isStale, shapeCandles, shapeHolders, shapeQuotes, shapeTrades, usdMap, windowStats } from "@/lib/envio/shape";
import type { BalanceRec, EnvioSource } from "@/lib/sync/source";
import { replaceHolders } from "@/lib/sync/writers";
import { nowSec } from "@/lib/time";
import type { HealthReport, MarketBackend } from "./backend";
import { PAIR_SELECT, pairFromRow, type PairRow } from "./dbShape";

/** A token's stored top holders are re-pulled from Envio when older than this (spec 5.4). */
export const HOLDER_REFRESH_SEC = 300;
const SYNC_OK_WITHIN_SEC = 300;
const HOLDERS_SHOWN = 10;
const HOLDERS_PULLED = 100;
const TRADES_LIMIT = 50;
const CANDLES_LIMIT = 300;
/** The same window as `loadWindowRows` in pairs.ts: h1 candles from a day before the 24h bucket. */
const windowSince = (now: number) => Math.floor((now - 86400) / 3600) * 3600 - 86400;
/** Only the message reaches the log: a driver error can carry a connection string. */
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

type QuoteCols = { usd_price: number | null; usd_updated_at: number | null; aggregator: string | null };
type ListedRow = { symbol: string; pool_id: string; quote_id: string } & QuoteCols;
type TokenCols = { decimals: number; total_supply: string; holders_count: number };
type StateRow = { job: string; cursor: number; last_ok_at: number | null; last_error: string | null };

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
const HOLDERS_SQL = `select holder, balance::text as balance from market.token_balances
  where token_id = $1 and balance > 0 order by balance desc limit ${HOLDERS_SHOWN}`;
const REFRESH_SQL = `select refreshed_at from market.holder_refresh where token_id = $1`;
const QUOTES_SQL = `select id, address, symbol, name, decimals, usd_price, usd_updated_at, aggregator from market.quotes order by id`;
const STATE_SQL = `select job, cursor, last_ok_at, last_error from market.sync_state where job in ('market', 'nightly')`;
const QUOTE_AGES_SQL = `select id, usd_updated_at, aggregator from market.quotes where usd_updated_at is not null order by id`;

/** SQL readers with M1's semantics (spec section 8). `now` is injectable for the tests. */
export function createDbBackend(db: Db, source: EnvioSource, now: () => number = nowSec): MarketBackend {
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
      if (!token) return { holders: [], count: 0 };
      const at = now();
      const refreshedAt = (await db.query<{ refreshed_at: number }>(REFRESH_SQL, [id]))[0]?.refreshed_at ?? null;
      if (refreshedAt === null || at - refreshedAt > HOLDER_REFRESH_SEC) {
        let fresh: BalanceRec[] | undefined;
        try {
          fresh = await source.topHolders(id, HOLDERS_PULLED);
        } catch (err) {
          console.warn(`holders refresh failed for ${id}: ${message(err)}`); // the stored rows still serve
        }
        if (fresh) await replaceHolders(db, id, fresh, at);
      }
      const rows = await db.query<BalanceRow>(HOLDERS_SQL, [id]);
      return { holders: shapeHolders(rows, token.decimals, BigInt(token.total_supply)), count: token.holders_count };
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
      const market = states.find((s) => s.job === "market");
      const nightly = states.find((s) => s.job === "nightly");
      const ages = await db.query<{ id: string; usd_updated_at: number; aggregator: string | null }>(QUOTE_AGES_SQL);
      const quotes = ages.map((q) => ({ id: q.id, ageSec: at - q.usd_updated_at, stale: isStale({ updatedAt: q.usd_updated_at, aggregator: q.aggregator ?? "" }, at) }));
      let lag: number | null = null;
      try {
        const m = await source.chainMeta();
        lag = m.blockHeight - m.latestProcessedBlock;
      } catch (err) {
        console.warn(`indexer lag unavailable: ${message(err)}`); // informational: the store still serves
      }
      const sync = {
        lastOkAgeSec: market?.last_ok_at != null ? at - market.last_ok_at : null,
        cursorAgeSec: market && market.cursor > 0 ? at - market.cursor : null,
        lastError: market?.last_error ?? null,
      };
      const night = { lastOkAgeSec: nightly?.last_ok_at != null ? at - nightly.last_ok_at : null, lastError: nightly?.last_error ?? null };
      const ok = sync.lastOkAgeSec !== null && sync.lastOkAgeSec <= SYNC_OK_WITHIN_SEC && quotes.every((q) => !q.stale);
      return { ok, backend: "db", lag, quotes, db: { latencyMs }, sync, nightly: night };
    },
  };
  return backend;
}
