# Chain reader: design

21 Sep 2026. Replaces the hosted Envio indexer, which was paused for exceeding its CPU allowance and then
wiped and restarted from block 0 by the vendor. Background, measurements and the options considered are in
the workspace repo at `research/indexer-capacity-2026-09-21.md`.

## Goal

Keep `market.*` fed from the chain itself, inside the Vercel cron that already runs, with no server to
operate and no hosted indexer. The site keeps reading the store exactly as it does today.

## Where things stand

Production reads the store as of 21 Sep 09:30 UTC (`MARKET_DATA_BACKEND` removed). The store holds:
132,004 tokens with holder counts and supply, 238,391 pools of which 45,732 are a token's listed pool,
16.6 M trades to 18 Sep 16:20, and 2.85 M candles (m15/h1/d1 from 10 Jun, m1 from 6 Sep, all to 18 Sep).
Prices, liquidity and holders render; 24-hour figures are empty because the newest candle predates the
window. Of 54 enabled quote assets 25 carry a USD price, the rest being the known no-Chainlink-feed gap.

Nothing else exists. The Envio endpoint is gone. Every number from here on is derived from the chain.

## Architecture

One module inside `/api/internal/sync`, the existing cron route, replacing `EnvioSource` as the origin of
new data. Everything downstream is unchanged: the same `writers.ts`, the same tables, the same lease and
cursor in `sync_state`, the same read path.

```
chain ──► source ──► fold ──► writers ──► market.*  ──► the site
          (logs)    (pure)    (one tx)
```

- **Source.** `fetchPoolManagerLogs(fromBlock, toBlock)` returns decoded events with block timestamps and
  transaction senders. HyperSync is primary (one request carries logs, senders and timestamps together, and
  the account now has a paid package); the public RPC is the fallback, needing `eth_getLogs` plus a batched
  `eth_getTransactionByHash` for senders. A request covers 300–2,500 blocks depending on log density.
- **Fold.** A pure function over `(events, state) → rows`. This is the indexer's own logic, ported with its
  tests: `price.ts`, `candles.ts`, `liquidity.ts`, `origin.ts`, `primaryPool.ts`, `quotes.ts`, `denylist.ts`
  and the three handlers in `handlers/poolManager.ts`, 718 lines in total.
- **Writers.** Existing functions, called inside one transaction with the cursor advance.

## The cycle

Runs repeatedly inside each one-minute invocation until the deadline, so the store trails the chain by well
under a minute.

1. Acquire the lease; read the block cursor from `sync_state`.
2. Read the chain head; target `head - 30` (about 3 seconds) so a reorganised block is never read.
3. Fetch the PoolManager's logs for `(cursor, target]`, capped at what one request covers.
4. Load the pools those events touch, plus their tokens and the quote list, in one query each.
5. Fold in block and log order:
   - **Initialize** — classify the pair (memestock against a quote asset, not denylisted, not native ETH);
     create the pool; create the token if new and read its symbol, name, decimals and supply from the
     contract; set `sqrt_price_x96`.
   - **Swap** — write the trade row; update the pool's price, `sqrt_price_x96`, trade count, last trade
     time, all-time volume and TVL (net of fee on the paid side, per the ported `principalDelta`); update
     the five candles; recompute the token's primary pool when it has more than one.
   - **ModifyLiquidity** — convert the liquidity delta to token amounts against the pool's
     `sqrt_price_x96` and apply to TVL. If the pool has no `sqrt_price_x96` yet, read `getSlot0` once.
6. Write every row and the new cursor in one transaction. All or nothing: a crash or timeout leaves the
   cursor where it was and the next run redoes the span, so no trade is doubled or skipped.
7. Refresh quote USD prices from the Chainlink aggregators with one multicall, replacing the
   `AnswerUpdated` subscription.
8. Release the lease.

## What is deliberately not indexed

ERC-20 `Transfer`. It was 68–80 % of the old indexer's intake and the reason it was throttled, and indexing
it here would move that cost onto Vercel and the Supabase disk instead. Its two outputs are served instead:

- **Total supply** — `totalSupply()` on the token, refreshed nightly for tokens that traded recently.
- **Holder count** — the stored baseline (131,902 tokens carry one) moved by trades: a wallet buying a token
  it did not hold is one more holder, a wallet selling out is one fewer, confirmed with `balanceOf` on the
  wallets that traded. Drift is limited to holders who arrive or leave without trading.
- **Top holder list** — read through per token with the existing HyperSync transfer client
  (`SuitVenturesMarket-indexer/src/lib/hypersync.ts`), cached in `market.token_balances` as today.

## Retention

Windows already shipped in `src/lib/sync/retention.ts`: candles m1 1 day, m5 2 days, m15 4 days, h1 14 days,
d1 300 days, which covers the chain's whole 103-day history so no token loses its daily chart. Trades stay
at 10 days pending Kobe's decision between 3 and 5. The nightly job gains a candle prune; the trade prune
exists. At these windows the database settles near 3 GB and stops growing.

A consequence to fix before cutover: the token page opens on the 15-minute interval, so a token dormant
longer than 4 days would open on an empty chart. The page should open on the finest interval that has data.

## Failure handling

| Case | Behaviour |
|---|---|
| A source refuses or rate-limits | Back off and retry; fall through to the other source. |
| The function dies mid-write | The transaction rolls back, the cursor has not moved, the next run redoes the span. |
| Two runs overlap | The existing lease admits one writer. |
| The chain reorganises its tip | Never read within 30 blocks of the head. |
| Behind for any reason | Catching up runs at thousands of blocks a second; health reports blocks behind the node's own head, never a vendor's. |
| Token metadata unreadable | Retried hourly, as the indexer did; trades still record. |

## Cutover

1. Catch up from 18 Sep 16:20 to the head, run locally like the seed, through HyperSync.
2. Check against the chain: replay a sample of pools and compare prices, candles and totals.
3. Set `CRON_SECRET` so the cron authenticates, and let the cycle run.
4. Watch health for an hour.

## Out of scope

No server, no Docker, no Hasura, no second database. No transfer indexing. No change to the read path other
than the chart-interval fallback. The Suits NFT fee tier, the launchpad URL patterns and the USD fallback for
unpriced quote assets remain their own open items.
