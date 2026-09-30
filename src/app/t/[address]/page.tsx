import type { Metadata } from "next";
import GatedSection from "@/components/GatedSection";
import TokenFacts from "@/components/TokenFacts";
import TokenView from "@/components/TokenView";
import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import { fmtPct, fmtPrice, fmtUsd, fmtUsdOrDash, fmtInt, MINUS } from "@/lib/format";
import type { Hex, TokenPair } from "@/lib/types";

interface Props {
  params: Promise<{ address: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/** `?launched=<tx>` from /launch's redirect (spec 7.3): a transaction hash, or ignored. */
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

const SITE_URL = "https://www.maxlong.markets";
// Same key and TTL as src/app/api/tokens/[address]/route.ts's GET handler, so this page's own
// two reads (generateMetadata, then the page body) and any request to that API route all share
// one process-wide memo instead of hitting the backend up to three times for one visit.
const TTL = 30;

/** This page is fetched fresh on every request rather than cached as a static route, because a
 *  crawler must see the same live price/volume a wallet-holding visitor does — `ttlCache` above
 *  is what actually bounds backend load, not Next's route cache. */
export const dynamic = "force-dynamic";

async function getPair(id: string): Promise<TokenPair | null> {
  return ttlCache(`pair:${id}`, TTL * 1000, () => getBackend().pair(id));
}

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

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  const id = decodeURIComponent(address).toLowerCase();
  const canonical = `${SITE_URL}/t/${id}`;
  const pair = await getPair(id);

  if (!pair) {
    // Unknown-token pages still get a real canonical so a stale or mistyped link consolidates
    // onto one URL rather than Google indexing every variant as a distinct thin page.
    return { title: "Unknown token", alternates: { canonical } };
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
  const { launched } = await searchParams;
  const launchedTx = typeof launched === "string" && TX_HASH.test(launched) ? (launched.toLowerCase() as Hex) : undefined;

  return (
    <>
      {/* The interactive app stays behind the gate; GatedSection renders a compact lock card in
          its place when the gate is on and the viewer holds no Suit. It comes first now (amended
          30 Sep 2026): it is what a visitor came for, and the facts block below used to push it
          off a phone screen entirely. */}
      <GatedSection>
        <TokenView address={id} launchedTx={launchedTx} />
      </GatedSection>
      {/* Public, server-rendered, outside any gate — this is the HTML a crawler or an AI search
          engine sees regardless of wallet or Suits ownership (2026-09-28 SEO spec). Its rows now
          live inside an expandable "Token details" disclosure; `launchedTx` lets it stay silent
          while TokenView above is the one showing the post-launch wait, instead of both showing
          their own, contradictory idea of what a pair-less page means. */}
      <TokenFacts pair={pair} address={id} launchedTx={launchedTx} />
    </>
  );
}
