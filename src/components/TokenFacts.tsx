import type { TokenPair } from "@/lib/types";
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
} from "@/lib/format";

const SITE_URL = "https://www.maxlong.markets";

interface Props {
  pair: TokenPair | null;
  /**
   * The address that was looked up, lowercase — kept even when `pair` is null so the
   * unknown-token copy can still name what was requested, matching `TokenView`'s client-side
   * "No token at {short(address)}." fallback rather than inventing a different message.
   */
  address: string;
}

interface FactRow {
  label: string;
  value: string;
  href?: string;
}

// The clock read for Age lives inline in the component below, under an explicit
// `react-hooks/purity` suppression. It was briefly wrapped in a lowercase helper instead, which
// works only because the rule's "component = capitalised function" heuristic cannot see through
// the call — a warning silenced without recording that anything was silenced, and invisible to
// any later audit of suppressions.

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
    { label: "1h change", value: fmtPctOrDash(pair.change1h) },
    { label: "24h change", value: fmtPctOrDash(pair.change24h) },
    { label: "24h volume", value: fmtUsdOrDash(vol24h) },
    { label: "Market cap", value: fmtUsdOrDash(mcap) },
    { label: "FDV", value: fmtUsdOrDash(fdv) },
    { label: "Liquidity", value: fmtUsdOrDash(pair.liquidity) },
    { label: "Holders", value: fmtInt(pair.holders) },
    { label: "Age", value: `${fmtAge(ageHours(pair.createdAt, now))} · ${fmtISODate(pair.createdAt)}` },
    { label: "Pool fee tier", value: pair.feeTier },
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
 * The public, server-rendered facts layer for a token page (2026-09-28 SEO spec). No
 * `"use client"`: its only job is to exist as real text in the SSR HTML response, so a crawler
 * or an AI search engine reads it without executing JavaScript or holding a Suit. The
 * interactive app (`TokenView`, wrapped in `GatedSection` by the page) sits below this,
 * unaffected by anything here.
 */
export default function TokenFacts({ pair, address }: Props) {
  if (!pair) {
    return (
      <section className="border-b border-hairline px-4 py-16 text-center tablet:px-5">
        <div className="text-[16px]">No token at {short(address)}.</div>
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
    <section className="border-b border-hairline px-4 py-[18px] tablet:px-5">
      <h1 className="flex flex-wrap items-baseline gap-[10px]">
        <span className="font-mono text-[20px] font-medium leading-[1.1] tracking-[-0.01em] text-ink">
          {pair.ticker}
        </span>
        <span className="font-sans text-[13px] text-ink-50">{pair.name}</span>
      </h1>
      <dl className="mt-[14px] grid grid-cols-1 gap-x-8 tablet:grid-cols-2">
        {rows.map(({ label, value, href }) => (
          <div
            key={label}
            className="m-0 flex justify-between gap-4 border-b border-hairline-soft py-[11px] font-mono text-[12.5px] tabular-nums"
          >
            <dt className="m-0 flex-none text-[10px] uppercase tracking-[0.16em] text-ink-40">{label}</dt>
            <dd className="m-0 truncate text-right">
              {href ? (
                <a href={href} target="_blank" rel="noreferrer" className="text-ink-70 hover:text-ink">
                  {value}
                </a>
              ) : (
                value
              )}
            </dd>
          </div>
        ))}
      </dl>
      {/* JSON-LD has no non-dangerous DOM path; safeJsonLd escapes anything that could break out of the tag. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd(pair)) }} />
    </section>
  );
}
