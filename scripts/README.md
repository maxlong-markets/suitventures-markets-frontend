# Database scripts

All four run from the repo root through `node --env-file-if-exists=.env.local --conditions=react-server --import tsx`
(see `package.json`). They read `DATABASE_URL_DIRECT`, the Supabase session pooler on port 5432, never the
app's `DATABASE_URL`. Never paste a connection string into a terminal, a chat, a commit or this file: it
lives in `.env.local` only.

| Command | What it does |
|---|---|
| `npm run db:migrate` | Applies every `supabase/migrations/*.sql` not yet recorded in `market.schema_migrations`, in filename order, and prints the names applied. |
| `npm run db:smoke` | One round trip; prints `ok`. Run it after changing `.env.local`. |
| `npm run seed` | The one-off load from Envio: quotes, tokens, pools, then swaps, candles and balances by id ranges with three workers at 200 queries a minute, then the finish phase (top 100 holders per token, listed pools, every pool's `synced_to` watermark and the sync cursors at the seed's start minus 600 s). About eight hours. |
| `npm run db:parity` | Loads `pairs("all")` and `pairs("launchpad")` through both backends and prints every token missing on either side, every field differing by more than 0.1 % (numbers) or at all (strings), then the counts. |

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

(quotes, tokens and pools are upserted and may stay), then delete `.seed/checkpoint.json` and run the seed again.

Run `npm run db:parity` once the sync has run for an hour (rollout step R5) and again a day after the flip.
The only expected differences are tokens that traded after the last sync cycle.
