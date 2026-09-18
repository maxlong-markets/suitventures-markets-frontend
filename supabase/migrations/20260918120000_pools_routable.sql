-- Tradeability (M3 design doc section 2): a pool is routable when the V4 Quoter answers an exact-input
-- quote for a small fixed amount of the pool's quote asset without reverting (a 0 answer counts — the
-- honest-zero ruling). routable is null until the nightly probe phase (src/lib/sync/probe.ts) has attempted
-- it at least once; probed_at (unix seconds) is null the same way. A transport failure during a probe leaves
-- both columns exactly as they were, so null here also covers "probed, but the node could not be reached".
-- Pools outside the probe's candidate set (spec section 2: no swap in the last 7 days) keep both null forever.
alter table market.pools add column routable boolean, add column probed_at int;
