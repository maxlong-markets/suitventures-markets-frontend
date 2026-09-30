import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import { withVoteCounts } from "../../_lib/counts";
import { badRequest, cached, failure, isAddress } from "../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 30;

/** One TokenPair by address, listed or not: the token page's fallback when the 500-row list does not carry it. */
export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  if (!isAddress(id)) return badRequest("bad address");
  try {
    const pair = await ttlCache(`pair:${id}`, TTL * 1000, () => getBackend().pair(id), {
      // Amended 30 Sep 2026 (should fix 9): a launch can land in the store seconds after this
      // answers 404, so "not found" must not sit in the 30 s memo the way a real pair does.
      skipCache: (v) => v === null,
    });
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
