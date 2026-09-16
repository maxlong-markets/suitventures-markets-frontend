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

## Data layer

Everything the UI renders comes through `MarketsDataSource`
(`src/lib/types.ts`), never from literals.

- `MockDataSource` (`src/lib/data/mock.ts`) — deterministic, seeded with the
  handoff's eight real pairs plus eight placeholders. Default.
- `EnvioDataSource` (`src/lib/data/envio.ts`) — live data, read through this
  app's own route handlers. Select it with `NEXT_PUBLIC_DATA_SOURCE=envio`.

Live mode needs three variables:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_DATA_SOURCE` | `envio` |
| `ENVIO_GRAPHQL_URL` | the indexer's GraphQL endpoint |
| `ENVIO_GRAPHQL_KEY` | the endpoint API key from Envio Cloud's Security tab (not the HyperSync token) |

The last two are server-only: the route handlers under `src/app/api` are the
only Envio clients, and `EnvioDataSource` just fetches those routes. Both
sources share the swap math in `src/lib/quote.ts` — a constant-product
approximation until the v4 Quoter lands in M2.

`GET /api/health` reports indexer lag (chain head minus last processed block)
and which quote-asset USD prices are stale.

Watchlist and votes are browser-local in live mode
(`src/lib/data/localStore.ts`, `localStorage` keyed by wallet address): they do
not follow the wallet to another device, and vote counts read 0 until the
signed API lands in M2.

Two methods were added beyond the handoff interface: `votes(address)` (the
caller's current vote per token address) — see the comment in `types.ts`.

## Stubs still to wire (M2)

| Stub | Where | Real implementation |
|---|---|---|
| Swap execution | `src/lib/swap.ts` | SVRouter via wagmi `writeContract`, Permit2 + Universal Router v4 |
| Wallet balances | `src/hooks/useTokenBalance.ts` | ERC-20 `balanceOf` reads for quote and pair token |
| Suit holder check | `src/lib/suits.ts` | Live once `NEXT_PUBLIC_SUITS_NFT_ADDRESS` is set; mock flag until then |
| Watchlist / votes persistence | localStorage, in both sources | Route handlers keyed by address, authorised by the session signature |
| Launchpad links for untradeable pools | `src/lib/chain.ts` | Bags dapp URL |

## Layout

```
src/app            routes, layout, global CSS (design tokens)
src/components     UI, one file per handoff component group
src/context        Providers (wagmi, query, RainbowKit theme), AppState, DataSource
src/hooks          breakpoint, data queries, balances
src/lib            types, formatting, market filters, chain, wagmi, swap stub, quote math
src/lib/data       seed data, mock source, Envio source, local watch store
```
