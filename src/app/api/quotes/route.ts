import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import { cached, failure } from "../_lib/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const TTL = 30;

export async function GET() {
  try {
    return cached(await ttlCache("quotes", TTL * 1000, () => getBackend().quotes()), TTL);
  } catch (err) {
    return failure(err);
  }
}
