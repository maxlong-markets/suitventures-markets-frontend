import type { Address, Candle, Denom, Holder, Interval, MarketsDataSource, Quote, QuoteAsset, Side, TokenPair, Trade, VoteDir } from "@/lib/types";
import { localQuote } from "@/lib/quote";
import { LocalWatchStore } from "./localStore";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
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

  async quoteSwap(id: string, side: Side, amount: number, denom: Denom, isSuitHolder: boolean, slippagePct: number): Promise<Quote> {
    const fresh = this.pairsCache && Date.now() - this.pairsCache.at < 30_000 ? this.pairsCache.list : await this.pairs();
    const pair = fresh.find((p) => p.id === id.toLowerCase());
    if (!pair) throw new Error(`Unknown token ${id}`);
    return localQuote(pair, side, amount, denom, isSuitHolder, slippagePct);
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
