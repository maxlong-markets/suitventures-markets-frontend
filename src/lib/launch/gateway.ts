/**
 * The Filebase gateway the logo resolver tries first for every ipfs:// URI (instant launchpad design, section 5.6):
 * FILEBASE_GATEWAY_URL, a dedicated gateway's https origin, else Filebase's public one. Server-only by use: only the
 * resolver reads it. Not a secret.
 */
export const FILEBASE_GATEWAY_FALLBACK = "https://ipfs.filebase.io";

/**
 * Only a bare https origin is accepted: https, the default port, no user or password, no path beyond "/", no query or
 * fragment, and written exactly as the URL parser writes its origin (lower-case host). Anything else falls back.
 */
export function filebaseGatewayBase(): string {
  const raw = (process.env.FILEBASE_GATEWAY_URL || "").trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return FILEBASE_GATEWAY_FALLBACK;
  }
  const bare = url.protocol === "https:" && url.port === "" && url.username === "" && url.password === ""
    && (url.pathname === "/" || url.pathname === "") && url.search === "" && url.hash === "";
  const input = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  return bare && url.origin === input ? url.origin : FILEBASE_GATEWAY_FALLBACK;
}
