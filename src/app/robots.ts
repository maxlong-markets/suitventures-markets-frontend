import type { MetadataRoute } from "next";

/** The apex redirects here, so this — not the bare domain — is the canonical host (Builder B brief). */
const SITE_URL = "https://www.maxlong.markets";

/**
 * `/` and `/t/` are open to anyone since the Suits gate came down (9 Oct 2026); `/t/` renders a
 * server-side public facts layer on top (see TokenFacts.tsx). `/api/` is data, not a page —
 * nothing under it is meant to rank, and letting a crawler loose on it would spend crawl budget
 * the token pages need more.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: ["/", "/t/"], disallow: "/api/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
