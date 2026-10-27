# Security review: MaxLong Markets frontend

Review of this repository (the Next.js app, its API route handlers, the chain reader, the top-holder builder, the
launch upload path and the Supabase migrations) as of 27 Oct 2026, commit `13e040b` plus the fix in this commit.
It is a written self-review by the developer, not a third-party audit. Nothing in this system has been audited.
The contracts the app calls (`SVRouter`, `SVLaunchpad`) are reviewed in their own repository.

## 1. Scope

Read:

- Every route handler under `src/app/api` (21 files) and the helpers in `src/app/api/_lib`.
- The libraries they call: `src/lib/session` (SIWE and the cookie), `src/lib/social` (store, rate limits, counts
  cache), `src/lib/launch` (fields, image, Filebase, uploads, clean-up, gateway), `src/lib/logos/resolve.ts`,
  `src/lib/quote`, `src/lib/market`, `src/lib/sync/state.ts`, the lease and error paths of `src/lib/chain/run.ts`
  and `src/lib/holders/run.ts`, the HyperSync source's auth and error strings, `src/lib/db/client.ts`.
- The browser's wallet path: `src/lib/swap.ts`, `src/lib/swap/permit.ts`, `src/lib/chain.ts` (router address and
  browser RPC list), `src/lib/suits.ts`, and the places user-supplied launch text is rendered
  (`src/components/ActivityTabs.tsx`, `src/components/TokenFacts.tsx`).
- Every dynamic SQL string in `src` and `scripts` (grep for interpolated `query`/`exec` text), `.env.example`,
  `next.config.ts`, `vercel.json`, `.gitignore`.

Ran:

| Check | Result |
|---|---|
| `npm test` (vitest) | 130 files, 1,640 tests, all passing, 63 s (1,639 before the test added here) |
| `npm run lint` | 0 problems in tracked code; 28 `no-require-imports` errors, all in `.chain/`, a local scratch folder that is git-excluded and never committed |
| `npm audit --omit=dev` | 19 advisories: 1 critical, 11 high, 7 moderate (see F-2 and F-3) |
| Secret grep over every tracked file | no credentials. Matches were event topics, pool ids, a fake `postgres://user:sup3rSecret@` URL in a test, and anvil's published test key 0 in the local fork harness |

Not run: `npm run build` against production variables, any call to production, HyperSync, Filebase or a paid RPC.

## 2. Threat model

Assets:

- Users' tokens. The app never holds them, but it builds the swap and launch transactions the user signs.
- The Postgres `market` schema: market data every page reads, and each wallet's watchlist and votes.
- Server secrets: `DATABASE_URL`, `CRON_SECRET`, `SESSION_SECRET`, `HYPERSYNC_API_TOKEN`, the Filebase keys, the paid
  RPC URLs.
- Budgets: HyperSync requests, the public RPC's 40 calls per second per address, Filebase storage, function time.

Actors:

| Actor | Can do | Must not be able to |
|---|---|---|
| Visitor | read every public route, request quotes and logos | write anything, reach internal hosts, run up costs without bound |
| Signed-in wallet | star tokens, vote, upload a launch image within limits | act as another wallet, exceed per-wallet caps |
| Hostile token or pool | choose its `name`, `symbol`, `logo()`, `tokenURI()`, metadata JSON, hook | inject script, steer server fetches inward, break the reader's fold |
| Bot or scraper | send any request at any rate | stop the chain reader, exhaust memory, poison the CDN |
| Vercel Cron | call the three internal routes with the bearer secret | run two overlapping folds |
| Owner / ops wallet | owns the contracts on chain | (out of scope here; see the contracts repo) |

Trust boundaries: the browser and the API (everything in a request is untrusted); the API and chain data (token
contracts and metadata are attacker-chosen); the API and outside hosts (gateways, DexScreener, Filebase); the cron
routes and the database (one writer per job, enforced by a lease). The deployment itself (Vercel project, its
environment variables) is trusted: the browser signs what the quote route returns.

## 3. Controls in place

| Control | Where | What it prevents |
|---|---|---|
| SIWE: domain, chain id 4663, version 1, nonce, mandatory expiry, not-before, signature (EOA offline, EIP-1271/6492 via RPC with 5 s timeout) | `src/lib/session/siwe.ts:17` `verifySiwe` | signing in with a message meant for another site, chain or session; an unbounded replay window |
| Nonce: 16 CSPRNG bytes, HMAC-sealed in a 10-minute cookie, spent on success | `src/lib/session/cookie.ts:58` `newNonce`, `src/app/api/session/route.ts:71` `spendNonce` | guessable nonces (viem's `generateSiweNonce` is `Math.random`); replay of a captured sign-in into a second session |
| Session: `base64url(json).hmac-sha256`, timing-safe compare, lowercase-address check, 7-day `exp` inside the MAC; secret must be 32+ chars | `src/lib/session/cookie.ts:44` `verifySession`, `:75` `sessionSecret` | forged or extended sessions; a weak or empty key silently enabling sign-in |
| Cookies `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production; logout clears both | `src/app/api/_lib/session.ts:79` `setCookie`; `DELETE /api/session` | script access to the session; cross-site POST/PUT/DELETE carrying it |
| Wallet identity from the cookie only; `/api/me/*` never reads an address from the body | `src/app/api/_lib/session.ts:71` `requireSession`; `src/app/api/me/**` | writing another wallet's watchlist or votes |
| Per-wallet write budget 60/min; pre-auth per-IP budget 20/min for nonce + sign-in; upload per-IP 10/min; all maps capped at 10,000 keys | `src/lib/social/rateLimit.ts:81-91` | a runaway client; memory growth from distinct keys |
| Per-wallet row caps (409 `WalletCapError`) | `src/lib/social/store.ts:37` | one wallet filling the tables |
| Cron routes: `Bearer CRON_SECRET`, constant-time compare, refuse when unset | `src/app/api/_lib/cron.ts:4` | anyone triggering a sync, a holder build or the nightly |
| Lease per job, one conditional `UPDATE`, lease equal to `maxDuration` (300 s) | `src/lib/sync/state.ts:32` `acquireLease`; `src/app/api/internal/sync/route.ts:43` | two invocations folding the same block range (candle volume and running totals are additive) |
| Upload: session, both budgets, the launchpad's own `isAllowedLauncher` read (a failed read refuses), multipart only, body counted and cut at 2.2 MB, image <= 2 MiB, magic bytes, sharp must agree on the format, 50 MP input cap, one frame re-encoded to 512x512 WebP, SVG refused | `src/app/api/launch/upload/route.ts:39,91`; `src/lib/launch/image.ts:22,35` | oversized bodies, polyglots, SVG script, EXIF leaks, pixel bombs, non-holders pinning files |
| Upload text: byte limits matching the contract, control, bidi and zero-width characters refused, links rebuilt as `https://x.com/<handle>` / `https://t.me/<name>`, website must be `https:` | `src/lib/launch/fields.ts:155` `validateFields` | spoofed names, `javascript:` links, look-alike tickers |
| Persistent upload limits 5/hour, 20/day, recounted under a per-wallet advisory lock | `src/lib/launch/uploads.ts:38` `recordUpload` | parallel uploads racing past the limit |
| Object keys are SHA-256 of content; CIDs must match `Qm…`/`b…` shapes | `src/app/api/launch/upload/route.ts:77`; `src/lib/launch/filebase.ts:14` | path injection into the bucket; a hostile header landing in metadata |
| Launch links copied only from an upload by the launch's own creator | `src/lib/launch/store.ts:62` `attachUploads` | one creator borrowing another's image and links |
| Orphan clean-up keyed to the reader's cursor, skipped when the reader is stale, re-checks before and after each delete | `src/lib/launch/cleanup.ts` | deleting the image of a launch the reader has not folded yet |
| Logo fetch: `https` on 443 only, no IP literals, no `localhost`/`.local`/`.internal`, re-checked on every redirect (max 3), 15 s and 25 s budgets, 2 MiB cap counted while streaming, raster types only, `nosniff` | `src/lib/logos/resolve.ts:208,241,271`; `src/app/api/tokens/[address]/logo/route.ts:49` | SSRF to metadata endpoints or loopback, redirect bounces inward, SVG script in this origin, slow-loris upstreams |
| Logo route refuses any query string; logo memo capped at 5,000 | `src/app/api/tokens/[address]/logo/route.ts:115`; `src/lib/logos/resolve.ts:375` | walking past the CDN into the gateways |
| In-process memo capped at 5,000 keys (added in this commit) | `src/lib/envio/cache.ts:11` | memory growth from caller-chosen addresses (F-1) |
| Address inputs: `^0x[0-9a-f]{40}$` after lowercasing; amounts `^\d+(\.\d+)?$` parsed to bigint; slippage integer 1..5000 bps; enums checked by value | `src/app/api/_lib/respond.ts:8`; `src/app/api/tokens/[address]/quote/route.ts:27`; `src/lib/quote/math.ts` | malformed input reaching SQL or the Quoter; float amounts |
| Parameterised SQL everywhere; the only interpolated text is code constants (column names, fixed `ORDER BY` from a two-value map, `LIMIT` constants) | `src/lib/db/client.ts:70`; `src/lib/sync/state.ts:69` `saveCursors`; `src/lib/social/store.ts:89` `TRADERS_ORDER` | SQL injection |
| Errors answer fixed strings; logs carry name, code and message only, never driver objects, RPC URLs or signatures | `src/app/api/_lib/respond.ts:32` `failure`; `src/app/api/session/route.ts:136` | leaking connection strings, queries or keys |
| Cache headers: public market reads `s-maxage` 10-60 s; every per-wallet answer, error, quote and health answer `no-store` | `src/app/api/_lib/respond.ts` | one wallet's data or an error cached at the edge |
| Swap: Permit2 `PermitTransferFrom` for the exact `amountIn`, spender = router, random 256-bit nonce, 20-minute deadline; `amountIn` and `amountOutMin` checked as non-zero uint128; `Trade` event read only from the router's address and the user | `src/lib/swap.ts:93,187`; `src/lib/swap/permit.ts:32` | over-broad signatures, a zero minimum, reporting another log's amounts |
| Router and launchpad addresses from build-time env; malformed means "not live" | `src/lib/chain.ts`; `src/lib/launch/address.ts` | signing against a mistyped address |
| JSON-LD escaped (`<`, `>`, `&`) | `src/components/TokenFacts.tsx:63` | a token name breaking out of the script tag |

## 4. Findings

| ID | Severity | Title | Where | What could go wrong | Status |
|---|---|---|---|---|---|
| F-1 | Medium | In-process memo had no key cap | `src/lib/envio/cache.ts` | `candles`, `trades`, `holders` and the quote route's pool-key lookup memoise by a caller-chosen address and expired entries were never removed, so a client walking random valid addresses grew a function instance's memory without bound | Fixed in this commit: 5,000-key cap, expired idle entries swept first, then the oldest idle one; test in `src/lib/envio/cache.test.ts` |
| F-2 | High | `next` 16.3.5 is inside the range of current Next.js advisories (one critical) | `package.json` | `npm audit` lists image-optimization SSRF and RCE, cache poisoning and a Server Actions DoS for 16.0.0-16.4.0. The app uses `next/image` (`src/components/ui.tsx`) with a local source and no `remotePatterns`, and has no `next/og`, `"use cache"` or Server Actions, so most do not apply, but the image ones may | Open: upgrade to `next@16.4.3` or later and redeploy; not done here because it changes the framework under a live client deployment |
| F-3 | Low | Transitive advisories in the WalletConnect / Reown tree | `@walletconnect/ethereum-provider` 2.21.1 and its deps (`ws`, `zod`, `decode-uri-component`, `query-string`), plus `source-map-js` | DoS-class issues in browser-side or build-time code; none sits on a server route | Open: move to `@walletconnect/ethereum-provider` 2.26 when RainbowKit supports it; `npm audit fix` covers `source-map-js` |
| F-4 | Low | No security headers | `next.config.ts` | No `Content-Security-Policy`, `frame-ancestors` / `X-Frame-Options` or `Referrer-Policy`, so the trade panel and launch form can be framed by another site (clickjacking a wallet prompt still needs the user to confirm in the wallet) | Open: add `headers()` with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, then a CSP tested against RainbowKit and WalletConnect |
| F-5 | Low | Logo SSRF guard checks the hostname, not the resolved address | `src/lib/logos/resolve.ts:208` | A hostile token can name `https://<public name that resolves to 10.x or 169.254.x>`. Limited by https-on-443 only, raster-only answers, 2 MiB cap and no body returned unless it is an image | Open: resolve the host and refuse private, loopback and link-local results (or fetch through an agent with a lookup hook); accepted for now on Vercel, where no internal https service is known to be reachable |
| F-6 | Low | Public quote route has no rate limit | `src/app/api/tokens/[address]/quote/route.ts` | Each request is two unmetered `eth_call`s on the public RPC from Vercel's egress, answered `no-store`, so a bot can spend the same per-address budget the server's other reads use | Open: add a per-IP budget like `allowClient` (about 60/min), keeping the debounced UI well inside it |
| F-7 | Low | Browser signs the quote route's call block as returned | `src/lib/swap.ts:187` | The pool key, `tokenIn` and `amountOutMin` come from the server. A compromised deployment could send a 1-wei minimum or another pool. The Permit2 amount, token and spender are shown by the wallet, and the router enforces a non-zero minimum | Open: in the panel, check `tokenIn`/`tokenOut` against the pair and recompute `amountOutMin` from the displayed amount and slippage before signing |
| F-8 | Low | Spent-nonce set and rate limits are per serverless instance | `src/app/api/session/route.ts:44`; `src/lib/social/rateLimit.ts` | A captured sign-in POST replayed to another instance within 10 minutes opens a second session (whoever can capture it can already read its `Set-Cookie`); the true rate ceiling is the cap times live instances | Accepted: bounds a runaway client, not a determined attacker; the recommendation is a shared store (Postgres or Redis) |
| F-9 | Low | Stateless sessions cannot be revoked | `src/lib/session/cookie.ts`; `DELETE /api/session` | Logout clears this browser only; a copied cookie stays valid for up to 7 days. Rotating `SESSION_SECRET` revokes all | Accepted: the session can only edit a watchlist and votes; no funds or contract calls hang off it |
| F-10 | Informational | `SESSION_DOMAIN` unset falls back to the `Host` header | `src/app/api/session/route.ts:41` | Correct on Vercel, which controls `Host`; behind another proxy a forged `Host` would make the domain check a no-op | Open: set `SESSION_DOMAIN=www.maxlong.markets` in production |
| F-11 | Informational | Client IP from `x-forwarded-for` | `src/app/api/_lib/session.ts:45` | Correct on Vercel, which overwrites the header; self-hosted without a proxy every caller shares one bucket, behind a naive proxy the key is spoofable | Accepted: documented in code; Vercel is the only deployment |
| F-12 | Informational | `NEXT_PUBLIC_RPC_URL` ships in the bundle | `src/lib/chain.ts:15`; `.env.example` | The paid backup RPC's key is readable by anyone | Accepted: it is a browser backup by design; `.env.example` says to restrict the key by domain at the provider |
| F-13 | Informational | `/api/health` is public and detailed | `src/app/api/health/route.ts`; `src/lib/market/dbBackend.ts` | It shows job ages, last error strings, RPC hostnames and the lengths (never values) of the Filebase settings | Accepted: it is the designed way to see the reader's state; error strings are fixed phrases with no URLs or keys |
| F-14 | Informational | Unlimited ERC-20 approval to Permit2 | `src/lib/swap.ts:205` | `approve(Permit2, maxUint256)` on the first trade of a token | Accepted: Uniswap's standard pattern; Permit2's signature transfer still needs a fresh per-trade signature naming the router and amount |
| F-15 | Informational | Router address check does not verify the checksum | `src/lib/chain.ts:87` | A mistyped mixed-case `NEXT_PUBLIC_SVROUTER_ADDRESS` would be accepted (the launchpad address uses viem's strict check) | Open: use `isAddress(value, { strict: true })` as `src/lib/launch/address.ts` does |
| F-16 | Informational | No CSRF token on cookie-authenticated writes | `/api/me/*`, `/api/launch/upload` | Cross-site requests do not carry a `SameSite=Lax` cookie on POST/PUT/DELETE; a compromised sibling subdomain would | Accepted: Lax plus JSON or multipart bodies is the control; the worst outcome is a starred token or a vote |

## 5. Reporting

Report a vulnerability privately through a GitHub security advisory on
[maxlong-markets/suitventures-markets-frontend](https://github.com/maxlong-markets/suitventures-markets-frontend/security/advisories/new).
