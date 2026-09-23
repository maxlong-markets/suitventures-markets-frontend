import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import { badRequest, cached, failure, isAddress } from "../../../_lib/respond";

export const dynamic = "force-dynamic";
/**
 * Design section 5. The in-process memo is short for every status, because the backend call behind it is
 * also what stamps a build request: a longer memo would swallow the re-stamps of a tab left open. The CDN
 * is what differs — a finished list may be held for a minute, but a list the tab is polling every 5 s must
 * not be, or the poll would read the same `building` long after the builder had finished.
 */
const MEMO_MS = 5_000;
const READY_TTL = 60;
const BUILDING_TTL = 5;

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  if (!isAddress(id)) return badRequest("bad address");
  try {
    const view = await ttlCache(`holders:${id}`, MEMO_MS, () => getBackend().holders(id));
    return cached(view, view.status === "ready" ? READY_TTL : BUILDING_TTL);
  } catch (err) {
    return failure(err);
  }
}
