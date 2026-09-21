-- The pool's last sqrtPriceX96 (Uniswap V4's Q64.96 price, a uint160 and so wider than float8 or bigint):
-- needed to turn a ModifyLiquidity delta into token amounts once we fold PoolManager events ourselves,
-- instead of reading Envio's aggregates. Null until the frozen-snapshot copy sets it, or later a swap does.
alter table market.pools add column sqrt_price_x96 numeric;
