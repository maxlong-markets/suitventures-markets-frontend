/**
 * Formatting helpers, ported exactly from the design prototype.
 * Numbers are always rendered in the mono face with tabular figures.
 */

/** True minus sign (U+2212), never a hyphen, for negative changes. */
export const MINUS = "−";

export function fmtUsd(v: number): string {
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  return "$" + v.toFixed(v < 10 ? 2 : 0);
}

/** `$0.1943` — 2dp with commas ≥ 1000; 2dp ≥ 1; 4dp ≥ 0.01; 6dp ≥ 0.0001; else 8dp. */
export function fmtPrice(p: number): string {
  if (p >= 1000)
    return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1) return "$" + p.toFixed(2);
  if (p >= 0.01) return "$" + p.toFixed(4);
  if (p >= 0.0001) return "$" + p.toFixed(6);
  return "$" + p.toFixed(8);
}

/** fmtPrice without the currency sign, for chart axes and legends. */
export function fmtPlainPrice(p: number): string {
  return fmtPrice(p).slice(1);
}

/** `+4.21%` / `−17.69%` (U+2212), 2dp. */
export function fmtPct(v: number): string {
  const sign = v > 0 ? "+" : v < 0 ? MINUS : "";
  return sign + Math.abs(v).toFixed(2) + "%";
}

export function fmtInt(v: number): string {
  return Math.round(v).toLocaleString("en-US");
}

/** `2h · 17d · 2mo` from an age in hours (m/h/d/mo). */
export function fmtAge(hours: number): string {
  if (hours < 1) return Math.round(hours * 60) + "m";
  if (hours < 24) return Math.round(hours) + "h";
  if (hours < 720) return Math.round(hours / 24) + "d";
  return Math.round(hours / 720) + "mo";
}

export function ageHours(createdAt: number, now: number): number {
  return Math.max(0, now - createdAt) / 3_600_000;
}

/** Token / quote amounts: locale commas, decimals by magnitude unless given. */
export function fmtAmt(v: number, dp?: number): string {
  if (!Number.isFinite(v)) return "0";
  const d =
    dp != null ? dp : v >= 1000 ? 0 : v >= 1 ? 2 : v >= 0.01 ? 4 : 6;
  return v.toLocaleString("en-US", { maximumFractionDigits: d });
}

/** Amounts ≥ 1000 drop decimals entirely (trade panel, toasts). */
export function fmtTradeAmt(v: number): string {
  return fmtAmt(v, v >= 1000 ? 0 : undefined);
}

/** Price in quote units: 4/6/8/10 dp by magnitude. */
export function fmtQuote(v: number): string {
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.0001) return v.toFixed(6);
  if (v >= 0.000001) return v.toFixed(8);
  return v.toFixed(10);
}

/** `0x3f8A…9A2c` — first 6 + last 4. */
export function short(a?: string): string {
  return a ? a.slice(0, 6) + "…" + a.slice(-4) : "";
}

/** FNV-1a; stable across reloads, drives placeholder avatar shades and mock seeds. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const LOGO_SHADES = [
  "#1C1C21",
  "#232329",
  "#2A2A31",
  "#1A1A1F",
  "#2E2E36",
  "#212127",
] as const;

/** Placeholder avatar shade: hash of ticker → one of six near-blacks. */
export function logoShade(ticker: string): string {
  return LOGO_SHADES[hash(ticker) % LOGO_SHADES.length];
}

export type Tone = "up" | "down" | "flat";

export function pctTone(v: number): Tone {
  return v > 0 ? "up" : v < 0 ? "down" : "flat";
}

/** Text colour class for a signed change. */
export function toneClass(v: number): string {
  const t = pctTone(v);
  return t === "up" ? "text-up" : t === "down" ? "text-down" : "text-ink-50";
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** `13:41:05` local time. */
export function fmtClock(t: number): string {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** `13:41` local time. */
export function fmtHHMM(t: number): string {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `Sep 4` local date. */
export function fmtMonthDay(t: number): string {
  return new Date(t).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/** `2026-07-14` local date. */
export function fmtISODate(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Smallest price step worth showing on a chart axis for this magnitude. */
export function priceMinMove(p: number): number {
  if (p >= 1) return 0.01;
  if (p >= 0.01) return 0.0001;
  if (p >= 0.0001) return 0.000001;
  return 0.00000001;
}
