import type { MetadataRoute } from "next";
import { getBackend } from "@/lib/market/backend";

/** The apex redirects here, so this — not the bare domain — is the canonical host (Builder B brief). */
const SITE_URL = "https://www.maxlong.markets";

/**
 * Regenerate hourly rather than only at build/deploy. `/` is behind the Suits gate and gives a
 * crawler no path to any token page (that is the whole reason this file exists — see robots.ts),
 * so a sitemap that only refreshes on deploy would leave freshly-listed tokens undiscoverable for
 * however long it is between deploys, with nothing else to find them by.
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
 * Only the homepage. `/t/[address]` is added per listed pair below — there is no static entry
 * that could stand in for a token address.
 *
 * `/traders` and `/watchlist` are deliberately NOT here, though they are real routes. Both are
 * still gated, so a crawler asking for either gets the lock screen — byte for byte the same page
 * `/` returns. Submitting three URLs that render identical content asks Google to index
 * duplicates and invites it to judge the site thin, and it spends crawl budget the token pages
 * actually need. `/` earns its place because it is the homepage and that lock screen is the
 * brand's public face for now. The other two belong here the day the gate lifts, not before.
 */
const STATIC_ROUTES: MetadataRoute.Sitemap = [
  { url: SITE_URL, changeFrequency: "daily", priority: 1 },
];

/**
 * The only crawl path to `/t/[address]` while `/` is gated (see robots.ts's comment), so this has
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
