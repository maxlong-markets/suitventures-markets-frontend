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
 * `open` for a viewer the gate admits (a holder, or anyone once the gate is off) is closed,
 * since the interactive app above already shows the same numbers; everyone else gets it open,
 * so the public page still carries its facts without a click. The server cannot read a wallet,
 * so it always renders from the gate's own on/off switch alone (`gateEnabled()`), and this
 * component's first client render matches it exactly: `useSuitsAccess` cannot answer "granted"
 * before the balance read resolves, and that read is never done synchronously, so
 * `access.status !== "granted"` is true on both the server's render and the client's very first
 * one. Only a later render, once the read actually settles, can close it for a granted viewer,
 * computed fresh during render rather than written with a state setter inside an effect
 * (react-hooks/set-state-in-effect forbids that) and never poked at the DOM by hand.
 *
 * That same rule protects a manual toggle. React only touches the DOM `open` attribute on a
 * render where this derived value itself changes; once access settles (granted stays granted,
 * denied stays denied), later re-renders keep handing <details> that same value, so React
 * leaves whatever the viewer clicked alone instead of snapping it back.
 */
export default function TokenFactsDetails({ ticker, name, children }: Props) {
  const { address } = useAppState();
  const access = useSuitsAccess(address);
  const open = gateEnabled() && access.status !== "granted";

  return (
    <details open={open} className="group mt-[14px]">
      <summary className="flex cursor-pointer list-none items-center gap-[8px] py-[2px] opacity-70 transition-opacity hover:opacity-100 [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="inline-block text-[13px] leading-none text-ink-40 transition-transform duration-150 group-open:rotate-45"
        >
          +
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-40">Token details</span>
        <span className="font-mono text-[11px] text-ink-60">{ticker}</span>
        <span className="font-sans text-[11px] text-ink-45">{name}</span>
      </summary>
      {children}
    </details>
  );
}
