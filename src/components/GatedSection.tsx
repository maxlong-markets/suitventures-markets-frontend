"use client";

import type { ReactElement, ReactNode } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import type { SuitsAccess } from "@/lib/suits";
import { gateEnabled, useSuitsAccess } from "@/lib/suits";
import { useAppState } from "@/context/AppState";
import { short } from "@/lib/format";
import { walletButtonClass } from "@/components/WalletButton";
import { Spinner, SuitsMark } from "./ui";

/** OpenSea's listing for The Suits — the same destination `LockScreen` sends a denied wallet to. */
const OPENSEA_URL = "https://opensea.io/collection/the-suits-nft";

/**
 * Chalk primary, from TradePanel's submit button (the same recipe LockScreen quotes verbatim),
 * resized to sit beside the Connect Wallet button rather than LockScreen's full-width hero.
 */
const PRIMARY_BTN =
  "inline-flex h-[34px] items-center justify-center bg-chalk px-[18px] font-mono text-[9.5px] uppercase tracking-[0.22em] text-onlight hover:bg-white";

/** Outline — the Retry recipe from page.tsx's pairs-load error card, verbatim. */
const OUTLINE_BTN =
  "h-[30px] border border-hairline-btn bg-transparent px-[14px] font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink hover:border-[rgba(240,232,214,0.5)]";

interface Content {
  line: string;
  sub: string;
  action: ReactNode;
}

function getContent(
  access: SuitsAccess,
  ctx: { address?: string; openConnectModal?: () => void },
): Content {
  switch (access.status) {
    case "idle":
    case "granted":
      // "granted" never reaches this function — the caller renders `children` for it above —
      // but the switch has to stay exhaustive against `SuitsAccess`'s full union, and it shares
      // idle's copy: an invitation to connect, same as the unreachable branch in LockScreen.
      return {
        line: "This section is for Suits holders.",
        sub: "Connect your wallet to see it.",
        action: (
          <button
            type="button"
            onClick={ctx.openConnectModal}
            className={`${walletButtonClass} h-[34px] px-[18px]`}
          >
            Connect Wallet
          </button>
        ),
      };
    case "checking":
      return {
        line: "Checking for a Suit.",
        sub: "Reading the chain for this wallet's balance.",
        action: <Spinner />,
      };
    case "denied":
      return {
        line: "No Suit on this wallet.",
        // `short()` answers "" for a missing address; a wallet is always connected to be denied,
        // but the copy should not depend on it (same fallback LockScreen uses).
        sub: ctx.address ? `${short(ctx.address)} holds 0 Suits.` : "This wallet holds 0 Suits.",
        action: (
          <a href={OPENSEA_URL} target="_blank" rel="noreferrer" className={PRIMARY_BTN}>
            Get a Suit ↗
          </a>
        ),
      };
    case "error":
      return {
        line: "Couldn't check your Suits balance.",
        // Deliberately not denial copy: an RPC failure is not a confirmed zero, and telling a
        // genuine holder they own nothing here is exactly the bug SuitsAccess's five states
        // exist to prevent (see src/lib/suits.ts).
        sub: "This is us, not you.",
        action: (
          <button type="button" onClick={access.retry} className={OUTLINE_BTN}>
            Retry
          </button>
        ),
      };
  }
}

/**
 * The small sibling of `LockScreen`: gates one section of a page rather than the whole document.
 * Built for `/t/[address]`, which `TokenGate` now exempts from the whole-tree gate so the route
 * stays crawlable — the page renders a public facts layer plus `<GatedSection><TokenView /></GatedSection>`
 * around the interactive parts. Reads `address` the same way `TokenGate` does (`useAppState()`),
 * so the two gates can never disagree about which wallet they are checking.
 */
export default function GatedSection({ children }: { children: ReactNode }): ReactElement {
  const { address } = useAppState();
  const access = useSuitsAccess(address);
  const { openConnectModal } = useConnectModal();

  if (!gateEnabled() || access.status === "granted") return <>{children}</>;

  const content = getContent(access, { address, openConnectModal });
  return (
    // Fix round 1, finding 13: no bottom border. TokenFacts (page.tsx) now sits directly under
    // this card with its own top border; the two hairlines side by side read as one doubled line.
    <div className="border-x border-t border-hairline px-4 py-10 text-center">
      <SuitsMark size={36} className="mx-auto opacity-80" />
      <div className="mb-[6px] mt-[18px] text-[16px]">{content.line}</div>
      <div className="text-[12.5px] text-ink-50">{content.sub}</div>
      <div className="mt-[18px] flex min-h-[34px] items-center justify-center">{content.action}</div>
    </div>
  );
}
