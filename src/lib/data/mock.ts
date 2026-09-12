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
import { hexAddr, hexBytes32, normal, rng } from "./random";
import { buildPairs, buildQuotes, poolFeePct, quoteUsd } from "./seed";

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
const DEFAULT_WATCHLIST = ["SUIT", "AI"];

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

  constructor(opts: MockOptions = {}) {
    this.latencyMs = opts.latencyMs ?? 350;
    this.now = Date.now();
    this.pairList = buildPairs(this.now);
    this.quoteList = buildQuotes(this.pairList);
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
  }

  private pair(ticker: string): TokenPair {
    const key = ticker.toLowerCase();
    const found = this.pairList.find((p) => p.ticker.toLowerCase() === key);
    if (!found) throw new Error(`Unknown pair: ${ticker}`);
    return found;
  }

  async quotes(): Promise<QuoteAsset[]> {
    await this.delay();
    return this.quoteList.map((q) => ({ ...q }));
  }

  async pairs(): Promise<TokenPair[]> {
    await this.delay();
    return this.pairList.map((p) => ({ ...p }));
  }

  async candles(ticker: string, interval: Interval): Promise<Candle[]> {
    const pair = this.pair(ticker);
    const key = `${pair.ticker}|${interval}`;
    let out = this.candleCache.get(key);
    if (!out) {
      out = generateCandles(pair, interval, this.now);
      this.candleCache.set(key, out);
    }
    await this.delay();
    return out.map((c) => ({ ...c }));
  }

  async trades(ticker: string): Promise<Trade[]> {
    const pair = this.pair(ticker);
    let out = this.tradeCache.get(pair.ticker);
    if (!out) {
      out = generateTrades(pair, this.now);
      this.tradeCache.set(pair.ticker, out);
    }
    await this.delay();
    return out.map((t) => ({ ...t }));
  }

  async holders(ticker: string): Promise<Holder[]> {
    const pair = this.pair(ticker);
    let out = this.holderCache.get(pair.ticker);
    if (!out) {
      out = generateHolders(pair);
      this.holderCache.set(pair.ticker, out);
    }
    await this.delay();
    return out.map((h) => ({ ...h }));
  }

  async quoteSwap(
    ticker: string,
    side: Side,
    amount: number,
    denom: Denom,
    isSuitHolder: boolean,
    slippagePct: number,
  ): Promise<Quote> {
    const pair = this.pair(ticker);
    const pn = pair.priceQuote;
    const buy = side === "buy";
    let pay: number;
    let receive: number;
    if (buy) {
      if (denom === "quote") {
        pay = amount;
        receive = amount / pn;
      } else {
        receive = amount;
        pay = amount * pn;
      }
    } else if (denom === "token") {
      pay = amount;
      receive = amount * pn;
    } else {
      receive = amount;
      pay = amount / pn;
    }
    const payUsd = pay * (buy ? quoteUsd(pair.quote) : pair.priceUsd);
    // Constant-product approximation: impact against half the pool's USD depth.
    const impact = pair.liquidity ? (payUsd / (pair.liquidity / 2)) * 100 : 0;
    const poolFee = poolFeePct(pair.launchpad);
    return {
      payAmount: pay,
      receiveAmount: receive,
      priceImpactPct: impact,
      routerFeePct: isSuitHolder ? 0 : 0.5,
      poolFeePct: poolFee,
      minReceived: receive * (1 - slippagePct / 100 - poolFee / 100),
    };
  }

  private loadWatch(address: Address): string[] {
    const key = address.toLowerCase();
    let list = this.watchBook.get(key);
    if (!list) {
      list =
        readStore<string[]>(storageKey("watch", address)) ?? [
          ...DEFAULT_WATCHLIST,
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
    ticker: string,
    on: boolean,
    signature: string,
  ): Promise<void> {
    requireSignature(signature);
    const list = this.loadWatch(address);
    const next = on
      ? list.includes(ticker)
        ? list
        : [...list, ticker]
      : list.filter((t) => t !== ticker);
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
    ticker: string,
    dir: VoteDir,
    signature: string,
  ): Promise<void> {
    requireSignature(signature);
    const pair = this.pair(ticker);
    const book = { ...this.loadVotes(address) };
    const prev = book[pair.ticker];
    if (prev) pair[prev] -= 1;
    if (prev === dir) {
      delete book[pair.ticker];
    } else {
      book[pair.ticker] = dir;
      pair[dir] += 1;
    }
    this.voteBook.set(address.toLowerCase(), book);
    writeStore(storageKey("votes", address), book);
    await this.delay();
  }
}
