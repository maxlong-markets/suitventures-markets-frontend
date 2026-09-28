"use client";

import type { ReactNode } from "react";
import { useAppState } from "@/context/AppState";
import { gateEnabled, useSuitsAccess } from "@/lib/suits";
import LockScreen from "@/components/LockScreen";

/**
 * Gates the whole app behind Suits ownership (design doc §4.2, D44). Reads `address` from
 * `useAppState()` rather than wagmi's `useAccount()` directly: every other component that
 * needs the connected wallet (`TopBar`, `TradePanel`, `WalletButton`, `SignModal`, …) already
 * goes through the one `useAccount()` call `AppState.tsx` composes, and a second, independent
 * subscription here would be the one place in the app not following that.
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
 * `address` also goes to `LockScreen` as a prop rather than being read there from wagmi again,
 * so the wallet the denial copy names is always the wallet the balance was read against.
 */
export default function TokenGate({ children }: { children: ReactNode }) {
  const { address } = useAppState();
  const access = useSuitsAccess(address);

  if (!gateEnabled()) return <>{children}</>;
  if (access.status === "granted") return <>{children}</>;
  // Locked is the default whenever the answer is anything but a confirmed grant — idle,
  // checking, denied or error — so the app never shows its contents to a wallet that has not
  // been confirmed to hold a Suit.
  return <LockScreen access={access} address={address} />;
}
