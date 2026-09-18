import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { allowWrite } from "@/lib/social/rateLimit";
import { WalletCapError, setWatch } from "@/lib/social/store";
import { nowSec } from "@/lib/time";
import { badRequest, conflict, failure, isAddress, tooManyRequests } from "../../../_lib/respond";
import { requireSession } from "../../../_lib/session";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ address: string }> };

/**
 * Session, then budget, then address, then the store. The budget is spent before the address is
 * checked on purpose: a client looping malformed writes is exactly what the cap is for. A request
 * with no session never reaches the counter, so nobody can spend another wallet's budget.
 */
async function write(req: Request, ctx: Ctx, on: boolean) {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const now = nowSec();
  if (!allowWrite(session.address, now)) return tooManyRequests();
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  if (!isAddress(id)) return badRequest("bad address");
  try {
    await setWatch(getDb(), session.address, id, on, now);
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    // The wallet is full, which is neither its fault this second nor a server fault: 409, so the
    // client can tell it apart from the 429 budget and the 503 outage (review I4).
    if (err instanceof WalletCapError) return conflict("watchlist full");
    return failure(err);
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  return write(req, ctx, true);
}

export async function DELETE(req: Request, ctx: Ctx) {
  return write(req, ctx, false);
}
