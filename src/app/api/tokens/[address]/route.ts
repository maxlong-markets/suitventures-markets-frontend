import { NextResponse } from "next/server";
import { withVoteCounts } from "../../_lib/counts";
import { lookupPair } from "../../_lib/pairLookup";
import { badRequest, cached, failure, isAddress } from "../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 30;

/** One TokenPair by address, listed or not: the token page's fallback when the 500-row list does not carry it. */
export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  // Fix round 1, finding 9: kept here (not folded into `lookupPair` alone) so a malformed
  // address still answers the more specific 400 "bad address" rather than a 404, exactly as
  // before; `lookupPair`'s own check is what protects the token page, which had none of its own.
  if (!isAddress(id)) return badRequest("bad address");
  try {
    // Fix round 1, finding 3: `lookupPair` is now the one place that decides the key, the ttl
    // and the "never cache a miss" rule, shared with the token page and the quote route.
    const pair = await lookupPair(id);
    if (!pair) {
      // A short CDN hold only, not the list's 30 s: this is the one answer that can flip from
      // true to false within seconds of a creator's own launch, and a stale 404 here reads as
      // "the address is wrong" right when it is not.
      return NextResponse.json({ error: "unknown token" }, { status: 404, headers: { "Cache-Control": "public, s-maxage=5" } });
    }
    // Merged onto a copy after the memo answered: `ttlCache` hands every caller the same object.
    const [withCounts] = await withVoteCounts([pair]);
    return cached(withCounts, TTL);
  } catch (err) {
    return failure(err);
  }
}
