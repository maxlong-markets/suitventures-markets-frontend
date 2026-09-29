import { isAddress } from "viem";
import type { Address } from "@/lib/types";

/**
 * An address, or undefined for anything else: an unset `NEXT_PUBLIC_*` reaches the bundle as "". A mixed-case value
 * must carry a correct checksum, so a mistyped address reads as not live instead of pointing at the wrong contract.
 * Whitespace around the value is ignored: a newline pasted into a dashboard is not a different address.
 */
export function parseLaunchpadAddress(raw: string | undefined): Address | undefined {
  const value = raw?.trim();
  return value !== undefined && isAddress(value, { strict: true }) ? (value as Address) : undefined;
}

/**
 * The SVLaunchpad (instant launchpad design, section 5.2), read by the browser and the reader alike, validated like
 * `SVROUTER_ADDRESS` in `src/lib/chain.ts:87-89`. `process.env.NEXT_PUBLIC_…` is substituted at build time and must be
 * read by direct member access, as below. Unset: the reader skips its second log selection, `/launch` shows "not live
 * yet", and the upload route answers 503.
 */
export const LAUNCHPAD_ADDRESS: Address | undefined = parseLaunchpadAddress(process.env.NEXT_PUBLIC_LAUNCHPAD_ADDRESS);

export function hasLaunchpad(): boolean {
  return LAUNCHPAD_ADDRESS !== undefined;
}
