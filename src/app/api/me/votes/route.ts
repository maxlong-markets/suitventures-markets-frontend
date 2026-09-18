import { getDb } from "@/lib/db/client";
import { votes } from "@/lib/social/store";
import { failure, noStore } from "../../_lib/respond";
import { requireSession } from "../../_lib/session";

export const dynamic = "force-dynamic";

/** The signed-in wallet's own direction per token, so the token page renders the voted state after a reload. */
export async function GET(req: Request) {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  try {
    return noStore(await votes(getDb(), session.address));
  } catch (err) {
    return failure(err);
  }
}
