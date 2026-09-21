-- The chain reader folds PoolManager events itself instead of trusting Envio's aggregates, and its running
-- totals (tvl, swapCount, volumeQuoteAllTime — see PoolState.baselineAt in src/lib/chain/types.ts) must not
-- double-count what the old indexer already contributed. baseline_at is the block timestamp up to which a
-- pool's totals already include every event, because they were copied from the old indexer at that moment;
-- the fold adds only events after it. Backfilled from synced_at (the moment of that copy, 17 Sep 2026 about
-- 10:05 to 10:20 UTC) so every pool the frozen-snapshot copy created starts fully covered; a pool the reader
-- creates itself later defaults to 0, since it starts empty and every event is new. Price, last trade time,
-- trade rows and candles are never gated by it. The reader itself never writes this column again after this
-- migration sets it.
alter table market.pools add column baseline_at int not null default 0;
update market.pools set baseline_at = synced_at;

-- The runner (Task 6) retries a token whose metadata could not be read from the chain (readTokenMetadata
-- failed for it) once an hour rather than every cycle; metadata_retry_at is the next unix-second timestamp
-- it may try again, 0 meaning "never tried, try now". Nothing in this task writes it — it exists so the
-- runner can.
alter table market.tokens add column metadata_retry_at int not null default 0;
