"use client";

import type { ReactNode } from "react";
import { useAppState } from "@/context/AppState";
import { gateEnabled, useSuitsAccess } from "@/lib/suits";

interface Props {
  ticker: string;
  name: string;
  children: ReactNode;
}

/**
 * The one client-rendered piece of the token page's public facts layer (amended 30 Sep 2026,
 * see docs/superpowers/specs/2026-09-28-suits-token-gate-design.md): a native <details> around
 * the rows TokenFacts.tsx (a Server Component) hands it as `children`, so the facts stay real
 * server-rendered text no matter what this component decides about `open`. Native <details>
 * also means the disclosure works with no JavaScript at all: a crawler or a no-JS browser gets
 * whichever `open` the server chose, and can still read everything either way, since a closed
 * <details>'s content stays in the HTML, just visually collapsed.
 *
 * Fix round 1, finding 4: `open` is true only for `idle` (disconnected, a crawler included),
 * `denied` (turned away) and `error` (the check failed); `checking` is now closed, not open.
 * A connected wallet, holder or not, therefore renders closed from its very first paint, on the
 * server and on the client alike, and a holder never again sees the block open for the second or
 * two the balance read takes before it closes. `checking` used to map to open, which meant every
 * hard load, and every account switch (granted, then checking, then granted again), flashed the
 * whole block open before closing it: a false-then-true-then-false toggle a hand-opened state
 * could get lost inside. Under this rule an account switch only ever computes false, false,
 * false, and a denied or errored wallet still expands once the check actually finishes, which is
 * the one remaining, accepted transition (closed while checking, open once turned away).
 *
 * The server cannot read a wallet, so `access.status` on the server is always either "idle" (no
 * address at all) or "checking" (a cookie-seeded address, `Providers.tsx`'s
 * `cookieToInitialState`, with the balance read still in flight; it can never itself be
 * "granted", "denied" or "error", since none of those can be known synchronously). Idle matches
 * the open list, so a server render with no wallet cookie renders open exactly when the gate is
 * on, same as before this round. Checking does not match the open list, so a server render with
 * a wallet cookie, holder or not, now renders closed, whatever the gate setting says. This
 * component's first client render lands on the same two cases for the same reason:
 * `useSuitsAccess` cannot answer "granted" before the balance read resolves, and that read is
 * never done synchronously, so the very first client render is always idle or checking too, each
 * matching what the server just sent. Only a later render, once the read actually settles, can
 * flip a gated viewer's default, computed fresh during render rather than written with a state
 * setter inside an effect (react-hooks/set-state-in-effect forbids that) and never poked at the
 * DOM by hand.
 *
 * That same rule protects a manual toggle. React only touches the DOM `open` attribute on a
 * render where this derived value itself changes; once access settles into a value that does not
 * flip again (granted stays granted, denied stays denied), later re-renders keep handing
 * <details> that same value, so React leaves whatever the viewer clicked alone instead of
 * snapping it back.
 */
export default function TokenFactsDetails({ ticker, name, children }: Props) {
  const { address } = useAppState();
  const access = useSuitsAccess(address);
  const open = gateEnabled() && (access.status === "idle" || access.status === "denied" || access.status === "error");

  return (
    <details open={open} className="group mt-[14px]">
      <summary className="flex min-h-[40px] cursor-pointer list-none items-center gap-[8px] [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="inline-block flex-none text-[13px] leading-none text-ink-50 transition-transform duration-150 group-open:rotate-45"
        >
          +
        </span>
        {/* Re-review finding 3: ink-50 on the void ground is about 4.2:1, just under AA's 4.5:1
            for 10px text; ink-55 clears it (about 4.8:1). */}
        <span className="flex-none font-mono text-[10px] uppercase tracking-[0.16em] text-ink-55">
          Token details
        </span>
        {/* Re-review finding 4: truncates instead of flex-none, since a ticker from an origin
            other than the launchpad has no length cap (fields.ts's 11-byte cap is launch-only)
            and could otherwise push the row past a phone's width with nothing to clip it. */}
        <span className="min-w-0 truncate font-mono text-[11px] text-ink-60">{ticker}</span>
        <span className="min-w-0 truncate font-sans text-[11px] text-ink-60">{name}</span>
      </summary>
      {children}
    </details>
  );
}
