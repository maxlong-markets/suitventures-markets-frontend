# SuitVentures Markets — frontend

Desktop-first web app that lists every memecoin pair on Robinhood Chain
(chain id 4663) and swaps through the SuitVentures router. Built from the
design handoff in `docs/design-handoff/`.

Stack: Next.js 16 (App Router) · TypeScript · Tailwind v4 (`@theme` tokens in
`src/app/globals.css`) · wagmi v3 + viem + RainbowKit · TanStack Query ·
TradingView Lightweight Charts.

## Run

```bash
npm install
cp .env.example .env.local   # then fill in what you have
npm run dev                  # http://localhost:3000
```

`npm run build` type-checks and builds; `npm run lint` runs ESLint.

## Routes

| Route | Page |
|---|---|
| `/` | Markets — quote chips, presets, launchpad filter, pairs table |
| `/watchlist` | Starred pairs (needs a connected wallet) |
| `/t/[address]` | Token page — chart, trades / holders / info, trade panel |
| `/launch` | Launch a token: image, name, symbol, currency, opening valuation, optional first buy; one transaction, for Suits holders |

## Data layer

Everything the UI renders comes through `MarketsDataSource`
(`src/lib/types.ts`), never from literals.

- `MockDataSource` (`src/lib/data/mock.ts`) — deterministic, seeded with the
  handoff's eight real pairs plus eight placeholders. Default.
- `EnvioDataSource` (`src/lib/data/envio.ts`) — live data, read through this
  app's own route handlers. Select it with `NEXT_PUBLIC_DATA_SOURCE=envio`.

### The store

Live market data lives in a Postgres schema `market` on a Supabase project the
app owns (`supabase/migrations/`). The one-minute cron reads the PoolManager's
`Initialize`, `Swap` and `ModifyLiquidity` events through HyperSync, folds them
with the indexer's own arithmetic, and writes rows and a block cursor in one
transaction. That cron does not index ERC-20 `Transfer` at all, so total supply
comes from the token contract and the holder count from the stored baseline
moved by trades; the separate top-holder builder folds `Transfer` per token for
the few hundred tokens that need an exact list, and resets their count to exact
at every refresh. The route handlers under `src/app/api` read that store.

- **Sync** (`src/lib/chain`, `src/lib/sync`, `src/lib/holders`): `GET
  /api/internal/sync` runs every minute on Vercel cron (`vercel.json`) and is the
  chain reader (`src/lib/chain/run.ts`) described above; `GET
  /api/internal/holders` (`src/lib/holders/run.ts`) runs every minute too and is
  the top-holder builder, folding each covered token's `Transfer` logs into
  `market.token_balances` at 80 HyperSync requests a minute
  (`docs/superpowers/specs/2026-09-23-top-holders-design.md`); `GET
  /api/internal/sync/nightly` (`src/lib/sync/nightly.ts`) runs at 03:00 UTC,
  recomputing every listed pool, pruning swaps and candles past their retention
  windows, dropping the holder lists of tokens neither covered nor opened in the
  last week, then probing pool routability. All three require `Authorization:
  Bearer <CRON_SECRET>`, take a lease in `market.sync_state` so invocations never
  overlap, and record their last run, last success and last error there. The
  chain job's lease matches its 300 s `maxDuration` exactly: re-folding an
  overlapping block range would double-count candle volume and pool totals,
  unlike the nightly phases' plain upserts — and the holder builder's lease exists
  for the same reason, its balance upserts being additive too.
- **Backend switch** (`src/lib/market`): route handlers call `getBackend()`,
  which is always the store implementation now — Envio was decommissioned 21
  Sep 2026 (Task 6) and `MARKET_DATA_BACKEND` is no longer read anywhere, so
  setting it changes nothing and there is no rollback path left. `shapePairs()`
  in `src/lib/envio/shape.ts` remains the parity reference the laptop-only
  `npm run db:parity` (`scripts/db/parity.mts`) checks the store against.
- **Routes**: `/api/pairs`, `/api/quotes` and
  `/api/tokens/[address]/{candles,trades,holders}` keep their contract and cache
  headers. `GET /api/tokens/[address]` is new: one `TokenPair` (or 404) for a
  token outside the 500-row list, so deep links work. `GET /api/health` reports
  the backend, database latency, sync age and last error, indexer lag (chain
  head minus last processed block), which quote-asset USD prices are stale, and
  the holder builder's last cycle and last error next to `market.token_balances`'s
  row estimate and total size.
- **Scripts** (`scripts/`, see `scripts/README.md`): `npm run db:migrate`,
  `npm run db:smoke`, `npm run seed` (the resumable one-off load) and
  `npm run db:parity`. They read `DATABASE_URL_DIRECT` (session pooler) from
  `.env.local`, never the app's `DATABASE_URL`.

Live mode needs these variables; all but the first are server-only:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_DATA_SOURCE` | `envio` |
| `DATABASE_URL` | Supabase pooler, transaction mode, port 6543 |
| `CRON_SECRET` | 32 random bytes; Vercel sends it as a Bearer token to the cron routes |
| `HYPERSYNC_API_TOKEN` | the HyperSync token both the chain reader and the top-holder builder use, from Envio's HyperSync dashboard (`ENVIO_API_TOKEN` is a fallback). A paid key (100 requests a minute) since the builder shipped: it paces itself to 80 a minute, leaving the reader the rest. On a key that advertises a smaller budget the builder drops to that budget minus 10 rather than starving the reader, so a free key only makes the lists build slowly |
| `HYPERSYNC_URL` | optional; defaults to `https://4663.hypersync.xyz` |
| `CHAIN_RPC_URL` | optional; primary RPC for the reader's chain reads (metadata, Chainlink prices, holder-count balances, health), defaults to the chain's public node; always paced at 40 calls a second |
| `CHAIN_RPC_FALLBACK_URL` | optional; backup RPC (a paid endpoint, server-only) tried once when the primary refuses, times out or errors |
| `SYNC_INTERVAL_SEC` | optional; seconds between sync cycles inside one invocation, default 30 |
| `NEXT_PUBLIC_LAUNCHPAD_ADDRESS` | the launchpad contract, set only after it is deployed; empty keeps `/launch` on "not live yet", the reader off its logs and the upload route at 503 |
| `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY`, `FILEBASE_BUCKET` | required; the Filebase IPFS bucket launch images are pinned to; all three for uploads and the nightly clean-up |
| `FILEBASE_GATEWAY_URL` | optional; a dedicated gateway's https origin for launch logos, https origin only, default `https://ipfs.filebase.io` |

Preview deployments get no database variable and stay on the mock source. The live source
prices a trade through `GET /api/tokens/[address]/quote`, which simulates the V4 Quoter and
returns both the display numbers and the execution `call` block; `src/lib/quote.ts` keeps its
constant-product approximation for the mock source and for the amount-0 case the route does
not answer.

`GET /api/tokens/[address]/logo` proxies the token's logo, resolved per token
from the contract's `logo()` (Pons), its `tokenURI()` JSON (LONG) or
DexScreener, and cached; the optional server-only `ROBINHOOD_RPC_URL` picks the
RPC those reads use, defaulting to the public one.

### The instant launchpad

The design is `docs/superpowers/specs/2026-09-28-instant-launchpad-design.md`. The reader adds the launchpad as a
second log selection in its per-minute HyperSync request and folds `Launched`, `FeesCollected` and `PayoutChanged`
into `market.launches` and `market.launch_fee_events`. A launched token lists with the `SV` badge from its launch
block. A launched token keeps the SV origin, but the badge and the SV filter follow the listed pool, so if another pool
becomes the listed one the badge can differ. One nobody has bought leaves the table after the listing window below and returns with its first trade; its
page stays up. `POST /api/launch/upload` re-encodes a creator's image to a WebP and pins it and a metadata JSON on
Filebase before the launch. Only Suits holders may upload, within the per-wallet limits below. The nightly job's
`uploads` phase unpins what no launch used.

| Launchpad number | Value |
|---|---|
| Uploads per wallet per hour | 5 |
| Uploads per wallet per day | 20 |
| Launch image | 512 x 512 WebP |
| Listing window for a token nobody has bought | 24 hours |
| Token page re-reads after a launch | every 5 seconds, for up to 5 minutes |
| A hidden launch's logo answers "no logo" | within about 2 hours at worst |

To hide a launch's image and links, run this in the Supabase SQL editor:

    update market.launches set hidden = true where token_id = '<lowercase address>'

Rollout, in this order:

1. Apply the migration with `npm run db:migrate` before pushing. Without the launch tables every token page and
   `GET /api/tokens/[address]` fail, because the single-token query joins `market.launches`. `/api/health` answers
   503, and logos across the whole site fail, because every logo lookup reads `market.launches`.
2. Before rollout, run `EXPLAIN (ANALYZE, BUFFERS)` in production on the pairs query for both scopes, `all` and
   `launchpad`, and confirm the new order uses the `pools_activity` index. The query is `ORDER` in
   `src/lib/market/dbBackend.ts`.
3. Set `NEXT_PUBLIC_LAUNCHPAD_ADDRESS` only after the contract is deployed, and before anyone launches: a launch the
   reader has already passed over needs a catch-up rewind to appear. The value is fixed at build time, so setting or
   changing it takes a redeploy.
4. Set the Filebase names on Vercel. `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY` and `FILEBASE_BUCKET` are
   required. `FILEBASE_GATEWAY_URL` is optional and takes an https origin only.

Watchlist and votes are browser-local in live mode
(`src/lib/data/localStore.ts`, `localStorage` keyed by wallet address): they do
not follow the wallet to another device, and vote counts read 0 until the
signed API lands in M3.

Two methods were added beyond the handoff interface: `votes(address)` (the
caller's current vote per token address) and `pair(id)` (one token by address,
listed or not) — see the comments in `types.ts`.

## Stubs still to wire

| Stub | Where | Status |
|---|---|---|
| Swap execution | `src/lib/swap.ts` | **Done (M2)** — Permit2 signature and `SVRouter.swapExactIn`, the receipt's `Trade` event parsed for the real output |
| Swap quote | `src/lib/quote.ts` `localQuote` | **Done (M2)** — the V4 Quoter behind `GET /api/tokens/[address]/quote`; the approximation stays for the mock source |
| Wallet balances | `src/hooks/useTokenBalance.ts` | **Done (M2)** — batched ERC-20 `balanceOf` reads for the quote asset and the pair token |
| Suit holder check | `src/lib/suits.ts` | **Done (M2)** — live `balanceOf` when `NEXT_PUBLIC_SUITS_NFT_ADDRESS` is set; the mock flag now defaults to "not a holder" |
| Watchlist / votes persistence | `src/lib/social/store.ts`, `/api/me/*` | **Done (M4)** — Sign-In with Ethereum opens an HttpOnly session cookie; the watchlist and the votes live in the market store, so one wallet sees the same lists on every device. The demo source still keeps them in `localStorage` |
| Top traders board | `src/app/traders`, `/api/traders` | **Done (M4)** — the last 24 hours of `market.swaps` ranked by USD volume or by trade count, 50 wallets, cached a minute |
| Launchpad links for untradeable pools | `src/lib/chain.ts` | M3 — Bags dapp URL |

Execution is off until `NEXT_PUBLIC_SVROUTER_ADDRESS` names a deployed router; the quote route
still answers, so every number on the panel is real before the deploy. `scripts/fork/` proves
the whole path against a local anvil fork in the meantime — see `scripts/README.md`.

## Layout

```
src/app            routes, layout, global CSS (design tokens)
src/components     UI, one file per handoff component group
src/context        Providers (wagmi, query, RainbowKit theme), AppState, DataSource
src/hooks          breakpoint, data queries, balances
src/lib            types, formatting, market filters, chain, wagmi, SVRouter swap, quote math
src/lib/chain      the reader: HyperSync log source, decode, fold, onchain metadata and Chainlink prices, store writes
src/lib/data       seed data, mock source, Envio source, local watch store
src/lib/db         Db interface (postgres driver, PGlite in tests), migrations
src/lib/holders    the top-holder builder: coverage, due list, transfer fold, balance store
src/lib/launch     the instant launchpad: ABI and address, stores, upload rules, Filebase, form arithmetic; wallet writes in src/lib/launch.ts
src/lib/sync       writers, cursor/lease state, the job runner, retention, nightly
src/lib/market     MarketBackend: the store implementation (the only one now)
src/lib/seed       the resumable one-off loader
scripts            migrate, smoke, seed, parity (laptop, session pooler)
supabase           migrations for the market schema
```
