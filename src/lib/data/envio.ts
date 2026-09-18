import { createSiweMessage } from "viem/siwe";
import type { Address, Candle, Denom, Holder, Interval, MarketsDataSource, Quote, QuoteAsset, Side, SignMessage, TokenPair, Trade, TraderRow, TradersBy, VoteDir } from "@/lib/types";
import type { PriceResult } from "@/lib/quote/price";
import { robinhoodChain } from "@/lib/chain";
import { localQuote, poolFeePctFor } from "@/lib/quote";
import { SIWE_STATEMENT } from "@/lib/session/siwe";

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

/**
 * How long the signed message stays valid. The server's cookie lives exactly as long
 * (`SESSION_TTL_SEC` in `src/lib/session/cookie.ts`); the number is repeated rather than imported
 * because that module reads `SESSION_SECRET` and must never be resolvable from a client bundle.
 */
const SIGN_IN_TTL_MS = 7 * 86_400 * 1000;

/**
 * The route answered 503 because no market store is configured. Its own class, not a message to
 * match on: the board prints one sentence for this and a different one for a request that failed,
 * and a string comparison is exactly the kind of thing that stops matching without anyone noticing.
 */
export class StoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreUnavailableError";
  }
}

/** Live data through the app's own route handlers (the only Envio clients). */
export class EnvioDataSource implements MarketsDataSource {
  readonly kind = "envio" as const;
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

  async traders(by: TradersBy): Promise<TraderRow[]> {
    const res = await fetch(`/api/traders?by=${by}`, { cache: "no-store" });
    if (res.status === 503) throw new StoreUnavailableError("traders board needs the market store");
    if (!res.ok) throw new Error(`/api/traders: ${res.status}`);
    return (await res.json()) as TraderRow[];
  }

  // --- The signed-in user's own data ------------------------------------
  // Every request below is same-origin, so `fetch` sends and stores `svm_session` on its own;
  // `credentials: "same-origin"` is the default and is written out to say that it is load-bearing.
  //
  // A read answers empty for 401 and 503 instead of throwing: a cookie that lapsed between the
  // page load and a refetch must not put an error card over the markets table, and an empty
  // watchlist is exactly what a signed-out user already sees. A write throws on any refusal,
  // because `AppState` has already painted the star and needs its invalidate to undo it.

  async watchlist(): Promise<string[]> {
    const res = await fetch("/api/me/watchlist", { cache: "no-store", credentials: "same-origin" });
    if (res.status === 401 || res.status === 503) return [];
    if (!res.ok) throw new Error(`/api/me/watchlist: ${res.status}`);
    return (await res.json()) as string[];
  }

  async setWatch(id: string, on: boolean): Promise<void> {
    const res = await fetch(`/api/me/watchlist/${id.toLowerCase()}`, {
      method: on ? "PUT" : "DELETE",
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`/api/me/watchlist: ${res.status}`);
  }

  async votes(): Promise<Record<string, VoteDir>> {
    const res = await fetch("/api/me/votes", { cache: "no-store", credentials: "same-origin" });
    if (res.status === 401 || res.status === 503) return {};
    if (!res.ok) throw new Error(`/api/me/votes: ${res.status}`);
    return (await res.json()) as Record<string, VoteDir>;
  }

  async vote(id: string, dir: VoteDir): Promise<VoteDir | null> {
    const res = await fetch(`/api/me/votes/${id.toLowerCase()}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir }),
    });
    if (!res.ok) throw new Error(`/api/me/votes: ${res.status}`);
    return ((await res.json()) as { dir: VoteDir | null }).dir;
  }

  // --- Session ----------------------------------------------------------

  /**
   * 503 reads as null, not as a failure: `SESSION_SECRET` unset means "nobody can be signed in",
   * and the whole read-only app must keep working around it (spec section 2).
   */
  async session(): Promise<Address | null> {
    const res = await fetch("/api/session", { cache: "no-store", credentials: "same-origin" });
    if (res.status === 401 || res.status === 503) return null;
    if (!res.ok) throw new Error(`/api/session: ${res.status}`);
    return ((await res.json()) as { address: Address }).address;
  }

  /**
   * Sign-In with Ethereum, EIP-4361. The server issues the nonce and holds its HMAC in `svm_nonce`,
   * so a message this client made up cannot be replayed; `domain` and `uri` come from the page the
   * user is actually looking at, which is what the server checks the message against.
   */
  async signIn(sign: SignMessage, address: Address): Promise<Address> {
    // A direct fetch, not the shared `getJson`: this is the one read in the sign-in flow whose
    // cookie (`svm_nonce`) the POST below must echo back, so it keeps its own explicit
    // `credentials` rather than inheriting whatever `getJson` does for the public reads that
    // also call it.
    const nonceRes = await fetch("/api/session/nonce", { cache: "no-store", credentials: "same-origin" });
    if (!nonceRes.ok) throw new Error(`/api/session/nonce: ${nonceRes.status}`);
    const { nonce } = (await nonceRes.json()) as { nonce: string };
    const issuedAt = new Date();
    const message = createSiweMessage({
      address,
      chainId: robinhoodChain.id,
      domain: window.location.host,
      uri: window.location.origin,
      statement: SIWE_STATEMENT,
      version: "1",
      nonce,
      issuedAt,
      expirationTime: new Date(issuedAt.getTime() + SIGN_IN_TTL_MS),
    });
    const signature = await sign(message);
    const res = await fetch("/api/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    });
    if (!res.ok) throw new Error(`/api/session: ${res.status}`);
    // The address the server put in the cookie, lowercase — not the one we asked for.
    return ((await res.json()) as { address: Address }).address;
  }

  async signOut(): Promise<void> {
    const res = await fetch("/api/session", { method: "DELETE", credentials: "same-origin" });
    // 401 is "already signed out", which is the state the caller wanted.
    if (!res.ok && res.status !== 401) throw new Error(`/api/session: ${res.status}`);
  }
}
