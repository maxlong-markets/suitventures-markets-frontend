create schema if not exists market;

create table if not exists market.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

create table market.quotes (
  id text primary key,
  address text not null,
  symbol text not null,
  name text not null,
  decimals int not null,
  enabled boolean not null,
  usd_price double precision,
  usd_updated_at int,
  aggregator text
);

create table market.tokens (
  id text primary key,
  address text not null,
  symbol text not null,
  name text not null,
  decimals int not null,
  total_supply numeric(78,0) not null,
  holders_count int not null,
  pool_count int not null,
  origin text not null check (origin in ('LONG','Pons','Uniswap','Other','SUIT','SV')),
  primary_pool_id text,
  listed_pool_id text,
  created_at int not null,
  metadata_loaded boolean not null,
  synced_at int not null
);
create index tokens_listed_pool on market.tokens (listed_pool_id);
create index tokens_origin_listed on market.tokens (origin, listed_pool_id);

create table market.pools (
  id text primary key,
  token_id text not null,
  quote_id text not null,
  token_is_currency0 boolean not null,
  hooks text not null,
  fee int not null,
  tick_spacing int not null,
  origin text not null check (origin in ('LONG','Pons','Uniswap','Other','SUIT','SV')),
  created_at int not null,
  price_quote double precision not null,
  tvl_token numeric(78,0),
  tvl_quote numeric(78,0),
  swap_count int not null,
  last_swap_at int,
  volume_quote_all_time double precision not null,
  synced_at int not null
);
create index pools_token_last_swap on market.pools (token_id, last_swap_at desc);
create index pools_last_swap on market.pools (last_swap_at desc nulls last);

create table market.swaps (
  tx_hash text not null,
  log_index int not null,
  pool_id text not null,
  token_id text not null,
  ts int not null,
  side text not null check (side in ('buy','sell')),
  amount_token double precision not null,
  amount_quote double precision not null,
  price_quote double precision not null,
  wallet text not null,
  primary key (tx_hash, log_index)
);
create index swaps_pool_ts on market.swaps (pool_id, ts desc);

create table market.candles (
  pool_id text not null,
  interval text not null check (interval in ('m1','m5','m15','h1','d1')),
  t int not null,
  open double precision not null,
  high double precision not null,
  low double precision not null,
  close double precision not null,
  volume_quote double precision not null,
  volume_token double precision not null,
  trades int not null,
  primary key (pool_id, interval, t)
);

create table market.token_balances (
  token_id text not null,
  holder text not null,
  balance numeric(78,0) not null,
  updated_at int not null,
  primary key (token_id, holder)
);
create index token_balances_rank on market.token_balances (token_id, balance desc);

create table market.holder_refresh (
  token_id text primary key,
  refreshed_at int not null
);

create table market.sync_state (
  job text primary key,
  cursor int not null default 0,
  cursor2 int not null default 0,
  cursor_text text not null default '',
  phase text not null default '',
  last_run_at int,
  last_ok_at int,
  last_error text,
  rows_written int not null default 0,
  queries_used int not null default 0,
  lease_until int not null default 0,
  lease_owner text
);
