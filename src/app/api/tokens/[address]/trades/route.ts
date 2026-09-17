import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import { badRequest, cached, failure, isAddress } from "../../../_lib/respond";

export const dynamic = "force-dynamic";
const TTL = 10;

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  if (!isAddress(id)) return badRequest("bad address");
  try {
    return cached(await ttlCache(`trades:${id}`, TTL * 1000, () => getBackend().trades(id)), TTL);
  } catch (err) {
    return failure(err);
  }
}
