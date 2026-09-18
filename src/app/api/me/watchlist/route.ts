import { getDb } from "@/lib/db/client";
import { watchlist } from "@/lib/social/store";
import { failure, noStore } from "../../_lib/respond";
import { requireSession } from "../../_lib/session";

export const dynamic = "force-dynamic";

/** The signed-in wallet's starred token ids. The client never sends an address: the cookie is the identity. */
export async function GET(req: Request) {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  try {
    return noStore(await watchlist(getDb(), session.address));
  } catch (err) {
    return failure(err);
  }
}
