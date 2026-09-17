import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import { badRequest, cached, failure, isAddress } from "../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 30;

/** One TokenPair by address, listed or not: the token page's fallback when the 500-row list does not carry it. */
export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  if (!isAddress(id)) return badRequest("bad address");
  try {
    const pair = await ttlCache(`pair:${id}`, TTL * 1000, () => getBackend().pair(id));
    if (!pair) {
      // Unknown is a fact for the next 30 s too, so the CDN may hold it as long as the list.
      return NextResponse.json({ error: "unknown token" }, { status: 404, headers: { "Cache-Control": `public, s-maxage=${TTL}, stale-while-revalidate=60` } });
    }
    return cached(pair, TTL);
  } catch (err) {
    return failure(err);
  }
}
