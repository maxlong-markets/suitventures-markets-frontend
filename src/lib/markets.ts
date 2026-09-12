import type { Launchpad, TokenPair } from "./types";

/** Pure filter/sort logic for the Markets and Watchlist tables. */

export type PresetKey = "all" | "volume" | "gainers" | "new" | "holders";
export type SortKey =
  | "rank"
  | "ticker"
  | "price"
  | "h1"
  | "h24"
  | "vol"
  | "mcap"
  | "fdv"
  | "liq"
  | "holders"
  | "age";
export type SortDir = "asc" | "desc";
export type LaunchpadFilter = "all" | Launchpad;

export interface Preset {
  key: PresetKey;
  label: string;
  sort: SortKey;
  dir: SortDir;
}

export const PRESETS: readonly Preset[] = [
  { key: "all", label: "All", sort: "vol", dir: "desc" },
  { key: "volume", label: "Top volume", sort: "vol", dir: "desc" },
  { key: "gainers", label: "Gainers", sort: "h24", dir: "desc" },
  { key: "new", label: "New", sort: "age", dir: "asc" },
  { key: "holders", label: "Most holders", sort: "holders", dir: "desc" },
];

export const LAUNCHPAD_OPTIONS: ReadonlyArray<{
  key: LaunchpadFilter;
  label: string;
}> = [
  { key: "all", label: "All" },
  { key: "LONG", label: "LONG" },
  { key: "Pons", label: "PONS" },
  { key: "Bags", label: "BAGS" },
  { key: "SV", label: "SV" },
];

export interface MarketFilters {
  quotes: string[];
  launchpad: LaunchpadFilter;
  preset: PresetKey;
  sortKey: SortKey;
  sortDir: SortDir;
  query: string;
}

export const DEFAULT_FILTERS: MarketFilters = {
  quotes: [],
  launchpad: "all",
  preset: "all",
  sortKey: "vol",
  sortDir: "desc",
  query: "",
};

const NEW_MAX_AGE_MS = 7 * 86_400_000;
const GAINERS_MIN_LIQUIDITY = 10_000;

/** Default direction on first click: desc, except Age and Token asc. */
export function defaultDir(key: SortKey): SortDir {
  return key === "age" || key === "ticker" ? "asc" : "desc";
}

export function toggleSort(f: MarketFilters, key: SortKey): MarketFilters {
  const sortDir =
    f.sortKey === key ? (f.sortDir === "desc" ? "asc" : "desc") : defaultDir(key);
  return { ...f, sortKey: key, sortDir };
}

export function applyPreset(f: MarketFilters, key: PresetKey): MarketFilters {
  const preset = PRESETS.find((p) => p.key === key) ?? PRESETS[0];
  return { ...f, preset: preset.key, sortKey: preset.sort, sortDir: preset.dir };
}

export function presetLabel(key: PresetKey): string {
  return PRESETS.find((p) => p.key === key)?.label ?? "";
}

export function matchesQuery(p: TokenPair, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    p.ticker.toLowerCase().includes(q) ||
    p.name.toLowerCase().includes(q) ||
    p.address.toLowerCase().includes(q)
  );
}

export interface SelectOptions {
  /** Restrict to these tickers (the watchlist). */
  only?: ReadonlySet<string>;
}

export function filterPairs(
  pairs: readonly TokenPair[],
  f: MarketFilters,
  now: number,
  opts: SelectOptions = {},
): TokenPair[] {
  const quotes = f.quotes.length ? new Set(f.quotes) : null;
  const out: TokenPair[] = [];
  for (const p of pairs) {
    if (opts.only && !opts.only.has(p.ticker)) continue;
    if (quotes && !quotes.has(p.quote)) continue;
    if (f.launchpad !== "all" && p.launchpad !== f.launchpad) continue;
    if (!matchesQuery(p, f.query)) continue;
    if (
      f.preset === "gainers" &&
      !(p.change24h > 0 && p.liquidity > GAINERS_MIN_LIQUIDITY)
    )
      continue;
    if (f.preset === "new" && now - p.createdAt > NEW_MAX_AGE_MS) continue;
    out.push(p);
  }
  return out;
}

function sortValue(p: TokenPair, key: SortKey, now: number): number | string {
  switch (key) {
    case "ticker":
      return p.ticker;
    case "price":
      return p.priceUsd;
    case "h1":
      return p.change1h;
    case "h24":
      return p.change24h;
    case "mcap":
      return p.mcap;
    case "fdv":
      return p.fdv;
    case "liq":
      return p.liquidity;
    case "holders":
      return p.holders;
    case "age":
      return now - p.createdAt;
    case "rank":
    case "vol":
    default:
      return p.vol24h;
  }
}

export function sortPairs(
  pairs: readonly TokenPair[],
  key: SortKey,
  dir: SortDir,
  now: number,
): TokenPair[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...pairs].sort((a, b) => {
    const av = sortValue(a, key, now);
    const bv = sortValue(b, key, now);
    let c: number;
    if (typeof av === "string" && typeof bv === "string") {
      c = av.localeCompare(bv);
    } else {
      c = (av as number) - (bv as number);
    }
    if (c !== 0) return sign * c;
    return b.vol24h - a.vol24h;
  });
}

export function selectPairs(
  pairs: readonly TokenPair[],
  f: MarketFilters,
  now: number,
  opts: SelectOptions = {},
): TokenPair[] {
  return sortPairs(filterPairs(pairs, f, now, opts), f.sortKey, f.sortDir, now);
}
