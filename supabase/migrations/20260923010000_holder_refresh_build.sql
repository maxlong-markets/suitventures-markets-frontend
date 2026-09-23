-- Top holders (docs/superpowers/specs/2026-09-23-top-holders-design.md, section 3): market.holder_refresh
-- becomes the per-token build state of the exact balance map in market.token_balances. Additive, defaulted,
-- reversible by dropping the four columns and the index; the table is empty on production today.
alter table market.holder_refresh
  add column if not exists cursor_block int not null default 0,
  add column if not exists requested_at int not null default 0,
  add column if not exists status text not null default 'building',
  add column if not exists transfers bigint not null default 0;
alter table market.holder_refresh drop constraint if exists holder_refresh_status_check;
alter table market.holder_refresh add constraint holder_refresh_status_check check (status in ('building', 'ready', 'skipped'));
-- The builder's first priority: opened tokens still building, newest request first (design section 4, due list 1).
create index if not exists holder_refresh_requested on market.holder_refresh (requested_at desc) where status <> 'skipped';
