import { getDb } from "@/lib/db/client";
import { allowWrite } from "@/lib/social/rateLimit";
import { WalletCapError, toggleVote } from "@/lib/social/store";
import { nowSec } from "@/lib/time";
import { badRequest, conflict, failure, isAddress, noStore, tooManyRequests } from "../../../_lib/respond";
import { requireSession } from "../../../_lib/session";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ address: string }> };

/** The toggle the app already has: the same direction clears, the other switches. Answers the new direction, or null. */
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
    return noStore({ dir: await toggleVote(getDb(), session.address, id, dir, now) });
  } catch (err) {
    // Only a vote on a token this wallet has never voted on can reach here: switching or clearing
    // one it already holds is never refused (review I4).
    if (err instanceof WalletCapError) return conflict("too many votes");
    return failure(err);
  }
}
