"use client";

import { useEffect, useState } from "react";
import { useSignMessage } from "wagmi";
import { useAppState, type GateKind } from "@/context/AppState";
import { robinhoodChain } from "@/lib/chain";
import type { Address } from "@/lib/types";
import { short } from "@/lib/format";
import { Spinner, SuitsMark } from "./ui";

function makeNonce(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function SignDialog({
  kind,
  address,
  onSigned,
  onCancel,
}: {
  kind: GateKind;
  address: Address;
  onSigned(signature: string): void;
  onCancel(): void;
}) {
  const [nonce] = useState(makeNonce);
  const [error, setError] = useState<string | null>(null);
  const { signMessageAsync, isPending } = useSignMessage();
  // The preview shortens the address for the eye; the signed statement carries it in full.
  const statement = (addr: string) =>
    `SuitVentures Markets wants you to sign in with ${addr} · Chain ${robinhoodChain.id} · Nonce ${nonce}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const sign = async () => {
    setError(null);
    try {
      const signature = await signMessageAsync({ message: statement(address) });
      onSigned(signature);
    } catch {
      setError("Signature declined. Nothing was saved.");
    }
  };

  return (
    <div
      onClick={onCancel}
      className="fixed inset-0 z-[30] flex items-start justify-center bg-[rgba(5,5,6,0.78)] px-4 pb-4 pt-[72px]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sign-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[400px] border border-hairline-strong bg-panel px-[22px] pb-[22px] pt-6"
      >
        <div className="flex items-start justify-between">
          <SuitsMark size={36} />
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="bg-transparent p-0 text-[18px] leading-none text-ink-50 hover:text-ink"
          >
            ×
          </button>
        </div>
        <div id="sign-title" className="mt-4 text-[17px] font-medium">
          {kind === "vote" ? "Sign to cast your vote" : "Sign to save your watchlist"}
        </div>
        <p className="mt-2 text-pretty text-[12.5px] leading-[1.55] text-ink-55">
          A one-time signature ties your watchlist and votes to this address. No gas,
          no transaction, nothing moves.
        </p>
        <div className="mt-4 break-all border border-hairline px-3 py-[10px] font-mono text-[10.5px] leading-[1.6] text-ink-50">
          {statement(short(address))}
        </div>
        {error ? (
          <div role="alert" className="mt-2 font-mono text-[10.5px] text-down">
            {error}
          </div>
        ) : null}
        <div className="mt-[18px] grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-10 border border-hairline-btn bg-transparent font-mono text-[10px] uppercase tracking-[0.22em] text-ink hover:border-[rgba(240,232,214,0.5)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={sign}
            disabled={isPending}
            className="flex h-10 items-center justify-center gap-2 bg-chalk font-mono text-[10px] uppercase tracking-[0.22em] text-void hover:bg-white disabled:cursor-wait disabled:bg-[rgba(244,238,218,0.55)]"
          >
            {isPending ? (
              <>
                <Spinner dark /> Confirm in wallet
              </>
            ) : (
              "Sign message"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SignModal() {
  const { signModal, address, completeSign, cancelSign } = useAppState();
  if (!signModal || !address) return null;
  return (
    <SignDialog
      key={address}
      kind={signModal.kind}
      address={address}
      onSigned={completeSign}
      onCancel={cancelSign}
    />
  );
}
