"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAppState } from "@/context/AppState";
import { gateEnabled, useSuitsAccess } from "@/lib/suits";
import LockScreen from "@/components/LockScreen";

/**
 * Gates the whole app behind Suits ownership (design doc §4.2, D44) — except `/t/[address]`,
 * which must stay crawlable (2026-09-28 SEO work): Googlebot never holds a Suit, so exempting
 * only the route with its own public facts layer (Builder A's `TokenFacts` + `GatedSection`,
 * rendered by `src/app/t/[address]/page.tsx`) is what gives it something to index at all.
 * Reads `address` from `useAppState()` rather than wagmi's `useAccount()` directly: every other
 * component that needs the connected wallet (`TopBar`, `TradePanel`, `WalletButton`,
 * `SignModal`, …) already goes through the one `useAccount()` call `AppState.tsx` composes, and
 * a second, independent subscription here would be the one place in the app not following that.
 *
 * No mount gate, deliberately. `Providers.tsx` seeds wagmi from a cookie
 * (`cookieToInitialState`), and that is exactly what makes the address *the same* on the server
 * render and the client's hydration render: wagmi's `hydrate` sets `status: 'reconnecting'` with
 * the cookie's connections, and `getConnection` returns the address for that status. Pinning the
 * address to `undefined` until after mount would not prevent a mismatch — there is none to
 * prevent — it would only make both of those renders report `idle`, whose copy ("This floor is
 * for Suits", CONNECT WALLET) is a lie for a wallet the tree already knows about, and whose
 * button is inert besides: RainbowKit hands back an `openConnectModal` of `undefined` while the
 * connection status is `reconnecting`. Passing the address straight through instead leaves
 * `balanceOf` unresolved on both renders, so both say `checking` — identical trees, honest copy.
 *
 * `usePathname()` carries none of that risk and needs no mount gate of its own: the App Router
 * resolves the pathname from the request URL, so the server render and the client's hydration
 * render read the exact same value — unlike the wallet address, there is no client-only signal
 * (a cookie, `localStorage`, a media query) in play that the server could ever disagree with.
 *
 * `address` also goes to `LockScreen` as a prop rather than being read there from wagmi again,
 * so the wallet the denial copy names is always the wallet the balance was read against.
 */
export default function TokenGate({ children }: { children: ReactNode }) {
  const { address } = useAppState();
  const access = useSuitsAccess(address);
  const pathname = usePathname();

  // The trailing slash is load-bearing: `pathname.startsWith("/t")` would also swallow
  // `/traders`, which has no public layer of its own and must stay fully gated. `/t/[address]`
  // always has a segment after the slash, so this cannot be fooled by a route that merely starts
  // with the same two letters. Mirrors the identical check already in `TopBar.tsx`.
  const isTokenPage = pathname.startsWith("/t/");

  if (!gateEnabled()) return <>{children}</>;
  if (isTokenPage) return <>{children}</>;
  if (access.status === "granted") return <>{children}</>;
  // Locked is the default whenever the answer is anything but a confirmed grant — idle,
  // checking, denied or error — so the app never shows its contents to a wallet that has not
  // been confirmed to hold a Suit.
  return <LockScreen access={access} address={address} />;
}
