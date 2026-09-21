-- pruneCandles (src/lib/sync/retention.ts, Task 8) scans `where interval = $1 and t < $2`, and market.candles's
-- only index is its primary key (pool_id, interval, t) — the wrong leading column for that predicate, so every
-- batch was a full scan of a table around 2.9 M rows. That risks the pooler's 2-minute statement timeout, which
-- throws rather than letting pruneCandles return done: false, and nothing catches it. This index puts interval
-- first so the scan matches the prune's own predicate.
create index if not exists candles_interval_t on market.candles (interval, t);
