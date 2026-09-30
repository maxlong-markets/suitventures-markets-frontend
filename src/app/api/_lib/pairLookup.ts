import { ttlCache } from "@/lib/envio/cache";
import { getBackend } from "@/lib/market/backend";
import type { TokenPair } from "@/lib/types";
import { isAddress } from "./respond";

/** The one time to live every caller already used on its own. */
const TTL_MS = 30_000;

/**
 * One token by address, shared by the token page (`src/app/t/[address]/page.tsx`), the token API
 * (`route.ts`) and the quote route (`quote/route.ts`): the same `ttlCache` key, the same 30 s
 * time to live, and the same rule that a "not found" answer is never memoised (fix round 1,
 * finding 3, 30 Sep 2026). Before this, each of the three ran its own
 * `ttlCache(\`pair:${id}\`, ...)` call; whichever of them happened to ask first, while a
 * just-launched token still had no row, decided for every other caller sharing that key whether
 * the miss sat cached for the full 30 s. A quote request from a bot, a pasted link or a retrying
 * client, in the minute after a launch, could leave the token page and the token API both
 * serving a stale 404 seconds after the store actually had the token, with the creator's own
 * `router.refresh()` landing on nothing.
 *
 * Lowercases `id` itself (re-review finding 5, since every caller already lowercased before
 * calling this, but the helper silently answering "not found" for a checksummed or uppercase id
 * it was ever handed unlowercased, rather than reading it, was a footgun for the next caller
 * rather than a fact about the check). `isAddress` only accepts lowercase hex, and reads and
 * writes both went by the raw, unlowercased id before this, so two different casings of the same
 * address would have been two different memo keys and two different backend reads.
 *
 * A malformed address (finding 9) answers `null` immediately, with no `ttlCache` call and no
 * database read at all: `isAddress` is the same check the token API and the quote route already
 * ran on their own before this, now the one place that decides it for every caller, including the
 * token page, which never validated the address at all.
 */
export function lookupPair(id: string): Promise<TokenPair | null> {
  const key = id.toLowerCase();
  if (!isAddress(key)) return Promise.resolve(null);
  return ttlCache(`pair:${key}`, TTL_MS, () => getBackend().pair(key), { skipCache: (v) => v === null });
}
