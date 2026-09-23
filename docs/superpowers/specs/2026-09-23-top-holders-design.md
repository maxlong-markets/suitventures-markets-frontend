# Top holders — design

**Date:** 23 Sep 2026. **Decided with Kobe** in chat the same evening (cadence, coverage, storage ceiling, cleanup).
**Status:** approved for build.

## 1. What the user gets

The Holders tab of a token shows its top wallets by balance (the existing `HOLDERS_SHOWN` rows, 10 today),
each with balance and share of supply, plus an "as of" line. Every token on the markets table has a list
that is at most 15 minutes old while the token trades and at most an hour old otherwise. A token that is
not on the table gets a list the first time someone opens it, within a minute or two for a typical token.
The holder count shown next to the list is exact for every token that has a list.

Four states, all rendered by the tab:

| Status | Meaning | Tab shows |
|---|---|---|
| `ready` | the fold reached the chain head at `asOf` | rows, "as of N min ago" (or "No holders yet." when empty) |
| `building` | a fold is queued or in progress | skeleton rows and "Building this token's holder list. Usually under a minute." — the tab polls every 5 s |
| `skipped` | too large to fold (over a million holders, or a transfer history past the safety valve) | "Holder list unavailable for a token this large." |
| `none` | never requested | never reaches the tab: the holders route turns it into `building` |

## 2. Where the data comes from, and why

Three sources were measured on 23 Sep 2026:

- The explorer's holders API sits behind a Cloudflare browser challenge and answers servers with 403. Out.
- Balance reads (`balanceOf`) confirm a wallet's balance but cannot discover which wallets hold a token. Out
  for lists; they stay the reader's tool for the live holder-count deltas.
- HyperSync's log query with `address = token, topic0 = Transfer` returns a token's complete ERC-20 transfer
  history. Folding it gives exact balances for every wallet. A small token's whole history is 4 requests;
  a dense one yields about 4,800 transfers per request, so a token with a million transfers is a few hundred
  requests. HyperSync refuses bursts: the paid key (100 requests a minute, burst 250) sustained 86 a minute
  with zero refusals; the free key refused at 31 in a minute.

So: per-token incremental folds of HyperSync transfer history, each token with its own stored cursor, applied
in slices, paced.

## 3. Data

`market.token_balances (token_id, holder, balance numeric(78,0), updated_at)` — already exists with the
`(token_id, balance desc)` index. It becomes the exact balance map of every covered token: one row per wallet
with a non-zero balance, nothing else.

`market.holder_refresh` — exists with `(token_id primary key, refreshed_at int)`. Gains:

| Column | Type | Meaning |
|---|---|---|
| `cursor_block` | `int not null default 0` | first block NOT yet folded; 0 = nothing folded |
| `requested_at` | `int not null default 0` | last time someone opened the tab (0 = never) |
| `status` | `text not null default 'building'`, check in `('building','ready','skipped')` | see section 1 |
| `transfers` | `bigint not null default 0` | transfers folded so far, for reports and the safety valve |

`refreshed_at` keeps its meaning: the last time the fold reached the chain head; 0 until it first does.

`market.sync_state` gains a row `job = 'holders'` (lease, last_ok_at, last_error, last_report), through the
existing helpers — no schema change.

## 4. The builder

A cron, `/api/internal/holders`, every minute, `maxDuration 300`, under the `holders` lease (300 s, matching
the reader's), working for at most 50 s per invocation and yielding to the nightly the way the reader does.

Each invocation:

1. Reads the chain head from HyperSync once.
2. Computes the **coverage set**: the top 500 token ids by trade count over the last 24 hours in
   `market.swaps`, minus the quote assets (`QUOTES` in `src/lib/chain/math/quotes.ts`) and minus tokens whose
   `holders_count` exceeds 1,000,000.
3. Builds the **due list**, in this order, and works through it until the window ends:
   1. tokens with `requested_at > 0` and `status = 'building'` — someone opened them — newest request first;
   2. coverage tokens whose `refreshed_at` is older than 15 minutes AND that have a trade in `market.swaps`
      newer than `refreshed_at` — most traded first;
   3. coverage tokens whose `refreshed_at` is older than 60 minutes — oldest first.
   A token appears once. A token in the coverage set with no refresh row at all is inserted as `building`
   and treated as (3).
4. For each due token, **slices** until it is ready or the window ends: one HyperSync request from
   `cursor_block`, the returned transfers folded into a delta map (`from` loses `value`, `to` gains it, the
   zero address ignored), and one transaction applying the slice: additive upsert of the deltas, delete of the
   touched rows that reached zero, `cursor_block = nextBlock`, `transfers += n`. When `nextBlock` reaches
   `head - 30`, the token is **ready**: `status = 'ready'`, `refreshed_at = now`, and `market.tokens.holders_count`
   set to the exact count of its rows.
5. Requests are spaced at least 750 ms apart (80 a minute), leaving the reader its 4 and a margin under the
   key's 100. HyperSync's 429s go through the source's own retry with backoff; a slice that still fails is
   counted as an error, the token's cursor stays where it was, and the invocation moves to the next token.
6. Writes its cycle report through `finishRun` (`last_report`): tokens touched, tokens made ready, requests,
   transfers, errors.

Safety valve: a token whose fold passes 10,000,000 transfers without reaching the head is marked `skipped`
and its rows deleted (raised from 5,000,000 on the first live night: WETH, a listed token here, tripped the
valve as intended, while PONS, a listing whose list matters, was on course to; ten million bounds one token
at about 2,100 requests once).

Why slices, not whole histories in memory: a slice is one request's transfers (a few thousand rows), applied
and committed with its cursor. Any interruption — the window, a crash, a redeploy — loses at most one
uncommitted slice, and the next invocation resumes from the stored cursor.

## 5. Serving

`GET /api/tokens/[address]/holders` answers `{ holders, count, status, asOf }`:
`holders` the top rows shaped as today, `count` the token's `holders_count`, `status` one of the four,
`asOf` = `refreshed_at` or null. When the token has no refresh row, or has one with `status = 'building'`
and `requested_at` older than 60 s, the route stamps `requested_at = now` (inserting the row as `building`
when absent) — that is what puts a token in the builder's first priority. The route's 60-second memo stays
for `ready`; anything else is memoised for 5 s so the tab's polling sees progress.

The dead read-through (`DbBackendOpts.topHolders`, `HOLDER_REFRESH_SEC`, `HOLDERS_PULLED`) is removed: the
builder is the only writer of `token_balances`.

## 6. Two writers of `holders_count`

The reader keeps applying ±1 deltas from live trades (a wallet's first buy, a full sell); the builder sets
the exact count whenever a token's fold reaches the head. Between refreshes the reader's deltas keep the
number moving; at each refresh the builder resets it to exact. The only drift possible is the reader
double-counting a transition that happened between the head the builder saw and the reader's own cursor, a
few blocks, and the next refresh erases it.

## 7. Cleanup and ceiling

The nightly job gains a phase `holders` after `prune`: delete the balances and refresh rows of every token
that is neither in the coverage set nor was requested in the last 7 days. With the top 500 at about 1.1 M
rows (0.2 GB) and giants excluded, the table cannot grow past roughly 1 GB even if the whole long tail were
opened in a week; the database is 5.3 GB today against an 18 GB line.

## 8. Health

`/api/health` gains `holders: { lastCycle, table: { rows, bytes } }`: the builder's last cycle from its
`last_report` (age, tokens touched and made ready, requests, transfers, errors) and the balances table's
size from `pg_class.reltuples` and `pg_total_relation_size`, so cost and progress are visible without the
logs.

## 9. Costs

| Item | Value |
|---|---|
| Builder pace | 80 requests a minute, one every 750 ms |
| Steady state | about 30,000 requests a day |
| One-time build of the top 500 | about 4,500 requests, roughly an hour |
| Holder rows for the top 500 | about 1.1 million, about 0.2 GB |
| Largest token on the table today | mShare, 642,000 holders (included) |

## 10. Out of scope

A nightly spot-check of each list's top rows against `balanceOf` (catches rebasing and fee-on-transfer
tokens whose events do not match balances). Lists for tokens over a million holders. Anything about the
Transfer events of the quote assets.
