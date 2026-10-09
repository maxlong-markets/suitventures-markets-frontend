import type { MetadataRoute } from "next";
import { getBackend } from "@/lib/market/backend";

/** The apex redirects here, so this — not the bare domain — is the canonical host (Builder B brief). */
const SITE_URL = "https://www.maxlong.markets";

/**
 * Regenerate hourly rather than only at build/deploy. The markets table at `/` is client-rendered,
 * so a crawler still finds no token links in its HTML; this sitemap is the reliable path to the
 * token pages, and one that only refreshes on deploy would leave freshly-listed tokens
 * undiscoverable for however long it is between deploys.
 */
export const revalidate = 3600;

/**
 * Google indexes a few hundred URLs from one sitemap well; more is a diminishing-returns crawl
 * budget spend, not a hard cap it enforces. The backend's own `pairs()` already caps at
 * `PAIRS_LIMIT` (500, src/lib/envio/pairs.ts) for the table UI's sake — this is a second,
 * independent ceiling rather than trusting that constant to stay small enough for a sitemap too.
 */
const TOKEN_PAGE_LIMIT = 300;

/**
 * The homepage and the launch page. `/t/[address]` is added per listed pair below — there is no
 * static entry that could stand in for a token address.
 *
 * `/launch` joined the day the Suits gate came down (9 Oct 2026): it is a real public page now.
 * `/watchlist` is deliberately NOT here, though it is a real route: it is one wallet's own list,
 * and a crawler, holding no wallet, gets the signed-out empty copy, which is thin content that
 * would spend crawl budget the token pages actually need. `/traders` is not a route at all since
 * 30 Sep 2026: its tab and page were removed, and the board behind them is parked.
 */
const STATIC_ROUTES: MetadataRoute.Sitemap = [
  { url: SITE_URL, changeFrequency: "daily", priority: 1 },
  { url: `${SITE_URL}/launch`, changeFrequency: "weekly", priority: 0.5 },
];

/**
 * The reliable crawl path to `/t/[address]` (the table at `/` is client-rendered), so this has
 * to fail soft: a backend outage must still hand Google the static routes rather than a 500, which
 * a crawler would otherwise treat as a reason to back off the whole site rather than just retry.
 * Pulls pairs from the same cached backend the `/api/pairs` route uses (`getBackend().pairs`,
 * ttl-cached 30s in src/lib/envio/pairs.ts) rather than fetching that route over HTTP — this
 * already runs on the server, so a self-fetch would just add a network hop to the same cache.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    const pairs = await getBackend().pairs("all");
    const tokens: MetadataRoute.Sitemap = pairs.slice(0, TOKEN_PAGE_LIMIT).map((pair) => ({
      // Lowercase to match the route's own canonicalization (src/app/t/[address]/page.tsx) and
      // TokenPair.id, so this never lists a second, distinct URL for the same token.
      url: `${SITE_URL}/t/${pair.address.toLowerCase()}`,
      changeFrequency: "hourly",
      priority: 0.6,
    }));
    return [...STATIC_ROUTES, ...tokens];
  } catch {
    return STATIC_ROUTES;
  }
}
