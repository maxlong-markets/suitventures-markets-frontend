import { NextResponse } from "next/server";
import { getBackend } from "@/lib/market/backend";
import { priceSwap } from "@/lib/quote/price";
import { QuoterUnavailableError, createQuoter } from "@/lib/quote/quoter";
import type { Denom, Side } from "@/lib/types";
import { badRequest, failure, isAddress } from "../../../_lib/respond";

/** A price is never a CDN fact: the route is dynamic and every answer is no-store. */
export const dynamic = "force-dynamic";
/** Two quoter simulations plus one store read, comfortably inside the platform's limit. */
export const maxDuration = 15;

const AMOUNT = /^\d+(\.\d+)?$/;
const INTEGER = /^\d+$/;
const NO_STORE = { "Cache-Control": "no-store" };

function answer(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function GET(req: Request, ctx: { params: Promise<{ address: string }> }): Promise<Response> {
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  if (!isAddress(id)) return badRequest("bad address");

  const params = new URL(req.url).searchParams;
  // Cast before the check, not after: a bare `string | null` cannot be narrowed to a literal
  // union by elimination, so the runtime `!==` chain below is what actually validates the value.
  const side = params.get("side") as Side | null;
  if (side !== "buy" && side !== "sell") return badRequest("bad side");
  const denom = params.get("denom") as Denom | null;
  if (denom !== "quote" && denom !== "token") return badRequest("bad denom");
  const amount = params.get("amount") ?? "";
  if (!AMOUNT.test(amount) || Number(amount) <= 0) return badRequest("bad amount");
  const slippage = params.get("slippageBps") ?? "";
  const slippageBps = Number(slippage);
  if (!INTEGER.test(slippage) || slippageBps < 1 || slippageBps > 5000) return badRequest("bad slippageBps");
  const holder = params.get("holder") ?? "0";
  if (holder !== "0" && holder !== "1") return badRequest("bad holder");

  try {
    const backend = getBackend();
    // The trading pool must carry the same quote asset as the pair this token is presented in
    // (C2), or the panel would label, balance-check and gate on one asset while the wallet signed
    // a Permit2 for another. pair() gives the quote SYMBOL (TokenPair.quote); quotes() — already
    // cached by the quotes route — maps it to the address poolKey() takes. Neither resolving is
    // any different from "no listed pool": both read as 404, same as poolKey() itself answering
    // null.
    const [pair, quoteAssets] = await Promise.all([backend.pair(id), backend.quotes()]);
    if (!pair) return answer({ error: "no listed pool" }, 404);
    const quoteAsset = quoteAssets.find((q) => q.symbol === pair.quote);
    if (!quoteAsset) return answer({ error: "no listed pool" }, 404);

    const pool = await backend.poolKey(id, quoteAsset.address.toLowerCase());
    if (!pool) return answer({ error: "no listed pool" }, 404);

    const request = { side, amount, denom, slippageBps, holder: holder === "1", pool, origin: pair.origin };
    const quoter = createQuoter();
    // Pricing runs per request, with nothing memoised across requests: two concurrent requests for
    // the same pool — the normal case in a debounced typing UI, not an edge case — must never share
    // one outcome (ruling 6). Sharing an in-flight *pricing* promise let a huge refused amount hand
    // `routable: false` to a concurrent request for a perfectly servable amount, with the quoter
    // called only once. Routability is decided by this same simulation on every quote (spec section
    // 3); nothing about it is cached at this layer.
    const priced = await priceSwap(quoter, request);
    return answer(priced);
  } catch (err) {
    // toBase() rejects anything the query validation let through; the user sees one message.
    if (err instanceof RangeError) return badRequest("bad amount");
    if (err instanceof QuoterUnavailableError) {
      // The quoter has already stripped the endpoint and the body from this (ruling 1); the
      // message is a class name, and this line adds nothing of its own. Rule 4.
      console.warn("quote rpc unavailable");
      return NextResponse.json(
        { error: "rpc unavailable" },
        { status: 503, headers: { ...NO_STORE, "Retry-After": "15" } },
      );
    }
    return failure(err);
  }
}
