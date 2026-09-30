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
into `market.launches` and `market.launch_fee_events`. A launched token lists from its launch block with the origin
`SV`, which the table, the origin chip and the token page all print as `SUITS`. A launched token keeps the SV origin,
but the badge follows the listed pool, so if another pool becomes the listed one the badge can differ. One nobody has
bought leaves the default table after the listing window below and returns with its first trade; its page stays up.
The Suits tab is fed by its own call, `GET /api/pairs?scope=sv`, which lists every launch newest first, bought or not
and listed or not. The launch page lists the connected wallet's own launches under the form, from the same list.
`POST /api/launch/upload` re-encodes a creator's image to a WebP and pins it and a metadata JSON on
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

### The launchpad end to end

This section follows one launch from the form to the nightly clean-up and names every endpoint it touches: the Next.js
routes, the cron jobs, the contract functions and events, and the outside services. It is read from the code on
`feat/instant-launchpad`, not from the design. The contract is `src/SVLaunchpad.sol` in the contracts repo, and the
browser's copy of its interface is `src/lib/launch/abi.ts`.

#### The parts and how they connect

```mermaid
flowchart LR
  subgraph Browser
    LF["/launch form"]
    TV["/t/address token page"]
    MK["/ markets, SUITS tab"]
    WAL["Wallet"]
  end
  subgraph App["Next.js on Vercel"]
    SES["/api/session and /api/session/nonce"]
    UPL["POST /api/launch/upload"]
    TOK["GET /api/tokens/address"]
    LOGO["GET /api/tokens/address/logo"]
    QUO["GET /api/tokens/address/quote"]
    PAIRS["GET /api/pairs"]
    HEALTH["GET /api/health"]
  end
  subgraph Cron["Vercel cron"]
    SYNC["/api/internal/sync every minute"]
    NIGHT["/api/internal/sync/nightly at 03:00 UTC"]
  end
  PG[("Postgres, schema market")]
  FBS["Filebase S3 API"]
  GW["Filebase gateway and public IPFS gateways"]
  HS["HyperSync"]
  RPC["Chain RPC"]
  subgraph Chain["Robinhood Chain 4663"]
    LP["SVLaunchpad"]
    PM["Uniswap v4 PoolManager"]
    P2["Permit2"]
    SUITS["Suits NFT"]
    SVR["SVRouter"]
    UR["Universal Router"]
    CL["Chainlink feeds"]
  end

  LF --> SES
  LF --> UPL
  LF -- "your launches, scope=sv" --> PAIRS
  LF -- "settings and preview reads" --> LP
  WAL -- "launch, collectFees, claim, setPayout" --> LP
  WAL -- "approve the quote to Permit2" --> P2
  WAL -- "swapExactIn" --> SVR
  UPL -- "isAllowedLauncher" --> RPC
  UPL -- "PUT image and JSON" --> FBS
  UPL -- "launch_uploads" --> PG
  LP -- "balanceOf" --> SUITS
  LP -- "permitTransferFrom" --> P2
  LP -- "initialize, unlock, modifyLiquidity, swap" --> PM
  SVR -- "permitTransferFrom" --> P2
  SVR -- "execute" --> UR
  UR -- "swap" --> PM
  SYNC -- "PoolManager and launchpad logs" --> HS
  SYNC -- "token reads, prices, balances" --> RPC
  RPC --> CL
  RPC --> LP
  SYNC -- "applyFold" --> PG
  NIGHT -- "cursor block time" --> RPC
  NIGHT -- "HEAD and DELETE" --> FBS
  NIGHT --> PG
  TV --> TOK
  TV --> LOGO
  TV --> QUO
  MK -- "scope=sv on the SUITS tab" --> PAIRS
  TOK --> PG
  PAIRS --> PG
  LOGO --> PG
  LOGO --> GW
  QUO --> RPC
  HEALTH --> PG
  HEALTH --> RPC
  FBS -. "pins on IPFS" .-> GW
```

#### Launching a token

The form reads every contract setting live and never hard-codes a fee or a share. The upload runs its checks in a fixed
order, so a request that fails early costs nothing further. The launch itself is one transaction.

```mermaid
sequenceDiagram
  actor C as Creator
  participant F as /launch form
  participant W as Wallet
  participant S as Session routes
  participant U as Upload route
  participant DB as Postgres
  participant FB as Filebase S3
  participant L as SVLaunchpad
  participant N as Suits NFT
  participant P2 as Permit2
  participant PM as PoolManager

  C->>F: open /launch
  Note over F: no NEXT_PUBLIC_LAUNCHPAD_ADDRESS shows Not live yet
  F->>L: routerFeeBps, creatorShareBps, firstBuyCapBps, dailyLaunchLimit, hook
  F->>L: isAllowedLauncher and launchesToday for the wallet
  F->>L: currency for the picked quote
  F->>L: predictToken, then openingFor, 300 ms after the last edit
  C->>F: press Launch
  opt no session yet, normally signed when the wallet connects
    F->>S: GET /api/session/nonce
    S-->>F: nonce and a signed nonce cookie
    F->>W: sign the SIWE message
    F->>S: POST /api/session
    S-->>F: session cookie
  end
  F->>U: POST /api/launch/upload, multipart
  U->>U: session, wallet and IP budgets, configuration
  U->>L: isAllowedLauncher over the server RPC
  L->>N: balanceOf
  U->>U: body cap, fields, size, magic bytes
  U->>U: sharp re-encodes one 512 x 512 WebP
  U->>DB: this wallet's uploads in the last hour and day
  U->>FB: PUT launch/img/sha256.webp
  FB-->>U: image CID in x-amz-meta-cid
  U->>FB: PUT launch/meta/sha256.json
  FB-->>U: metadata CID
  U->>DB: insert launch_uploads under a wallet lock
  U-->>F: imageCid, metadataCid, metadataUri
  opt first buy plus creation fee above zero
    F->>W: approve Permit2 when the allowance is short
    F->>W: sign a PermitTransferFrom for the exact total
  end
  F->>L: simulate launch
  F->>W: send launch
  W->>L: launch with params, permit, signature
  L->>N: isAllowedLauncher reads balanceOf
  L->>P2: permitTransferFrom the total
  L->>L: deploy SVLaunchToken by CREATE2
  L->>PM: initialize the pool
  L->>PM: unlock
  PM->>L: unlockCallback
  L->>PM: modifyLiquidity mints the locked position
  L->>PM: swap, only for a first buy
  L->>PM: settle token and quote, take bought tokens to the creator
  L->>L: fees to the fee wallet, burn the unused supply
  L-->>W: Launched event in the receipt
  F->>F: read the token from this creator's Launched log
  F->>C: redirect to /t/token?launched=tx
```

#### Indexing the launch

The chain reader is the only writer of launch rows. It adds the launchpad as a second log selection in the same
HyperSync request, so a launch and its pool arrive in one batch and the pool is labelled SV before it is written.

```mermaid
sequenceDiagram
  participant V as Vercel cron
  participant R as /api/internal/sync
  participant DB as Postgres
  participant HS as HyperSync
  participant RPC as Chain RPC
  participant T as Token page
  participant A as GET /api/tokens/address

  V->>R: GET with Bearer CRON_SECRET
  R->>DB: take the chain lease, read the cursor
  loop one cycle every SYNC_INTERVAL_SEC
    R->>HS: PoolManager selection plus launchpad selection
    HS-->>R: Initialize, ModifyLiquidity, Swap, Launched, FeesCollected, PayoutChanged
    R->>R: decode by the emitting address
    R->>RPC: new token metadata and supply, Chainlink prices, holder balances
    R->>R: fold, a pool named by Launched becomes SV
    R->>DB: applyFold in one transaction
    Note over DB: pools, tokens, swaps, candles, launches, attach uploads, fee events, payouts, listing, cursor
  end
  T->>A: every 5 s for up to 5 minutes while launched is set
  A->>DB: the pair and its launch block
  A-->>T: 404 until the launch is folded, then the pair
```

What `applyFold` does with the launch rows, in order:

| Step | Writes |
|---|---|
| 1 | `insertLaunches`: one `market.launches` row per `Launched`, nothing on conflict |
| 2 | `attachUploads`: copies image CID, description and links from the creator's matching `launch_uploads` row, marks it `used` |
| 3 | `insertLaunchFees`: one `market.launch_fee_events` row per `FeesCollected` log |
| 4 | `applyPayouts`: moves `market.launches.payout`, only forward by block and log index |
| 5 | `svWindowClosedTokens` and `recomputeListedPools`: the listing, including SV launches whose window just closed |
| 6 | `saveCursors`: the block cursor, in the same transaction |

#### Trading after the launch

A launched pool is an ordinary hookless v4 pool, so trades go through the same path as every other pair.

```mermaid
sequenceDiagram
  actor B as Buyer
  participant P as Trade panel
  participant Q as GET quote route
  participant W as Wallet
  participant SR as SVRouter
  participant P2 as Permit2
  participant UR as Universal Router
  participant PM as PoolManager
  participant R as Chain reader
  participant DB as Postgres

  B->>P: enter an amount
  P->>Q: GET /api/tokens/address/quote
  Q->>Q: simulate the V4 Quoter over RPC
  Q-->>P: numbers and the call block
  P->>W: approve Permit2 when short, sign the permit
  W->>SR: swapExactIn
  SR->>P2: permitTransferFrom
  SR->>UR: execute with the amount after the router fee
  UR->>PM: swap on the launch pool
  R->>R: next cycle reads the Swap log from HyperSync
  R->>DB: swaps, candles, pool swap_count
  R->>DB: recompute the listed pool
  Note over DB: listable means traded, or SV and under 24 h old
```

| Listing rule | Value |
|---|---|
| An SV pool with no swaps stays listed for | 86,400 s |
| The per-cycle sweep looks back past a closed window for | 259,200 s |
| The nightly run recomputes the listing of | every token |

#### Fees, claims and the payout

Anyone may call `collectFees`. The split uses the creator share fixed at launch. A transfer that fails is credited to
`owed` and taken later with `claim`.

```mermaid
sequenceDiagram
  participant FP as Fee panel
  participant W as Wallet
  participant L as SVLaunchpad
  participant PM as PoolManager
  participant PAY as Payout
  participant FW as Fee wallet
  participant R as Chain reader
  participant DB as Postgres

  FP->>L: uncollectedFees and owed, every 30 s
  FP->>W: Collect
  W->>L: collectFees for the token
  L->>PM: unlock
  PM->>L: unlockCallback
  L->>PM: modifyLiquidity with a zero delta
  L->>PM: take token and quote fees, measured by balance
  L->>PAY: the creator share
  L->>FW: the rest
  Note over L,FW: a refused transfer is credited to owed
  L-->>R: FeesCollected
  R->>DB: one launch_fee_events row
  FP->>W: Claim to an address
  W->>L: claim for a currency, to an address
  PAY->>L: setPayout for the token
  L-->>R: PayoutChanged
  R->>DB: update the launch payout
```

The fee totals on the token page are never stored. `GET /api/tokens/[address]` sums `market.launch_fee_events` when it
builds the `launch` block.

#### Logos and hiding a launch

A token launched here answers only from its own row. A launch row never falls through to the older logo sources.

```mermaid
sequenceDiagram
  participant B as Browser
  participant CDN as Vercel CDN
  participant LR as Logo route
  participant DB as Postgres
  participant GW as IPFS gateways

  B->>CDN: GET /api/tokens/address/logo
  CDN->>LR: on a miss
  LR->>LR: per-process memo, 1 h for a launch
  LR->>DB: image_cid, metadata_uri, hidden from market.launches
  alt the read failed
    LR-->>B: 404 logo unavailable, held 60 s
  else hidden is true
    LR-->>B: 404 no logo, held 1 h
  else the row has an image CID
    LR->>GW: Filebase gateway, then pinata, dweb.link, w3s.link, ipfs.io
    GW-->>LR: the WebP
    LR-->>B: the image, held 1 h
  else the row has only a metadata URI
    LR->>GW: the metadata JSON, then its image
  else no launch row
    LR->>LR: logo, tokenURI, then DexScreener, as before
  end
```

| Logo number | Value |
|---|---|
| Memo for a launch logo, hit or hidden | 3,600 s |
| Browser and CDN hold for a launch logo | 3,600 s |
| Hold for a failed lookup | 60 s |
| Whole lookup budget | 25,000 ms |
| Largest image proxied | 2 MB |

Setting `hidden` also blanks the image CID, description and links in the `launch` block of `GET /api/tokens/[address]`.

#### Nightly clean-up of unused uploads

The `uploads` phase runs between `holders` and `probe`. Its cut-off comes from the block the reader has reached, not the
wall clock, so an upload whose launch is not yet folded is never deleted.

```mermaid
sequenceDiagram
  participant V as Vercel cron
  participant N as /api/internal/sync/nightly
  participant DB as Postgres
  participant RPC as Chain RPC
  participant FB as Filebase S3

  V->>N: GET at 03:00 UTC with Bearer CRON_SECRET
  N->>N: phases listed, prune, holders, uploads, probe
  alt Filebase names unset
    N->>N: skip as unconfigured
  else the reader has not succeeded for an hour
    N->>N: skip as reader-stale
  else ready
    N->>RPC: timestamp of the cursor block
    N->>N: cut-off is that time less 86,400 s less 1,200 s
    loop 200 pending or refused rows older than the cut-off
      N->>DB: does another row still need this CID
      N->>FB: HEAD the key for Last-Modified
      alt modified at or after the cut-off
        N->>N: keep the row
      else older
        N->>FB: DELETE the key, which unpins it
        N->>DB: mark the row deleted
      end
    end
  end
```

| Upload status | Meaning |
|---|---|
| `pending` | pinned, no launch folded yet |
| `refused` | pinned, then refused by the locked recount |
| `used` | the reader matched it to a launch |
| `deleted` | the nightly phase removed its objects |

#### Deploy and rollout

These are admin steps. The app never calls an owner setter.

```mermaid
sequenceDiagram
  actor K as Kobe
  participant DB as Postgres
  participant G as launch:currencies
  participant S as DeployLaunchpad script
  participant CL as Chainlink feeds
  participant L as SVLaunchpad
  participant O as OWNER
  participant V as Vercel

  K->>DB: npm run db:migrate, before pushing
  K->>DB: EXPLAIN the pairs query for both scopes
  K->>G: npm run launch:currencies with --out
  G-->>K: launch-currencies.json, reference prices filled by hand
  K->>S: forge script, dry run on an anvil fork first
  S->>CL: decimals and latestRoundData per chainlink row
  S->>L: deploy with the broadcaster as owner
  S->>L: setCurrency for every row
  S->>L: transferOwnership to OWNER
  O->>L: acceptOwnership
  K->>V: set NEXT_PUBLIC_LAUNCHPAD_ADDRESS and the Filebase names, redeploy
```

| Deploy script name | Use |
|---|---|
| `OWNER` | the final owner, who must call `acceptOwnership` |
| `FEE_WALLET` | receives the router fee, the creation fee and the platform fee share |
| `LAUNCHER_GATE` | the Suits NFT; zero lets anyone launch |
| `POOL_MANAGER` | optional, defaults to the chain's PoolManager |
| `PERMIT2` | optional, defaults to canonical Permit2 |
| `ALLOW_OTHER_ADDRESSES` | optional, `true` allows another PoolManager or Permit2 |

The script reads `script/config/launch-currencies.json`, refuses any chain but 4663, and prices and checks every row
before it broadcasts. The deployer key is passed to forge with `--account`, `--ledger` or `--interactive`, never
through the environment.

#### Every endpoint the launchpad touches

Next.js routes and pages:

| Endpoint | Method | Called by | Auth | Reads | Writes |
|---|---|---|---|---|---|
| `/launch` | page | creator | none to view | contract views through the wallet RPC, and `GET /api/pairs?scope=sv` for the connected wallet's own launches | nothing |
| `/t/[address]` | page | anyone, and the redirect with `?launched=<tx>` | none | the store through the backend | nothing |
| `/` with the SUITS origin chip | page | anyone | none | `GET /api/pairs?scope=sv` | nothing |
| `/api/session/nonce` | GET | the sign-in asked at wallet connect, or the form's fallback step | per-IP budget | nothing | nonce cookie, 10 minutes |
| `/api/session` | POST | the same, after the SIWE signature | nonce cookie, SIWE signature | nonce cookie | session cookie, 7 days |
| `/api/session` | GET | app | session cookie | session cookie | nothing |
| `/api/session` | DELETE | sign out | none | nothing | clears both cookies |
| `/api/launch/upload` | POST | form, on Launch | session cookie, 60 writes a minute per wallet, 10 uploads a minute per IP, 5 an hour and 20 a day per wallet | `isAllowedLauncher`, `market.launch_uploads` | Filebase PUT twice, one `market.launch_uploads` row |
| `/api/tokens/[address]` | GET | token page, every 5 s after a launch | none, cached 30 s | `market.tokens`, `pools`, `launches`, `launch_fee_events`, `quotes` | nothing |
| `/api/tokens/[address]/logo` | GET | every logo on the site | none, no query string | `market.launches`, IPFS gateways | nothing |
| `/api/tokens/[address]/quote` | GET | trade panel | none | V4 Quoter over RPC, the store | nothing |
| `/api/pairs` | GET | markets table | none | the store, `scope=all` or `scope=launchpad`, the second now including SV | nothing |
| `/api/pairs?scope=sv` | GET | the SUITS chip on the markets table, and the launch page's list of the wallet's own launches | none, cached 30 s | `market.launches` with its tokens, pools and quotes: every launch newest first, at most 500, bought or not, listed or not, hidden ones included | nothing |
| `/api/health` | GET | monitors | none | the `launches` block, `sync.lastCycle.launchEvents` | nothing |
| `/api/internal/sync` | GET | Vercel cron, every minute | Bearer `CRON_SECRET` | HyperSync, chain RPC | every launch table, the listing, the cursor |
| `/api/internal/sync/nightly` | GET | Vercel cron, 03:00 UTC | Bearer `CRON_SECRET` | `market.sync_state`, `launch_uploads`, block time over RPC | Filebase HEAD and DELETE, `launch_uploads.status` |

Contract functions the app sends:

| Function | Who | Effect |
|---|---|---|
| `launch(p, permit, signature)` | a Suits holder | deploys the token, opens and funds the pool, optional first buy, emits `Launched` |
| `collectFees(token)` | anyone | pokes the position, splits the fees, emits `FeesCollected` |
| `claim(currency, to)` | anyone with `owed` | pays what a failed delivery left, no event |
| `setPayout(token, payout)` | the current payout | moves the payout, emits `PayoutChanged` |
| `approve(Permit2, max)` on the quote | creator or buyer | only when the allowance is short |
| `swapExactIn` on SVRouter | buyer | the ordinary trade path |

Contract views the app reads:

| View | Read by | When |
|---|---|---|
| `routerFeeBps`, `creatorShareBps`, `firstBuyCapBps`, `dailyLaunchLimit`, `hook` | form | every 30 s |
| `isAllowedLauncher(account)`, `launchesToday(account)` | form | every 30 s |
| `isAllowedLauncher(account)` | upload route | every upload |
| `currency(quote)` | form | every 30 s, and after a `PermitMismatch` |
| `predictToken(creator, salt, name, symbol)` | form | 300 ms after the last edit |
| `openingFor(token, quote, valuation)` | form | after `predictToken` |
| `uncollectedFees(token)` | fee panel | every 30 s |
| `owed(account, currency)` | fee panel | every 30 s, for the token and the quote |

In the ABI but not read by the app: `getLaunch`, `poolKeyOf`, `launchCount`, `feeWallet`, `launcherGate`,
`POOL_MANAGER`, `PERMIT2`.

Events:

| Event | Emitted by | Folded into |
|---|---|---|
| `Launched` | `launch` | `market.launches`, the pool and token become SV |
| `FeesCollected` | `collectFees` | `market.launch_fee_events` |
| `PayoutChanged` | `setPayout` | `market.launches.payout` |
| `FeeWalletChanged`, `RouterFeeChanged`, `CreatorShareChanged`, `FirstBuyCapChanged`, `DailyLaunchLimitChanged`, `LauncherGateChanged`, `HookChanged`, `CurrencyChanged` | owner setters and the constructor | not read by the reader |

Owner-only setters, admin work, never called by the app: `setFeeWallet`, `setRouterFee`, `setCreatorShare`,
`setFirstBuyCap`, `setDailyLaunchLimit`, `setLauncherGate`, `setHook`, `setCurrency`, and `transferOwnership` with
`acceptOwnership`. `renounceOwnership` always reverts.

Outside services:

| Service | Called by | Calls |
|---|---|---|
| Uniswap v4 PoolManager | `launch`, `collectFees` | `initialize`, `unlock`, then `modifyLiquidity`, `swap`, `sync`, `settle`, `take` inside the callback |
| Permit2 | `launch`, SVRouter | `permitTransferFrom`, a signature transfer |
| Suits NFT | `isAllowedLauncher` | `balanceOf` with a gas cap |
| SVRouter and Universal Router | trades after launch | `swapExactIn`, then `execute` |
| HyperSync | chain reader | one query a cycle, the launchpad selection filtered by address and the 3 activity topics |
| Chain RPC, `CHAIN_RPC_URL` then `CHAIN_RPC_FALLBACK_URL` | upload route, chain reader, nightly, health | `isAllowedLauncher`, token metadata and supply, holder balances, Chainlink prices, block time, chain head |
| Chain RPC, `ROBINHOOD_RPC_URL` | logo route | `logo` and `tokenURI` for tokens not launched here |
| Chainlink feeds | deploy script, chain reader | `decimals`, `latestRoundData` |
| Filebase S3 API | upload route, nightly | PUT, HEAD, DELETE on `FILEBASE_BUCKET`, the CID from `x-amz-meta-cid` |
| Filebase gateway, `FILEBASE_GATEWAY_URL` | logo route | the first of 5 gateways tried |

Postgres tables:

| Table | Written by | Read by |
|---|---|---|
| `market.launches` | chain reader, and `hidden` by hand | token route, logo route, health, `attachUploads`, pairs with `scope=sv` |
| `market.launch_fee_events` | chain reader | token route |
| `market.launch_uploads` | upload route, chain reader, nightly | upload route, nightly, health |
| `market.pools` | chain reader, origin SV from `Launched` | pairs, token route, listing |
| `market.tokens` | chain reader, origin SV and `listed_pool_id` | pairs, token route |
| `market.sync_state` | both cron jobs | nightly for the cursor and the reader's last success |

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
| Top traders board | `src/components/TradersBoard.tsx`, `/api/traders` | **Parked, 30 Sep 2026.** The Traders tab and the `/traders` page were removed: the board showed nothing, and its data is not available yet. The API, its store query and the board component stay dormant behind `TRADERS_BOARD`, so the tab can come back. Built in M4: the last 24 hours of `market.swaps` ranked by USD volume or by trade count, 50 wallets, cached a minute |
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
