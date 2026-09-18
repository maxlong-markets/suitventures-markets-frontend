# Token page (M3) — design and plan

Status: Kobe said "lets go to the next milestone" on 18 Sep 2026. Due Sep 23.

## 1. What the milestone asks, and what already exists

README M3: "Every row opens a page with the candle chart switchable across all
five intervals, liquidity, the last 50 trades with wallets, top holders with
share of supply, and pool details. Unroutable pools show a launchpad link in
place of Buy and Sell."

Audit of the page as shipped (18 Sep 2026):

| Requirement | State | Where |
|---|---|---|
| Chart, five intervals | done | `CandleChart.tsx` offers 1m 5m 15m 1h 1d |
| Liquidity | done | info tab, USD and quote units |
| Last 50 trades with wallets | done, wallet hidden below tablet width | `ActivityTabs.tsx`, `TRADES_LIMIT = 50` |
| Top holders with share of supply | done, top 10 plus count | `HOLDERS_SHOWN = 10`, `share` % |
| Pool details | done: pool id, hook, fee tier, created, liquidity | info tab |
| Unroutable pools show a launchpad link | **not done**: `tradeable` is hard-coded `true` on both backends and `ORIGIN_URLS` is empty | `dbShape.ts:45`, `shape.ts:129`, `chain.ts:37` |

So M3 is three things: a real tradeability flag, the launchpad links, and
small page polish. The rest lands with the market-store switchover, which
makes the page read from our own database.

## 2. Tradeability (D28 as amended): a nightly probe, stored per pool

**Rule.** A pool is routable when the V4 Quoter answers an exact-input
quote for a small fixed amount of the pool's quote asset without a contract
revert. A `0` answer is routable (the honest-zero ruling). A transport
failure is not an answer and leaves the flag untouched.

**Amount.** `10^(quoteDecimals - 3)` base units of the quote asset (0.001
NVDA), buy direction (`zeroForOne = quote is currency0`). Small enough for
dust pools, large enough to exercise the hook.

**Storage.** `market.pools` gains `routable boolean` (null = never probed)
and `probed_at int` (unix seconds, null = never). New migration file; the
original stays frozen.

**Who probes.** A new nightly phase `probe`, after `listed`, over the pools
that can appear in the table: `last_swap_at >= now - 7 days`, ordered by id,
paged, persisting the cursor like the other phases. Concurrency 4 against
the chain RPC, a per-run cap of 3000 probes, and the nightly's deadline. It
consumes no indexer budget; the RPC calls are cheap `eth_call`s. Pools
outside that set keep `routable = null`.

**How the flag is read.**
- Store backend: `tradeable = routable !== false` for the listed pool. Null
  is optimistic: the table never hides a pool because it has not been
  probed yet, and the quote route tells the truth on the page.
- Indexer backend (live until the switchover): `pairs()` keeps `true`
  (500 probes per request is not acceptable); `pair(id)` probes once per
  pool through the same quoter, memoised 5 minutes, so the token page shows
  the launchpad card for an unroutable pool on both backends.

**What it is not.** A refused quote for one amount on the token page does
not flip the flag (a verdict on one amount is not a verdict on the pool,
ruling 6). Only the probe writes `routable`.

## 3. Launchpad links

`ORIGIN_URLS` becomes `launchpadUrl(pair): string | undefined`, a per-origin
URL pattern that takes the token address. The patterns come from MAXLONG:
LONG's launchpad page for a token and the Bags page for a Pons token. Until
they arrive the function returns `undefined` and the card shows its text
without a button, exactly as today. `UntradeableCard` already renders the
link when one exists.

## 4. Page polish

- The trades table shows a short wallet on phone width too (the milestone
  says "with wallets"; hiding it below tablet reads as missing).
- The info tab links the hook address, the token and the quote asset to
  Blockscout; the pool id stays plain (a v4 pool id is not an address).

## 5. Listing rule (decision for Kobe, not blocking)

With a real `routable` flag the table's listing rule can stop requiring a
past trade: `LISTED_POOL` would take a sane-priced pool that is not proven
unroutable, so a freshly launched token with liquidity appears with zero
volume. Today it needs `swap_count > 0`. This is a product call; the
milestone ships either way.

## 6. Tasks

1. **Probe storage and phase.** Migration `20260918_pools_routable.sql`;
   `src/lib/sync/probe.ts` (`probePools(db, quoter, opts)`: select the
   candidate pools after a cursor, probe with concurrency 4, write
   `routable`/`probed_at`, return counts); the nightly phase `probe` with
   its cursor; `deps.ts` supplies the quoter. Tests: PGlite for the writes
   and cursor, a fake quoter for routable/unroutable/transport-failure.
2. **Reading the flag.** `dbShape` maps `tradeable` from `routable`;
   `dbBackend` selects it; `envioBackend.pair()` lazy-probes with a 5-minute
   memo; health reports the probe phase like the others. Tests on both
   backends; the parity test covers a `false` pool.
3. **Launchpad links and polish.** `launchpadUrl()` with the patterns
   behind two constants to fill; phone-width wallet column; Blockscout links
   on the info tab. Component tests for the card with and without a URL.

Gates at every commit: `npm test`, `npx tsc --noEmit`, `npx eslint .`
(zero warnings), `npm run build`. Commit trailer as the trading plan.

## 7. Verified facts the tasks rely on

- The server-side quoter (`src/lib/quote/quoter.ts`, `createQuoter()`)
  already runs `simulateContract` against the Quoter at
  `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` and throws
  `NotRoutableError` on a contract revert and `QuoterUnavailableError` on
  anything else. The probe reuses it unchanged.
- `market.pools` has `last_swap_at int` (null when never swapped),
  `quote_id`, `token_is_currency0`, `hooks`, `fee`, `tick_spacing`, and
  `market.quotes.decimals`; the nightly persists phase and cursor through
  `saveCursors(db, "nightly", { phase, cursorText })`.
- A per-pool probe is one `eth_call`; the public RPC answered the Quoter in
  about 2 s under load and 0.3 s warm.
