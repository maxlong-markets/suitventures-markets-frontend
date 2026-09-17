-- Envio computes token supplies and holder balances from events, and two tokens already report supplies of 79 and
-- 80 digits (beyond uint256). The store mirrors the indexer, so the four amount columns lose their 78-digit cap;
-- plain numeric holds up to 131072 digits and keeps any decimals the indexer sends.
alter table market.tokens alter column total_supply type numeric;
alter table market.pools alter column tvl_token type numeric, alter column tvl_quote type numeric;
alter table market.token_balances alter column balance type numeric;
