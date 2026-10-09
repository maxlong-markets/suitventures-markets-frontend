import type { Metadata } from "next";
import { cache } from "react";
import TokenFacts from "@/components/TokenFacts";
import TokenView from "@/components/TokenView";
import { lookupPair } from "@/app/api/_lib/pairLookup";
import { fmtPct, fmtPrice, fmtUsd, fmtUsdOrDash, fmtInt, MINUS } from "@/lib/format";
import type { Hex, TokenPair } from "@/lib/types";

interface Props {
  params: Promise<{ address: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/** `?launched=<tx>` from /launch's redirect (spec 7.3): a transaction hash, or ignored. */
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** Reads `?launched=<tx>` from a resolved searchParams object; undefined when absent or malformed.
 *  Shared by `generateMetadata` and the page body (amended 30 Sep 2026, B1c) so the tab title and
 *  the rendered page agree on whether this is a fresh launch still waiting to be indexed. */
function parseLaunchedTx(searchParams: { [key: string]: string | string[] | undefined }): Hex | undefined {
  const { launched } = searchParams;
  return typeof launched === "string" && TX_HASH.test(launched) ? (launched.toLowerCase() as Hex) : undefined;
}

const SITE_URL = "https://www.maxlong.markets";

/** This page is fetched fresh on every request rather than cached as a static route, because a
 *  crawler must see the same live price/volume a wallet-holding visitor does: `lookupPair`'s own
 *  memo is what actually bounds backend load, not Next's route cache. */
export const dynamic = "force-dynamic";

/**
 * `cache()` (amended 30 Sep 2026, should fix 9) makes `generateMetadata` and the page body call
 * `lookupPair` at most once each *request*, the same guarantee `fetch` gives for free and the
 * Next.js docs name `cache` as the stand-in for when `fetch` is not what is doing the reading
 * (generate-metadata.md: "React `cache` can be used if `fetch` is unavailable"). That keeps the
 * "one database read per request" ceiling exact regardless of `lookupPair`'s own memo, which no
 * longer holds a `null` answer for a token that is not found yet (fix round 1, finding 3: the
 * same helper, and the same key and ttl, that `route.ts` and `quote/route.ts` now use too), so
 * two calls to `getPair` a request apart must not turn into two database reads for one visit.
 */
const getPair = cache(lookupPair);

/**
 * One factual, quotable sentence: ticker, name, quote asset, price, 24h change, 24h volume,
 * liquidity and holder count — the set an AI search engine can lift verbatim, so every number in
 * it is real, never a placeholder. Kept under 160 characters (Google shows the whole thing, and
 * a cut-off number would misstate a fact rather than just trim one) by dropping the parenthetical
 * name first, then hard-truncating as a last resort for a name long enough to still overflow.
 */
function buildDescription(pair: TokenPair): string {
  const price = pair.stale ? "price unavailable (feed stale)" : fmtPrice(pair.priceUsd);
  const change = pair.change24h === null ? "no prior candle" : fmtPct(pair.change24h) + " 24h";
  const vol = pair.stale ? MINUS : fmtUsd(pair.vol24h);
  const liq = fmtUsdOrDash(pair.liquidity);
  const holders = fmtInt(pair.holders);

  const withName = `${pair.ticker} (${pair.name}) trades at ${price} per ${pair.quote}, ${change}, ${vol} 24h volume, ${liq} liquidity, ${holders} holders.`;
  if (withName.length <= 160) return withName;

  const withoutName = `${pair.ticker} trades at ${price} per ${pair.quote}, ${change}, ${vol} 24h volume, ${liq} liquidity, ${holders} holders.`;
  if (withoutName.length <= 160) return withoutName;

  return withoutName.slice(0, 159) + "…";
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { address } = await params;
  const id = decodeURIComponent(address).toLowerCase();
  const canonical = `${SITE_URL}/t/${id}`;
  const pair = await getPair(id);

  if (!pair) {
    // Unknown-token pages still get a real canonical so a stale or mistyped link consolidates
    // onto one URL rather than Google indexing every variant as a distinct thin page.
    const launchedTx = parseLaunchedTx(await searchParams);
    // B1c, amended 30 Sep 2026: a page opened from /launch's redirect is not actually unknown,
    // it just is not indexed yet, and the tab a creator is watching should say so rather than
    // suggest a bad address.
    return {
      title: launchedTx ? "Indexing your token" : "Unknown token",
      alternates: { canonical },
    };
  }

  const price = pair.stale ? "—" : fmtPrice(pair.priceUsd);
  // No product name here — the root layout's title template already appends " · MaxLong Markets".
  const title = `${pair.ticker} / ${pair.quote} — ${price}`;
  const description = buildDescription(pair);

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: "MaxLong Markets",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default async function TokenPage({ params, searchParams }: Props) {
  const { address } = await params;
  const id = decodeURIComponent(address).toLowerCase();
  const pair = await getPair(id);
  const launchedTx = parseLaunchedTx(await searchParams);

  return (
    <>
      {/* The interactive app comes first (amended 30 Sep 2026): it is what a visitor came for,
          and the facts block below used to push it off a phone screen entirely. `serverHadPair`
          (fix round 1, findings 1 and 5) is this read's own answer, so TokenView knows whether it
          is the one place left to say anything about a pair-less page, and whether a later,
          client-found pair is news worth a refresh. */}
      <TokenView address={id} launchedTx={launchedTx} serverHadPair={pair !== null} />
      {/* Public, server-rendered: this is the HTML a crawler or an AI search engine sees without
          running JavaScript (2026-09-28 SEO spec). `launchedTx` lets it stay silent while
          TokenView above is the one showing the post-launch wait, instead of both showing their
          own, contradictory idea of what a pair-less page means. */}
      <TokenFacts pair={pair} address={id} launchedTx={launchedTx} />
    </>
  );
}
