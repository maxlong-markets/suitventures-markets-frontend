import type { Address, Origin, QuoteAsset, TokenPair } from "@/lib/types";
import { hash } from "@/lib/format";
import { hexAddr, hexBytes32, rng } from "./random";

/**
 * Seed data from the design handoff: the eight real pairs plus eight
 * placeholder pairs the prototype used for table density. Quote USD prices
 * and Pons pair counts are the Sep 10, 2026 snapshot.
 */

export const QUOTE_USD: Record<string, number> = {
  NVDA: 224.4,
  TSLA: 380.2,
  AAPL: 245.1,
  SPY: 655.3,
  HIMS: 48.6,
  SPCX: 210.0,
  PLTR: 178.4,
  ETH: 4480,
  USDG: 1,
};

/** Quote-token contracts on Robinhood Chain that are already known (project README §2). */
export const KNOWN_QUOTE_ADDRESSES: Record<string, Address> = {
  USDG: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  NVDA: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
  PLTR: "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a",
  TSLA: "0x322f0929c4625ed5bad873c95208d54e1c003b2d",
  AAPL: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
};

const QUOTE_DECIMALS: Record<string, number> = { USDG: 6, cbBTC: 8 };

/** [symbol, name, graduated-pair count] */
export const QUOTE_LIST: ReadonlyArray<readonly [string, string, number]> = [
  ["NVDA", "NVIDIA", 341],
  ["ETH", "Ether", 2770],
  ["USDG", "Global Dollar", 1247],
  ["SPY", "S&P 500 ETF", 231],
  ["GME", "GameStop", 184],
  ["DJT", "Trump Media", 157],
  ["RDDT", "Reddit", 116],
  ["QQQ", "Nasdaq 100 ETF", 103],
  ["AAPL", "Apple", 80],
  ["TSLA", "Tesla", 75],
  ["PLTR", "Palantir", 42],
  ["HIMS", "Hims & Hers", 38],
  ["SPCX", "SpaceX", 29],
  ["AMD", "Advanced Micro Devices", 27],
  ["MSFT", "Microsoft", 24],
  ["HOOD", "Robinhood", 22],
  ["COIN", "Coinbase", 19],
  ["MSTR", "Strategy", 17],
  ["AMZN", "Amazon", 15],
  ["GOOGL", "Alphabet", 14],
  ["META", "Meta Platforms", 12],
  ["CRCL", "Circle", 11],
  ["AI", "Artificial Inu", 9],
  ["cbBTC", "Coinbase Wrapped BTC", 7],
];

interface SeedToken {
  t: string;
  n: string;
  q: string;
  pad: Origin;
  p: number;
  h1: number;
  h24: number;
  vol: number;
  fdv: number;
  liq: number;
  holders: number;
  /** age in hours */
  age: number;
  bull: number;
  bear: number;
  addr?: Address;
  untradeable?: boolean;
  /** placeholder row, not one of the eight real pairs */
  ph?: boolean;
}

export const SEED_TOKENS: readonly SeedToken[] = [
  { t: "AI", n: "Artificial Inu", q: "NVDA", pad: "LONG", p: 0.1943, h1: -2.69, h24: -17.69, vol: 4180389, fdv: 192265217, liq: 5141337, holders: 18423, age: 1400, bull: 1240, bear: 388, addr: "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18" },
  { t: "SUIT", n: "The Suits", q: "NVDA", pad: "LONG", p: 0.00412, h1: 1.12, h24: 6.84, vol: 212640, fdv: 4108700, liq: 318200, holders: 2210, age: 960, bull: 402, bear: 19, addr: "0x87A78590D563F0EFC62192239af46707FFF74386" },
  { t: "SPACEHOOD", n: "Spacehood", q: "SPCX", pad: "LONG", p: 0.0328, h1: 4.21, h24: 31.6, vol: 1462300, fdv: 32800000, liq: 1204000, holders: 6120, age: 410, bull: 880, bear: 140 },
  { t: "BONER", n: "Boner Coin", q: "HIMS", pad: "LONG", p: 0.00891, h1: -0.84, h24: 12.4, vol: 684200, fdv: 8910000, liq: 402100, holders: 3480, age: 720, bull: 512, bear: 97 },
  { t: "MOO", n: "Moo", q: "TSLA", pad: "LONG", p: 0.0512, h1: 0.32, h24: -4.18, vol: 918400, fdv: 51200000, liq: 2210000, holders: 7940, age: 1900, bull: 640, bear: 210 },
  { t: "CASHCAT", n: "Cash Cat", q: "ETH", pad: "Pons", p: 0.00174, h1: -1.4, h24: -9.6, vol: 402300, fdv: 1740000, liq: 186400, holders: 1980, age: 300, bull: 220, bear: 88 },
  { t: "TENDIES", n: "Tendies", q: "ETH", pad: "Pons", p: 0.000612, h1: 2.9, h24: 44.2, vol: 388900, fdv: 612000, liq: 98200, holders: 1120, age: 38, bull: 310, bear: 42 },
  { t: "STONKBROKER", n: "Stonkbroker", q: "USDG", pad: "Other", p: 0.0000482, h1: 0, h24: -2.1, vol: 12400, fdv: 48200, liq: 9100, holders: 214, age: 14, bull: 12, bear: 9, untradeable: true },
  { t: "PRINTER", n: "Money Printer", q: "NVDA", pad: "Pons", p: 0.00263, h1: -3.1, h24: 8.2, vol: 264100, fdv: 2630000, liq: 141000, holders: 1640, age: 520, bull: 198, bear: 76, ph: true },
  { t: "GAINZ", n: "Gainz", q: "SPY", pad: "Pons", p: 0.0117, h1: -0.6, h24: -12.8, vol: 146800, fdv: 11700000, liq: 612000, holders: 2890, age: 2100, bull: 150, bear: 171, ph: true },
  { t: "DIAMONDHANDS", n: "Diamond Hands", q: "TSLA", pad: "Pons", p: 0.000934, h1: 1.8, h24: 3.3, vol: 98400, fdv: 934000, liq: 72400, holders: 860, age: 190, bull: 96, bear: 31, ph: true },
  { t: "WIFEMONEY", n: "Wife Changing Money", q: "AAPL", pad: "LONG", p: 0.00448, h1: 6.4, h24: 58.9, vol: 1120400, fdv: 4480000, liq: 284000, holders: 2410, age: 9, bull: 720, bear: 64, ph: true },
  { t: "YOLO", n: "Yolo", q: "USDG", pad: "Pons", p: 0.0000917, h1: -8.2, h24: -31.4, vol: 88200, fdv: 91700, liq: 22600, holders: 640, age: 66, bull: 44, bear: 120, ph: true },
  { t: "BAGHOLDER", n: "Bagholder", q: "ETH", pad: "Pons", p: 0.000338, h1: 0.1, h24: 0.9, vol: 41200, fdv: 338000, liq: 61000, holders: 1210, age: 3300, bull: 60, bear: 58, ph: true },
  { t: "CHALK", n: "Tailor's Chalk", q: "NVDA", pad: "SV", p: 0.00092, h1: 2.2, h24: 14.6, vol: 176300, fdv: 920000, liq: 118000, holders: 530, age: 2, bull: 140, bear: 11, ph: true },
  { t: "PLTRCHAD", n: "Palantir Chad", q: "PLTR", pad: "LONG", p: 0.0219, h1: -0.3, h24: 2.4, vol: 312900, fdv: 21900000, liq: 1480000, holders: 4100, age: 1250, bull: 380, bear: 150, ph: true },
];

/** Circulating ratio for mcap = FDV × ratio (default 1). */
const CIRC: Record<string, number> = { SUIT: 0.62, CHALK: 0.55, WIFEMONEY: 0.9 };

export const PLACEHOLDER_TICKERS: ReadonlySet<string> = new Set(
  SEED_TOKENS.filter((t) => t.ph).map((t) => t.t),
);

export const HOOK_BY_ORIGIN: Record<Origin, string> = {
  LONG: "Doppler shared v4 hook",
  Pons: "Pons MemeHook · afterSwap",
  Uniswap: "None",
  SUIT: "None",
  SV: "None",
  Other: "Unknown hook",
};

export const FEE_TIER_BY_ORIGIN: Record<Origin, string> = {
  LONG: "Dynamic · 0.30% now",
  Pons: "1.00% hook fee",
  Uniswap: "0.30%",
  SUIT: "0.30%",
  SV: "0.30%",
  Other: "0.30%",
};

export function quoteUsd(symbol: string): number {
  return QUOTE_USD[symbol] ?? 1;
}

export function buildPairs(now: number): TokenPair[] {
  return SEED_TOKENS.map((s) => {
    const r = rng(hash("pair|" + s.t));
    const address = s.addr ?? hexAddr(r);
    return {
      id: address.toLowerCase(),
      ticker: s.t,
      name: s.n,
      address,
      quote: s.q,
      origin: s.pad,
      tradeable: !s.untradeable,
      priceUsd: s.p,
      priceQuote: s.p / quoteUsd(s.q),
      change1h: s.h1,
      change24h: s.h24,
      vol24h: s.vol,
      mcap: Math.round(s.fdv * (CIRC[s.t] ?? 1)),
      fdv: s.fdv,
      liquidity: s.liq,
      holders: s.holders,
      createdAt: now - s.age * 3_600_000,
      bull: s.bull,
      bear: s.bear,
      poolId: hexBytes32(r),
      hook: HOOK_BY_ORIGIN[s.pad],
      feeTier: FEE_TIER_BY_ORIGIN[s.pad],
    };
  });
}

export function buildQuotes(pairs: readonly TokenPair[]): QuoteAsset[] {
  return QUOTE_LIST.map(([symbol, name, count]) => {
    const listed = pairs
      .filter((p) => p.quote === symbol)
      .reduce((a, p) => a + p.vol24h, 0);
    return {
      symbol,
      name,
      address: KNOWN_QUOTE_ADDRESSES[symbol] ?? hexAddr(rng(hash("quote|" + symbol))),
      decimals: QUOTE_DECIMALS[symbol] ?? 18,
      usdPrice: QUOTE_USD[symbol] ?? 100 + (hash(symbol) % 400),
      pairs: count,
      // Quotes without a listed pair get a plausible volume from their pair count.
      vol24h: listed || count * (400 + (hash(symbol) % 1500)),
    };
  });
}

/** The prototype's demo wallet; only used for copy previews when nothing is connected. */
export const MOCK_USER: Address = "0x3f8A7c21e9B4d0a6F15c8E2b7D9a4C0e1F6b9A2c";
