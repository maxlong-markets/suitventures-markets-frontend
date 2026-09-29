import "server-only";

import type { Db } from "@/lib/db/client";
import type { Address, Hex, LaunchInfo } from "@/lib/types";

type LaunchCols = {
  creator: string; payout: string; quote_id: string; quote_decimals: number; token_is_currency0: boolean; open_tick: number;
  opening_valuation: string; first_buy_in: string; first_buy_tokens: string; router_fee: string; creator_share_bps: number;
  launched_at: number; launch_block: number; launch_tx: string; hidden: boolean;
  image_cid: string; description: string; website: string; x: string; telegram: string;
};
type FeeCols = { token_to_payout: string; token_to_platform: string; quote_to_payout: string; quote_to_platform: string; fees_collected_at: number | string };

/** numeric cast to text, so both drivers hand back the exact digits. */
const LAUNCH_SQL = `select l.creator, l.payout, l.quote_id, q.decimals as quote_decimals, l.token_is_currency0, l.open_tick,
  l.opening_valuation::text as opening_valuation, l.first_buy_in::text as first_buy_in, l.first_buy_tokens::text as first_buy_tokens,
  l.router_fee::text as router_fee, l.creator_share_bps, l.launched_at, l.launch_block, l.launch_tx, l.hidden,
  l.image_cid, l.description, l.website, l.x, l.telegram
  from market.launches l join market.quotes q on q.id = l.quote_id where l.token_id = $1`;

/** Spec 5.5 (amended 29 Sep 2026): fee totals are never stored, only summed here, served by launch_fee_events_token. */
const FEES_SQL = `select coalesce(sum(token_payout), 0)::text as token_to_payout, coalesce(sum(token_platform), 0)::text as token_to_platform,
  coalesce(sum(quote_payout), 0)::text as quote_to_payout, coalesce(sum(quote_platform), 0)::text as quote_to_platform,
  coalesce(max(ts), 0) as fees_collected_at
  from market.launch_fee_events where token_id = $1`;

/** The `launch` block of the single-token response, or null for a token not launched here. Hidden blanks the five text fields. */
export async function readLaunchInfo(db: Db, tokenId: string): Promise<LaunchInfo | null> {
  const [l] = await db.query<LaunchCols>(LAUNCH_SQL, [tokenId]);
  if (!l) return null;
  const [f] = await db.query<FeeCols>(FEES_SQL, [tokenId]);
  const shown = (value: string) => (l.hidden ? "" : value);
  return {
    creator: l.creator as Address,
    payout: l.payout as Address,
    quoteAddress: l.quote_id as Address,
    quoteDecimals: l.quote_decimals,
    tokenIsCurrency0: l.token_is_currency0,
    openTick: l.open_tick,
    openingValuation: l.opening_valuation,
    firstBuyIn: l.first_buy_in,
    firstBuyTokens: l.first_buy_tokens,
    creatorShareBps: l.creator_share_bps,
    launchedAt: l.launched_at,
    launchBlock: l.launch_block,
    launchTx: l.launch_tx as Hex,
    hidden: l.hidden,
    imageCid: shown(l.image_cid),
    description: shown(l.description),
    website: shown(l.website),
    x: shown(l.x),
    telegram: shown(l.telegram),
    routerFee: l.router_fee,
    feesCollected: {
      tokenToPayout: f!.token_to_payout,
      tokenToPlatform: f!.token_to_platform,
      quoteToPayout: f!.quote_to_payout,
      quoteToPlatform: f!.quote_to_platform,
    },
    feesCollectedAt: Number(f!.fees_collected_at),
  };
}
