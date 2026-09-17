# Supabase market store: design

Date: 2026-09-16. Status: for Kobe's review. Author: Claude with Kobe.

Decides: the app's market data moves into a Postgres database the project owns (Supabase), fed by one sync job from the Envio indexer. Envio becomes the ingest engine only. This supersedes the read side of `2026-09-12-m1-live-data-design.md` (section 6); the indexer itself is unchanged. Workspace README decision D35 ("Supabase holds only user data") is amended by this design (section 12).

## 1. Goal and non-goals

After this change:

- Every screen reads from Postgres we own. The browser still talks only to the app's own `/api/*` routes; the JSON contract of those routes is unchanged, and one route is added.
- Envio's GraphQL endpoint is queried by one sync job, a read-through holders refresh and the health probe, well under its 250 queries a minute. Visitor count no longer affects Envio traffic at all.
- A paused, re-synced or redesigned Envio deployment costs freshness, never the table. The indexer can be rebuilt behind the sync without a visible change.
- The 500-row recency window of M1 stops breaking deep links: any token the store knows has a page.

Not in scope: indexer changes (the redesign that fixes primary-pool ranking and adds time indexes is separate); watchlist and vote tables (M4); server-side presets and search over the whole table; candle pruning (M5); removing the Envio read path (M5); ETH quotes.

## 2. Architecture

```
chain ─► Envio HyperIndex (Production Small) ─► Hasura GraphQL
                                                   │
               sync job (Next.js route, Vercel cron, every minute) ◄─┘
                                                   │ writes
                                          Supabase Postgres, schema `market`
                                                   │ reads (pooler)
                              route handlers /api/* (unchanged caching) ─► browser
```

Three clients of the database:

| Client | Connection | What it does |
|---|---|---|
| Sync route on Vercel | pooler, transaction mode | upserts what changed since its cursor |
| Data routes on Vercel | pooler, transaction mode | indexed reads, cached as in M1 |
| Scripts on the laptop | session pooler | migrations, the one-off seed, the parity check |

The frontend does not change shape. `EnvioDataSource` keeps calling the same routes. The one visible addition is `GET /api/tokens/{address}`, so the token page can load a token that is not in the current 500-row list.

## 3. Facts the design rests on

Envio, measured 16 Sep 2026 on the full deployment:

- 250 queries a minute; pages of 1,000 rows; aggregates disabled; every `Candle.interval` filter fails (enum named `Interval`); Float columns arrive as strings; `Token_by_pk` needs a chain id.
- Indexes exist on `Pool(token, lastSwapAt)`, `Swap(pool, timestamp)`, `Candle(pool, interval, t)`, `TokenBalance(token, balance)` and every primary key. There is no index on `Pool.lastSwapAt`, `Swap.timestamp` or `TokenBalance.updatedAt` alone. A global "everything since T" scan of `Pool` (234,945 rows) is fine; the same scan of `Swap` (52.5 M rows) or `TokenBalance` is not. Deltas of those two are therefore found through the pools and tokens that moved.
- Sizes: pools 234,945; tokens 130,226; swaps 52,531,609, growing about 1.1 M a day across about 8,400 pools; non-zero holder rows 17.65 M; candles estimated 20 to 25 M; quotes 54, of which 29 have no Chainlink feed and one (USDG) is pinned at 1.
- Keyset pagination on a primary key (`order_by: {id: asc}, where: {id: {_gt: $last}}`) was used for every extraction in M1 and never timed out.

Vercel: the `cobweb3` team is on Pro. Cron can run every minute, runs only against the production deployment, and sends `Authorization: Bearer <CRON_SECRET>` when that variable is set. Route handlers may declare `maxDuration` up to 300 s.

Supabase Pro: USD 25 a month; 8 GB disk included, then USD 0.125 per GB a month; the smallest compute is included and the next sizes cost USD 15 and 60; Postgres 17; the Supavisor pooler serves transaction mode on port 6543 (no prepared statements) and session mode on 5432. A schema that is not `public` is not exposed through PostgREST, so the anon key can never read market data.

## 4. Schema

One Postgres schema, `market`. Ids are the indexer's ids, lowercase. Times are unix seconds in `integer`, matching the indexer's `Int`. Uint256 values are `numeric(78,0)`; the indexer's Floats are `double precision`; intervals use the indexer's names `m1 m5 m15 h1 d1`; origins are the indexer's `Origin` values as text with a check constraint.

```sql
create schema if not exists market;

create table market.schema_migrations (name text primary key, applied_at timestamptz not null default now());

create table market.quotes (
  id text primary key, address text not null, symbol text not null, name text not null,
  decimals int not null, enabled boolean not null,
  usd_price double precision, usd_updated_at int, aggregator text
);

create table market.tokens (
  id text primary key, address text not null, symbol text not null, name text not null,
  decimals int not null, total_supply numeric(78,0) not null, holders_count int not null,
  pool_count int not null, origin text not null check (origin in ('LONG','Pons','Uniswap','Other','SUIT','SV')),
  primary_pool_id text, listed_pool_id text, created_at int not null, metadata_loaded boolean not null,
  synced_at int not null
);
create index tokens_listed_pool on market.tokens (listed_pool_id);
create index tokens_origin_listed on market.tokens (origin, listed_pool_id);

create table market.pools (
  id text primary key, token_id text not null, quote_id text not null, token_is_currency0 boolean not null,
  hooks text not null, fee int not null, tick_spacing int not null,
  origin text not null check (origin in ('LONG','Pons','Uniswap','Other','SUIT','SV')),
  created_at int not null, price_quote double precision not null,
  tvl_token numeric(78,0), tvl_quote numeric(78,0), swap_count int not null, last_swap_at int,
  volume_quote_all_time double precision not null, synced_at int not null,
  synced_to int not null default 0   -- swaps and candles are stored up to this time; 0 = never
);
create index pools_token_last_swap on market.pools (token_id, last_swap_at desc);
create index pools_last_swap on market.pools (last_swap_at desc nulls last);
create index pools_unsynced on market.pools (last_swap_at desc) where synced_to < last_swap_at;

create table market.swaps (
  tx_hash text not null, log_index int not null, pool_id text not null, token_id text not null,
  ts int not null, side text not null check (side in ('buy','sell')),
  amount_token double precision not null, amount_quote double precision not null,
  price_quote double precision not null, wallet text not null,
  primary key (tx_hash, log_index)
);
create index swaps_pool_ts on market.swaps (pool_id, ts desc);

create table market.candles (
  pool_id text not null, interval text not null check (interval in ('m1','m5','m15','h1','d1')),
  t int not null, open double precision not null, high double precision not null,
  low double precision not null, close double precision not null,
  volume_quote double precision not null, volume_token double precision not null, trades int not null,
  primary key (pool_id, interval, t)
);

create table market.token_balances (
  token_id text not null, holder text not null, balance numeric(78,0) not null, updated_at int not null,
  primary key (token_id, holder)
);
create index token_balances_rank on market.token_balances (token_id, balance desc);

create table market.holder_refresh (token_id text primary key, refreshed_at int not null);

create table market.sync_state (
  job text primary key, cursor int not null default 0, cursor2 int not null default 0,
  cursor_text text not null default '', phase text not null default '', last_run_at int, last_ok_at int, last_error text,
  rows_written int not null default 0, queries_used int not null default 0,
  lease_until int not null default 0, lease_owner text
);
```

Notes:

- `swaps` stores the indexer's `Swap.id` split into `(tx_hash, log_index)`; the id is `txHash-logIndex`. That saves a 70-byte text column and its index on 52 M rows. `Swap.txHash` is the same value.
- `token_balances` holds at most the top 100 non-zero holders per token. Holder *counts* come from `tokens.holders_count`; the balance rows exist for the top-holders panel and share-of-supply.
- `pools.synced_to` is each pool's own watermark: the Envio head time up to which its swaps and candles are stored. A batch fetches from the oldest watermark among its pools (minus the overlap) rather than from the cycle's cursor, and stamps the head time it reached afterwards, so advancing the cursor past a batch can never drop older history of the pools behind it. (Amended 17 Sep 2026 after the Task 4 fix rounds.)
- `tokens.listed_pool_id` is the M1 `resolvePool` result, precomputed: the primary pool when it prices sanely and has traded, else the sane pool with the most swaps, else null. Sane means `1e-24 < price_quote < 1e18`. A token with a null listed pool is not in the table.
- No summary table for 1h/24h stats. They are computed at read time from the listed pools' `h1` candles with the existing `windowStats()` (section 8), exactly as M1 does.
- Estimated size at seed: swaps about 25 GB with their two indexes, candles about 6 GB, balances under 1 GB, the rest negligible. Swaps grow by about 0.5 GB a day; whether to keep them past 90 days is an M5 retention decision, not this design's.

## 5. Sync job

### 5.1 Entry, auth, cadence, lease

- `GET /api/internal/sync` and `GET /api/internal/sync/nightly`, `maxDuration = 300`, Node runtime. Both require `Authorization: Bearer <CRON_SECRET>`; anything else is 401. `vercel.json` schedules the first every minute and the second at 03:00 UTC.
- The minute route runs market cycles back to back for up to 55 s, sleeping `SYNC_INTERVAL_SEC` (default 30) between cycle starts, so freshness is about 30 s at the cost of one function invocation a minute. Setting the variable to 60 gives one cycle per invocation.
- A lease in `sync_state` (`lease_until`, `lease_owner`, taken with one conditional `UPDATE … WHERE lease_until < now RETURNING`) keeps two invocations from overlapping. A holder that dies leaves a lease that expires after 120 s.
- Every cycle ends by writing `last_run_at`, `last_ok_at` or `last_error`, `rows_written` and `queries_used`.

### 5.2 Market cycle (job `market`)

Cursor `c` = the largest `Pool.lastSwapAt` fully processed. Overlap `o` = 120 s. `since = c − o`. Every write is an upsert or an insert-ignore, so re-processing the overlap is harmless.

1. **Quotes.** One query: `Quote` and `QuotePrice`. Upsert `quotes`.
2. **Pools that traded.** Page `Pool(where: {lastSwapAt: {_gte: since}}, order_by: [{lastSwapAt: asc}, {id: asc}], limit: 1000)` with a two-column keyset (`lastSwapAt > last` or `lastSwapAt = last and id > lastId`). For each page, in order:
   1. upsert the pool rows;
   2. **swaps**, in batches of 50 pool ids, with the batch's own `since` = the smallest `synced_to` among its pools minus the overlap (never the cycle's cursor): page `Swap(where: {pool_id: {_in: ids}, timestamp: {_gte: since}}, order_by: [{timestamp: asc}, {id: asc}], limit: 1000)`; insert with `on conflict do nothing`;
   3. **candles**, same batches, one document with two aliases: `recent: Candle(where: {pool_id: {_in: ids}, t: {_gte: since − 900}}, order_by: [{t: asc}, {id: asc}], limit: 1000)`, paged by a `(t, id)` keyset when a batch has more, catches every m1, m5 and m15 bucket that could have changed, and `open: Candle(where: {id: {_in: […]}})` looks up by id the h1 and d1 buckets containing `since` and now (at most four ids per pool). The interval is parsed from the id (`<pool>-<interval>-<bucket>`); the field is never filtered on. Upsert;
   4. **tokens** of the batch's pools, by id (primary-key lookups). Upsert, then recompute `listed_pool_id` for those tokens with one SQL statement, and stamp the batch's pools with `synced_to = headTs`, the largest `lastSwapAt` Envio returned in this cycle so far (a swap Envio processed at that time means every earlier swap is already there);
   5. after each batch of 50 pools has its swaps, candles and tokens written, advance `c` to that batch's largest `lastSwapAt` and persist it; the page is ordered ascending, so every unprocessed pool has a `lastSwapAt` at or after `c`. A cycle that runs out of time or queries between batches simply stops. One that runs out inside a batch persists that batch's resume state (its `since`, its pool ids, and the swap and candle keysets reached) in `sync_state.cursor_text`; the next cycle drains that batch first, clears the record, and only then continues normal paging. Progress is therefore guaranteed at the granularity of one request, never of a page, so catch-up after the seed or an outage runs at the query budget. (Amended 17 Sep 2026 after the Task 4 review: the original page-level rule could stall for good on a page whose history outgrew one invocation.)
3. **Repair**, at most one batch per cycle while budget remains and only when the cycle read Envio pool rows: the 50 pools with the newest `last_swap_at` among those with `synced_to < last_swap_at` and `last_swap_at < c − o` (pools the paging would not find again), processed exactly like a page batch. This is the safety net for any pool the cursor passed, whatever the cause.
4. **New pools** (created, never traded). Cursor `c2` on `createdAt`: `Pool(where: {createdAt: {_gte: c2 − o}, lastSwapAt: {_is_null: true}}, order_by: [{createdAt: asc}, {id: asc}])`. Upsert pools and their tokens. A few pages a day.

Why `c` is safe: Envio writes in block order, so any pool updated after a read carries a `lastSwapAt` at least as large as every value that read returned. The overlap covers clock slop and the handler's own retries.

Budget: about 40 queries per cycle at today's volume (1 quotes + 1 to 3 pool pages + about 10 swap batches + 10 candle batches + 5 token batches + 1 new-pools), so 80 a minute at the default cadence. The route stops issuing queries at 150 per invocation and waits for the next minute.

### 5.3 Nightly (job `nightly`)

Full re-pull of `Token` (131 pages) and `Pool` (235 pages) by keyset on id, upsert, then recompute `listed_pool_id` for every token. This catches what the market cycle cannot see: TVL changes from liquidity events on pools that did not trade, metadata that loaded late, holder counts of tokens that only transferred. About 370 queries; it fits in one invocation and is resumable by `phase` and `cursor_text` (the last id of the completed page) in `sync_state` if it does not.

### 5.4 Holders, read-through

No holders loop. The holders route serves `token_balances` from the store and, when `holder_refresh.refreshed_at` for that token is older than 300 s, first re-pulls the token's top 100 non-zero balances from Envio (one query, `order_by: {balance: desc}, limit: 100`), replaces that token's rows in one transaction and stamps the refresh. If Envio is unreachable it serves the stored rows. Envio therefore sees at most one holders query per hot token every five minutes.

### 5.5 Failure modes

| Failure | Effect | Recovery |
|---|---|---|
| Envio down or rate-limiting | cycle records `last_error`; store stops moving; health shows sync lag | automatic on the next minute; overlap and cursors make catch-up exact |
| Database down | cron invocation fails; routes answer 503 | automatic; nothing to replay because cursors live in the database |
| Two invocations at once | second one finds the lease taken and exits | none needed |
| Envio deployment replaced (re-sync, redesign) | the new deployment replays from genesis behind the same endpoint; the sync ignores rows older than its cursor and resumes when the replay passes it; the store never regresses | none, unless the redesign changes what a row means, which is a re-seed |
| Store falls behind by hours | pools are paged by `lastSwapAt`; progress is saved per 50-pool batch, a batch cut short resumes from its saved keysets, and each pool fetches from its own watermark so no window is skipped | catch-up runs at the query budget; a day's backlog clears in about an hour; pools the cursor passed are repaired by later cycles |

## 6. Read models

`tokens.listed_pool_id` is the only precomputed column. The recompute statement, run per affected token set and once over the whole table at seed and nightly:

```sql
update market.tokens t set listed_pool_id = coalesce(
  (select p.id from market.pools p where p.id = t.primary_pool_id and p.swap_count > 0
     and p.price_quote > 1e-24 and p.price_quote < 1e18),
  (select p.id from market.pools p where p.token_id = t.id and p.swap_count > 0
     and p.price_quote > 1e-24 and p.price_quote < 1e18
   order by p.swap_count desc, p.last_swap_at desc nulls last, p.id limit 1))
where t.id = any($1);
```

## 7. Seed

A one-off script run from the laptop against the session pooler, resumable through a checkpoint file (git-ignored), with a rate limiter at 200 queries a minute and three concurrent workers over id ranges for the big tables. Phases, in order:

| Phase | Source | Pages | Time at the limit |
|---|---|---|---|
| quotes | `Quote`, `QuotePrice` | 1 | seconds |
| tokens | `Token` by id | 131 | 1 min |
| pools | `Pool` by id | 235 | 1 min |
| swaps | `Swap` by id, COPY into `swaps` | 52,600 | about 4.4 h |
| candles | `Candle` by id, COPY | 20,000 to 25,000 | about 2 h |
| balances | `TokenBalance` by id with `balance > 0`, COPY, then trimmed to the top 100 per token in SQL | about 18,000 | about 1.5 h |
| finish | recompute `listed_pool_id` for all tokens; set every pool's `synced_to` to the seed's start time minus 600 s (the id walks are complete up to then); set `sync_state.market.cursor` to the same value; set `nightly.last_ok_at`; print row counts | | minutes |

About eight hours unattended. The chain keeps moving during the seed; the first market cycles replay everything since the seed started because the cursor is set back to that moment, and every write is idempotent. The archive under the indexer's `.superpowers/sdd/2026-09-12-m1-indexer/archive-seed/` stays as a fallback but is not the seed source: it lacks token names, decimals and tick spacing.

## 8. API reads

A `MarketBackend` interface with two implementations behind `MARKET_DATA_BACKEND`: `db` (default whenever `DATABASE_URL` is set) and `envio` (today's code, kept for rollback until M5). Route handlers, cache headers and TTLs are unchanged; each route calls the backend instead of `gql` directly.

The `db` backend:

- **pairs(scope)**: one query joins `tokens` to their listed pool and quote, ordered by the pool's `last_swap_at` descending, limit 500, optionally filtered to `origin in ('LONG','Pons')`; a second query fetches `h1` candles for those pool ids since a day before the 24-hour bucket; `windowStats()` and a row-to-`TokenPair` mapper reproduce `shapePairs()` field for field (USD conversion, stale flag with the pinned exemption, liquidity, FDV, age from the pool's `created_at`).
- **quotes()**: `quotes` table plus the pair set, through `shapeQuotes()`.
- **pair(id)** (new): the same two queries for one token; null when the token or its listed pool is unknown. Serves `GET /api/tokens/{address}`, which answers the `TokenPair` JSON or 404, cached 30 s.
- **candles(id, interval)**: token → listed pool → `candles` by `(pool_id, interval, t desc)` limit 300 → `shapeCandles()`.
- **trades(id)**: token → listed pool → `swaps` by `(pool_id, ts desc)` limit 50 → `shapeTrades()`.
- **holders(id)**: read-through refresh (section 5.4), then the top 10 rows → `shapeHolders()`, count from `tokens.holders_count`.
- **health()**: database round-trip time, `sync_state` for `market` (age of `last_ok_at`, cursor age, last error) and `nightly`, plus the M1 indexer lag and quote staleness. `ok` when the database answers, the market sync succeeded within the last 300 s and every quote with a feed is fresh.

Frontend: `MarketsDataSource` gains `pair(id)`; `usePair` falls back to it when the token is not in the loaded list. The mock source implements it from its own list.

## 9. Environments and secrets

| Where | Variable | Value |
|---|---|---|
| Vercel Production | `DATABASE_URL` (sensitive) | pooler, transaction mode, port 6543 |
| Vercel Production | `CRON_SECRET` (sensitive) | 32 random bytes |
| Vercel Production | `MARKET_DATA_BACKEND` | unset (db) or `envio` to roll back |
| Vercel Production | `SYNC_INTERVAL_SEC` | optional, default 30 |
| Vercel Production | `ENVIO_GRAPHQL_URL`, `ENVIO_GRAPHQL_KEY` | unchanged; used by the sync, holders refresh and health |
| laptop `.env.local` | `DATABASE_URL_DIRECT` | session pooler, port 5432, for migrations and the seed |

Preview deployments get no database variable; they stay on the mock source as today. Crons never run on previews.

Supabase project: a new org `SuitVentures` on Pro (so it can be handed to MAXLONG at M5 without touching Kobe's other projects), project `suitventures-markets`, region `us-east-1` to sit next to Vercel's default function region, Postgres 17. The database password is generated locally, written straight into `.env.local` and Vercel, and never printed or committed. The `market` schema is not added to the API's exposed schemas.

Migrations live in `supabase/migrations/<timestamp>_<name>.sql` and are applied by the repo's own runner (`scripts/db/migrate.mts`), which records them in `market.schema_migrations`; the same runner loads them into the test database, so tests and production run identical SQL.

## 10. Testing

- **Database tests run against real Postgres**: `@electric-sql/pglite` in Vitest applies the migrations and every SQL path (upserts, `listed_pool_id`, the pairs query, candles, trades, holders replacement, the lease) is exercised on it. No SQL is mocked.
- **Envio is faked at the source boundary.** The sync steps take an `EnvioSource` interface (`quotes()`, `poolsSince()`, `poolsCreatedSince()`, `swapsFor()`, `candlesFor()`, `tokensById()`, `topHolders()`, `chainMeta()`, and the id-range page methods the seed and nightly use: `tokensPage()`, `poolsPage()`, `swapsPage()`, `candlesPage()`, `balancesPage()`); `FakeSource` serves fixtures and counts calls, so tests assert cursor progress, idempotence under overlap, the query budget and partial-page behaviour.
- **Parity**: a script loads pairs through both backends and reports tokens present in one but not the other and any field differing by more than 0.1 %. Run before the flip and again after a day.
- **Acceptance**: after the flip, `/api/pairs` answers in under 500 ms from a cold function; `/api/health` reports sync lag under 60 s for an hour; Envio's usage shows the sync alone; the parity report is empty apart from tokens newer than the last sync.

## 11. Rollout

1. Kobe creates the Supabase org on Pro. Claude creates the project from the CLI, generates the password, writes `DATABASE_URL_DIRECT` locally, runs the migrations.
2. Seed overnight from the laptop with `caffeinate`. Check counts in the morning.
3. Set `DATABASE_URL`, `CRON_SECRET` and `MARKET_DATA_BACKEND=envio` on Vercel; deploy. The sync starts; routes still read Envio. Watch `/api/health` for an hour.
4. Run the parity script. Remove `MARKET_DATA_BACKEND`; redeploy. Routes now read the store.
5. Rollback at any point is setting `MARKET_DATA_BACKEND=envio` again; the sync keeps running either way.
6. Amend the workspace README (section 12) and tell the client in one line.

## 12. Decision Log changes (workspace README)

- New D39, Sep 16 2026 (K): market data is mirrored into a Supabase Postgres the project owns, fed by a sync job from Envio; the app reads only its own store; Envio is the ingest engine and can be replaced behind it. Costs USD 25 a month plus disk.
- D35 amended: Supabase holds market data as well as watchlists and votes. The part that is not on-chain is still only the user data.
- Section 4 Infrastructure: add the Supabase row; the Indexer row gains "read by the sync job only".
- Section 6 Environments: the Supabase account is already listed under service accounts.
- Section 10 Risks: replace "Envio pause takes the table down" with "Envio pause freezes prices until it is back".

## 13. Costs

| Item | Monthly |
|---|---|
| Supabase Pro | USD 25 |
| Disk beyond the included 8 GB, about 25 GB at seed | about USD 3, rising about USD 2 a month until a retention rule |
| Compute add-on if the smallest tier struggles | USD 0 to 15 |
| Vercel function time for the sync, about one instance-minute per minute | inside the Pro allowance or a few dollars |
| Envio Production Small | USD 70, unchanged |

## 14. Risks

- The seed depends on Envio's rate limit and on Hasura not timing out on keyset pages of the big tables; M1's extractions of the same shape did not time out. The script is resumable, so a failure costs a restart, not a redo.
- Envio's Hasura may return the `interval` field fine but the sync never relies on it; it parses the id. If ids ever change shape, the candle step fails loudly rather than mislabelling buckets.
- The smallest Supabase compute has 1 GB of memory; the pairs query and the sync's upserts are indexed and small, but the seed's COPY and index maintenance will run slower there. Upgrading compute is a dashboard change.
- The nightly job and the market cycle share a query budget; a nightly running during a busy hour delays the market cycle by at most one invocation.
- D35's wording to the client changes. Kobe tells MAXLONG.
