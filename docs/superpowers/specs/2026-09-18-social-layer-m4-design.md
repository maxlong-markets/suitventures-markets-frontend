# Social layer (M4) — design

Status: Kobe said "go start on the next milestone" on 18 Sep 2026 (22:03 Manila). Due Sep 28.

## 1. What the milestone asks

README M4: "The top traders board ranks wallets by 24h volume and trade
count. A signed-in user maintains a watchlist and votes bullish or bearish
once per token, with counts on the table and token page, persisting across
sessions and devices for the same wallet." D35: tied to a connected wallet
through a signed message and stored in Supabase, the only data the app keeps
that is not on-chain.

What exists today: a wallet gate in `AppState` (`gate("star" | "vote")`) that
opens `SignModal`, which signs a plain message with a client-made nonce and
keeps `{ address, signature }` in memory only; a `/watchlist` page filtering
the table by stars; `VoteButtons` on the token page; bull/bear counts on the
table and header, hard-coded to `0` in both shapes; and `LocalWatchStore`,
which keeps watchlist and votes in the browser's `localStorage`. There is no
traders board.

So M4 is three things: a real sign-in that the server can verify, server-side
watchlists and votes with public counts, and the traders board.

## 2. Sign-in: SIWE with an HttpOnly session cookie

The existing modal already asks for a signature once per wallet per session;
it becomes a Sign-In with Ethereum (EIP-4361) flow the server verifies.

1. `GET /api/session/nonce` answers `{ nonce }` and sets `svm_nonce`, an
   HttpOnly, SameSite=Lax, 10-minute cookie carrying an HMAC of the nonce.
2. The client builds the message with viem's `createSiweMessage`
   (`domain` and `uri` from the page, `chainId` 4663, `version` "1",
   `statement` "Sign in to SuitVentures Markets", `expirationTime` now + 7
   days) and signs it with the wallet.
3. `POST /api/session` `{ message, signature }` verifies with viem's
   `verifySiweMessage` against a public client for chain 4663 (so a smart
   account signing through EIP-1271 also verifies), checks the domain, the
   chain, the expiry and that the nonce matches the `svm_nonce` cookie, then
   sets `svm_session`: HttpOnly, Secure in production, SameSite=Lax, 7 days,
   value `base64url(payload).base64url(hmac)` where payload is
   `{ address, iat, exp }` and the key is `SESSION_SECRET` (32 random bytes,
   a new Vercel variable). It clears `svm_nonce`.
4. `GET /api/session` answers `{ address }` or 401; `DELETE /api/session`
   clears the cookie.

The address in the cookie is lowercase and is the only identity the user
routes trust; the client never sends an address for user data. A wallet
switch in the browser invalidates the client's notion of the session (the
gate compares the connected address with the session's), which prompts a new
sign-in, as today.

`SESSION_SECRET` unset: the session routes answer 503 `{ error: "sessions
not configured" }` and the client keeps working read-only.

## 3. Watchlist and votes: stored in the market store

Two tables, new migration file (the original stays frozen):

```sql
create table market.watchlist (wallet text not null, token_id text not null, created_at int not null, primary key (wallet, token_id));
create table market.votes (wallet text not null, token_id text not null, dir text not null check (dir in ('bull','bear')), updated_at int not null, primary key (wallet, token_id));
create index votes_token on market.votes (token_id, dir);
```

Routes, all reading the wallet from `svm_session` (401 without it):

| Route | Does |
|---|---|
| `GET /api/me/watchlist` | `string[]` of token ids |
| `PUT /api/me/watchlist/{address}` | adds; `DELETE` removes; idempotent |
| `GET /api/me/votes` | `Record<tokenId, "bull" \| "bear">` |
| `POST /api/me/votes/{address}` `{ dir }` | the toggle the app already has: same direction clears, the other switches; answers `{ dir: "bull" \| "bear" \| null }` |

Public counts:

| Route | Does |
|---|---|
| `GET /api/votes?ids=a,b,…` (≤ 500 ids) | `Record<tokenId, { bull, bear }>`, cached 30 s |

The pairs route and the single-token route merge counts from the store when
`hasDb()`, so `TokenPair.bull` / `bear` are real on both backends; without a
database they stay `0`. A vote updates the counts optimistically in the
client as today and the next fetch reconciles.

Writes are cheap but bounded: at most 60 user writes a minute per wallet,
answered 429 beyond that, counted in process (M5 verifies rate limiting
under load properly).

`MarketsDataSource` loses the `address` and `signature` parameters of
`watchlist`, `setWatch`, `votes` and `vote`: the session cookie is the
identity. The Envio source calls the routes; the demo source keeps
`LocalWatchStore` unchanged. `AppState`'s gate keeps its shape; `completeSign`
now runs the SIWE flow (nonce, sign, post) and stores only `{ address }`.
Reads of the user's own lists happen only when the session says who they are
(`GET /api/session` on load), so a signed-in wallet sees its watchlist on any
device after signing in there.

## 4. Top traders board

`GET /api/traders?by=volume|trades` (default `volume`) answers the top 50
wallets over the last 24 hours from `market.swaps` (well inside the 10-day
window): `{ wallet, volumeUsd, trades, tokens }`, where `volumeUsd` is
`sum(amount_quote × quotes.usd_price)` through the pool's quote asset,
`trades` is the row count and `tokens` the distinct tokens traded. Cached
60 s. The indexer records `wallet` as the transaction sender (verified in
`handlers/poolManager.ts`), so routed trades count for the person, not the
router. Without a database the route answers 503 `{ error: "traders board
needs the market store" }` and the page says so plainly.

Page `/traders`: rank, wallet (short, Blockscout link), 24h volume in USD,
trades, tokens, with the two orderings as a toggle; a "Traders" link in the
top bar next to Watchlist.

## 5. Not in this milestone

Following other wallets, comments, notifications, vote history, per-wallet
profile pages, and rate limiting beyond the in-process cap.

## 6. Testing

| Layer | What |
|---|---|
| Session | nonce issue and single use; a valid SIWE message signed by a test key verifies and sets the cookie; wrong domain, wrong chain, expired, reused nonce, bad signature all fail; cookie tampering fails; `SESSION_SECRET` unset → 503 |
| Store | watchlist add/remove idempotent; vote toggle semantics; counts per token; PGlite |
| User routes | 401 without a session; each route with a valid cookie; the 60-a-minute cap |
| Counts merge | pairs and token routes carry real counts with a database, zeros without |
| Client | data source calls the routes; `AppState` sign-in flow with mocked wallet; optimistic vote and star as today |
| Traders | the query's ranking and USD conversion on PGlite; the route's 503 without a database; the page renders a board (DOM) |

Gates unchanged: `npm test`, `npx tsc --noEmit`, `npx eslint .` (zero
warnings), `npm run build`.

## 7. Verified facts

- `SignModal` signs `SuitVentures Markets wants you to sign in with {addr} ·
  Chain 4663 · Nonce {nonce}` with a client-made nonce; nothing verifies it
  today. viem 2.56 ships `createSiweMessage`, `parseSiweMessage` and
  `verifySiweMessage`.
- `market.quotes` carries `usd_price`; `market.swaps` carries `wallet`
  (transaction sender), `amount_quote`, `ts`, `pool_id`, `token_id`.
- The store is reachable from the routes only when `DATABASE_URL` is set,
  which the market-store switchover (runbook R4) does; until then the user
  routes answer 503 and the client stays read-only, so M4 ships behind that
  step.
