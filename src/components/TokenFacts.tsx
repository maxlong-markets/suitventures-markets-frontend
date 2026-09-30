import type { Hex, TokenPair } from "@/lib/types";
import { addressUrl } from "@/lib/chain";
import { originLabel } from "@/lib/markets";
import {
  ageHours,
  fmtAge,
  fmtInt,
  fmtISODate,
  fmtPctOrDash,
  fmtPriceOrDash,
  fmtUsdOrDash,
  short,
  toneClassOrFlat,
} from "@/lib/format";
import TokenFactsDetails from "./TokenFactsDetails";

const SITE_URL = "https://www.maxlong.markets";

interface Props {
  pair: TokenPair | null;
  /**
   * The address that was looked up, lowercase — kept even when `pair` is null so the
   * unknown-token copy can still name what was requested, matching `TokenView`'s client-side
   * "No token at {short(address)}." fallback rather than inventing a different message.
   */
  address: string;
  /**
   * The tx hash from /launch's redirect (spec 7.3), when the page was opened that way (amended
   * 30 Sep 2026, corrected fix round 1 finding 12). The server has no pair yet for a token this
   * fresh either, and TokenView (now above this section, inside GatedSection) already owns the
   * one true message for that wait: a countdown, then, once five minutes pass with nothing, its
   * own "on chain, but the site's data is running late" copy with a Retry button. This component
   * stays silent rather than adding a second, contradictory message under either one.
   */
  launchedTx?: Hex;
}

interface FactRow {
  label: string;
  value: string;
  href?: string;
  /** text-up / text-down / neutral, for a signed change; unset for every other row. */
  toneClass?: string;
  /** One plain sentence under the value, explaining it; only the Pool fee tier row carries one. */
  note?: string;
}

// The clock read for Age lives inline in the component below, under an explicit
// `react-hooks/purity` suppression. It was briefly wrapped in a lowercase helper instead, which
// works only because the rule's "component = capitalised function" heuristic cannot see through
// the call — a warning silenced without recording that anything was silenced, and invisible to
// any later audit of suppressions.

/** bps to a percent string with no more decimals than the value needs: 7000 -> "70", 6543 -> "65.43". */
function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(2).replace(/\.?0+$/, "");
}

/**
 * One plain sentence under the fee tier value, since "0.30%" or "Dynamic" means nothing to a
 * reader who has never met a Uniswap v4 pool (30 Sep 2026, the owner's request to "expound more
 * on the pool fee tier"). Three cases, checked in this order:
 *  - launched here, on its own launch pool (`pair.launch` present AND `pair.origin === "SV"`,
 *    fixed in fix round 1 finding 2): every launchpad pool is origin SV with a static 1% fee
 *    (spec 4.3 `POOL_FEE`), and a token has exactly one launch pool, so this is the one case
 *    `pair.launch` being present actually proves the pool on screen IS that pool. A token
 *    launched here can later be listed through a different, traded pool of another origin
 *    (`dbBackend.pair`'s `coalesce(listed_pool_id, launch pool_id)`) while still carrying its old
 *    `launch` block; checking `pair.launch` alone would then claim a creator/MaxLong split for
 *    fees that pool's own liquidity providers keep, or, for a hooked dynamic fee on that other
 *    pool, print a fee split next to the word "Dynamic". The tier is this pool's own cut of
 *    every trade. The pool itself is open (the hook is zero, spec 4.3), so anyone can add
 *    liquidity to it; the sentence says no more than that the launch's own locked liquidity earns
 *    its share of that fee, and, of what it earns, `creatorShareBps` is the exact, current split
 *    to the creator's payout address versus MaxLong, read from the launch rather than assumed to
 *    be the usual 70/30 (corrected again, a second review: claiming the launch's split of the
 *    *whole pool's* fee overstated it, since the launch's liquidity is not the only liquidity a
 *    reader could be trading against). 0 and 10000 bps get their own plain sentences rather than
 *    an odd "0% ... and 100% ...".
 *  - a dynamic fee (`feeTier === "Dynamic"`, `envio/shape.ts`'s label for v4's dynamic-fee
 *    flag): the pool's hook decides the number per trade, so there is no fixed percentage to
 *    name.
 *  - anything else: a plain fixed tier. Who receives it is not said, since that differs by
 *    launchpad and this pool did not launch here.
 */
function feeTierNote(pair: TokenPair): string {
  if (pair.launch && pair.origin === "SV") {
    const creatorBps = pair.launch.creatorShareBps;
    const lede = `${pair.feeTier} of every trade. The launch's locked liquidity earns this fee, and `;
    // 0 and 10000 bps get their own plain sentences rather than an odd "0% ... and 100% ...".
    if (creatorBps === 0) {
      return `${lede}all of what it earns goes to MaxLong.`;
    }
    if (creatorBps === 10_000) {
      return `${lede}all of what it earns goes to the creator's payout address.`;
    }
    const creatorPct = bpsToPercent(creatorBps);
    const maxlongPct = bpsToPercent(10_000 - creatorBps);
    return `${lede}${creatorPct}% of what it earns goes to the creator's payout address and ${maxlongPct}% to MaxLong.`;
  }
  if (pair.feeTier === "Dynamic") {
    return "The pool's hook sets the fee on each trade, so it can differ from one trade to the next.";
  }
  return `The pool charges ${pair.feeTier} on every trade.`;
}

function buildRows(pair: TokenPair, now: number): FactRow[] {
  // USD-denominated fields read 0 when `stale` (TokenPair.stale's doc comment) and must show a
  // dash rather than a misleading "$0" — the same `stale ? null : v` gate PairsTable's row and
  // TokenHeader use for these four. `liquidity` is nullable independently of `stale`, and
  // change1h/change24h are percentages rather than USD, so neither is gated here.
  const priceUsd = pair.stale ? null : pair.priceUsd;
  const vol24h = pair.stale ? null : pair.vol24h;
  const mcap = pair.stale ? null : pair.mcap;
  const fdv = pair.stale ? null : pair.fdv;
  return [
    { label: "Ticker", value: pair.ticker },
    { label: "Name", value: pair.name },
    { label: "Token address", value: pair.address, href: addressUrl(pair.address) },
    { label: "Quote asset", value: pair.quote },
    { label: "Origin", value: originLabel(pair.origin) },
    { label: "Price (USD)", value: fmtPriceOrDash(priceUsd) },
    { label: "1h change", value: fmtPctOrDash(pair.change1h), toneClass: toneClassOrFlat(pair.change1h) },
    { label: "24h change", value: fmtPctOrDash(pair.change24h), toneClass: toneClassOrFlat(pair.change24h) },
    { label: "24h volume", value: fmtUsdOrDash(vol24h) },
    { label: "Market cap", value: fmtUsdOrDash(mcap) },
    { label: "FDV", value: fmtUsdOrDash(fdv) },
    { label: "Liquidity", value: fmtUsdOrDash(pair.liquidity) },
    { label: "Holders", value: fmtInt(pair.holders) },
    { label: "Age", value: `${fmtAge(ageHours(pair.createdAt, now))} · ${fmtISODate(pair.createdAt)}` },
    { label: "Pool fee tier", value: pair.feeTier, note: feeTierNote(pair) },
  ];
}

/**
 * `Product` over `FinancialProduct`: schema.org's FinancialProduct vocabulary (interestRate,
 * feesAndCommissionsSpecification, provider, areaServed, …) describes loans and bank accounts,
 * not a tradeable token — bending this data to fit those properties would be structured data
 * that misrepresents the page, which is exactly what Google's guidelines warn against. Product's
 * name/identifier/url triple, with `additionalProperty` for the ticker, is the closest
 * well-supported vocabulary for "a named, addressable, priced thing," even though no schema.org
 * type is a precise fit for a memecoin.
 *
 * No `isAccessibleForFree`, and no `hasPart` paywall markup either. That pattern exists to tell
 * Google "gated content IS present in this HTML, do not read it as cloaking" — and none is. A
 * visitor without a Suit gets `GatedSection`'s lock card in place of the chart and trade list,
 * not the real thing hidden by CSS, so there is nothing withheld to declare. `isAccessibleForFree`
 * is also a `CreativeWork` property rather than a `Product` one, so asserting it here would be
 * invalid structured data making a claim about a document this node does not describe.
 */
function jsonLd(pair: TokenPair) {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: pair.name,
    identifier: pair.address,
    url: `${SITE_URL}/t/${pair.id}`,
    additionalProperty: {
      "@type": "PropertyValue",
      name: "ticker",
      value: pair.ticker,
    },
  };
}

/**
 * Escapes `<`, `>` and `&` so a backend-sourced name or ticker containing `</script>` (or any
 * other markup) cannot break out of the script tag or inject HTML — the standard mitigation for
 * JSON embedded via `dangerouslySetInnerHTML`. `<` etc. decode back to the same characters
 * once parsed as JSON, so the payload itself is unaffected.
 */
function safeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/**
 * The public, server-rendered facts layer for a token page (2026-09-28 SEO spec, amended 30 Sep
 * 2026). No `"use client"` here: its only job is to exist as real text in the SSR HTML response,
 * so a crawler or an AI search engine reads it without executing JavaScript or holding a Suit.
 * The interactive app (`TokenView`, wrapped in `GatedSection` by the page) now sits above this
 * section rather than below it, since it is what a visitor came for and this block used to push
 * it off a phone screen; `TokenFactsDetails`, the only client piece involved, wraps the rows
 * below in a native `<details>` so the same text is also an optional disclosure rather than a
 * wall of rows, without ever leaving the SSR HTML.
 */
export default function TokenFacts({ pair, address, launchedTx }: Props) {
  if (!pair) {
    // Fix round 1 finding 8: the page always has exactly one <h1>, even with no pair. A page
    // opened from a fresh launch has no pair yet either, but that is not "unknown"; see the
    // `launchedTx` prop doc above. TokenView (above this section) has no heading of its own while
    // it waits, so this one is server-rendered but visually hidden, naming the same state its tab
    // title (`generateMetadata`, page.tsx) already does, rather than repeating TokenView's own
    // visible copy a second time.
    if (launchedTx) return <h1 className="sr-only">Indexing your token</h1>;
    // Keep today's wording for every other case unchanged; it is now the page's <h1>.
    return (
      <section className="border-t border-hairline px-4 py-16 text-center tablet:px-5">
        <h1 className="text-[16px]">No token at {short(address)}.</h1>
        <div className="mt-[6px] text-[12.5px] text-ink-50">
          It may not be indexed yet, or the address is wrong.
        </div>
      </section>
    );
  }

  // Impure by nature, and safe here: a Server Component on a `force-dynamic` page (page.tsx)
  // renders once per request and never re-renders or memoizes. Freezing the clock at module load
  // would make Age drift further from the truth the longer a server instance stays alive.
  // eslint-disable-next-line react-hooks/purity -- server-only, exactly one render per request
  const rows = buildRows(pair, Date.now());

  return (
    // Amended 30 Sep 2026: this section now sits below the app (GatedSection/TokenView), so the
    // hairline that used to separate it from what followed now separates it from what precedes
    // it, a top border rather than a bottom one.
    <section className="border-t border-hairline px-4 py-[18px] tablet:px-5">
      <h1 className="flex flex-wrap items-baseline gap-[10px]">
        <span className="font-mono text-[20px] font-medium leading-[1.1] tracking-[-0.01em] text-ink">
          {pair.ticker}
        </span>
        <span className="font-sans text-[13px] text-ink-50">{pair.name}</span>
      </h1>
      {/* TokenFactsDetails is the only client-rendered piece here: a native <details> around
          these server-rendered rows, closed by default once the gate admits the viewer. */}
      <TokenFactsDetails ticker={pair.ticker} name={pair.name}>
        <dl className="mt-[14px] grid grid-cols-1 gap-x-8 tablet:grid-cols-2">
          {rows.map(({ label, value, href, toneClass, note }) => (
            <div
              key={label}
              className="m-0 border-b border-hairline-soft py-[11px] font-mono text-[12.5px] tabular-nums"
            >
              <div className="flex justify-between gap-4">
                <dt className="m-0 flex-none text-[10px] uppercase tracking-[0.16em] text-ink-40">{label}</dt>
                <dd className={`m-0 truncate text-right ${toneClass ?? ""}`}>
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer" className="text-ink-70 hover:text-ink">
                      {value}
                    </a>
                  ) : (
                    value
                  )}
                </dd>
              </div>
              {note ? (
                <p className="m-0 mt-[6px] text-pretty text-left font-sans text-[11px] leading-[1.5] text-ink-50">
                  {note}
                </p>
              ) : null}
            </div>
          ))}
        </dl>
      </TokenFactsDetails>
      {/* JSON-LD has no non-dangerous DOM path; safeJsonLd escapes anything that could break out of the tag. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd(pair)) }} />
    </section>
  );
}
