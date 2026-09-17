# Database scripts

All four run from the repo root through `node --env-file-if-exists=.env.local --conditions=react-server --import tsx`
(see `package.json`). They read `DATABASE_URL_DIRECT`, the Supabase session pooler on port 5432, never the
app's `DATABASE_URL`. Never paste a connection string into a terminal, a chat, a commit or this file: it
lives in `.env.local` only.

| Command | What it does |
|---|---|
| `npm run db:migrate` | Applies every `supabase/migrations/*.sql` not yet recorded in `market.schema_migrations`, in filename order, and prints the names applied. |
| `npm run db:smoke` | One round trip; prints `ok`. Run it after changing `.env.local`. |
| `npm run seed` | The one-off load from Envio: quotes, tokens, pools, then swaps, candles and balances by id ranges with three workers at 200 queries a minute, then the finish phase (top 100 holders per token, listed pools, sync cursors). About eight hours. |
| `npm run db:parity` | Loads `pairs("all")` and `pairs("launchpad")` through both backends and prints every token missing on either side, every field differing by more than 0.1 % (numbers) or at all (strings), then the counts. |

Seed, on a laptop that must not sleep:

    caffeinate -i npm run seed

It prints one line per page: `swaps r2 pages=1234 rows=1234000 queries=1240 elapsed=372s`. Progress is
checkpointed to `.seed/checkpoint.json` after every page. If it stops for any reason, run the same command
again: it resumes at the saved phase and range cursors and re-reads at most one page per range. Delete
`.seed/checkpoint.json` to start from scratch; the writes are idempotent, so a restart only costs time.

Run `npm run db:parity` once the sync has run for an hour (rollout step R5) and again a day after the flip.
The only expected differences are tokens that traded after the last sync cycle.
