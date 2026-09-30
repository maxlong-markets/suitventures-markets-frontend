import type { Address, Candle, Holder, Origin, QuoteAsset, TokenPair, Trade } from "@/lib/types";
import type { BalanceRow, CandleRow, Numeric, QuotePriceRow, QuoteRow, SwapRow, TokenRow, WindowRow } from "./queries";

export const STALE_AFTER_SEC = 259_200; // 3 days: distinguishes a dead aggregator from an off-hours hold
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const DYNAMIC_FEE_FLAG = 8388608;
const ORIGINS = new Set<Origin>(["LONG", "Pons", "Uniswap", "Other", "SUIT", "SV"]);

/**
 * Every Float-derived column arrives from Hasura as a string. `+` would concatenate them,
 * so nothing may read one of these fields without passing it through here first.
 */
export const num = (v: Numeric): number => (typeof v === "number" ? v : Number(v));

/** A pool parked at a tick boundary quotes ~3.4e50 or ~0; both are unusable as a price. Structural, so a narrower row can be checked too. */
export function isSanePool(p: { priceQuote: Numeric }): boolean {
  const q = num(p.priceQuote);
  return q > 1e-24 && q < 1e18;
}

/** The indexer's TVL-ranked `primaryPool` is wrong for 1000+ tokens; prefer it only when it prices sanely. Generic so POOL_KEY_QUERY's narrower rows use the same rule. */
export function resolvePool<P extends { priceQuote: Numeric }>(t: { primaryPool: P | null; fallbackPool?: P[] }): P | null {
  if (t.primaryPool && isSanePool(t.primaryPool)) return t.primaryPool;
  const fallback = t.fallbackPool?.[0];
  return fallback && isSanePool(fallback) ? fallback : null;
}

export function toOrigin(s: string): Origin {
  return ORIGINS.has(s as Origin) ? (s as Origin) : "Other";
}

export function units(raw: string | null, decimals: number): number | null {
  if (raw === null) return null;
  return Number(BigInt(raw)) / 10 ** decimals;
}

export function hookLabel(origin: Origin): string {
  switch (origin) {
    case "LONG":
      return "Doppler shared v4 hook";
    case "Pons":
      return "Pons MemeHook · afterSwap";
    case "Other":
      return "Unknown hook";
    default:
      return "None";
  }
}

export function feeTierLabel(fee: number): string {
  return fee === DYNAMIC_FEE_FLAG ? "Dynamic" : `${(fee / 10_000).toFixed(2)}%`;
}

/** A pinned row (USDG) has a frozen updatedAt and is never stale; a real feed goes stale after 3 days. */
export function isStale(p: { updatedAt: number; aggregator: string }, nowSec: number): boolean {
  return p.aggregator !== "pinned" && nowSec - p.updatedAt > STALE_AFTER_SEC;
}

/** quote id → USD price, null when the feed is stale. */
export function usdMap(prices: QuotePriceRow[], nowSec: number): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const p of prices) m.set(p.id, isStale(p, nowSec) ? null : num(p.usdPrice));
  return m;
}

export type WindowStats = { ref1h: number | null; ref24h: number | null; vol24h: number };

const HOUR = 3600;
const DAY = 86400;

/** Price at time t from h1 candles: the open of t's hour bucket, else the last close before that bucket, else null. */
function refAt(rows: WindowRow[], t: number): number | null {
  const bucket = Math.floor(t / HOUR) * HOUR;
  const exact = rows.find((r) => r.t === bucket);
  if (exact) return num(exact.open);
  let last: WindowRow | undefined;
  for (const r of rows) if (r.t < bucket && (!last || r.t > last.t)) last = r;
  return last ? num(last.close) : null;
}

/** Per-pool 1h and 24h reference prices and 24h quote volume from that pool's h1 candles, in any order. */
export function windowStats(rows: WindowRow[], nowSec: number): Map<string, WindowStats> {
  const byPool = new Map<string, WindowRow[]>();
  for (const r of rows) {
    const list = byPool.get(r.pool_id) ?? [];
    list.push(r);
    byPool.set(r.pool_id, list);
  }
  const out = new Map<string, WindowStats>();
  for (const [poolId, list] of byPool) {
    let vol24h = 0;
    for (const r of list) if (r.t >= nowSec - DAY) vol24h += num(r.volumeQuote);
    out.set(poolId, { ref1h: refAt(list, nowSec - HOUR), ref24h: refAt(list, nowSec - DAY), vol24h });
  }
  return out;
}

export function shapePairs(
  tokens: TokenRow[],
  usd: Map<string, number | null>,
  windows: Map<string, WindowStats>,
): TokenPair[] {
  const out: TokenPair[] = [];
  for (const t of tokens) {
    const p = resolvePool(t);
    if (!p) continue;
    const priceQuote = num(p.priceQuote);
    const q = usd.get(p.quote_id) ?? null;
    const usdPrice = q ?? 0; // stale or unknown quote: USD figures read 0, liquidity null
    const priceUsd = priceQuote * usdPrice;
    const supply = Number(BigInt(t.totalSupply)) / 10 ** t.decimals;
    const tvlQuote = units(p.tvlQuote, p.quote.decimals);
    // Quote side only — see dbShape.pairFromRow for why (D43). These two must stay in step.
    const liquidity = q === null || tvlQuote === null ? null : tvlQuote * q;
    const w = windows.get(p.id);
    const ref1 = w?.ref1h ?? undefined;
    const ref24 = w?.ref24h ?? undefined;
    const origin = toOrigin(p.origin);
    out.push({
      id: t.id,
      ticker: t.symbol,
      name: t.name,
      address: t.address as `0x${string}`,
      // Same-origin proxy, resolved per token at request time; nothing on chain or in the
      // indexer carries a logo URL. A token without one answers 404 and the UI keeps its letter.
      logoUrl: `/api/tokens/${t.id}/logo`,
      quote: p.quote.symbol,
      origin,
      // A per-pool probe on every row of a 500-pair list is not acceptable (spec section 2), so
      // this default stays true for both pairs() and the un-probed base pair() builds; pair()
      // (envioBackend.ts) probes the one listed pool itself and overrides this afterwards.
      tradeable: true,
      priceUsd,
      priceQuote,
      change1h: ref1 !== undefined && ref1 > 0 ? (priceQuote / ref1 - 1) * 100 : null,
      change24h: ref24 !== undefined && ref24 > 0 ? (priceQuote / ref24 - 1) * 100 : null,
      vol24h: (w?.vol24h ?? 0) * usdPrice,
      mcap: priceUsd * supply,
      fdv: priceUsd * supply,
      liquidity,
      stale: q === null,
      holders: t.holdersCount,
      // The token's own age, as dbShape.pairFromRow: these two must stay in step.
      createdAt: Math.min(t.createdAt, p.createdAt) * 1000,
      bull: 0,
      bear: 0,
      poolId: p.id as `0x${string}`,
      hook: hookLabel(origin),
      hookAddress: p.hooks.toLowerCase() as Address,
      feeTier: feeTierLabel(p.fee),
    });
  }
  return out;
}

export function shapeQuotes(
  quotes: QuoteRow[],
  pairs: TokenPair[],
  usd: Map<string, number | null>,
  prices: QuotePriceRow[],
  nowSec: number,
): QuoteAsset[] {
  const bySymbol = new Map<string, { pairs: number; vol: number }>();
  for (const p of pairs) {
    const cur = bySymbol.get(p.quote) ?? { pairs: 0, vol: 0 };
    bySymbol.set(p.quote, { pairs: cur.pairs + 1, vol: cur.vol + p.vol24h });
  }
  const byId = new Map(prices.map((p) => [p.id, p]));
  return quotes.map((q) => ({
    symbol: q.symbol,
    name: q.name,
    address: q.address as `0x${string}`,
    decimals: q.decimals,
    usdPrice: usd.get(q.id) ?? 0,
    stale: (() => { const p = byId.get(q.id); return p ? isStale(p, nowSec) : true; })(),
    pairs: bySymbol.get(q.symbol)?.pairs ?? 0,
    vol24h: bySymbol.get(q.symbol)?.vol ?? 0,
  }));
}

/** Candles come newest-first from the query; the chart wants oldest-first, USD, ms. */
export function shapeCandles(rows: CandleRow[], usdAtTime: (t: number) => number | null): Candle[] {
  return [...rows]
    .sort((a, b) => a.t - b.t)
    .flatMap((c) => {
      const u = usdAtTime(c.t);
      // No USD price for this candle: an empty chart beats a chart drawn on the floor.
      if (u === null) return [];
      return [{ t: c.t * 1000, o: num(c.open) * u, h: num(c.high) * u, l: num(c.low) * u, c: num(c.close) * u, v: num(c.volumeQuote) * u }];
    });
}

export function shapeTrades(rows: SwapRow[], usd: number | null, _ticker: string): Trade[] {
  const u = usd ?? 0;
  return rows.map((s) => ({
    t: s.timestamp * 1000,
    side: s.side,
    amount: num(s.amountToken),
    priceUsd: num(s.priceQuote) * u,
    wallet: s.wallet as `0x${string}`,
    tx: s.txHash as `0x${string}`,
  }));
}

export function shapeHolders(rows: BalanceRow[], decimals: number, totalSupply: bigint): Holder[] {
  return rows.map((b) => {
    const bal = BigInt(b.balance);
    // Percent as fixed point: scale by 1e10 before the integer divide, so a share keeps
    // eight decimals instead of truncating to four.
    const share = totalSupply > 0n ? Number((bal * 10_000_000_000n) / totalSupply) / 100_000_000 : 0;
    return {
      wallet: b.holder as `0x${string}`,
      balance: Number(bal) / 10 ** decimals,
      share,
      tag: b.holder.toLowerCase() === POOL_MANAGER ? "Pool" : undefined,
    };
  });
}
