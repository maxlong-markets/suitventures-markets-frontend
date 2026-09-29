-- Instant launchpad (spec 2026-09-28-instant-launchpad-design.md, section 5). Additive: three new tables and one index.

create table market.launches (
  token_id text primary key,                 -- lower-case token address, the key of market.tokens
  pool_id text not null,
  quote_id text not null,
  creator text not null,
  payout text not null,
  token_is_currency0 boolean not null,
  creator_share_bps int not null check (creator_share_bps between 0 and 10000),
  open_tick int not null check (open_tick % 200 = 0),
  opening_valuation numeric not null,        -- V', raw quote units for the whole supply
  liquidity numeric not null,
  tokens_in_pool numeric not null,
  first_buy_in numeric not null,
  first_buy_tokens numeric not null,
  router_fee numeric not null,
  creation_fee numeric not null,
  hook text not null,
  name text not null,
  symbol text not null,
  metadata_uri text not null,
  metadata_cid text not null default '',     -- from metadata_uri when it is ipfs://<cid>, else ''
  image_cid text not null default '',        -- the rest copied from market.launch_uploads, '' without a match
  description text not null default '',
  website text not null default '',
  x text not null default '',
  telegram text not null default '',
  launch_block int not null,
  launch_log_index int not null,
  launch_tx text not null,
  launched_at int not null,
  -- No fee totals here (amended 29 Sep 2026): they are summed on read from market.launch_fee_events (5.5).
  payout_block int not null,                 -- the last PayoutChanged applied, as (block, log index)
  payout_log_index int not null,
  hidden boolean not null default false,     -- moderation: no image, description or links anywhere
  updated_at int not null,
  check (opening_valuation > 0 and liquidity > 0 and tokens_in_pool > 0),
  check (first_buy_in >= 0 and first_buy_tokens >= 0 and router_fee >= 0 and creation_fee >= 0)
);
create index launches_creator on market.launches (creator);
create index launches_metadata_cid on market.launches (metadata_cid) where metadata_cid <> '';

-- One row per FeesCollected log (amended 29 Sep 2026): the primary key makes a re-applied batch a no-op. Fee totals
-- are never stored; the single-token read sums this table through launch_fee_events_token.
create table market.launch_fee_events (
  tx_hash text not null,
  log_index int not null,
  token_id text not null,
  payout text not null,
  token_payout numeric not null check (token_payout >= 0),
  token_platform numeric not null check (token_platform >= 0),
  quote_payout numeric not null check (quote_payout >= 0),
  quote_platform numeric not null check (quote_platform >= 0),
  block int not null,
  ts int not null,
  primary key (tx_hash, log_index)
);
create index launch_fee_events_token on market.launch_fee_events (token_id, ts desc);

create table market.launch_uploads (
  id bigint generated always as identity primary key, -- one row per accepted upload, so every one counts
  wallet text not null,
  image_cid text not null,
  metadata_cid text not null,
  image_key text not null,                   -- Filebase object keys, for the orphan clean-up
  metadata_key text not null,
  name text not null,
  symbol text not null,
  description text not null default '',
  website text not null default '',
  x text not null default '',
  telegram text not null default '',
  -- 'refused': pinned, then refused by the locked recount (section 6 step 12); not counted, cleaned like 'pending'
  status text not null default 'pending' check (status in ('pending', 'used', 'deleted', 'refused')),
  created_at int not null,
  used_at int not null default 0,
  token_id text not null default ''
);
create index launch_uploads_wallet_created on market.launch_uploads (wallet, created_at desc);
create index launch_uploads_metadata_cid on market.launch_uploads (metadata_cid);
create index launch_uploads_image_cid on market.launch_uploads (image_cid);
create index launch_uploads_cleanable on market.launch_uploads (created_at) where status in ('pending', 'refused');

-- The markets table now orders by coalesce(last_swap_at, created_at) so an unswapped launch in its first 24 hours
-- is not cut off (5.4).
create index if not exists pools_activity on market.pools ((coalesce(last_swap_at, created_at)) desc);

-- Backs the per-cycle query for SV pools whose 24-hour listing window has closed (5.4).
create index pools_sv_unswapped on market.pools (created_at) where origin = 'SV' and swap_count = 0;
