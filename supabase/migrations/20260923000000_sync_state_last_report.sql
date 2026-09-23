-- The chain job's last cycle, as a small JSON object for /api/health (23 Sep 2026): how many distinct
-- (token, wallet) pairs its holder-count upkeep saw, how many it resolved with real balance reads and how
-- many it had to leave unknown. That is the one signal that says whether balance reads are getting through
-- the RPC's rate limit, and until now it was only visible by calling the cron by hand or reading the logs.
-- Additive, defaulted, instant on a table of a few rows; reversible by dropping the column.
alter table market.sync_state add column if not exists last_report jsonb not null default '{}'::jsonb;
