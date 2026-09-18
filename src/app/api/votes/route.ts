import { MAX_VOTE_IDS } from "@/lib/social/store";
import { VOTES_TTL, voteCountsFor } from "../_lib/counts";
import { badRequest, cached, failure, isAddress } from "../_lib/respond";

export const dynamic = "force-dynamic";

/**
 * Public bull/bear counts for up to 500 tokens: `?ids=a,b,…`. Ids are lowercased first, exactly as
 * the token route lowercases its path segment, so a checksummed id is accepted and every key in the
 * answer is the lowercase id the store uses. Without a database the counts are zeros, never an error.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0))];
  if (ids.length > MAX_VOTE_IDS) return badRequest("too many ids");
  if (!ids.every((id) => isAddress(id))) return badRequest("bad ids");
  try {
    return cached(await voteCountsFor(ids), VOTES_TTL);
  } catch (err) {
    return failure(err);
  }
}
