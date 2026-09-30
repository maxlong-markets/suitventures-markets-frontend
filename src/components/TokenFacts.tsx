import type { Hex, TokenPair } from "@/lib/types";
import { short } from "@/lib/format";
import { buildFactRows } from "@/lib/tokenFacts";
import PublicFactsSection from "./PublicFactsSection";
import TokenFactsList from "./TokenFactsList";

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
 * it off a phone screen; `PublicFactsSection`, the only client piece involved, shows it to a
 * viewer the gate keeps outside the app and keeps it off screen, still in the HTML, for everyone
 * inside, who has the same figures in the details card under the trade panel.
 */
export default function TokenFacts({ pair, address, launchedTx }: Props) {
  if (!pair) {
    // Fix round 1 finding 8: the page always has exactly one <h1>, even with no pair. A page
    // opened from a fresh launch has no pair yet either, but that is not "unknown"; see the
    // `launchedTx` prop doc above. TokenView (above this section) has no heading of its own while
    // it waits, so this one is server-rendered but visually hidden, naming the same state its tab
    // title (`generateMetadata`, page.tsx) already does, rather than repeating TokenView's own
    // visible copy a second time. Re-review finding 1: the wrapping section's own top border is
    // what closes GatedSection's lock card from below for a visitor the gate does not admit; the
    // bare `<h1>` alone left that card open-bottomed for the whole wait.
    if (launchedTx) {
      return (
        <section className="border-t border-hairline">
          <h1 className="sr-only">Indexing your token</h1>
        </section>
      );
    }
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
  const rows = buildFactRows(pair, Date.now());

  return (
    <>
      {/* PublicFactsSection is the only client-rendered piece here: it shows this block to a viewer
          the gate keeps outside the app and keeps it off screen for everyone inside, who has the
          same figures in the details card under the trade panel. The heading and the rows below
          are server-rendered either way. */}
      <PublicFactsSection
        heading={
          <h1 className="flex flex-wrap items-baseline gap-[10px]">
            <span className="font-mono text-[20px] font-medium leading-[1.1] tracking-[-0.01em] text-ink">
              {pair.ticker}
            </span>
            <span className="font-sans text-[13px] text-ink-50">{pair.name}</span>
          </h1>
        }
      >
        <TokenFactsList rows={rows} wide />
      </PublicFactsSection>
      {/* JSON-LD has no non-dangerous DOM path; safeJsonLd escapes anything that could break out of the tag. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd(pair)) }} />
    </>
  );
}
