"use client";

import { useState, type ReactNode } from "react";
import { isAddress } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import { useAppState } from "@/context/AppState";
import { useLaunchFees } from "@/hooks/useLaunchpad";
import { robinhoodChain, ZERO_ADDRESS } from "@/lib/chain";
import { ageHours, fmtAge, fmtAmt } from "@/lib/format";
import {
  LAUNCH_MESSAGES, LaunchFailedError, LaunchRejectedError, LaunchUnconfirmedError, changePayout, claimOwed, collectLaunchFees,
  type LaunchDeps, type WriteHandle,
} from "@/lib/launch";
import { toHuman } from "@/lib/quote/math";
import type { Address, LaunchInfo, TokenPair } from "@/lib/types";

const BUTTON = "h-9 w-full bg-chalk font-mono text-[10.5px] uppercase tracking-[0.22em] text-onlight hover:bg-white disabled:cursor-not-allowed disabled:bg-[rgba(244,238,218,0.06)] disabled:text-ink-34";
const SMALL = "h-8 border border-hairline-btn bg-transparent px-3 font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink hover:border-hairline-hover disabled:cursor-not-allowed disabled:text-ink-34";
const INPUT = "h-8 w-full border border-hairline-strong bg-transparent px-2 font-mono text-[11px] outline-none focus:border-hairline-focus";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-t border-hairline-soft pt-3 first:border-t-0 first:pt-0">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink-40">{title}</div>
      <div className="mt-2">{children}</div>
    </section>
  );
}
/**
 * Why an address typed into the panel cannot be sent to, or null when it can. viem's strict check, so a mixed-case address
 * with a wrong checksum is refused, and never the zero address: the contract would refuse it after the wallet prompt.
 */
function addressProblem(value: string): string | null {
  if (value === "") return "Enter an address.";
  if (!isAddress(value, { strict: true })) return "That is not a valid address.";
  if (value.toLowerCase() === ZERO_ADDRESS) return "The zero address cannot receive fees.";
  return null;
}
function Reason({ text }: { text: string | null }) {
  return text ? <div className="mt-1 font-mono text-[10.5px] text-down">{text}</div> : null;
}
function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px] font-mono text-[11.5px]">
      <span className="text-ink-50">{label}</span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  );
}

/**
 * The launch's fee panel under the trade panel (instant launchpad design, section 7.3): what the position has earned and
 * not yet collected, read live from the contract, split by the contract's own numbers; what was collected so far, summed
 * by the store; anything owed to the connected wallet, with a claim to an address it picks; Collect, for anyone; and
 * Change payout, for the current payout address only.
 */
export default function LaunchFeesPanel({ pair, launch, now }: { pair: TokenPair; launch: LaunchInfo; now: number }) {
  const { address, isConnected, addToast, updateToast } = useAppState();
  const publicClient = usePublicClient({ chainId: robinhoodChain.id });
  const { data: walletClient } = useWalletClient({ chainId: robinhoodChain.id });
  const token = pair.address as Address;
  const fees = useLaunchFees(token, launch.quoteAddress, address);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimTo, setClaimTo] = useState<string | null>(null);
  const [newPayout, setNewPayout] = useState("");

  const tok = (raw: bigint) => `${fmtAmt(Number(toHuman(raw, 18)))} ${pair.ticker}`;
  const quo = (raw: bigint) => `${fmtAmt(Number(toHuman(raw, launch.quoteDecimals)))} ${pair.quote}`;
  const both = (t: bigint, q: bigint) => `${tok(t)} · ${quo(q)}`;
  const isPayout = Boolean(address && address.toLowerCase() === launch.payout.toLowerCase());
  const u = fees.uncollected;
  const nothingToCollect = u !== undefined && u.tokenFees === 0n && u.quoteFees === 0n;
  const owedToken = fees.owedToken ?? 0n;
  const owedQuote = fees.owedQuote ?? 0n;
  const to = (claimTo ?? address ?? "") as Address;
  const toProblem = addressProblem(to);
  // An empty field is not an error yet: the button stays off until something is typed.
  const payoutProblem = newPayout === "" ? null : addressProblem(newPayout);

  async function run(key: string, pending: string, done: string, start: (deps: LaunchDeps) => Promise<WriteHandle>) {
    if (busy || !address || !walletClient || !publicClient) return;
    setBusy(key);
    setError(null);
    const toastId = addToast({ kind: "pending", message: pending });
    try {
      const handle = await start({ wallet: walletClient, publicClient, account: address });
      updateToast(toastId, { hash: handle.hash });
      await handle.confirmation;
      updateToast(toastId, { kind: "confirmed", message: done });
      fees.refetch();
    } catch (err) {
      const known = err instanceof LaunchFailedError || err instanceof LaunchRejectedError || err instanceof LaunchUnconfirmedError;
      const message = known ? (err as Error).message : LAUNCH_MESSAGES.writeFallback;
      updateToast(toastId, { kind: err instanceof LaunchUnconfirmedError ? "unconfirmed" : "failed", message });
      setError(message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border border-hairline p-4">
      <div className="mb-3 font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-40">Launch fees</div>
      <div className="flex flex-col gap-3">
        <Section title="Uncollected fees">
          {fees.uncollectedFailed ? (
            <div className="font-mono text-[11px] text-ink-50">Could not read the uncollected fees just now.</div>
          ) : u ? (
            <>
              <Line label="To payout" value={both(u.tokenToPayout, u.quoteToPayout)} />
              <Line label="To MaxLong" value={both(u.tokenToFeeWallet, u.quoteToFeeWallet)} />
            </>
          ) : (
            <div className="font-mono text-[11px] text-ink-40">Reading…</div>
          )}
        </Section>

        <Section title="Collected so far">
          <Line label="To payout" value={both(BigInt(launch.feesCollected.tokenToPayout), BigInt(launch.feesCollected.quoteToPayout))} />
          <Line label="To MaxLong" value={both(BigInt(launch.feesCollected.tokenToPlatform), BigInt(launch.feesCollected.quoteToPlatform))} />
          <div className="mt-1 font-mono text-[10.5px] text-ink-45">
            {launch.feesCollectedAt > 0 ? `Last collected ${fmtAge(ageHours(launch.feesCollectedAt * 1000, now))} ago` : "Not collected yet"}
          </div>
        </Section>

        {owedToken > 0n || owedQuote > 0n ? (
          <Section title="Owed to you">
            <div className="font-mono text-[10.5px] leading-[1.5] text-ink-50">A share that could not be delivered waits here. Send it to this wallet or another address.</div>
            <label className="mt-2 block font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-45" htmlFor="claim-to">
              Send to
            </label>
            <input id="claim-to" aria-label="Send to" className={`mt-1 ${INPUT}`} value={to} onChange={(e) => setClaimTo(e.target.value.trim())} spellCheck={false} />
            <Reason text={toProblem} />
            {(
              [
                [owedToken, token, pair.ticker, tok(owedToken)],
                [owedQuote, launch.quoteAddress, pair.quote, quo(owedQuote)],
              ] as const
            ).map(([amount, currency, label, text]) =>
              amount > 0n ? (
                <div key={label} className="mt-2 flex items-center justify-between gap-3">
                  <span className="font-mono text-[11.5px] tabular-nums">{text}</span>
                  <button
                    type="button"
                    disabled={busy !== null || toProblem !== null}
                    onClick={() => {
                      if (toProblem !== null) return;
                      void run(`claim-${label}`, `Claiming ${text}`, `Claimed ${text}`, (deps) => claimOwed(currency, to, deps));
                    }}
                    className={SMALL}
                  >
                    {`Claim ${label}`}
                  </button>
                </div>
              ) : null,
            )}
          </Section>
        ) : null}

        <div>
          <button
            type="button"
            disabled={busy !== null || !isConnected || nothingToCollect}
            onClick={() => void run("collect", `Collecting fees for ${pair.ticker}`, `Fees collected for ${pair.ticker}`, (deps) => collectLaunchFees(token, deps))}
            className={BUTTON}
          >
            Collect fees
          </button>
          {nothingToCollect ? <div className="mt-2 text-center font-mono text-[10.5px] text-ink-50">Nothing to collect yet.</div> : null}
          {!isConnected ? <div className="mt-2 text-center font-mono text-[10.5px] text-ink-50">Connect a wallet to collect.</div> : null}
        </div>

        {isPayout ? (
          <Section title="Change payout">
            <input aria-label="New payout address" placeholder="0x…" className={INPUT} value={newPayout} onChange={(e) => setNewPayout(e.target.value.trim())} spellCheck={false} />
            <Reason text={payoutProblem} />
            <button
              type="button"
              disabled={busy !== null || newPayout === "" || payoutProblem !== null}
              onClick={() => {
                if (newPayout === "" || payoutProblem !== null) return;
                void run("payout", "Changing the payout", "Payout changed", (deps) => changePayout(token, newPayout as Address, deps));
              }}
              className={`mt-2 w-full ${SMALL}`}
            >
              Change payout
            </button>
            <div className="mt-2 font-mono text-[10.5px] leading-[1.5] text-ink-50">Once you hand the payout on, only the new address can change it.</div>
          </Section>
        ) : null}

        {error ? (
          <div role="alert" className="font-mono text-[10.5px] text-down">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
