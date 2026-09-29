/**
 * The Filebase gateway the logo resolver tries first for every ipfs:// URI (instant launchpad design, section 5.6):
 * FILEBASE_GATEWAY_URL, a dedicated gateway's https origin, else Filebase's public one. Server-only by use: only the
 * resolver reads it. Not a secret.
 */
export const FILEBASE_GATEWAY_FALLBACK = "https://ipfs.filebase.io";

export function filebaseGatewayBase(): string {
  const raw = (process.env.FILEBASE_GATEWAY_URL || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^/\s]+$/.test(raw) ? raw : FILEBASE_GATEWAY_FALLBACK;
}
