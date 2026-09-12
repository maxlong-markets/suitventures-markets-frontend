"use client";

import { useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAppState } from "@/context/AppState";
import { short } from "@/lib/format";
import { SuitsMark } from "./ui";

/** 32px outlined wallet button; also used by the watchlist's locked state at 34px. */
export const walletButtonClass =
  "flex items-center gap-[9px] whitespace-nowrap border border-wallet-border bg-transparent font-mono text-[9.5px] uppercase tracking-[0.22em] text-[#F4F2EE] hover:border-wallet-border-hover hover:bg-wallet-hover";

function HolderBadge() {
  const [tip, setTip] = useState(false);
  return (
    <span
      className="relative flex"
      onMouseEnter={() => setTip(true)}
      onMouseLeave={() => setTip(false)}
    >
      <SuitsMark
        size={16}
        className="shadow-[0_0_0_1px_rgba(240,232,214,0.22)]"
      />
      {tip ? (
        <span
          role="tooltip"
          className="absolute -right-[10px] top-[26px] z-[5] whitespace-nowrap border border-hairline-strong bg-panel px-[9px] py-[6px] text-[9.5px] normal-case tracking-[0.06em] text-ink"
        >
          Suit holder, 0% fee
        </span>
      ) : null}
    </span>
  );
}

export default function WalletButton() {
  const { isHolder } = useAppState();

  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        mounted,
        openAccountModal,
        openChainModal,
        openConnectModal,
      }) => {
        const connected = mounted && Boolean(account) && Boolean(chain);
        let onClick = openConnectModal;
        let title: string | undefined;
        if (connected && chain?.unsupported) {
          onClick = openChainModal;
          title = "Switch to Robinhood Chain";
        } else if (connected) {
          onClick = openAccountModal;
          title = "Wallet";
        }
        return (
          <button
            type="button"
            onClick={onClick}
            title={title}
            className={`${walletButtonClass} h-8 px-[14px]`}
            style={mounted ? undefined : { opacity: 0, pointerEvents: "none" }}
            aria-hidden={!mounted}
          >
            {connected && isHolder ? <HolderBadge /> : null}
            <span>
              {connected && account ? short(account.address) : "Connect Wallet"}
            </span>
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}
