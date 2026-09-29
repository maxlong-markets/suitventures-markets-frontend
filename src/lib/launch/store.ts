import "server-only";

import type { LaunchFeesRow, LaunchRow, PayoutRow } from "@/lib/chain/types";
import type { Db } from "@/lib/db/client";

/**
 * The instant launchpad's writes into market.launches and market.launch_fee_events (design section 5.2), all called from
 * inside `applyFold`'s one transaction, so a throw rolls the batch back with the cursor. Every statement is idempotent:
 * the launch and fee inserts do nothing on conflict, the payout update is gated by the (block, log index) it replaces.
 */

/** Rows per statement, as src/lib/sync/writers.ts's CHUNK: each column is one array parameter. */
const CHUNK = 1000;
function chunk<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}
/** Booleans travel as text and are cast per element: see src/lib/sync/writers.ts's `bool` for why. */
const bool = (b: boolean) => (b ? "true" : "false");

export async function insertLaunches(db: Db, rows: readonly LaunchRow[], now: number): Promise<number> {
  let inserted = 0;
  for (const c of chunk(rows)) {
    const out = await db.query<{ token_id: string }>(
      `insert into market.launches (token_id, pool_id, quote_id, creator, payout, token_is_currency0, creator_share_bps, open_tick,
         opening_valuation, liquidity, tokens_in_pool, first_buy_in, first_buy_tokens, router_fee, creation_fee, hook, name, symbol,
         metadata_uri, metadata_cid, launch_block, launch_log_index, launch_tx, launched_at, payout_block, payout_log_index, updated_at)
       select token_id, pool_id, quote_id, creator, payout, token_is_currency0::boolean, creator_share_bps, open_tick,
         opening_valuation, liquidity, tokens_in_pool, first_buy_in, first_buy_tokens, router_fee, creation_fee, hook, name, symbol,
         metadata_uri, metadata_cid, launch_block, launch_log_index, launch_tx, launched_at, launch_block, launch_log_index, $25::int
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::int[],
         $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[], $14::numeric[], $15::numeric[], $16::text[],
         $17::text[], $18::text[], $19::text[], $20::text[], $21::int[], $22::int[], $23::text[], $24::int[])
         as u(token_id, pool_id, quote_id, creator, payout, token_is_currency0, creator_share_bps, open_tick, opening_valuation,
           liquidity, tokens_in_pool, first_buy_in, first_buy_tokens, router_fee, creation_fee, hook, name, symbol, metadata_uri,
           metadata_cid, launch_block, launch_log_index, launch_tx, launched_at)
       on conflict (token_id) do nothing
       returning token_id`,
      [
        c.map((r) => r.tokenId), c.map((r) => r.poolId), c.map((r) => r.quoteId), c.map((r) => r.creator), c.map((r) => r.payout),
        c.map((r) => bool(r.tokenIsCurrency0)), c.map((r) => r.creatorShareBps), c.map((r) => r.openTick),
        c.map((r) => r.openingValuation.toString()), c.map((r) => r.liquidity.toString()), c.map((r) => r.tokensInPool.toString()),
        c.map((r) => r.firstBuyIn.toString()), c.map((r) => r.firstBuyTokens.toString()), c.map((r) => r.routerFee.toString()),
        c.map((r) => r.creationFee.toString()), c.map((r) => r.hook), c.map((r) => r.name), c.map((r) => r.symbol),
        c.map((r) => r.metadataUri), c.map((r) => r.metadataCid), c.map((r) => r.block), c.map((r) => r.logIndex),
        c.map((r) => r.txHash), c.map((r) => r.timestamp), now,
      ],
    );
    inserted += out.length;
  }
  return inserted;
}

/**
 * Links and the image CID reach a launch from market.launch_uploads by metadata CID (design 5.2 step 2): the newest
 * `pending` or `used` upload wins, then every `pending` upload of that CID becomes `used` by this token. Only an upload
 * made by the launch's own creator counts (both addresses are stored lowercase), so one creator cannot borrow another's
 * image and links by reusing their metadata URI. A deleted upload's objects are gone and a refused one's are about to
 * be, so neither is ever copied from nor revived; such a launch shows no image and health counts it.
 */
export async function attachUploads(db: Db, tokenIds: readonly string[], now: number): Promise<void> {
  if (tokenIds.length === 0) return;
  const ids = [...tokenIds];
  await db.query(
    `update market.launches l set image_cid = u.image_cid, description = u.description, website = u.website,
       x = u.x, telegram = u.telegram, updated_at = $2::int
     from (select distinct on (metadata_cid, wallet) * from market.launch_uploads
           where status in ('pending', 'used')
             and metadata_cid in (select metadata_cid from market.launches where token_id = any($1::text[]))
           order by metadata_cid, wallet, id desc) u
     where l.token_id = any($1::text[]) and l.metadata_cid <> '' and u.metadata_cid = l.metadata_cid and u.wallet = l.creator`,
    [ids, now],
  );
  await db.query(
    `update market.launch_uploads u set status = 'used', used_at = $2::int, token_id = l.token_id
     from market.launches l
     where l.token_id = any($1::text[]) and l.metadata_cid <> '' and u.metadata_cid = l.metadata_cid
       and u.wallet = l.creator and u.status = 'pending'`,
    [ids, now],
  );
}

/** One row per FeesCollected log and nothing else (design 5.2 step 3): no totals are stored, so a re-applied batch inserts nothing. */
export async function insertLaunchFees(db: Db, rows: readonly LaunchFeesRow[]): Promise<number> {
  let inserted = 0;
  for (const c of chunk(rows)) {
    const out = await db.query<{ tx_hash: string }>(
      `insert into market.launch_fee_events (tx_hash, log_index, token_id, payout, token_payout, token_platform,
         quote_payout, quote_platform, block, ts)
       select * from unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[],
         $8::numeric[], $9::int[], $10::int[])
       on conflict (tx_hash, log_index) do nothing
       returning tx_hash`,
      [
        c.map((r) => r.txHash), c.map((r) => r.logIndex), c.map((r) => r.tokenId), c.map((r) => r.payout),
        c.map((r) => r.tokenPayout.toString()), c.map((r) => r.tokenPlatform.toString()), c.map((r) => r.quotePayout.toString()),
        c.map((r) => r.quotePlatform.toString()), c.map((r) => r.block), c.map((r) => r.timestamp),
      ],
    );
    inserted += out.length;
  }
  return inserted;
}

/**
 * Last-write-wins by position (design 5.2 step 4): the stored (block, log index) makes a replay a no-op. Only the latest
 * change per token is sent, since an UPDATE … FROM that joins one target row to several source rows applies an arbitrary one.
 */
export async function applyPayouts(db: Db, rows: readonly PayoutRow[], now: number): Promise<number> {
  const latest = new Map<string, PayoutRow>();
  for (const r of rows) {
    const seen = latest.get(r.tokenId);
    if (!seen || r.block > seen.block || (r.block === seen.block && r.logIndex > seen.logIndex)) latest.set(r.tokenId, r);
  }
  let updated = 0;
  for (const c of chunk([...latest.values()])) {
    const out = await db.query<{ token_id: string }>(
      `update market.launches l set payout = u.payout, payout_block = u.block, payout_log_index = u.log_index, updated_at = $5::int
       from unnest($1::text[], $2::text[], $3::int[], $4::int[]) as u(token_id, payout, block, log_index)
       where l.token_id = u.token_id and (l.payout_block, l.payout_log_index) < (u.block, u.log_index)
       returning l.token_id`,
      [c.map((r) => r.tokenId), c.map((r) => r.payout), c.map((r) => r.block), c.map((r) => r.logIndex), now],
    );
    updated += out.length;
  }
  return updated;
}

/**
 * Health's `launches` block (design section 13): launches that carry a metadata CID but no image, which is how a launch
 * whose upload was already cleaned up shows, and the uploads the nightly clean-up has removed.
 */
export async function launchHealth(db: Db): Promise<{ missingUploads: number; deletedUploads: number }> {
  const [row] = await db.query<{ missing: number | string; deleted: number | string }>(
    `select (select count(*) from market.launches where metadata_cid <> '' and image_cid = '') as missing,
            (select count(*) from market.launch_uploads where status = 'deleted') as deleted`,
  );
  return { missingUploads: Number(row!.missing), deletedUploads: Number(row!.deleted) };
}
