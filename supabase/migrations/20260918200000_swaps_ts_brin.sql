-- A BRIN index costs almost nothing (a few KB total, min/max per block range rather than an entry per row) and
-- serves the nightly prune's `ts <` scan (src/lib/sync/retention.ts) well on market.swaps: rows are written in
-- roughly time order, so each block range's ts values cluster tightly and a stale scan can skip whole ranges.
create index if not exists swaps_ts_brin on market.swaps using brin (ts);
