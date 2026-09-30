"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isAddress } from "viem";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { useAppState } from "@/context/AppState";
import { useLaunchFees, type PendingFees } from "@/hooks/useLaunchpad";
import { keys } from "@/hooks/useMarketsData";
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

/**
 * How often, and for how long, the panel keeps asking the store for this token after a Collect (Review
 * Focus 12): the contract's own uncollected read updates at once, but "Collected so far" comes from the
 * store, which can lag a fold cycle behind. Counted in ticks, not by reading the clock, so nothing here
 * calls an impure API from a plain function the react-compiler cannot prove runs outside render.
 */
const REFRESH_POLL_MS = 10_000;
/** One immediate ask plus twelve more, ten seconds apart: about two minutes end to end. */
const REFRESH_MAX_TICKS = 13;

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

type WalletState = "disconnected" | "wrong-network" | "ready";

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
  const { chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const { openConnectModal } = useConnectModal();
  const queryClient = useQueryClient();
  const token = pair.address as Address;
  const fees = useLaunchFees(token, launch.quoteAddress, address);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimTo, setClaimTo] = useState<string | null>(null);
  const [newPayout, setNewPayout] = useState("");
  // Review Focus 13: a second click ("Confirm") is what actually sends the write; the first only opens
  // this step, so the full address and the "permanent" line are seen before the wallet is ever asked.
  const [confirmingPayout, setConfirmingPayout] = useState(false);
  // Review Focus 12: the split just sent, shown at once so "Collected so far" never looks like it
  // vanished while the store's own copy is still catching up.
  const [justCollected, setJustCollected] = useState<PendingFees | null>(null);
  // The running poll's interval id and the feesCollectedAt the store showed right before this Collect,
  // so the poll can tell "the store caught up" apart from "still the old total". A ref, not state: it
  // never needs to trigger a render on its own.
  const refreshRef = useRef<{ timer: number; baseline: number } | null>(null);

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

  // Review Focus 8: on the wrong network, or with nothing connected, Collect, Claim and Change payout did
  // nothing. This reads the same "connected && chain unsupported" state WalletButton.tsx keeps in its own
  // ConnectButton.Custom render prop (WalletButton.tsx:53), so a chain id that has not loaded yet never
  // reads as "wrong network".
  const wrongNetwork = isConnected && chainId !== undefined && chainId !== robinhoodChain.id;
  const walletState: WalletState = !isConnected ? "disconnected" : wrongNetwork ? "wrong-network" : "ready";

  function walletAction() {
    if (walletState === "disconnected") openConnectModal?.();
    else if (walletState === "wrong-network") switchChain?.({ chainId: robinhoodChain.id });
  }
  /** The button's usual label once the wallet is connected to the right chain; otherwise what pressing it will do. */
  function walletLabel(defaultLabel: string): string {
    return walletState === "disconnected" ? "Connect wallet" : walletState === "wrong-network" ? "Switch to Robinhood Chain" : defaultLabel;
  }

  function stopRefresh() {
    if (refreshRef.current) window.clearInterval(refreshRef.current.timer);
    refreshRef.current = null;
  }
  // Cleanup only: the effect body itself never runs anything on mount, so there is nothing here for
  // react-hooks/set-state-in-effect to catch. stopRefresh only clears an interval and a ref, never a
  // state setter, and only ever runs when this panel unmounts.
  useEffect(() => stopRefresh, []);

  /**
   * Review Focus 12: keeps invalidating this token's pair query until its own `feesCollectedAt` moves past
   * `baseline` (the store caught up) or REFRESH_MAX_TICKS polls pass, whichever comes first. Reads the
   * query cache directly rather than this component's own `launch` prop, so it keeps working even if the
   * panel's parent does not happen to be subscribed to the same query right now.
   */
  function startRefresh(baseline: number) {
    stopRefresh();
    // Set by `tick` itself when the immediate call below already caught up (unlikely, but the store could
    // in principle fold within the same tick) or ran out of tries. Read right after that call, since
    // refreshRef.current cannot tell the two cases apart at that point.
    let stopped = false;
    let ticks = 0;
    const tick = () => {
      ticks += 1;
      void queryClient.invalidateQueries({ queryKey: keys.pair(pair.id) });
      const fresh = queryClient.getQueryData<TokenPair>(keys.pair(pair.id));
      const caughtUp = fresh?.launch != null && fresh.launch.feesCollectedAt !== baseline;
      if (caughtUp || ticks >= REFRESH_MAX_TICKS) {
        stopped = true;
        stopRefresh();
        setJustCollected(null);
      }
    };
    // Asks once right away, since there is no reason to make the first poll wait a full REFRESH_POLL_MS,
    // then keeps asking on the interval below until `tick` itself stops it.
    tick();
    if (stopped) return;
    const timer = window.setInterval(tick, REFRESH_POLL_MS);
    refreshRef.current = { timer, baseline };
  }

  async function run(key: string, pending: string, done: string, start: (deps: LaunchDeps) => Promise<WriteHandle>, onDone?: () => void) {
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
      onDone?.();
    } catch (err) {
      const known = err instanceof LaunchFailedError || err instanceof LaunchRejectedError || err instanceof LaunchUnconfirmedError;
      const message = known ? (err as Error).message : LAUNCH_MESSAGES.writeFallback;
      updateToast(toastId, { kind: err instanceof LaunchUnconfirmedError ? "unconfirmed" : "failed", message });
      setError(message);
    } finally {
      setBusy(null);
    }
  }

  function onCollect() {
    if (nothingToCollect || !u) return;
    const snapshot = u;
    const baseline = launch.feesCollectedAt;
    void run("collect", `Collecting fees for ${pair.ticker}`, `Fees collected for ${pair.ticker}`, (deps) => collectLaunchFees(token, deps), () => {
      setJustCollected(snapshot);
      startRefresh(baseline);
    });
  }

  return (
    <div className="border border-hairline p-4">
      <div className="mb-3 font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-40">Pool fees</div>
      <div className="flex flex-col gap-3">
        <Section title="Uncollected fees">
          {fees.uncollectedFailed ? (
            <div className="font-mono text-[11px] text-ink-50">Could not read the uncollected fees just now.</div>
          ) : u ? (
            <>
              <Line label={isPayout ? "To you" : "To payout"} value={both(u.tokenToPayout, u.quoteToPayout)} />
              <Line label="To MaxLong" value={both(u.tokenToFeeWallet, u.quoteToFeeWallet)} />
            </>
          ) : (
            <div className="font-mono text-[11px] text-ink-40">Reading…</div>
          )}
        </Section>

        <Section title="Collected so far">
          <Line label={isPayout ? "To you" : "To payout"} value={both(BigInt(launch.feesCollected.tokenToPayout), BigInt(launch.feesCollected.quoteToPayout))} />
          <Line label="To MaxLong" value={both(BigInt(launch.feesCollected.tokenToPlatform), BigInt(launch.feesCollected.quoteToPlatform))} />
          <div className="mt-1 font-mono text-[10.5px] text-ink-45">
            {launch.feesCollectedAt > 0 ? `Last collected ${fmtAge(ageHours(launch.feesCollectedAt * 1000, now))} ago` : "Not collected yet"}
          </div>
          {justCollected ? (
            <div className="mt-1 font-mono text-[10.5px] text-ink-45">
              {`Just collected: ${both(justCollected.tokenFees, justCollected.quoteFees)}. Totals update within about two minutes.`}
            </div>
          ) : null}
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
                    disabled={busy !== null || (walletState === "ready" && toProblem !== null)}
                    onClick={() => {
                      if (walletState !== "ready") { walletAction(); return; }
                      if (toProblem !== null) return;
                      void run(`claim-${label}`, `Claiming ${text}`, `Claimed ${text}`, (deps) => claimOwed(currency, to, deps));
                    }}
                    className={SMALL}
                  >
                    {walletLabel(`Claim ${label}`)}
                  </button>
                </div>
              ) : null,
            )}
          </Section>
        ) : null}

        <div>
          <button
            type="button"
            disabled={busy !== null || (walletState === "ready" && nothingToCollect)}
            onClick={() => (walletState === "ready" ? onCollect() : walletAction())}
            className={isPayout ? BUTTON : `${SMALL} w-full`}
          >
            {walletLabel("Collect fees")}
          </button>
          {walletState === "ready" && nothingToCollect ? <div className="mt-2 text-center font-mono text-[10.5px] text-ink-50">Nothing to collect yet.</div> : null}
          <div className="mt-2 text-center font-mono text-[10.5px] leading-[1.5] text-ink-50">
            Sends the fees gathered so far to the payout address and to MaxLong. Whoever presses this pays the gas.
          </div>
        </div>

        {isPayout ? (
          <Section title="Change payout">
            {confirmingPayout ? (
              <>
                <div className="font-mono text-[11px] leading-[1.6] text-ink-60">
                  Hand the payout to <span className="break-all text-ink">{newPayout}</span>? This is permanent. Only that address can change it again.
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      void run("payout", "Changing the payout", "Payout changed", (deps) => changePayout(token, newPayout as Address, deps), () => setConfirmingPayout(false));
                    }}
                    className={`h-8 flex-1 ${SMALL}`}
                  >
                    Confirm
                  </button>
                  <button type="button" disabled={busy !== null} onClick={() => setConfirmingPayout(false)} className={`h-8 flex-1 ${SMALL}`}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <input aria-label="New payout address" placeholder="0x…" className={INPUT} value={newPayout} onChange={(e) => setNewPayout(e.target.value.trim())} spellCheck={false} />
                <Reason text={payoutProblem} />
                <button
                  type="button"
                  disabled={busy !== null || (walletState === "ready" && (newPayout === "" || payoutProblem !== null))}
                  onClick={() => {
                    if (walletState !== "ready") { walletAction(); return; }
                    if (newPayout === "" || payoutProblem !== null) return;
                    setConfirmingPayout(true);
                  }}
                  className={`mt-2 w-full ${SMALL}`}
                >
                  {walletLabel("Change payout")}
                </button>
                <div className="mt-2 font-mono text-[10.5px] leading-[1.5] text-ink-50">Once you hand the payout on, only the new address can change it.</div>
              </>
            )}
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
