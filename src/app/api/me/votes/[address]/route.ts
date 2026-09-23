import { getDb } from "@/lib/db/client";
import { rememberCounts } from "@/lib/social/countsCache";
import { allowWrite } from "@/lib/social/rateLimit";
import { WalletCapError, toggleVote } from "@/lib/social/store";
import { nowSec } from "@/lib/time";
import { badRequest, conflict, failure, isAddress, noStore, tooManyRequests } from "../../../_lib/respond";
import { requireSession } from "../../../_lib/session";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ address: string }> };

/**
 * The toggle the app already has: the same direction clears, the other switches. Answers the new
 * direction (or null) *and* the token's counts as the writing transaction read them, so the client
 * has an authoritative number to paint and never has to ask a cache that is older than its own
 * write for it (the 23 Sep report).
 */
export async function POST(req: Request, ctx: Ctx) {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const now = nowSec();
  if (!allowWrite(session.address, now)) return tooManyRequests();
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  if (!isAddress(id)) return badRequest("bad address");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("bad body");
  }
  const dir = (body as { dir?: unknown } | null)?.dir;
  if (dir !== "bull" && dir !== "bear") return badRequest("bad direction");
  try {
    const { dir: standing, counts } = await toggleVote(getDb(), session.address, id, dir, now);
    // Every reader of this token's counts goes through the same thirty-second cache, so the entry
    // is replaced here rather than left to expire: without it the write is invisible to the very
    // refetch the client makes after it.
    rememberCounts(id, counts, now);
    return noStore({ dir: standing, bull: counts.bull, bear: counts.bear });
  } catch (err) {
    // Only a vote on a token this wallet has never voted on can reach here: switching or clearing
    // one it already holds is never refused (review I4).
    if (err instanceof WalletCapError) return conflict("too many votes");
    return failure(err);
  }
}
