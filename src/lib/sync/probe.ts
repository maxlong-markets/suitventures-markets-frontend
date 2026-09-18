import type { Db } from "@/lib/db/client";
import { poolKeyRow, type PoolKeyParts } from "@/lib/market/poolKey";
import { NotRoutableError, type Quoter } from "@/lib/quote/quoter";
import { PAGE_LIMIT } from "./market";

/** eth_calls in flight at once (spec section 2): a small worker pool, not a dependency's. */
export const PROBE_CONCURRENCY = 4;
/** Probes in one probePools call (spec section 2, "a per-run cap of 3000 probes"): generous against the
 * nightly's deadline at PROBE_CONCURRENCY without one invocation trying to walk the whole candidate set. */
export const PROBE_RUN_CAP = 3000;
/** A pool untraded this long cannot appear in the table (spec section 2): probing it would be wasted RPC. */
export const PROBE_ACTIVE_SEC = 7 * 86_400;

export type ProbeOpts = { now: number; deadlineMs: number; afterId: string; cap?: number };
export type ProbeResult = { probed: number; routable: number; unroutable: number; skipped: number; lastId: string; done: boolean };

/** The candidate set, joined for poolKeyRow()'s fields exactly as dbBackend's POOL_KEY_SQL joins them (poolKey.ts's
 * one field mapping, kept in sync by both call sites using it); paged by pool id after `$2`, sane-priced pools
 * that traded within PROBE_ACTIVE_SEC of `$1` only. */
const CANDIDATES_SQL = `
  select p.id, p.hooks, p.fee, p.tick_spacing, p.token_is_currency0, p.price_quote,
    t.address as token_address, t.decimals as token_decimals,
    q.address as quote_address, q.decimals as quote_decimals, p.quote_id
  from market.pools p
  join market.tokens t on t.id = p.token_id
  join market.quotes q on q.id = p.quote_id
  where p.last_swap_at >= $1::int and p.price_quote > 1e-24 and p.price_quote < 1e18 and p.id > $2::text
  order by p.id
  limit $3::int`;

const WRITE_SQL = "update market.pools set routable = $1::boolean, probed_at = $2::int where id = $3::text";

type CandidateRow = {
  id: string; hooks: string; fee: number; tick_spacing: number; token_is_currency0: boolean; price_quote: number;
  token_address: string; token_decimals: number; quote_address: string; quote_decimals: number; quote_id: string;
};

/** 0.001 of the quote asset in base units (spec section 2): small enough for a dust pool, large enough to exercise a hook. */
function probeAmount(quoteDecimals: number): bigint {
  return quoteDecimals < 3 ? 1n : 10n ** BigInt(quoteDecimals - 3);
}

type Outcome = "routable" | "unroutable" | "skipped";

/**
 * One pool's verdict, written unless the Quoter could not answer at all. Never throws: every failure the
 * Quoter can raise is caught here, exactly as the doc comment on probePools promises its caller.
 */
async function probeOne(db: Db, quoter: Quoter, row: CandidateRow, now: number): Promise<Outcome> {
  const parts: PoolKeyParts = {
    poolId: row.id, hooks: row.hooks, fee: row.fee, tickSpacing: row.tick_spacing,
    tokenIsCurrency0: row.token_is_currency0, priceQuote: row.price_quote,
    tokenAddress: row.token_address, tokenDecimals: row.token_decimals,
    quoteAddress: row.quote_address, quoteDecimals: row.quote_decimals,
  };
  // The join already restricts on q.id = p.quote_id, so this can only fail on a data race with a row deleted
  // between the select and here; treated the same as a transport failure, no write, nothing to route through.
  const key = poolKeyRow(parts, row.quote_id);
  if (!key) return "skipped";
  let routable: boolean;
  try {
    // Buying: the quote asset is paid, so the swap is not "token is currency0"'s own direction.
    await quoter.exactIn({ poolKey: key, zeroForOne: !row.token_is_currency0, exactAmount: probeAmount(row.quote_decimals) });
    routable = true; // any answer, 0n included, is the honest-zero ruling (spec section 2)
  } catch (err) {
    if (err instanceof NotRoutableError) routable = false;
    else return "skipped"; // QuoterUnavailableError, or anything else: not an answer, flag left untouched
  }
  await db.query(WRITE_SQL, [routable, now, row.id]);
  return routable ? "routable" : "unroutable";
}

/**
 * Probes active pools after `afterId` in id order (spec section 2 / 6 task 1). Pages the candidate set
 * PAGE_LIMIT rows at a time and, within a page, PROBE_CONCURRENCY pools at a time: at most that many eth_calls
 * are ever in flight, and `lastId` only ever advances to the end of a fully-settled batch, never mid-batch, so
 * a resume from it can redo at most PROBE_CONCURRENCY − 1 already-written pools and can never skip one.
 *
 * Stops at `cap` (default PROBE_RUN_CAP) or opts.deadlineMs, both checked before every batch is dispatched and
 * before every page is fetched, never after one is already running. `done` is true only once a fetched page
 * comes back shorter than requested — the candidate set genuinely ran out within the cap and the deadline —
 * exactly as the tokens/pools phases' own walk treats a short page as "the end" (nightly.ts).
 */
export async function probePools(db: Db, quoter: Quoter, opts: ProbeOpts): Promise<ProbeResult> {
  const cap = opts.cap ?? PROBE_RUN_CAP;
  const activeSince = opts.now - PROBE_ACTIVE_SEC;
  let afterId = opts.afterId;
  let probed = 0;
  let routable = 0;
  let unroutable = 0;
  let skipped = 0;
  const stop = (done: boolean) => ({ probed, routable, unroutable, skipped, lastId: afterId, done });

  for (;;) {
    const pageCap = cap - probed;
    if (pageCap <= 0) return stop(false);
    if (Date.now() >= opts.deadlineMs) return stop(false);
    const pageSize = Math.min(PAGE_LIMIT, pageCap);
    const rows = await db.query<CandidateRow>(CANDIDATES_SQL, [activeSince, afterId, pageSize]);
    if (rows.length === 0) return stop(true);

    for (let i = 0; i < rows.length; ) {
      const room = cap - probed;
      if (room <= 0) return stop(false);
      if (Date.now() >= opts.deadlineMs) return stop(false);
      const batch = rows.slice(i, i + Math.min(PROBE_CONCURRENCY, room));
      const outcomes = await Promise.all(batch.map((row) => probeOne(db, quoter, row, opts.now)));
      for (const outcome of outcomes) {
        probed += 1;
        if (outcome === "routable") routable += 1;
        else if (outcome === "unroutable") unroutable += 1;
        else skipped += 1;
      }
      afterId = batch[batch.length - 1].id;
      i += batch.length;
    }
    if (rows.length < pageSize) return stop(true);
  }
}
