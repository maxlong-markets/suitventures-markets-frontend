# Chain Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Feed `market.*` from the Uniswap v4 PoolManager's own events, inside the Vercel cron that already runs, replacing the hosted indexer that was cancelled on 21 Sep 2026.

**Architecture:** `LogSource` (HyperSync) → pure `foldEvents` (the old indexer's arithmetic, ported with its tests) → one Postgres transaction that writes rows and advances a block cursor. No server, no second database, no transfer indexing.

**Tech Stack:** TypeScript, Next.js route handlers on Vercel cron, porsager `postgres` behind `src/lib/db/client.ts`, viem, Vitest with PGlite for store tests.

**Spec:** `docs/superpowers/specs/2026-09-21-chain-reader-design.md`. Background and measurements: workspace repo `research/indexer-capacity-2026-09-21.md`.

## Global Constraints

- The shared contract is `src/lib/chain/types.ts`. Do not change it without saying so in your report; every module meets at it.
- Raw on-chain integers are `bigint` end to end and `numeric` in SQL. They never pass through `number`. `sqrtPriceX96` is a uint160.
- Addresses, pool ids and tx hashes are lowercased at the boundary (the decoder) and compared lowercase everywhere.
- The fold never writes `holders_count` or `total_supply`, and nothing in this plan indexes ERC-20 `Transfer`.
- Rows and the block cursor are written in ONE transaction. A failure leaves both untouched.
- The old indexer's code is the reference for every number: port it, do not reinvent it. Source: `/Users/kobs/Desktop/SuitVenturesMarket/SuitVenturesMarket-indexer/src/` (read-only; never edit that repo).
- Tests never touch the network or a real database: stub `fetch`, fake the viem client, use PGlite.
- No secret, token or URL with a key in a log, error or test snapshot. The HyperSync token is read from `HYPERSYNC_API_TOKEN` (fallback `ENVIO_API_TOKEN`) and only ever placed in the `Authorization` header.
- Gates before every commit: `npm test`, `npx tsc --noEmit` (read every line), `npx eslint .` (zero warnings), `npm run build`. A known PGlite boot-contention flake can time out `seed.test.ts` or `dbBackend.test.ts` in the full run: re-run that file alone and record both results.
- One commit per task with a trailing pathspec naming every file (never `git add -A`), ending with exactly:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` then `Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467`. Never push.
- In a fresh worktree run `npm ci` first. Never read, print or commit `.env*` files.

## Verified facts (21 Sep 2026)

- PoolManager: `0x8366a39cc670b4001a1121b8f6a443a643e40951`, chain 4663. Event signatures exactly as in the indexer's `config.yaml`:
  `Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)`,
  `Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)`,
  `ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)`.
- HyperSync, `https://4663.hypersync.xyz`: `GET /height` answers `{"height": 68689936}`; `POST /query` with
  `logs: [{ address: [PM], topics: [[t0Init, t0Swap, t0ModLiq]] }]` returns only those three events.
  `to_block` is exclusive. A response is size-capped and may cover fewer blocks than asked: continue from `next_block`.
  Shape: `{ data: [{ logs, blocks, transactions }], next_block, archive_height }`; a log has `block_number` (number),
  `log_index`, `transaction_hash`, `data`, `topic0..topic3` with absent topics omitted; a transaction is `{ hash, from }`;
  a block is `{ number, timestamp }` where **`timestamp` is a hex string** such as `"0x6ab0f871"`. Logs, blocks and
  transactions of one response can sit in different chunks of `data`: join across all chunks. 401 without a valid token.
  A working client with backoff and 429 handling exists at the indexer's `src/lib/hypersync.ts` (`postQuery`, `fetchPage`): port it.
- The public RPC `https://rpc.mainnet.chain.robinhood.com` accepts JSON-RPC batches of 100 and refuses back-to-back bursts (429); pace calls.
- `market.sync_state.job` is free text and `cursor` is `int`: a job named `chain` needs no migration and a block number fits.
- `market.pools.synced_at` holds the moment each pool was copied from the old indexer (17 Sep 2026, about 10:05 to 10:20 UTC); its running totals include everything up to then.
- Candle semantics in the old indexer: price is the pool price after the swap (from `sqrtPriceX96`); a new bucket opens at the previous pool price (gapless); all five intervals `m1 m5 m15 h1 d1`.

---

### Task 1: HyperSync log source

**Files:** Create `src/lib/chain/abi.ts`, `src/lib/chain/decode.ts`, `src/lib/chain/hypersyncSource.ts`, and a `.test.ts` beside each.

**Produces:** `createHyperSyncSource(opts?: { url?: string; token?: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; maxAttempts?: number }): LogSource` implementing `LogSource` from `types.ts`; `decodeLog(raw): ChainEvent | null`; `POOL_MANAGER`, `POOL_MANAGER_EVENTS_ABI`, `TOPIC0` (`{ initialize, swap, modifyLiquidity }`).

- `abi.ts`: the three signatures above through viem `parseAbi`; `TOPIC0` through viem `toEventSelector`.
- `decode.ts`: input `{ blockNumber: number; logIndex: number; txHash: string; topics: string[]; data: string; timestamp: number; txFrom: string | null }`; decode with viem `decodeEventLog`; lowercase every address, id and hash; `fee`, `tick`, `tickSpacing`, `tickLower`, `tickUpper` as `number`, amounts, `liquidity`, `liquidityDelta`, `sqrtPriceX96` as `bigint`; unknown topic0 → `null`.
- `hypersyncSource.ts`: `head()` = `GET {url}/height`; `fetch(from, to)` = one `POST {url}/query` with the body above (`to_block: to + 1`), field selection `block: ["number","timestamp"]`, `log: ["block_number","log_index","transaction_hash","topic0","topic1","topic2","topic3","data"]`, `transaction: ["hash","from"]`; join timestamps (parse hex) and senders across ALL chunks; sort by `(block, logIndex)`; return `nextBlock = min(next_block, to + 1)`. Throw if `next_block <= from` (no progress), if a log's block has no timestamp, or on a non-2xx after retries. Retry with capped exponential backoff on 429 and 5xx and network errors, honouring `Retry-After`; never retry 401/403, and say "HyperSync rejected the API token" without echoing it. `requests` counts every HTTP attempt. URL default `process.env.HYPERSYNC_URL ?? "https://4663.hypersync.xyz"`, token `process.env.HYPERSYNC_API_TOKEN ?? process.env.ENVIO_API_TOKEN`; a missing token throws at the first call, not at construction.
- Tests (stubbed fetch, build real topics and data with viem `encodeEventTopics` / `encodeAbiParameters`): each event decodes to the exact `ChainEvent`; negative `int128`/`int24`/`int256` values survive; a uint160 beyond 2^63 survives; hex timestamp parsed; join across two chunks; sorting; `nextBlock` when the response stops short and when it overshoots `to`; no-progress throws; missing timestamp throws; 429 then 200 backs off and succeeds; 401 fails once with the clear message; the token appears in the `Authorization` header and in no thrown message; `requests` counts attempts.

### Task 2: Port the indexer's arithmetic

**Files:** Create under `src/lib/chain/math/`: `constants.ts`, `price.ts`, `candles.ts`, `liquidity.ts`, `origin.ts`, `primaryPool.ts`, `denylist.ts`, `quotes.ts`, a `.test.ts` beside each, and `src/lib/chain/math/config/{quotes.json,curated-pools.json,token-denylist.json}` copied byte for byte from the indexer's `config/`.

**Port from** the indexer's `src/lib/{constants,price,candles,liquidity,origin,primaryPool,denylist,quotes}.ts` and their tests, verbatim except:
- `candles.ts`: drop `candleWindowAllows` and the env start blocks (retention replaces them); keep `INTERVALS`, `INTERVAL_SECONDS`, `bucketStart`, `candleId`; use `CandleInterval` from `types.ts`.
- `price.ts`: add `sqrtPriceX96FromPrice(priceQuote: number, decimals0: number, decimals1: number, tokenIsCurrency0: boolean): bigint`, the inverse of `priceFromSqrtPriceX96`, for pools whose `sqrtPriceX96` was never captured. Test: for a spread of prices, decimals and both orientations, `priceFromSqrtPriceX96(sqrtPriceX96FromPrice(p,…),…)` is within 1e-9 relative of `p`; zero, negative, NaN and infinite prices throw.
- JSON imports use the form this repo's TypeScript config accepts; if `with { type: "json" }` does not compile here, use a plain import.
- If `liquidity.sdk.test.ts` needs a dependency this repo lacks, do not add it: port `liquidity.test.ts` only and say so.
- Nothing may import from `envio`.

### Task 3: The fold

**Depends on:** Task 2. **Files:** Create `src/lib/chain/fold.ts`, `src/lib/chain/fold.test.ts`.

**Produces:** `foldEvents(events: readonly ChainEvent[], state: FoldState): FoldResult`. It mutates `state` (so a caller can fold several batches in a row) and returns the final states of everything it touched.

Port the three handlers in the indexer's `src/handlers/poolManager.ts` and the helpers in `src/handlers/shared.ts`, replacing `context.X.get/set` with the maps in `FoldState`:
- **Initialize:** `classify` exactly as the indexer (one side a quote and the other not; not native ETH; not denylisted) using `isQuote`/`isDenylisted` from Task 2, else ignore. Create the token if absent with the indexer's fallback metadata (`symbol = address.slice(0, 6)`, `name = address`, `decimals = 18`, `metadataLoaded = false`) and list its id in `newTokens`. Create the pool with `originFor`, `priceFromSqrtPriceX96`, `sqrtPriceX96` from the event, zero totals, `baselineAt = 0`. `poolCount + 1`; first pool becomes primary and sets the token's origin; more than one pool → re-pick the primary. An Initialize for a pool id already in state is ignored (replay safety). No transfer history replay: that part of the indexer is gone.
- **Swap:** unknown pool → `ignoredPools += 1`; both amounts zero → ignore. Token and quote deltas by `tokenIsCurrency0`; `amountToken`/`amountQuote` via `toUnits(absBig(…), decimals)`; `side = tokenDelta > 0n ? "buy" : "sell"`; trade `priceQuote = amountToken > 0 ? amountQuote / amountToken : price`; `wallet = txFrom` lowercased (a swap without a sender is an error, throw); `price` from `sqrtPriceX96`. Candles: all five intervals, existing bucket → high/low/close/volumes/trades, new bucket opens at the pool's previous price (gapless), using the pool price BEFORE this swap. Pool: `priceQuote`, `sqrtPriceX96`, `lastSwapAt = max` always; `swapCount + 1`, `volumeQuoteAllTime + amountQuote`, and TVL minus `principalDelta(delta, fee)` on each side (port `principalDelta` exactly) ONLY when `event.timestamp > pool.baselineAt` and the TVL side is not null. Re-pick the primary pool when the token has more than one.
- **ModifyLiquidity:** unknown pool or null TVL → ignore; `event.timestamp <= pool.baselineAt` → ignore; amounts from `amountsForLiquidityDelta(sqrt, tickLower, tickUpper, liquidityDelta)` where `sqrt = pool.sqrtPriceX96 ?? sqrtPriceX96FromPrice(pool.priceQuote, dec0, dec1, tokenIsCurrency0)`; add to TVL by orientation; re-pick the primary pool when the token has more than one.
- Primary pool: `choosePrimaryPool` over `poolsByToken` with quote USD prices from `state.quotes`; a change updates `primaryPoolId` and the token's `origin`.
- Tests: port the behavioural cases of the indexer's `src/handlers/poolManager.test.ts` (read it) onto the fold, plus: totals gated by `baselineAt` while price, trade row and candles are not; replayed Initialize ignored; gapless candle open; five candles per swap; ModifyLiquidity with a null `sqrtPriceX96` uses the derived one; folding the same batch into two equal states gives equal results; a swap missing `txFrom` throws.

### Task 4: The store side

**Depends on:** `types.ts` only. **Files:** Create `supabase/migrations/20260921010000_chain_reader.sql`, `src/lib/chain/store.ts`, `src/lib/chain/store.test.ts`; modify `src/lib/sync/state.ts` (`SyncJob` gains `"chain"`).

- Migration: `alter table market.pools add column baseline_at int not null default 0;` then `update market.pools set baseline_at = synced_at;` with a comment explaining the column (see `PoolState.baselineAt`). Earlier migrations are frozen.
- `readChainCursor(db): Promise<number>`: `sync_state.cursor` of job `chain` (0 when never set).
- `loadFoldState(db, events: readonly ChainEvent[]): Promise<FoldState>`: the pools the events name (with `sqrt_price_x96`, `tvl_token`, `tvl_quote` read as text into `bigint`, `baseline_at`), their tokens, every quote with its USD price, `poolsByToken` for every token loaded (all of its pool ids, and load those sibling pools too, since primary-pool choice ranks them), and the candle rows for every `(pool, interval, bucket)` the swap events will touch (compute the keys from the events; fetch with one `unnest` join, never one query per key).
- `applyFold(db, result: FoldResult, cursorBlock: number, now: number): Promise<void>` inside ONE `db.tx`: upsert pools (every `PoolState` column including `sqrt_price_x96`; never `baseline_at`; `synced_at = now`); insert new tokens `on conflict do nothing`; update existing tokens' `symbol, name, decimals, pool_count, origin, primary_pool_id, metadata_loaded, synced_at` and NEVER `holders_count` or `total_supply`; insert trades `on conflict (tx_hash, log_index) do nothing`; upsert candles with absolute values; `recomputeListedPools(t, tokenIds)` from `src/lib/sync/writers.ts` for the touched tokens; `saveCursors(t, "chain", { cursor: cursorBlock })`. Reuse the existing writers where their column sets fit; where they do not (they stamp or overwrite columns the reader must not touch), write a reader-specific statement here rather than changing a shared writer.
- PGlite tests: a round trip through `loadFoldState` → `applyFold` → `loadFoldState`; applying the same result twice changes nothing; a throw inside the transaction leaves rows and cursor untouched; uint160 and TVL values beyond 2^63 survive exactly; `baseline_at`, `holders_count` and `total_supply` are untouched; sibling pools are loaded for a multi-pool token; candle keys are fetched in one query.

### Task 5: Reads from the chain

**Depends on:** nothing. **Files:** Create `src/lib/chain/onchain.ts`, `src/lib/chain/onchain.test.ts`.

- `createChainClient(rpcUrl?: string)`: a viem public client on `robinhoodChain` (`src/lib/chain.ts`) over `http(url, { batch: { batchSize: 100, wait: 16 }, retryCount: 3 })`; URL from `CHAIN_RPC_URL`, else the chain's default RPC.
- `readTokenMetadata(client, addresses: readonly string[]): Promise<Map<string, { ok: boolean; symbol: string; name: string; decimals: number; totalSupply: bigint | null }>>`: port the semantics of the indexer's `src/effects/tokenMetadata.ts` (read it: string then bytes32 fallback, sanitising, the fallback values on failure); one token's failure never fails the batch.
- `readQuotePrices(client, quotes: readonly { address: string; chainlinkProxy: string | null; chainlinkDecimals: number | null }[], now: number): Promise<{ id: string; usdPrice: number; updatedAt: number; aggregator: string }[]>`: `latestRoundData()` on each proxy, `answer / 10 ** chainlinkDecimals`; skip non-positive answers and failed reads (never throw for one feed); USDG (`0x5fc5360d0400a0fd4f2af552add042d716f1d168`) is pinned at 1 with aggregator `"pinned"`, as the indexer did.
- Tests with a fake client exposing `readContract`: happy paths, bytes32 symbol, a reverting token, a reverting feed, a zero answer, the USDG pin, lowercase keys.

### Task 6: The runner, the route, and cutting Envio out of the running app

**Depends on:** Tasks 1 to 5. **Files:** Create `src/lib/chain/run.ts` + test; modify `src/lib/sync/deps.ts`, `src/app/api/internal/sync/route.ts` (+ test), `src/lib/sync/nightly.ts` (+ test), `src/lib/sync/run.ts` (+ test), `src/lib/market/dbBackend.ts` (+ test), `src/app/api/health/route.ts` if it needs it.

- `runChainSync(db, deps: { source: LogSource; client; quotes }, opts: { owner; now; sleep; windowSec; intervalSec; leaseSec; safetyBlocks = 30; maxSpan = 2_000 })`: take the `chain` lease (skip if held); if the cursor is 0 refuse with `"chain cursor not initialised: run the catch-up script"` (never start from genesis by accident); loop until the window ends: `target = head - safetyBlocks`; nothing to do → sleep `intervalSec`; else `fetch(cursor + 1, min(target, cursor + maxSpan))` → `loadFoldState` → `foldEvents` → `readTokenMetadata` for `newTokens` and merge → `applyFold(result, nextBlock - 1)`; refresh quote prices with `readQuotePrices` + `upsertQuotes` at most once a minute; `finishRun` after every cycle, ok or error; the first thrown error ends the invocation; always release the lease. Report cycles, blocks advanced, events, trades, requests.
- The sync route runs the chain job instead of the Envio market job. `deps.ts` builds the HyperSync source, the chain client and the quote config; the test override keeps working.
- The nightly job loses its `tokens` and `pools` phases (they re-copied from Envio and would now fail or overwrite good data) and its dependence on an `EnvioSource`; `listed`, `probe` and `prune` stay. `runSync`'s Envio head-block guard no longer applies to it.
- `createDbBackend`: the holder list's read-through refresh from Envio becomes optional and absent by default, so the holders endpoint serves what is stored and never errors because Envio is gone. Health reports `lag` as the node's head minus the `chain` cursor, in blocks, and no longer calls Envio.
- Remove nothing that tests still need, but no production path may construct an Envio client after this task: grep proves it. `MARKET_DATA_BACKEND=envio` remains a recognised value only if something still reads it; say what you found.

### Task 7: Catch-up and the candle gap-fill

**Depends on:** Task 6. **Files:** Create `scripts/chain/catchup.mts`, `scripts/chain/gapfill-candles.mts`, `src/lib/chain/catchup.ts` + test, `package.json` scripts `chain:catchup` and `chain:gapfill`.

- `gapfill-candles`: from `market.swaps`, build `h1` and `d1` candles for buckets that lie wholly inside the stored trade window and wholly before `--before <unix>`, `insert … on conflict do nothing` (never overwrite a candle copied from the old indexer). Open = the bucket's first trade price, close = its last, by `(ts, log_index)`. One statement per interval; report rows inserted.
- `catchup --from-ts <unix>`: find the first block at or after that time by binary search on block timestamps through the chain client; delete every candle with `t >= from-ts` (they are rebuilt exactly from events); set the `chain` cursor to `startBlock - 1` only if it is lower than that or 0 (a restart must resume, not rewind; `--force-rewind` overrides); then run fold cycles with a large `maxSpan` until the cursor is within `safetyBlocks` of the head, printing progress (blocks/s, events, requests, ETA). Lease-protected like the cron. Safe to stop and restart at any point.
- Tests for the block search and the resume-not-rewind rule with fakes.

### Task 8: Retention and documentation

**Depends on:** Task 6. **Files:** modify `src/lib/sync/retention.ts` (+ test), `src/lib/sync/nightly.ts` (+ test), `.env.example`, `README.md`, `scripts/README.md`.

- `SWAP_RETENTION_SEC = 5 * 86_400` (Kobe, 21 Sep 2026: nothing reads a trade older than 24 hours except the newest-50 list; 5 days keeps that list on quiet tokens). Fix every comment and test that says 10.
- `pruneCandles(db, { now, deadlineMs, batch? })`: per interval, delete rows with `t < candleCutoff(interval, now)` in ctid batches like `pruneSwaps`; the nightly `prune` phase runs it after the trade prune. Tests mirror `pruneSwaps`'s.
- `.env.example`: `HYPERSYNC_API_TOKEN`, `HYPERSYNC_URL`, `CHAIN_RPC_URL`, in the file's server-side inline style; mark the Envio GraphQL variables as no longer used.
- `README.md`: replace the Envio data-flow description with the reader's; `scripts/README.md`: the two new scripts and the order to run them.
