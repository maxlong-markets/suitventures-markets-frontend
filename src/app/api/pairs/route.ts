import { PAIRS_TTL, type PairsScope } from "@/lib/envio/pairs";
import { getBackend } from "@/lib/market/backend";
import { withVoteCounts } from "../_lib/counts";
import { cached, failure } from "../_lib/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const scope: PairsScope = new URL(req.url).searchParams.get("scope") === "launchpad" ? "launchpad" : "all";
  try {
    // After the backend's own memo, so the pairs cache stays backend-agnostic and one cached list can serve any counts.
    return cached(await withVoteCounts(await getBackend().pairs(scope)), PAIRS_TTL);
  } catch (err) {
    return failure(err);
  }
}
