import type { Address, Candle, Denom, Holder, Interval, MarketsDataSource, Quote, QuoteAsset, Side, TokenPair, Trade, VoteDir } from "@/lib/types";
import type { PriceResult } from "@/lib/quote/price";
import { localQuote, poolFeePctFor } from "@/lib/quote";
import { LocalWatchStore } from "./localStore";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** The panel's tolerance as the route's integer basis points, clamped to its 1..5000 range. */
function toSlippageBps(pct: number): number {
  return Math.min(5000, Math.max(1, Math.round(pct * 100)));
}

/**
 * The typed text in the shape the route's `AMOUNT` regex accepts, using string operations only:
 * `Number()` here would round the digits the user typed, and that string becomes `toBase`'s input
 * and then the `amountIn` Permit2 transfers (Global Constraint 1). "1." → "1", ".5" → "0.5",
 * "0.50" → "0.5", "0001.5" → "1.5". Junk is left alone; the route answers 400 for it.
 */
function toRouteAmount(text: string): string {
  const [whole = "", fraction = ""] = text.trim().split(".");
  const w = whole.replace(/^0+(?=\d)/, "") || "0";
  const f = fraction.replace(/0+$/, "");
  return f === "" ? w : `${w}.${f}`;
}

/** Live data through the app's own route handlers (the only Envio clients). */
export class EnvioDataSource implements MarketsDataSource {
  readonly kind = "envio" as const;
  private readonly store = new LocalWatchStore();
  private pairsCache: { at: number; list: TokenPair[] } | null = null;

  async pairs(): Promise<TokenPair[]> {
    const list = await getJson<TokenPair[]>("/api/pairs");
    this.pairsCache = { at: Date.now(), list };
    return list;
  }
  async pair(id: string): Promise<TokenPair | null> {
    const key = id.toLowerCase();
    const res = await fetch(`/api/tokens/${key}`, { cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`/api/tokens/${key}: ${res.status}`);
    return (await res.json()) as TokenPair;
  }
  quotes(): Promise<QuoteAsset[]> {
    return getJson("/api/quotes");
  }
  candles(id: string, interval: Interval): Promise<Candle[]> {
    return getJson(`/api/tokens/${id}/candles?interval=${interval}`);
  }
  trades(id: string): Promise<Trade[]> {
    return getJson(`/api/tokens/${id}/trades`);
  }
  async holders(id: string): Promise<Holder[]> {
    return (await getJson<{ holders: Holder[] }>(`/api/tokens/${id}/holders`)).holders;
  }

  async quoteSwap(id: string, side: Side, amount: string, denom: Denom, isSuitHolder: boolean, slippagePct: number): Promise<Quote> {
    const fresh = this.pairsCache && Date.now() - this.pairsCache.at < 30_000 ? this.pairsCache.list : await this.pairs();
    // The cached list is capped at 500 rows (PAIRS_LIMIT): a token outside that window still has
    // a page (usePair falls back to pair(id) the same way), so a miss here must not be fatal —
    // only the route's own "no such token" verdict is.
    const pair = fresh.find((p) => p.id === id.toLowerCase()) ?? (await this.pair(id));
    if (!pair) throw new Error(`Unknown token ${id}`);

    // The panel asks at amount 0 so the rate and the fee rows render before any input; the
    // route requires amount > 0 and answers 400 below it. The local approximation answers
    // that one case, and carries no `call`, so nothing can be submitted from it. `typed` is
    // the only float here, and it decides a branch rather than an amount: a half-typed "."
    // is NaN, which reads as 0.
    const typed = Number(amount);
    if (!(typed > 0)) return localQuote(pair, side, Number.isFinite(typed) ? typed : 0, denom, isSuitHolder, slippagePct);

    const key = id.toLowerCase();
    const query = new URLSearchParams({
      side,
      amount: toRouteAmount(amount),
      denom,
      slippageBps: String(toSlippageBps(slippagePct)),
      holder: isSuitHolder ? "1" : "0",
    });
    const res = await fetch(`/api/tokens/${key}/quote?${query}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`/api/tokens/${key}/quote: ${res.status}`);
    const body = (await res.json()) as PriceResult;

    if (!body.routable) {
      // The panel replaces the whole form with the "Not routed" card, so none of these
      // numbers is ever rendered; zeroes are the honest placeholder for "no price exists".
      return {
        payAmount: 0,
        receiveAmount: 0,
        priceImpactPct: 0,
        routerFeePct: isSuitHolder ? 0 : 0.5,
        poolFeePct: poolFeePctFor(pair),
        minReceived: 0,
        routable: false,
      };
    }
    return {
      payAmount: Number(body.payAmount),
      receiveAmount: Number(body.receiveAmount),
      priceImpactPct: body.priceImpactPct,
      routerFeePct: body.routerFeePct,
      poolFeePct: body.poolFeePct,
      minReceived: Number(body.minReceived),
      routable: true,
      call: body.call,
    };
  }

  async watchlist(address: Address): Promise<string[]> {
    return this.store.watchlist(address);
  }
  async setWatch(address: Address, id: string, on: boolean, signature: string): Promise<void> {
    if (!signature) throw new Error("A session signature is required.");
    this.store.setWatch(address, id, on);
  }
  async votes(address: Address): Promise<Record<string, VoteDir>> {
    return this.store.votes(address);
  }
  async vote(address: Address, id: string, dir: VoteDir, signature: string): Promise<void> {
    if (!signature) throw new Error("A session signature is required.");
    this.store.vote(address, id, dir);
  }
}
