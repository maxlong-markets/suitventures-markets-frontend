import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import type { IndexerInterval } from "@/lib/sync/ids";
import { badRequest, cached, failure, isAddress } from "../../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 10;
const INTERVALS: Record<string, IndexerInterval> = { "1m": "m1", "5m": "m5", "15m": "m15", "1h": "h1", "1d": "d1" };

export async function GET(req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  // Validate before the cache: an unbounded key space is a memory leak, and a bad id is a 400.
  if (!isAddress(id)) return badRequest("bad address");
  const key = new URL(req.url).searchParams.get("interval") ?? "15m";
  // hasOwn, not a truthiness check: `?interval=constructor` would otherwise reach the backend.
  if (!Object.hasOwn(INTERVALS, key)) return badRequest("bad interval");
  const interval = INTERVALS[key]!;
  try {
    return cached(await ttlCache(`candles:${id}:${interval}`, TTL * 1000, () => getBackend().candles(id, interval)), TTL);
  } catch (err) {
    return failure(err);
  }
}
