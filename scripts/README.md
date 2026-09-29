# Scripts

The four database scripts run from the repo root through `node --env-file-if-exists=.env.local --conditions=react-server --import tsx`
(see `package.json`). They read `DATABASE_URL_DIRECT`, the Supabase session pooler on port 5432, never the
app's `DATABASE_URL`. Never paste a connection string into a terminal, a chat, a commit or this file: it
lives in `.env.local` only.

| Command | What it does |
|---|---|
| `npm run db:migrate` | Applies every `supabase/migrations/*.sql` not yet recorded in `market.schema_migrations`, in filename order, and prints the names applied. |
| `npm run db:reset-swaps` | Refuses while a seed is running (`.seed/seed.lock` names a live pid — stop it first), else truncates `market.swaps` and rewinds `.seed/checkpoint.json` to redo the swaps phase (phase `"swaps"`, ranges cleared, `"swaps"` dropped from `done`, `startedAt` kept), only if the checkpoint exists. Prints the row count before and after and the checkpoint phase. Needs `DATABASE_URL_DIRECT`. Used when the retention rule or the range layout changes. |
| `npm run db:smoke` | Round-trips COPY, a query, a rolled-back transaction, and one `upsertTokens` with a hostile token name (quotes, braces, a backslash, a comma) inside a transaction that rolls back; prints `ok` only when every round trip matched. Needs the migration applied, so run it after `db:migrate`, and again after changing `.env.local`. |
| `npm run seed` | The one-off load from Envio: quotes, tokens, pools, then swaps, candles and balances by id ranges with three workers at 200 queries a minute, then the finish phase (top 100 holders per token, listed pools, every pool's `synced_to` watermark and the sync cursors at the seed's start minus 3600 s, an hour of slack for the indexer's own lag; none of them is ever lowered). About eight hours. |
| `npm run db:parity` | Loads `pairs("all")` and `pairs("launchpad")` through both backends and prints every token missing on either side, every field differing by more than 0.1 % (numbers) or at all (strings), then the counts. |
| `npm run launch:currencies -- --out <path>` | Writes the launchpad's deploy config for the contracts repo's `script/config/launch-currencies.json`, in the schema its deploy script reads: `minUsd` 5,000, `maxUsd` 10,000,000, `creationFee` `"0"`, then 54 currencies from `quotes.json`, each `address, symbol, decimals, priceSource, chainlinkProxy, chainlinkDecimals, referenceUsdPrice`, with only USDG `pinned` and every `referenceUsdPrice` `"0"` until filled in. Refuses to overwrite an existing file without `--force`, so the 29 reference prices filled in by hand are never lost. Reads no environment. |

Instant launchpad rollout, in this order:

1. Run `npm run db:migrate` against production before pushing. Without the launch tables `/api/health` answers 503
   and logos across the whole site fail, because every logo lookup reads `market.launches`.
2. Before rollout, run `EXPLAIN (ANALYZE, BUFFERS)` in production on the pairs query for both scopes, `all` and
   `launchpad`, and confirm the new order uses the `pools_activity` index.
3. Set `NEXT_PUBLIC_LAUNCHPAD_ADDRESS` only after the contract is deployed.
4. Set `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY` and `FILEBASE_BUCKET`, all required, and optionally
   `FILEBASE_GATEWAY_URL`, which takes an https origin only.

Seed, on a laptop that must not sleep:

    caffeinate -i npm run seed

It prints one line per page: `swaps r2 pages=1234 rows=1234000 queries=1240 elapsed=372s`. Progress is
checkpointed to `.seed/checkpoint.json` at the start of every phase and after every page. If it stops for any
reason, a resume is the normal path and needs nothing: run the same command again and it continues at the saved
phase and range cursors, re-reading at most one page per range through the idempotent writers. Keep the worker
count (3 in `seed.mts`) unchanged between a seed's start and its finish: the checkpoint's range keys are positional.

Starting from scratch needs empty market tables, not just a deleted checkpoint: the swaps, candles and balances
phases load with COPY, which has no `on conflict`, so a fresh run over rows from an earlier attempt stops on the
first duplicate key. A fresh start is, in the Supabase SQL editor,

    truncate market.swaps, market.candles, market.token_balances, market.holder_refresh

Reset the sync state in the same step, because its cursors and head-block mark never move backwards on their
own: `update market.sync_state set cursor = 0, cursor2 = 0, cursor_text = '', phase = '', head_block = 0`,
with every cron paused until the seed finishes (three of them since the top-holder builder shipped:
`vercel.json`).

(quotes, tokens and pools are upserted and may stay), then delete `.seed/checkpoint.json` and run the seed again.

Never run the seed's `balances` or `finish` phases against a database the top-holder builder owns: both write
Envio's stale top-N holder rows over the exact balance maps the builder folds from the chain, and neither
touches `market.holder_refresh`, so every overwritten list still reads as `ready` and nothing ever rebuilds it.

Run `npm run db:parity` once the sync has run for an hour (rollout step R5) and again a day after the flip.
Expected differences: tokens that traded after the last sync cycle (a field difference or a token missing on
either side), and `missing on Envio` lines for tokens beyond M1's recovery window (its 1000-candidate, 7-day
query), which the store lists anyway. Anything else is a defect.

## Chain reader scripts

Two one-off scripts around the chain reader (`src/lib/chain`, Task 6):
`scripts/chain/gapfill-candles.mts` and `scripts/chain/catchup.mts`.

Run the gap-fill first, over the trades already in `market.swaps`, then the catch-up, and give the
gap-fill a `--before` at or below the timestamp the catch-up will start from. A bucket the gap-fill
writes above that line is one the
replay later adds its trades onto a second time, inflating that candle's volume and trade count.
Both take the same `chain` lease the cron takes, so neither can run beside the other or beside the
cron. Run both while `CRON_SECRET` is unset, so nothing else is writing.

| Command | What it does |
|---|---|
| `npm run chain:gapfill -- --before <unix> [--interval h1\|d1]` | Builds `h1` and `d1` candles from the trades already in `market.swaps`, for the pools whose candles the frozen indexer's copy never reached. Fills only buckets lying wholly inside the stored trade window and wholly before `--before`, so no candle is ever built from partial data, and inserts on-conflict-do-nothing so a copied candle is never overwritten. Safe to re-run. Needs `DATABASE_URL_DIRECT`. |
| `npm run chain:catchup -- --from-ts <unix> [--force-rewind] [--max-span <n>] [--max-requests <n>] [--dry-run]` | Seeds the `chain` cursor and replays the PoolManager's events to the chain's head in one pass, instead of the cron's rolling 50-second window. Deletes the candles at or after the start first, because the replay rebuilds them exactly. Safe to stop and restart: the cursor only moves inside a committed transaction, and a restart resumes rather than rewinding. Needs `DATABASE_URL_DIRECT` (falls back to `DATABASE_URL` with a printed warning if that is not set — a multi-hour run should not sit on the pooler's two-minute statement timeout). |
| `npm run chain:catchup -- --release-lease [--yes]` | Reports who holds the `chain` lease and until when. Clears it outright if it is already expired; needs `--yes` to force-clear a live one. The escape hatch for a run that died without releasing it. |

`--from-ts` is floored to the UTC midnight at or before it, which is a bucket boundary for all five
candle intervals at once, so no half-counted bucket survives the delete. It is never accepted
earlier than the earliest real pool baseline, and no flag on the command line lifts that bound:
daily candles reach back further than the five-day trade window, so replaying from before the
baseline would delete history that only a full replay from the chain's start could rebuild. A
deliberate full rebuild means editing the script, not passing a flag.

`--force-rewind` only lowers an already-advanced cursor and redoes the candle delete on a re-run.
`--dry-run` reports the start block it found, how many candles the delete would remove and what the
cursor would become, then exits having written nothing; it re-reads both before exiting and fails if
either moved. Expect roughly 3.9 million blocks, about 1,900 requests and three to five hours for a
catch-up from 17 September 2026, dominated by per-request latency rather than the rate limit.

## Fork scripts (M2 trading)

Three scripts prove the whole trading path on a local anvil fork of Robinhood Chain, without
touching mainnet and without waiting on the SVRouter deploy. They need Foundry
(https://getfoundry.sh) and the contracts repo checked out beside this one
(`../SuitVenturesMarket-contracts`, or set `CONTRACTS_DIR`).

| Command | What it does |
|---|---|
| `npm run fork:anvil` | Starts `anvil --fork-url <public RPC> --chain-id 4663` and prints the funded test accounts. Leave it running. `FORK_RPC_URL`, `FORK_PORT` and `FORK_BLOCK` override the defaults; the public endpoint keeps only about 80 minutes of state, so an old `FORK_BLOCK` will not serve. |
| `npm run fork:deploy` | Runs the contracts repo's `script/Deploy.s.sol` against that anvil with the spec's Universal Router and Permit2, reads the router address out of forge's broadcast log, and writes `.env.fork` with `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_SVROUTER_ADDRESS` and a funded key. |
| `npm run fork:e2e` | A real buy and a real sell on AI/NVDA and MARIO/NVDA through the app's own modules — `priceSwap` over the V4 Quoter for the numbers, `executeSwap` for the Permit2 signature and the `swapExactIn` call. Asserts every `Trade` event's `amountOut` is at least the `amountOutMin` the quote signed for, that `fee` is exactly 0.5 % of the input (floored, no holder discount — the fork deploy leaves `SUITS_NFT` unset), and that `holderRate` is `false`; exits non-zero on any failed assertion. |

Run them in that order, `fork:anvil` in its own shell. `fork:e2e` reads `.env.local` as well,
because it resolves pool keys through the market backend (`getBackend()`), which needs either
`DATABASE_URL` or the `ENVIO_GRAPHQL_URL` / `ENVIO_GRAPHQL_KEY` pair, whichever backend is
configured there; `.env.fork` is loaded second so the fork's RPC and router win over anything
`.env.local` sets.

`.env.fork` is git-ignored and never carries a real key: the only key in it is anvil's own
published test account #0, which is public knowledge and funded only on the local fork. Both
scripts refuse to broadcast to anything but a localhost RPC, and both check the node reports
chain id 4663 before they sign anything.

The e2e funds the test wallet by writing each token's balance mapping directly (forge's `deal`
trick, done from viem): `eth_createAccessList` on a `balanceOf` call reports exactly which
storage slot the token touched, `anvil_setStorageAt` writes it, and a read-back confirms the
slot was not packed with anything else. A fixed small-slot guess does not work on this chain —
NVDA, AI and MARIO are all beacon-proxied, not plain storage — which is why the harness asks the
EVM instead of computing a candidate slot by hand.

Two more things this chain's real state costs you, both proven while building this harness and
both handled by the scripts, not by the person running them:

- **A ticker is not a token.** More than one on-chain token can answer to "AI"; the e2e resolves
  each pool by the token's own contract address (`pair(id)`) and then double-checks the pool id,
  never by searching a ticker/quote pair.
- **anvil's own test accounts are not blank on this chain.** Every "test test test … junk"
  address already carries a live EIP-7702 delegation on Robinhood Chain mainnet — inherited by
  the fork like any other account state — which makes Permit2 take the smart-contract signature
  path and reject a plain ECDSA signature. The e2e clears it locally with `anvil_setCode` before
  it signs anything; the real chain is never touched.
