import type {
  Address,
  Candle,
  Denom,
  Holder,
  Interval,
  MarketsDataSource,
  Quote,
  QuoteAsset,
  Side,
  TokenPair,
  Trade,
  VoteDir,
} from "@/lib/types";
import { hash } from "@/lib/format";
import { localQuote } from "@/lib/quote";
import { hexAddr, hexBytes32, normal, rng } from "./random";
import { buildPairs, buildQuotes } from "./seed";

/**
 * Deterministic, seeded mock of the markets data layer. Shapes come from the
 * design prototype's generator so the app looks like the handoff captures.
 * Timestamps are relative to construction time, so ages, trade clocks and
 * candle times read correctly on any day.
 */

const CANDLES = 72;
const SIGMA: Record<Interval, number> = {
  "1m": 0.004,
  "5m": 0.008,
  "15m": 0.012,
  "1h": 0.02,
  "1d": 0.06,
};
const STEP_MS: Record<Interval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};
/** Starred out of the box; resolved to token ids in the constructor. */
const DEFAULT_WATCHLIST_TICKERS = ["SUIT", "AI"];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function storageKey(kind: "watch" | "votes", address: Address): string {
  return `svm:${kind}:${address.toLowerCase()}`;
}

function readStore<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStore(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or quota — the in-memory copy still works for the session.
  }
}

function requireSignature(signature: string): void {
  if (!signature) throw new Error("A session signature is required.");
}

function generateCandles(pair: TokenPair, interval: Interval, now: number): Candle[] {
  const r = rng(hash(`${pair.ticker}|${interval}`));
  const sig = SIGMA[interval];
  const step = STEP_MS[interval];
  const end = Math.floor(now / step) * step;
  const closes = new Array<number>(CANDLES);
  let c = pair.priceUsd;
  for (let i = CANDLES - 1; i >= 0; i--) {
    closes[i] = c;
    c = c / (1 + normal(r) * sig);
  }
  const base = pair.vol24h / (86_400_000 / step);
  const out: Candle[] = [];
  for (let i = 0; i < CANDLES; i++) {
    const o = i ? closes[i - 1] : closes[0] * (1 + normal(r) * sig);
    const close = closes[i];
    const h = Math.max(o, close) * (1 + Math.abs(normal(r)) * sig * 0.6);
    const l = Math.min(o, close) * (1 - Math.abs(normal(r)) * sig * 0.6);
    out.push({
      t: end - (CANDLES - 1 - i) * step,
      o,
      h,
      l,
      c: close,
      v: base * (0.35 + r() * 1.3),
    });
  }
  return out;
}

function generateTrades(pair: TokenPair, now: number): Trade[] {
  const r = rng(hash(`trades|${pair.ticker}`));
  const out: Trade[] = [];
  let t = now;
  for (let i = 0; i < 14; i++) {
    t -= Math.floor(r() * 90_000) + 4_000;
    const buy = r() > 0.42;
    const usd = r() < 0.8 ? r() * 900 + 20 : r() * 12_000 + 900;
    out.push({
      t,
      side: buy ? "buy" : "sell",
      amount: usd / pair.priceUsd,
      priceUsd: pair.priceUsd * (1 + normal(r) * 0.006),
      wallet: hexAddr(r),
      tx: hexBytes32(r),
    });
  }
  return out;
}

function generateHolders(pair: TokenPair): Holder[] {
  const r = rng(hash(`holders|${pair.ticker}`));
  const out: Holder[] = [];
  let remaining = 100;
  for (let i = 0; i < 10; i++) {
    const share =
      i === 0 ? r() * 6 + 4 : Math.max(0.3, remaining * 0.08 * (0.5 + r()));
    remaining -= share;
    const suit = r() > 0.75;
    out.push({
      wallet: hexAddr(r),
      balance: (1e9 * share) / 100,
      share,
      tag: i === 0 ? "Pool" : suit ? "Suit" : undefined,
    });
  }
  return out;
}

export interface MockOptions {
  /** Simulated network latency for list calls, so loading states are visible. */
  latencyMs?: number;
}

export class MockDataSource implements MarketsDataSource {
  readonly kind = "mock" as const;
  private readonly latencyMs: number;
  private readonly now: number;
  private readonly pairList: TokenPair[];
  private readonly quoteList: QuoteAsset[];
  private readonly candleCache = new Map<string, Candle[]>();
  private readonly tradeCache = new Map<string, Trade[]>();
  private readonly holderCache = new Map<string, Holder[]>();
  private readonly watchBook = new Map<string, string[]>();
  private readonly voteBook = new Map<string, Record<string, VoteDir>>();
  private readonly defaultWatchlist: string[];

  constructor(opts: MockOptions = {}) {
    this.latencyMs = opts.latencyMs ?? 350;
    this.now = Date.now();
    this.pairList = buildPairs(this.now);
    this.quoteList = buildQuotes(this.pairList);
    this.defaultWatchlist = DEFAULT_WATCHLIST_TICKERS.flatMap((t) =>
      this.pairList.filter((p) => p.ticker === t).map((p) => p.id),
    );
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
  }

  private pairOrThrow(id: string): TokenPair {
    const key = id.toLowerCase();
    const found = this.pairList.find((p) => p.id === key);
    if (!found) throw new Error(`Unknown pair: ${id}`);
    return found;
  }

  /** The list's own row, or null: the mock never knows a token outside its seed. */
  async pair(id: string): Promise<TokenPair | null> {
    await this.delay();
    const found = this.pairList.find((p) => p.id === id.toLowerCase());
    return found ? { ...found } : null;
  }

  async quotes(): Promise<QuoteAsset[]> {
    await this.delay();
    return this.quoteList.map((q) => ({ ...q }));
  }

  async pairs(): Promise<TokenPair[]> {
    await this.delay();
    return this.pairList.map((p) => ({ ...p }));
  }

  async candles(id: string, interval: Interval): Promise<Candle[]> {
    const pair = this.pairOrThrow(id);
    const key = `${pair.id}|${interval}`;
    let out = this.candleCache.get(key);
    if (!out) {
      out = generateCandles(pair, interval, this.now);
      this.candleCache.set(key, out);
    }
    await this.delay();
    return out.map((c) => ({ ...c }));
  }

  async trades(id: string): Promise<Trade[]> {
    const pair = this.pairOrThrow(id);
    let out = this.tradeCache.get(pair.id);
    if (!out) {
      out = generateTrades(pair, this.now);
      this.tradeCache.set(pair.id, out);
    }
    await this.delay();
    return out.map((t) => ({ ...t }));
  }

  async holders(id: string): Promise<Holder[]> {
    const pair = this.pairOrThrow(id);
    let out = this.holderCache.get(pair.id);
    if (!out) {
      out = generateHolders(pair);
      this.holderCache.set(pair.id, out);
    }
    await this.delay();
    return out.map((h) => ({ ...h }));
  }

  /**
   * The seeded approximation, deliberately not the quote route: every mock token is a
   * pseudo-random address no backend knows, so `/api/tokens/{id}/quote` would 404 for all
   * of them and the demo build's panel would break. The result therefore carries no `call`,
   * which the panel reads as "nothing can be submitted" — the state a build with no
   * NEXT_PUBLIC_SVROUTER_ADDRESS is already in.
   *
   * `amount` is the typed string (ruling 11); this is one of the two float models allowed to
   * parse it, because nothing it computes ever reaches the chain. A half-typed "." is NaN,
   * which reads as 0.
   */
  async quoteSwap(
    id: string,
    side: Side,
    amount: string,
    denom: Denom,
    isSuitHolder: boolean,
    slippagePct: number,
  ): Promise<Quote> {
    const typed = Number(amount);
    return localQuote(
      this.pairOrThrow(id),
      side,
      Number.isFinite(typed) ? typed : 0,
      denom,
      isSuitHolder,
      slippagePct,
    );
  }

  private loadWatch(address: Address): string[] {
    const key = address.toLowerCase();
    let list = this.watchBook.get(key);
    if (!list) {
      list =
        readStore<string[]>(storageKey("watch", address)) ?? [
          ...this.defaultWatchlist,
        ];
      this.watchBook.set(key, list);
    }
    return list;
  }

  async watchlist(address: Address): Promise<string[]> {
    await this.delay();
    return [...this.loadWatch(address)];
  }

  async setWatch(
    address: Address,
    id: string,
    on: boolean,
    signature: string,
  ): Promise<void> {
    requireSignature(signature);
    const list = this.loadWatch(address);
    const next = on
      ? list.includes(id)
        ? list
        : [...list, id]
      : list.filter((t) => t !== id);
    this.watchBook.set(address.toLowerCase(), next);
    writeStore(storageKey("watch", address), next);
    await this.delay();
  }

  private loadVotes(address: Address): Record<string, VoteDir> {
    const key = address.toLowerCase();
    let book = this.voteBook.get(key);
    if (!book) {
      book = readStore<Record<string, VoteDir>>(storageKey("votes", address)) ?? {};
      this.voteBook.set(key, book);
    }
    return book;
  }

  async votes(address: Address): Promise<Record<string, VoteDir>> {
    await this.delay();
    return { ...this.loadVotes(address) };
  }

  async vote(
    address: Address,
    id: string,
    dir: VoteDir,
    signature: string,
  ): Promise<void> {
    requireSignature(signature);
    const pair = this.pairOrThrow(id);
    const book = { ...this.loadVotes(address) };
    const prev = book[pair.id];
    if (prev) pair[prev] -= 1;
    if (prev === dir) {
      delete book[pair.id];
    } else {
      book[pair.id] = dir;
      pair[dir] += 1;
    }
    this.voteBook.set(address.toLowerCase(), book);
    writeStore(storageKey("votes", address), book);
    await this.delay();
  }
}
