# M1: Markets and token page on live indexer data

**Status:** approved design, September 12, 2026. Spans two repos: `suitventures-markets-indexer` (new, Envio HyperIndex) and `suitventures-markets-frontend` (route handlers and `EnvioDataSource`).
**Milestone:** M1 in the project README (target September 15, 2026): on a phone, Markets lists live LONG and Pons tokens with origin badges, chips, presets and sort; the token page shows chart, trades and holders; no wallet.
**Decisions recorded** in the README Decision Log as D21 to D30. The README wins if this document and the README disagree.

## 1. Architecture

Three parts, one direction of data flow: chain → indexer → route handlers → frontend.

- **Indexer** (`suitventures-markets-indexer`): Envio HyperIndex v2, TypeScript, one network (Robinhood Chain, id 4663) read through HyperSync. Discovers every Uniswap v4 pool that pairs a non-quote token with an allowlisted quote asset, tracks its swaps, liquidity changes and donations, tracks the token's ERC-20 transfers for holders and supply, and ingests Chainlink equity feeds for USD prices. Stores everything in quote units.
- **API layer** (frontend repo, `src/app/api/`): the only client of the indexer's GraphQL endpoint. Converts to USD at the edge, shapes responses into the `MarketsDataSource` models, caches for seconds, reports health.
- **Frontend**: `EnvioDataSource` is a thin fetch client over those routes. Components are unchanged except for the contract changes in section 6.

## 2. Chain facts used by the design

| Item | Value |
|---|---|
| Chain | Robinhood Chain, id 4663, HyperSync endpoint provided by Envio |
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| Uniswap v4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| Uniswap v4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| Doppler shared v4 hook (LONG pools) | `0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544`, read from the AI/NVDA pool's `Initialize` log; dynamic-fee flag, tick spacing 8 |
| Pons v2 MemeHook | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044`; fee 0, tick spacing 200 |
| USDG | `0x5fc5360d0400a0fd4f2af552add042d716f1d168`, 6 decimals, USD price pinned at 1 |
| Stock tokens | Standard ERC-20, 18 decimals, each with its own Chainlink feed whose value already includes the token multiplier; feeds are 24/5 and may hold the last price off-hours |

Events consumed (signatures as emitted):

- PoolManager `Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)`
- PoolManager `Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)`
- PoolManager `ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)`
- PoolManager `Donate(bytes32 indexed id, address indexed sender, uint256 amount0, uint256 amount1)`
- ERC-20 `Transfer(address indexed from, address indexed to, uint256 value)` on tracked tokens (dynamic registration)
- Chainlink proxy `AggregatorConfirmed(address indexed previous, address indexed latest)`
- Chainlink aggregator `AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)`

The Pons `PoolRegistered` and `TokenLaunched` events are not consumed: a Pons pool is a v4 pool and fires `Initialize` on the PoolManager (verified on a graduated pool).

## 3. Discovery and tracking

**Quote allowlist.** A config file `quotes.json` seeds `Quote` rows: address, symbol, name, decimals, Chainlink proxy address (none for USDG). For M1 it holds the Robinhood stock tokens and USDG. Native ETH (currency address zero) and WETH are not rows in M1; adding either later is a row plus a backfill. All filtering reads the `Quote` rows; there is no hardcoded notion of "stock" or "USDG" anywhere in handlers.

**Discovery** happens on `Initialize` only. A pool is tracked when exactly one of `currency0`/`currency1` is a `Quote` and the other is not. Both sides quotes (stock/USDG pools) and neither side a quote are ignored. The non-quote side becomes the `Token`; `tokenIsCurrency0` records the orientation.

**Origin** is a label derived from `hooks`, never a gate: Doppler hook → `LONG`, MemeHook → `Pons`, address zero → `Uniswap`, anything else → `Other`. A curated config list of poolIds overrides the label (SUIT for the SUIT pool once MAXLONG supplies its key; the list starts empty). A new launchpad therefore appears as `Other` with no code change; giving it a name is a config entry.

**Tracking.** `Swap`, `ModifyLiquidity` and `Donate` handlers return immediately for poolIds that are not tracked. On discovery the token's ERC-20 is registered dynamically; Envio indexes a dynamically registered contract from its creation block, so the mint and every earlier transfer (including Pons curve-era transfers) are captured.

**Tradeability** is not derived from origin. It is a V4 Quoter simulation at the API edge, cached per pool with a short TTL, and lands with the router work in M2. In M1 the trade panel renders for every pool in its disconnected state.

## 4. Entities

- `Quote` (id = address): symbol, name, decimals, chainlinkProxy, enabled (false keeps the quote's existing pools but stops discovering new ones).
- `QuotePrice` (id = quote address): usdPrice (decimal), updatedAt, aggregator. Written from `AnswerUpdated`; USDG's row is fixed at 1.
- `Token` (id = address): symbol, name, decimals, totalSupply, origin, primaryPool, pools (derived one-to-many), holdersCount, createdAt (block time of the first discovered pool).
- `Pool` (id = poolId): token, quote, tokenIsCurrency0, hooks, fee, tickSpacing, createdAt, priceQuote (double, token price in quote units), sqrtPriceX96, tvlToken, tvlQuote (nullable until the tick-math work lands, see section 9), swapCount, lastSwapAt.
- `Swap` (id = txHash-logIndex): pool, timestamp, side, amountToken, amountQuote, priceQuote (execution price), wallet, txHash.
- `Candle` (id = poolId-interval-bucketStart): pool, interval (`1m`, `5m`, `15m`, `1h`, `1d`), t, open, high, low, close (quote units, post-swap pool price), volumeQuote, volumeToken, trades.
- `TokenBalance` (id = token-holder): token, holder, balance, updatedAt.

Token name, symbol and decimals are read once over RPC at discovery through Envio's effect API. `totalSupply` is never read: it is the running sum of `Transfer` amounts from address zero minus transfers to address zero, exact because transfers are indexed from the token's creation block.

## 5. Derivations

**Price.** From `sqrtPriceX96`: price of currency0 in currency1 = `(sqrtP / 2^96)^2 × 10^(dec0 − dec1)`; `priceQuote` is that value when the token is currency0, its inverse otherwise. Stored as a double for display; the raw `sqrtPriceX96` is kept.

**Swaps.** The event's `amount0`/`amount1` are the swapper's deltas: a positive token delta is a buy. `amountToken` and `amountQuote` are absolute values; the `Swap` row's price is the execution price (`amountQuote / amountToken`). The Swap event is emitted before `afterSwap` runs, so execution price and amounts are pre-hook-fee; the code carries a comment saying so. `wallet` is the transaction's `from` (a bundler for smart accounts, accepted for v1). Candles use the post-swap pool price so consecutive buckets are continuous.

**Candles.** Bucket start = `floor(timestamp / interval) × interval`. Empty buckets are never materialized; "gapless" means only that a bucket opened after a gap starts at the previous pool price (previous close). Creation windows, to keep backfill and storage bounded:

| Interval | Created from |
|---|---|
| 1m | `CANDLES_1M_START_BLOCK` ≈ 7 days before the first deployment |
| 5m | ≈ 30 days before the first deployment |
| 15m, 1h, 1d | full range |

No pruning in M1. Rolling deletes (1m after 7 days, 5m after 30) are on the M6 hardening list; the forward rate (about 30k 1m rows a day at a few hundred active pools) fits Production Small until then.

**TVL** by token-flow accounting, the method Uniswap's own v4 indexer uses: swaps add the negated swapper deltas, `Donate` adds both amounts, `ModifyLiquidity` adds the amounts computed from `liquidityDelta`, the tick range and the pool's stored `sqrtPriceX96` (price does not move between swaps). Accepted drift for v1: hook deltas and fees never appear in the Swap event, so pools with hooks that take fees from the output drift low over time. A periodic sanity check against StateView active liquidity, exact for Pons full-range positions and a bound for Doppler's multi-position curve, is M6.

**Holders.** `TokenBalance` moves on every `Transfer`; `holdersCount` increments when a balance rises from zero and decrements when it returns to zero; address zero is never a holder.

**USD.** `QuotePrice` rows come from Chainlink `AnswerUpdated` events, decoded with the feed's decimals; the feed value already includes the token multiplier. Aggregators are a static config list with a start block about 7 days back (only the current price matters). Proxies are indexed from their creation blocks; an `AggregatorConfirmed` with a new `latest` registers that aggregator dynamically, so feed rotations are followed without a config change. The API marks a quote stale when `updatedAt` is older than 3 days, which distinguishes a dead aggregator from an off-hours hold.

**primaryPool** is recomputed for the token whenever one of its pools' TVL changes: highest `(tvlQuote + tvlToken × priceQuote) × usdPrice`; if TVL is unavailable, highest `swapCount`; then earliest `createdAt`.

**Window statistics** are computed at the edge, not stored: price 1h and 24h ago are the close of the last 1m candle before each window start, fetched for all pools in one Hasura query with `distinct_on: pool_id` ordered by `t desc`; a pool with no candle before the window start is "new" (`null`), not 0%. 24h volume is the sum of 5m candles with `t ≥ now − 24h`, so the boundary error is under five minutes.

## 6. API contract and frontend changes

Route handlers in the frontend repo, server-only `ENVIO_GRAPHQL_URL` and `ENVIO_API_TOKEN`:

| Route | Returns | Cache |
|---|---|---|
| `GET /api/pairs` | `TokenPair[]`: one row per token via `primaryPool`, USD applied, tokens with zero swaps excluded, ordered by `lastSwapAt` desc, capped at 1,000 rows | 15s |
| `GET /api/quotes` | `QuoteAsset[]` with USD price, stale flag, pair count, 24h USD volume | 30s |
| `GET /api/tokens/{address}/candles?interval=` | candles in quote units plus a USD series converted at each candle's nearest `QuotePrice` (the earliest known price before the 7-day feed window) | 10s |
| `GET /api/tokens/{address}/trades` | last 50 swaps | 10s |
| `GET /api/tokens/{address}/holders` | top 10 with `Pool` tag on the PoolManager address, plus `holdersCount` | 60s |
| `GET /api/health` | indexer head lag (processed block vs chain head) and the age of every `QuotePrice` | none |

USD at the edge: `priceUsd = priceQuote × usdPrice`, `fdv = priceUsd × totalSupply`, `liquidity = (tvlQuote + tvlToken × priceQuote) × usdPrice` (null when TVL is null), `vol24h = volumeQuote24h × usdPrice` (current quote price, an accepted approximation). Envio unreachable → 503 with `Retry-After`; stale responses are served while revalidating.

Frontend contract changes:

- Tokens are keyed by **address**: `TokenPair.id` is the token address, routes become `/t/[address]`, and every `MarketsDataSource` method that took a ticker takes the address. The mock source follows.
- `Launchpad` becomes `Origin`: `LONG | Pons | Uniswap | Other | SUIT`, plus `SV` once the factory ships. The launchpad segment reads All · LONG · PONS · UNISWAP · OTHER. Badge styling is unchanged.
- `change1h` and `change24h` are nullable and render as a dash; the Gainers preset excludes nulls. `liquidity` is nullable and renders as a dash.
- `holders` comes from the API. The 1m and 5m chart intervals show whatever exists inside their creation windows.
- `EnvioDataSource` wraps the routes; watchlist and votes keep the local store until the signed API exists in M2.

## 7. Environments and monitoring

- Indexer: `envio dev` locally (Docker Postgres and Hasura, HyperSync for data). Envio Cloud dev indexer for the M1 demo; Production Small from the M2 demo, because Transfer indexing exceeds the free plan's 100,000-event soft limit during the first sync and a free deployment then lives about ten more days.
- Frontend: Vercel with `NEXT_PUBLIC_DATA_SOURCE=envio` in production; local development stays on the mock unless pointed at the cloud indexer.
- Monitoring in M1: `/api/health`, the stale-quote flag, and Envio Cloud's built-in stall alerts. M6 adds the TVL sanity check, candle pruning and a daily proxy-versus-config aggregator check.

## 8. Testing and acceptance

- Indexer unit tests on pure functions: price from `sqrtPriceX96` with orientation and decimals, bucket keys and the gapless open, tick-math amounts against Uniswap SDK reference values, holder zero-crossings and mint/burn supply, `primaryPool` ordering with both fallbacks.
- Handler tests with Envio's generated `TestHelpers` and mock database for `Initialize` (quote filter, origin labels, curated override), `Swap`, `ModifyLiquidity`, `Donate`, `Transfer`, `AggregatorConfirmed` and `AnswerUpdated`.
- Live validation before deploying: sync a narrow block range around known AI/NVDA swaps and compare price, 24h volume and liquidity with DexScreener and Blockscout.
- API route tests against a mocked GraphQL response: USD conversion, null "new" changes, the cap and ordering, stale quotes, 503 on failure.
- Frontend: `EnvioDataSource` mapping tests; the mock stays for UI work; a browser smoke of both live pages at phone width.
- Acceptance: the M1 definition of done at the top of this document, demonstrated on a phone against the cloud indexer.

## 9. Risks and fallbacks

- **Tick-math TVL is the schedule risk.** If it slips, M1 ships with `tvlToken`/`tvlQuote` null, liquidity renders as a dash, `primaryPool` falls back to swap count, and the work lands in M3.
- **Sizing.** Candle creation windows keep the backfill bounded; the Chainlink 7-day start keeps feed events small. If Production Small still fills, the next lever is narrowing the 5m window, then pruning.
- **Free tier lifetime.** The dev deployment is a demo environment with a ten-day fuse after its first sync; rotate to a fresh dev indexer if the paid plan is not yet active.
- **Hook drift.** Stated and accepted; the M6 sanity check bounds it.

## 10. Out of scope for M1

Wallet connection, quoter-based tradeability, the SVRouter swap path, the signed watchlist and vote API, candle pruning, TVL reconciliation, aggregator proxy checks, native ETH and WETH quotes, the SUIT curated pool until its key exists, the card feed layout from the Decision Log.

## 11. Rollout order

Schema and handlers → local sync and live validation → Envio Cloud deploy → route handlers → `EnvioDataSource` → flip `NEXT_PUBLIC_DATA_SOURCE` on Vercel.
