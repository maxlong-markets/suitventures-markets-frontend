import { timingSafeEqual } from "node:crypto";

/** True only when CRON_SECRET is set and the Authorization header equals `Bearer <CRON_SECRET>` (constant-time compare). */
export function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  // timingSafeEqual throws on unequal lengths; the length itself is not a secret.
  return given.length === expected.length && timingSafeEqual(given, expected);
}
