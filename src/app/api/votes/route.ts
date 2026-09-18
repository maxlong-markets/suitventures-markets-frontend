import { getDb, hasDb } from "@/lib/db/client";
import { countsFor } from "@/lib/social/countsCache";
import { MAX_VOTE_IDS, type VoteCount } from "@/lib/social/store";
import { nowSec } from "@/lib/time";
import { VOTES_TTL } from "../_lib/counts";
import { badRequest, cached, failure, isAddress } from "../_lib/respond";

export const dynamic = "force-dynamic";

/**
 * Public bull/bear counts for up to 500 tokens: `?ids=a,b,…`. Ids are lowercased first, exactly as
 * the token route lowercases its path segment, so a checksummed id is accepted and every key in the
 * answer is the lowercase id the store uses. Without a database the counts are zeros, never an error.
 * Counts come from the per-id cache (`countsFor`), not `ttlCache`: this route's id set is public and
 * caller-chosen, and a memo keyed by the whole set let every distinct set pin its own permanent,
 * never-evicted entry (Task 3 review I1).
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0))];
  if (ids.length > MAX_VOTE_IDS) return badRequest("too many ids");
  if (!ids.every((id) => isAddress(id))) return badRequest("bad ids");
  try {
    const counts: Record<string, VoteCount> = hasDb()
      ? await countsFor(getDb(), ids, nowSec())
      : Object.fromEntries(ids.map((id) => [id, { bull: 0, bear: 0 }]));
    return cached(counts, VOTES_TTL);
  } catch (err) {
    return failure(err);
  }
}
