"use client";

import type { ReactNode } from "react";
import { useAppState } from "@/context/AppState";
import { gateEnabled, useSuitsAccess } from "@/lib/suits";

interface Props {
  /** The page's one heading, server-rendered. Always reachable by a screen reader; on screen only with the block. */
  heading: ReactNode;
  /** The server-rendered facts. */
  children: ReactNode;
}

/**
 * The shell around the token page's public facts, and the one client-rendered piece of that layer (amended 30 Sep
 * 2026, see docs/superpowers/specs/2026-09-28-suits-token-gate-design.md). The facts themselves are handed in from
 * TokenFacts.tsx, a Server Component, so they are real text in the server HTML whatever this component decides.
 *
 * A viewer inside the app has the same figures in the details card under the trade panel (TokenDetailsCard), so the
 * block must not show a second time there. It is on screen only for a viewer the gate keeps outside: `idle` (no
 * wallet, a crawler included), `denied` (turned away) and `error` (the check failed), with the gate on. For everyone
 * else, a holder, anyone while the check is still running, and everyone when the gate is off, the section is kept
 * off screen with `sr-only`: the heading stays the page's one <h1> for a screen reader, the rows are hidden from it
 * too because the card already reads them out, and the text stays in the HTML for a crawler.
 *
 * The server cannot read a wallet, so on the server `access.status` is "idle" (no address) or "checking" (an address
 * seeded from the wallet cookie, with the balance read still in flight). The first client render lands on the same
 * two cases for the same reason, so it always equals the server HTML. Only a later render, once the read settles,
 * changes the class, and it is computed during render rather than written from an effect.
 */
export default function PublicFactsSection({ heading, children }: Props) {
  const { address } = useAppState();
  const access = useSuitsAccess(address);
  const shown = gateEnabled() && (access.status === "idle" || access.status === "denied" || access.status === "error");

  return (
    <section className={shown ? "border-t border-hairline px-4 py-[18px] tablet:px-5" : "sr-only"}>
      {heading}
      <div className="mt-[14px]" aria-hidden={shown ? undefined : true}>
        {children}
      </div>
    </section>
  );
}
