-- M4 social layer (spec section 3): the two tables the app stores that are not on-chain, both keyed by the
-- wallet the session cookie proves. No foreign key to market.tokens on purpose — a user may star a token the
-- store has not synced yet, and a sync that rewrites tokens must never cascade a user's own rows away.
create table market.watchlist (
  wallet text not null,
  token_id text not null,
  created_at int not null,
  primary key (wallet, token_id)
);

create table market.votes (
  wallet text not null,
  token_id text not null,
  dir text not null check (dir in ('bull','bear')),
  updated_at int not null,
  primary key (wallet, token_id)
);

-- The public counts query groups by (token_id, dir) for up to 500 tokens at a time; this index is the whole of it.
create index votes_token on market.votes (token_id, dir);
