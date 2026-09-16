import { loadPairs, PAIRS_TTL, type PairsScope } from "@/lib/envio/pairs";
import { cached, failure } from "../_lib/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const scope: PairsScope = new URL(req.url).searchParams.get("scope") === "launchpad" ? "launchpad" : "all";
  try {
    return cached(await loadPairs(scope), PAIRS_TTL);
  } catch (err) {
    return failure(err);
  }
}
