import type { Db } from "@/lib/db/client";
import { parseCandleId, parseSwapId } from "./ids";
import type { BalanceRec, CandleRec, PoolRec, QuotePriceRec, QuoteRec, SwapRec, TokenRec } from "./source";

/** Rows per statement. Each column is one array parameter, so a chunk bounds the statement's size, not its parameter count. */
const CHUNK = 1000;

function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

/**
 * Last occurrence wins: `on conflict do update` rejects a statement that touches one row twice. The rows come back in
 * key order, so every multi-row statement locks its rows in one order and the nightly's walk and a market cycle
 * writing the same pools or tokens cannot deadlock. Exported for its test.
 */
export function dedupe<T>(rows: readonly T[], key: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r);
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);
}

/**
 * Booleans travel as text and are cast per element in the SELECT list: the porsager driver infers the scalar
 * bool type for a plain boolean array and serialises the whole array as one "f". Strings and numbers infer no
 * type, so the server resolves them from the `::type[]` casts. Both drivers accept a plain JS array for those.
 */
const bool = (b: boolean) => (b ? "true" : "false");

export async function upsertQuotes(db: Db, quotes: readonly QuoteRec[], prices: readonly QuotePriceRec[]): Promise<number> {
  const rows = dedupe(quotes, (q) => q.id);
  for (const c of chunks(rows)) {
    await db.query(
      `insert into market.quotes (id, address, symbol, name, decimals, enabled)
       select id, address, symbol, name, decimals, enabled::boolean
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[]) as u(id, address, symbol, name, decimals, enabled)
       on conflict (id) do update set address = excluded.address, symbol = excluded.symbol, name = excluded.name,
         decimals = excluded.decimals, enabled = excluded.enabled`,
      [c.map((q) => q.id), c.map((q) => q.address), c.map((q) => q.symbol), c.map((q) => q.name), c.map((q) => q.decimals), c.map((q) => bool(q.enabled))],
    );
  }
  // The price columns are only ever written here: a quote without a QuotePrice row keeps what it has (null at first).
  for (const c of chunks(dedupe(prices, (p) => p.id))) {
    await db.query(
      `update market.quotes q set usd_price = p.usd_price, usd_updated_at = p.usd_updated_at, aggregator = p.aggregator
       from unnest($1::text[], $2::float8[], $3::int[], $4::text[]) as p(id, usd_price, usd_updated_at, aggregator)
       where q.id = p.id`,
      [c.map((p) => p.id), c.map((p) => Number(p.usdPrice)), c.map((p) => p.updatedAt), c.map((p) => p.aggregator)],
    );
  }
  return rows.length;
}

/** `synced_to` is deliberately absent: it belongs to markSynced and survives every upsert (0, never, on insert). */
export async function upsertPools(db: Db, pools: readonly PoolRec[], syncedAt: number): Promise<number> {
  const rows = dedupe(pools, (p) => p.id);
  for (const c of chunks(rows)) {
    await db.query(
      `insert into market.pools (id, token_id, quote_id, token_is_currency0, hooks, fee, tick_spacing, origin, created_at,
         price_quote, tvl_token, tvl_quote, swap_count, last_swap_at, volume_quote_all_time, synced_at)
       select id, token_id, quote_id, token_is_currency0::boolean, hooks, fee, tick_spacing, origin, created_at,
         price_quote, tvl_token, tvl_quote, swap_count, last_swap_at, volume_quote_all_time, $16::int
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::text[], $9::int[],
         $10::float8[], $11::numeric[], $12::numeric[], $13::int[], $14::int[], $15::float8[])
         as u(id, token_id, quote_id, token_is_currency0, hooks, fee, tick_spacing, origin, created_at,
           price_quote, tvl_token, tvl_quote, swap_count, last_swap_at, volume_quote_all_time)
       on conflict (id) do update set token_id = excluded.token_id, quote_id = excluded.quote_id,
         token_is_currency0 = excluded.token_is_currency0, hooks = excluded.hooks, fee = excluded.fee,
         tick_spacing = excluded.tick_spacing, origin = excluded.origin, created_at = excluded.created_at,
         price_quote = excluded.price_quote, tvl_token = excluded.tvl_token, tvl_quote = excluded.tvl_quote,
         swap_count = excluded.swap_count, last_swap_at = excluded.last_swap_at,
         volume_quote_all_time = excluded.volume_quote_all_time, synced_at = excluded.synced_at`,
      [
        c.map((p) => p.id), c.map((p) => p.token_id), c.map((p) => p.quote_id), c.map((p) => bool(p.tokenIsCurrency0)),
        c.map((p) => p.hooks), c.map((p) => p.fee), c.map((p) => p.tickSpacing), c.map((p) => p.origin), c.map((p) => p.createdAt),
        c.map((p) => Number(p.priceQuote)), c.map((p) => p.tvlToken), c.map((p) => p.tvlQuote), c.map((p) => p.swapCount),
        c.map((p) => p.lastSwapAt), c.map((p) => Number(p.volumeQuoteAllTime)), syncedAt,
      ],
    );
  }
  return rows.length;
}

/** Raises synced_to, the time up to which the pools' swaps and candles are stored, to syncedTo where it is lower; never lowers it. Returns the rows matched. */
export async function markSynced(db: Db, poolIds: readonly string[], syncedTo: number): Promise<number> {
  if (poolIds.length === 0) return 0;
  const rows = await db.query(
    "update market.pools set synced_to = greatest(synced_to, $1::int) where id = any($2::text[]) returning id",
    [syncedTo, [...poolIds]],
  );
  return rows.length;
}

/** `listed_pool_id` is deliberately absent: it belongs to recomputeListedPools and survives every upsert. */
export async function upsertTokens(db: Db, tokens: readonly TokenRec[], syncedAt: number): Promise<number> {
  const rows = dedupe(tokens, (t) => t.id);
  for (const c of chunks(rows)) {
    await db.query(
      `insert into market.tokens (id, address, symbol, name, decimals, total_supply, holders_count, pool_count, origin,
         primary_pool_id, created_at, metadata_loaded, synced_at)
       select id, address, symbol, name, decimals, total_supply, holders_count, pool_count, origin,
         primary_pool_id, created_at, metadata_loaded::boolean, $13::int
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::numeric[], $7::int[], $8::int[], $9::text[],
         $10::text[], $11::int[], $12::text[])
         as u(id, address, symbol, name, decimals, total_supply, holders_count, pool_count, origin, primary_pool_id, created_at, metadata_loaded)
       on conflict (id) do update set address = excluded.address, symbol = excluded.symbol, name = excluded.name,
         decimals = excluded.decimals, total_supply = excluded.total_supply, holders_count = excluded.holders_count,
         pool_count = excluded.pool_count, origin = excluded.origin, primary_pool_id = excluded.primary_pool_id,
         created_at = excluded.created_at, metadata_loaded = excluded.metadata_loaded, synced_at = excluded.synced_at`,
      [
        c.map((t) => t.id), c.map((t) => t.address), c.map((t) => t.symbol), c.map((t) => t.name), c.map((t) => t.decimals),
        c.map((t) => t.totalSupply), c.map((t) => t.holdersCount), c.map((t) => t.poolCount), c.map((t) => t.origin),
        c.map((t) => t.primaryPool_id), c.map((t) => t.createdAt), c.map((t) => bool(t.metadataLoaded)), syncedAt,
      ],
    );
  }
  return rows.length;
}

export async function insertSwaps(db: Db, swaps: readonly SwapRec[]): Promise<number> {
  let inserted = 0;
  for (const c of chunks(swaps)) {
    const keys = c.map((s) => parseSwapId(s.id));
    const rows = await db.query<{ tx_hash: string }>(
      `insert into market.swaps (tx_hash, log_index, pool_id, token_id, ts, side, amount_token, amount_quote, price_quote, wallet)
       select * from unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::int[], $6::text[], $7::float8[], $8::float8[], $9::float8[], $10::text[])
         as u(tx_hash, log_index, pool_id, token_id, ts, side, amount_token, amount_quote, price_quote, wallet)
       on conflict (tx_hash, log_index) do nothing
       returning tx_hash`,
      [
        keys.map((k) => k.txHash), keys.map((k) => k.logIndex), c.map((s) => s.pool_id), c.map((s) => s.token_id), c.map((s) => s.timestamp),
        c.map((s) => s.side), c.map((s) => Number(s.amountToken)), c.map((s) => Number(s.amountQuote)), c.map((s) => Number(s.priceQuote)), c.map((s) => s.wallet),
      ],
    );
    inserted += rows.length;
  }
  return inserted;
}

export async function upsertCandles(db: Db, candles: readonly CandleRec[]): Promise<number> {
  const rows = dedupe(candles, (c) => c.id).map((c) => ({ ...c, interval: parseCandleId(c.id).interval }));
  for (const c of chunks(rows)) {
    await db.query(
      `insert into market.candles (pool_id, interval, t, open, high, low, close, volume_quote, volume_token, trades)
       select * from unnest($1::text[], $2::text[], $3::int[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[], $9::float8[], $10::int[])
         as u(pool_id, interval, t, open, high, low, close, volume_quote, volume_token, trades)
       on conflict (pool_id, interval, t) do update set open = excluded.open, high = excluded.high, low = excluded.low,
         close = excluded.close, volume_quote = excluded.volume_quote, volume_token = excluded.volume_token, trades = excluded.trades`,
      [
        c.map((x) => x.pool_id), c.map((x) => x.interval), c.map((x) => x.t), c.map((x) => Number(x.open)), c.map((x) => Number(x.high)),
        c.map((x) => Number(x.low)), c.map((x) => Number(x.close)), c.map((x) => Number(x.volumeQuote)), c.map((x) => Number(x.volumeToken)), c.map((x) => x.trades),
      ],
    );
  }
  return rows.length;
}

export async function replaceHolders(db: Db, tokenId: string, balances: readonly BalanceRec[], refreshedAt: number): Promise<number> {
  const rows = dedupe(balances.filter((b) => BigInt(b.balance) > 0n), (b) => b.holder);
  return db.tx(async (t) => {
    await t.query("delete from market.token_balances where token_id = $1", [tokenId]);
    for (const c of chunks(rows)) {
      await t.query(
        `insert into market.token_balances (token_id, holder, balance, updated_at)
         select $1::text, holder, balance, updated_at from unnest($2::text[], $3::numeric[], $4::int[]) as u(holder, balance, updated_at)`,
        [tokenId, c.map((b) => b.holder), c.map((b) => b.balance), c.map((b) => b.updatedAt)],
      );
    }
    await t.query(
      `insert into market.holder_refresh (token_id, refreshed_at) values ($1, $2)
       on conflict (token_id) do update set refreshed_at = excluded.refreshed_at`,
      [tokenId, refreshedAt],
    );
    return rows.length;
  });
}

/** Spec section 6: the primary pool when sane and traded, else the sane traded pool with the most swaps, else null. */
const LISTED_POOL = `coalesce(
  (select p.id from market.pools p where p.id = t.primary_pool_id and p.swap_count > 0 and p.price_quote > 1e-24 and p.price_quote < 1e18),
  (select p.id from market.pools p where p.token_id = t.id and p.swap_count > 0 and p.price_quote > 1e-24 and p.price_quote < 1e18
     order by p.swap_count desc, p.last_swap_at desc nulls last, p.id limit 1))`;

export async function recomputeListedPools(db: Db, tokenIds: readonly string[] | "all"): Promise<number> {
  if (tokenIds !== "all" && tokenIds.length === 0) return 0;
  const where = tokenIds === "all" ? "" : "where t.id = any($1::text[])";
  const params = tokenIds === "all" ? [] : [[...tokenIds]];
  const [row] = await db.query<{ n: unknown }>(
    `with u as (update market.tokens t set listed_pool_id = ${LISTED_POOL} ${where} returning 1) select count(*) as n from u`,
    params,
  );
  return Number(row.n);
}
