import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import { priceSwap, type PriceResult } from "@/lib/quote/price";
import { QuoterUnavailableError, createQuoter } from "@/lib/quote/quoter";
import type { Denom, Side } from "@/lib/types";
import { badRequest, failure, isAddress } from "../../../_lib/respond";

/** A price is never a CDN fact: the route is dynamic and every answer is no-store. */
export const dynamic = "force-dynamic";
/** Two quoter simulations plus one store read, comfortably inside the platform's limit. */
export const maxDuration = 15;

/** D28: how long one pool's *positive* routability verdict stands, in this process only. */
const ROUTABLE_TTL_MS = 300_000;
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
    const pool = await getBackend().poolKey(id);
    if (!pool) return answer({ error: "no listed pool" }, 404);

    const request = { side, amount, denom, slippageBps, holder: holder === "1", pool };
    const quoter = createQuoter();
    // The quote for this pool prices inside the loader and records only the verdict; no priced
    // answer is ever kept. The loader returns `true` for a pool the quoter priced and `undefined`
    // for a refusal — and `ttlCache` stores nothing for `undefined`, because the quoter also
    // refuses an amount this pool's liquidity cannot serve and the key is the pool alone. One
    // dust-sized keystroke must never lock a live pool out for five minutes (ruling 6).
    const probe: { priced: PriceResult | null } = { priced: null };
    const routable = await ttlCache<true | undefined>(`routable:${pool.poolId}`, ROUTABLE_TTL_MS, async () => {
      const priced = await priceSwap(quoter, request);
      probe.priced = priced;
      return priced.routable ? true : undefined;
    });
    // `probe.priced` is null only when the cached `true` short-circuited the loader.
    if (!routable) return answer(probe.priced ?? { routable: false });
    return answer(probe.priced ?? (await priceSwap(quoter, request)));
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
