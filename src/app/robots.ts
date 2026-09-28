import type { MetadataRoute } from "next";

/** The apex redirects here, so this — not the bare domain — is the canonical host (Builder B brief). */
const SITE_URL = "https://www.maxlong.markets";

/**
 * `/` sits behind the Suits gate (TokenGate, design doc §4.2, D44) and Googlebot never connects
 * a wallet, so allowing it costs nothing — a crawler that requests it gets the lock screen, same
 * as any other non-holder. `/t/` is allowed because it is the one route TokenGate now exempts:
 * it renders a public facts layer for anyone, gate or no gate (see TokenGate.tsx). `/api/` is
 * data, not a page — nothing under it is meant to rank, and letting a crawler loose on it would
 * spend crawl budget the token pages need more.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: ["/", "/t/"], disallow: "/api/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
