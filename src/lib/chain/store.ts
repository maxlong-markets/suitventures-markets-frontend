import type { Db } from "@/lib/db/client";
import { bucketStart, INTERVALS } from "@/lib/sync/ids";
import { readState, saveCursors } from "@/lib/sync/state";
import type { PoolRec } from "@/lib/sync/source";
import { dedupe, recomputeListedPools, upsertPools } from "@/lib/sync/writers";
import type { TokenMetadataReading } from "./onchain";
import type { CandleInterval, CandleState, ChainEvent, FoldResult, FoldState, PoolState, QuoteState, TokenState, TradeRow } from "./types";

/** market.sync_state job name for this reader; see src/lib/sync/state.ts (SyncJob). */
const CHAIN_JOB = "chain";

/** Rows per statement, matching src/lib/sync/writers.ts's CHUNK: each column is one array parameter, so a chunk bounds a statement's size. */
const CHUNK = 1000;

function chunk<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

/** Booleans travel as text and are cast per element in the SELECT list: see src/lib/sync/writers.ts's `bool` for why. */
const bool = (b: boolean) => (b ? "true" : "false");

/** market.sync_state.cursor of the "chain" job; 0 when the job has never run. */
export async function readChainCursor(db: Db): Promise<number> {
  const state = await readState(db, CHAIN_JOB);
  return state.cursor;
}

type PoolRow = {
  id: string; token_id: string; quote_id: string; token_is_currency0: boolean; hooks: string; fee: number; tick_spacing: number;
  origin: string; created_at: number; price_quote: number; sqrt_price_x96: string | null; tvl_token: string | null; tvl_quote: string | null;
  swap_count: number; last_swap_at: number | null; volume_quote_all_time: number; baseline_at: number;
};
type TokenRow = {
  id: string; address: string; symbol: string; name: string; decimals: number; pool_count: number; origin: string;
  primary_pool_id: string | null; created_at: number; metadata_loaded: boolean;
};
type QuoteRow = { id: string; decimals: number; usd_price: number | null };
type CandleRow = {
  pool_id: string; interval: CandleInterval; t: number; open: number; high: number; low: number; close: number;
  volume_quote: number; volume_token: number; trades: number;
};

/**
 * sqrt_price_x96, tvl_token and tvl_quote are numeric holding integers far beyond 2^53 (a uint160 and TVL
 * totals): cast to text so both the postgres driver and PGlite hand back the exact decimal string to build a
 * bigint from. price_quote and volume_quote_all_time are double precision and arrive as numbers already.
 */
const POOL_COLUMNS = `id, token_id, quote_id, token_is_currency0, hooks, fee, tick_spacing, origin, created_at,
  price_quote, sqrt_price_x96::text as sqrt_price_x96, tvl_token::text as tvl_token, tvl_quote::text as tvl_quote,
  swap_count, last_swap_at, volume_quote_all_time, baseline_at`;

function rowToPoolState(r: PoolRow): PoolState {
  return {
    id: r.id, tokenId: r.token_id, quoteId: r.quote_id, tokenIsCurrency0: r.token_is_currency0, hooks: r.hooks,
    fee: r.fee, tickSpacing: r.tick_spacing, origin: r.origin, createdAt: r.created_at, priceQuote: r.price_quote,
    sqrtPriceX96: r.sqrt_price_x96 === null ? null : BigInt(r.sqrt_price_x96),
    tvlToken: r.tvl_token === null ? null : BigInt(r.tvl_token),
    tvlQuote: r.tvl_quote === null ? null : BigInt(r.tvl_quote),
    swapCount: r.swap_count, lastSwapAt: r.last_swap_at, volumeQuoteAllTime: r.volume_quote_all_time, baselineAt: r.baseline_at,
  };
}

function rowToTokenState(r: TokenRow): TokenState {
  return {
    id: r.id, address: r.address, symbol: r.symbol, name: r.name, decimals: r.decimals, poolCount: r.pool_count,
    origin: r.origin, primaryPoolId: r.primary_pool_id, createdAt: r.created_at, metadataLoaded: r.metadata_loaded,
  };
}

function rowToCandleState(r: CandleRow): CandleState {
  return {
    poolId: r.pool_id, interval: r.interval, t: r.t, open: r.open, high: r.high, low: r.low, close: r.close,
    volumeQuote: r.volume_quote, volumeToken: r.volume_token, trades: r.trades,
  };
}

/** The (poolId, interval, t) keys every swap event's five candle buckets touch, deduplicated. Initialize and ModifyLiquidity never touch candles. */
function candleKeys(events: readonly ChainEvent[]): { poolId: string; interval: CandleInterval; t: number }[] {
  const keys = new Map<string, { poolId: string; interval: CandleInterval; t: number }>();
  for (const e of events) {
    if (e.kind !== "swap") continue;
    for (const interval of INTERVALS) {
      const t = bucketStart(e.timestamp, interval);
      keys.set(`${e.poolId}-${interval}-${t}`, { poolId: e.poolId, interval, t });
    }
  }
  return [...keys.values()];
}

async function loadCandles(db: Db, events: readonly ChainEvent[]): Promise<Map<string, CandleState>> {
  const keys = candleKeys(events);
  const candles = new Map<string, CandleState>();
  if (keys.length === 0) return candles;
  // One join against the unnested keys: never one query per (pool, interval, bucket).
  const rows = await db.query<CandleRow>(
    `select c.pool_id, c.interval, c.t, c.open, c.high, c.low, c.close, c.volume_quote, c.volume_token, c.trades
     from market.candles c
     join unnest($1::text[], $2::text[], $3::int[]) as k(pool_id, interval, t)
       on c.pool_id = k.pool_id and c.interval = k.interval and c.t = k.t`,
    [keys.map((k) => k.poolId), keys.map((k) => k.interval), keys.map((k) => k.t)],
  );
  for (const r of rows) candles.set(`${r.pool_id}-${r.interval}-${r.t}`, rowToCandleState(r));
  return candles;
}

/**
 * Everything the fold needs before it sees `events`: the pools those events name, their tokens, every quote
 * (a small table, always loaded whole), poolsByToken for every token loaded — including sibling pools no
 * event named, since choosePrimaryPool ranks a token's pools against each other — and the candle buckets the
 * batch's swaps will touch. Every hop is one query batched over keys: never one query per pool or candle key.
 *
 * Token discovery is not only "the tokens of the pools events name": an `initialize` for a pool that does
 * not exist yet (a new pool of an already-tracked token) names no stored pool, so its currencies are unioned
 * in too — one of them is the fold's `classify` decision away from being that token, and `classify` cannot
 * run here. A currency that turns out to be a quote, or a genuinely new token, simply matches no row in
 * either table below: harmless. Skipping this widening would make the pool-by-token query below miss the
 * token's siblings entirely, and the fold would then treat a live, already-tracked token as brand new.
 */
export async function loadFoldState(db: Db, events: readonly ChainEvent[]): Promise<FoldState> {
  const poolIds = [...new Set(events.map((e) => e.poolId))];
  const initCurrencies = events.flatMap((e) => (e.kind === "initialize" ? [e.currency0, e.currency1] : []));

  const [tokenIdRows, quoteRows, candles] = await Promise.all([
    poolIds.length === 0
      ? Promise.resolve([] as { token_id: string }[])
      : db.query<{ token_id: string }>("select distinct token_id from market.pools where id = any($1::text[])", [poolIds]),
    db.query<QuoteRow>("select id, decimals, usd_price from market.quotes"),
    loadCandles(db, events),
  ]);
  const tokenIds = [...new Set([...tokenIdRows.map((r) => r.token_id), ...initCurrencies])];

  const [tokenRows, poolRows] = await Promise.all([
    tokenIds.length === 0
      ? Promise.resolve([] as TokenRow[])
      : db.query<TokenRow>(
          `select id, address, symbol, name, decimals, pool_count, origin, primary_pool_id, created_at, metadata_loaded
           from market.tokens where id = any($1::text[])`,
          [tokenIds],
        ),
    tokenIds.length === 0
      ? Promise.resolve([] as PoolRow[])
      : db.query<PoolRow>(`select ${POOL_COLUMNS} from market.pools where token_id = any($1::text[])`, [tokenIds]),
  ]);

  const pools = new Map<string, PoolState>();
  const poolsByToken = new Map<string, string[]>();
  for (const r of poolRows) {
    pools.set(r.id, rowToPoolState(r));
    const list = poolsByToken.get(r.token_id);
    if (list) list.push(r.id);
    else poolsByToken.set(r.token_id, [r.id]);
  }

  const tokens = new Map<string, TokenState>();
  for (const r of tokenRows) tokens.set(r.id, rowToTokenState(r));

  const quotes = new Map<string, QuoteState>();
  for (const r of quoteRows) quotes.set(r.id, { id: r.id, decimals: r.decimals, usdPrice: r.usd_price });

  return { pools, tokens, quotes, candles, poolsByToken };
}

function poolStateToRec(p: PoolState): PoolRec {
  return {
    id: p.id, token_id: p.tokenId, quote_id: p.quoteId, tokenIsCurrency0: p.tokenIsCurrency0, hooks: p.hooks,
    fee: p.fee, tickSpacing: p.tickSpacing, origin: p.origin, createdAt: p.createdAt, priceQuote: p.priceQuote,
    tvlToken: p.tvlToken === null ? null : p.tvlToken.toString(),
    tvlQuote: p.tvlQuote === null ? null : p.tvlQuote.toString(),
    swapCount: p.swapCount, lastSwapAt: p.lastSwapAt, volumeQuoteAllTime: p.volumeQuoteAllTime,
    sqrtPriceX96: p.sqrtPriceX96 === null ? null : p.sqrtPriceX96.toString(),
  };
}

/**
 * Tokens are never a plain upsert: total_supply and holders_count are maintained elsewhere (a holder refresh
 * this reader does not do) and must survive every write here. A brand new id is inserted with the indexer's
 * own fallback for a fresh token (holders_count 0 — port of the old indexer's src/handlers/shared.ts
 * newToken) and then left alone forever by `on conflict do nothing`. total_supply on that same insert uses
 * `newTokenSupply`'s value for the id when the runner already read it from the chain this cycle (Task 6:
 * readTokenMetadata for FoldResult.newTokens, in the same cycle that creates the row), else 0, same as the
 * indexer's own fallback. Every token in the batch, new or old, gets its other columns applied by a second,
 * separate statement that never mentions total_supply or holders_count, so an existing token's stored supply
 * survives even when `newTokenSupply` happens to name its id too (the update path never reads that map).
 */
async function upsertTokensFromFold(db: Db, tokens: readonly TokenState[], now: number, newTokenSupply?: ReadonlyMap<string, bigint>): Promise<void> {
  const rows = dedupe(tokens, (t) => t.id);
  for (const c of chunk(rows)) {
    await db.query(
      `insert into market.tokens (id, address, symbol, name, decimals, total_supply, holders_count, pool_count, origin,
         primary_pool_id, created_at, metadata_loaded, synced_at)
       select id, address, symbol, name, decimals, total_supply::numeric, 0::int, pool_count, origin, primary_pool_id,
         created_at, metadata_loaded::boolean, $12::int
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::int[], $8::text[], $9::text[], $10::int[], $11::text[])
         as u(id, address, symbol, name, decimals, total_supply, pool_count, origin, primary_pool_id, created_at, metadata_loaded)
       on conflict (id) do nothing`,
      [
        c.map((x) => x.id), c.map((x) => x.address), c.map((x) => x.symbol), c.map((x) => x.name), c.map((x) => x.decimals),
        c.map((x) => (newTokenSupply?.get(x.id) ?? 0n).toString()), c.map((x) => x.poolCount), c.map((x) => x.origin),
        c.map((x) => x.primaryPoolId), c.map((x) => x.createdAt), c.map((x) => bool(x.metadataLoaded)), now,
      ],
    );
    await db.query(
      `update market.tokens t set symbol = u.symbol, name = u.name, decimals = u.decimals, pool_count = u.pool_count,
         origin = u.origin, primary_pool_id = u.primary_pool_id, metadata_loaded = u.metadata_loaded::boolean, synced_at = $9::int
       from unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::int[], $6::text[], $7::text[], $8::text[])
         as u(id, symbol, name, decimals, pool_count, origin, primary_pool_id, metadata_loaded)
       where t.id = u.id`,
      [
        c.map((x) => x.id), c.map((x) => x.symbol), c.map((x) => x.name), c.map((x) => x.decimals), c.map((x) => x.poolCount),
        c.map((x) => x.origin), c.map((x) => x.primaryPoolId), c.map((x) => bool(x.metadataLoaded)), now,
      ],
    );
  }
}

/**
 * TradeRow already carries txHash and logIndex as separate fields (id is just `${txHash}-${logIndex}` for
 * callers that want one string), so this writes them straight to their columns rather than routing through
 * insertSwaps, which would re-derive the same two fields from that id via a regex parse. Column list, casts,
 * chunking and on-conflict semantics otherwise match insertSwaps exactly.
 */
async function insertTrades(db: Db, trades: readonly TradeRow[]): Promise<number> {
  const rows = dedupe(trades, (t) => t.id);
  let inserted = 0;
  for (const c of chunk(rows)) {
    const r = await db.query<{ tx_hash: string }>(
      `insert into market.swaps (tx_hash, log_index, pool_id, token_id, ts, side, amount_token, amount_quote, price_quote, wallet)
       select * from unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::int[], $6::text[], $7::float8[], $8::float8[], $9::float8[], $10::text[])
         as u(tx_hash, log_index, pool_id, token_id, ts, side, amount_token, amount_quote, price_quote, wallet)
       on conflict (tx_hash, log_index) do nothing
       returning tx_hash`,
      [
        c.map((x) => x.txHash), c.map((x) => x.logIndex), c.map((x) => x.poolId), c.map((x) => x.tokenId), c.map((x) => x.timestamp),
        c.map((x) => x.side), c.map((x) => x.amountToken), c.map((x) => x.amountQuote), c.map((x) => x.priceQuote), c.map((x) => x.wallet),
      ],
    );
    inserted += r.length;
  }
  return inserted;
}

/**
 * CandleState already carries `interval` directly, so this writes it straight rather than routing through
 * upsertCandles, which derives interval by parsing a synthetic id CandleState does not have. Column list,
 * casts, chunking and on-conflict semantics otherwise match upsertCandles exactly.
 */
async function upsertCandlesFromFold(db: Db, candles: readonly CandleState[]): Promise<void> {
  const rows = dedupe(candles, (c) => `${c.poolId}-${c.interval}-${c.t}`);
  for (const c of chunk(rows)) {
    await db.query(
      `insert into market.candles (pool_id, interval, t, open, high, low, close, volume_quote, volume_token, trades)
       select * from unnest($1::text[], $2::text[], $3::int[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[], $9::float8[], $10::int[])
         as u(pool_id, interval, t, open, high, low, close, volume_quote, volume_token, trades)
       on conflict (pool_id, interval, t) do update set open = excluded.open, high = excluded.high, low = excluded.low,
         close = excluded.close, volume_quote = excluded.volume_quote, volume_token = excluded.volume_token, trades = excluded.trades`,
      [
        c.map((x) => x.poolId), c.map((x) => x.interval), c.map((x) => x.t), c.map((x) => x.open), c.map((x) => x.high),
        c.map((x) => x.low), c.map((x) => x.close), c.map((x) => x.volumeQuote), c.map((x) => x.volumeToken), c.map((x) => x.trades),
      ],
    );
  }
}

/**
 * Everything a batch changed, written with its cursor in ONE transaction: a failure leaves rows and the
 * cursor untouched. Reuses upsertPools as-is (its column set is exactly PoolState minus baseline_at, which it
 * never mentions, so an existing pool's baseline_at survives the update and a new pool gets the migration's
 * default of 0) and saveCursors from the sync module unchanged. Tokens, trades and candles get reader-specific
 * statements — see upsertTokensFromFold, insertTrades and upsertCandlesFromFold for why each does not reuse
 * its sync/writers.ts counterpart.
 *
 * recomputeListedPools runs over the union of result.tokens' ids and every result.pools' tokenId, not
 * result.tokens alone: listing depends on a pool's swap_count/price_quote/last_swap_at (src/lib/sync/writers.ts's
 * LISTED_POOL), and the fold only returns a token when *it* changed (a new pool, a primary-pool re-pick) —
 * not on every swap of a single-pool token, or a swap that leaves the primary choice alone. Without the
 * union, a token's first trade would never flip its listed_pool_id off null and it would stay invisible.
 *
 * opts.newTokenSupply carries total_supply for a brand-new token the runner already read from the chain this
 * same cycle (Task 6: readTokenMetadata for FoldResult.newTokens), so it doesn't show a supply of 0 until the
 * next nightly; see upsertTokensFromFold for how it's used and what it can never affect.
 */
export async function applyFold(
  db: Db,
  result: FoldResult,
  cursorBlock: number,
  now: number,
  opts?: { newTokenSupply?: ReadonlyMap<string, bigint> },
): Promise<void> {
  await db.tx(async (t) => {
    await upsertPools(t, result.pools.map(poolStateToRec), now);
    await upsertTokensFromFold(t, result.tokens, now, opts?.newTokenSupply);
    await insertTrades(t, result.trades);
    await upsertCandlesFromFold(t, result.candles);
    const tokenIds = [...new Set([...result.tokens.map((tok) => tok.id), ...result.pools.map((p) => p.tokenId)])];
    await recomputeListedPools(t, tokenIds);
    await saveCursors(t, CHAIN_JOB, { cursor: cursorBlock });
  });
}

/**
 * Up to `limit` token ids (addresses) due for a metadata retry — `metadata_loaded = false` and
 * `metadata_retry_at <= now` — oldest retry first then id (Task 6, run.ts's metadata retry sweep). The
 * queue starts tiny: 21 of 132,004 rows carry `metadata_loaded = false` (Task 6 brief, measurement 3), so
 * this is always a small, bounded read, never a scan of the whole table.
 */
export async function dueForMetadata(db: Db, now: number, limit: number): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `select id from market.tokens where metadata_loaded = false and metadata_retry_at <= $1::int
     order by metadata_retry_at, id limit $2::int`,
    [now, limit],
  );
  return rows.map((r) => r.id);
}

/**
 * Applies one readTokenMetadata sweep to the metadata retry queue (Task 6, run.ts's step 5, paired with
 * dueForMetadata above): an `ok` reading loads the token for good — symbol, name, decimals,
 * metadata_loaded = true, metadata_retry_at reset to 0, and total_supply when the reading carries one (the
 * indexer's own `readTotalSupply` can fail independently of `ok`; when it did, `total_supply` is left alone
 * rather than overwritten with a fallback). A failed reading only pushes metadata_retry_at an hour out
 * (`now + 3600`, the indexer's own hourly retry cadence, ported), touching nothing else — the fallback
 * metadata already stored (symbol/name/decimals) survives untouched, as does the token's row generally. As
 * with every other write in this file, holders_count is never mentioned and so never written.
 */
export async function refreshTokenMetadata(db: Db, readings: ReadonlyMap<string, TokenMetadataReading>, now: number): Promise<void> {
  const ok = [...readings.entries()].filter(([, r]) => r.ok);
  const failedIds = [...readings.entries()].filter(([, r]) => !r.ok).map(([id]) => id);

  for (const c of chunk(ok)) {
    await db.query(
      `update market.tokens t set symbol = u.symbol, name = u.name, decimals = u.decimals,
         metadata_loaded = true, metadata_retry_at = 0, total_supply = coalesce(u.total_supply::numeric, t.total_supply)
       from unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[]) as u(id, symbol, name, decimals, total_supply)
       where t.id = u.id`,
      [
        c.map(([id]) => id), c.map(([, r]) => r.symbol), c.map(([, r]) => r.name), c.map(([, r]) => r.decimals),
        c.map(([, r]) => (r.totalSupply === null ? null : r.totalSupply.toString())),
      ],
    );
  }
  for (const c of chunk(failedIds)) {
    await db.query("update market.tokens set metadata_retry_at = $2::int where id = any($1::text[])", [c, now + 3600]);
  }
}
