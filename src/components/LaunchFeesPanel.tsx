"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getAddress, isAddress, isAddressEqual, parseEventLogs } from "viem";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { useAppState } from "@/context/AppState";
import { useLaunchFees } from "@/hooks/useLaunchpad";
import { keys } from "@/hooks/useMarketsData";
import { LAUNCHPAD_EVENTS_ABI, POOL_MANAGER } from "@/lib/chain/abi";
import { robinhoodChain, ZERO_ADDRESS } from "@/lib/chain";
import { ageHours, fmtAge, fmtAmt } from "@/lib/format";
import {
  LAUNCH_MESSAGES, LaunchFailedError, LaunchRejectedError, LaunchUnconfirmedError, changePayout, claimOwed, collectLaunchFees,
  type LaunchDeps, type WriteHandle,
} from "@/lib/launch";
import { LAUNCHPAD_ADDRESS } from "@/lib/launch/address";
import { toHuman } from "@/lib/quote/math";
import type { Address, Hex, LaunchInfo, TokenPair } from "@/lib/types";

const BUTTON = "h-9 w-full bg-chalk font-mono text-[10.5px] uppercase tracking-[0.22em] text-onlight hover:bg-white disabled:cursor-not-allowed disabled:bg-[rgba(244,238,218,0.06)] disabled:text-ink-34";
const SMALL = "h-8 border border-hairline-btn bg-transparent px-3 font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink hover:border-hairline-hover disabled:cursor-not-allowed disabled:text-ink-34";
/** Claim's own label can grow long ("Switch to Robinhood Chain"); min-h instead of a fixed h keeps a wrapped label from
 * spilling past the border at 320 px (Review round 1, finding 11). */
const CLAIM_BUTTON = "min-h-8 border border-hairline-btn bg-transparent px-3 py-1 font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink hover:border-hairline-hover disabled:cursor-not-allowed disabled:text-ink-34";
const INPUT = "h-8 w-full border border-hairline-strong bg-transparent px-2 font-mono text-[11px] outline-none focus:border-hairline-focus";

/**
 * How often, and for how long, the panel keeps asking the store for this token after a write that changes it (Collect
 * or Change payout): the contract's own reads update at once, but the store can lag a fold cycle behind. Counted in
 * ticks, not by reading the clock, so nothing here calls an impure API from a plain function the react-compiler
 * cannot prove runs outside render.
 */
const REFRESH_POLL_MS = 10_000;
/** One immediate ask plus twelve more, ten seconds apart: about two minutes end to end. */
const REFRESH_MAX_TICKS = 13;
/** How long Confirm stays disabled after the confirm step opens, so a double click meant for "Change payout" cannot
 * also land on Confirm (Review round 1, finding 10). */
const CONFIRM_GUARD_MS = 300;

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

type WalletState = "disconnected" | "wrong-network" | "connecting" | "ready";

/** What one Collect transaction's own `FeesCollected` log actually moved, split by destination. "unknown" when the
 * receipt or the event could not be read: the collection still went through, only the split is unavailable. */
type CollectedSplit =
  | { payout: Address; tokenToPayout: bigint; quoteToPayout: bigint; tokenToPlatform: bigint; quoteToPlatform: bigint }
  | "unknown";
type JustCollected = { baseline: number; split: CollectedSplit };

/**
 * The launch's fee panel under the trade panel (instant launchpad design, section 7.3): what the position has earned and
 * not yet collected, read live from the contract, split by the contract's own numbers; what was collected so far, summed
 * by the store; anything owed to the connected wallet, with a claim to an address it picks; Collect, for anyone; and
 * Change payout, for the current payout address only.
 */
export default function LaunchFeesPanel({ pair, launch, now }: { pair: TokenPair; launch: LaunchInfo; now: number }) {
  const { address, isConnected, addToast, updateToast } = useAppState();
  const publicClient = usePublicClient({ chainId: robinhoodChain.id });
  const { data: walletClient, refetch: refetchWalletClient } = useWalletClient({ chainId: robinhoodChain.id });
  const { chainId, isReconnecting } = useAccount();
  const { switchChain } = useSwitchChain();
  const { openConnectModal } = useConnectModal();
  const queryClient = useQueryClient();
  const token = pair.address as Address;
  const fees = useLaunchFees(token, launch.quoteAddress, address);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimTo, setClaimTo] = useState<string | null>(null);
  const [newPayout, setNewPayout] = useState("");
  // Review round 1, finding 10: a second click ("Confirm") is what actually sends the write; the first only opens
  // this step, so the full address and the "permanent" line are seen before the wallet is ever asked.
  const [confirmingPayout, setConfirmingPayout] = useState(false);
  // Stays false for CONFIRM_GUARD_MS after the step opens, so a double click meant for "Change payout" cannot also
  // land on Confirm (finding 10).
  const [confirmReady, setConfirmReady] = useState(false);
  // Review round 1, finding 5: set on a successful Change payout, so the viewer stops being treated as the payout at
  // once, before the store's own copy of `launch.payout` has caught up.
  const [handed, setHanded] = useState<{ from: Address; to: Address } | null>(null);
  // A switch the wallet refused. Shown only while the wallet is still on the wrong network, so it cannot sit beside
  // working buttons after the creator switches from the wallet itself.
  const [switchRefused, setSwitchRefused] = useState(false);
  // Review round 1, finding 2 and 8: the split this Collect actually moved (read from its own receipt, not a
  // click-time guess), plus the store's feesCollectedAt right before it. Shown only while those still match (finding
  // 8): the render-time comparison itself decides visibility, so nothing needs to clear this on a timer.
  const [justCollected, setJustCollected] = useState<JustCollected | null>(null);
  const refreshRef = useRef<number | null>(null);
  // Which refresh run is current. A run that finds another has started since, or that the panel stopped, ends itself,
  // so two writes confirming close together can never leave an interval nobody owns.
  const runRef = useRef(0);
  // Review round 1, finding 9: sooner than the effect below can run its cleanup, an async write can still be waiting
  // on a confirmation after this panel has already unmounted (a different token's page: /t/[address] remounts on
  // navigation, but only once the new route actually renders, not the instant the old write was sent).
  const mountedRef = useRef(true);
  const promptRef = useRef<HTMLDivElement>(null);
  const payoutInputRef = useRef<HTMLInputElement>(null);
  // Set by Cancel just before it closes the confirm step, so the effect below knows to return focus to the input;
  // never set on the initial mount or after a successful Confirm, which can drop the whole section instead.
  const returnFocusRef = useRef(false);

  const tok = (raw: bigint) => `${fmtAmt(Number(toHuman(raw, 18)))} ${pair.ticker}`;
  const quo = (raw: bigint) => `${fmtAmt(Number(toHuman(raw, launch.quoteDecimals)))} ${pair.quote}`;
  const both = (t: bigint, q: bigint) => `${tok(t)} · ${quo(q)}`;
  // Review round 1, finding 5: a confirmed Change payout overrides `launch.payout` at once, so the viewer is never
  // told it is still the payout after handing the stream on. The override holds only while the store still shows the
  // address that was handed from: once the store moves, by this handover or a later one, the store is the truth again.
  const effectivePayout = handed && launch.payout.toLowerCase() === handed.from.toLowerCase() ? handed.to : launch.payout;
  const isPayout = Boolean(address && address.toLowerCase() === effectivePayout.toLowerCase());
  const u = fees.uncollected;
  const nothingToCollect = u !== undefined && u.tokenFees === 0n && u.quoteFees === 0n;
  const owedToken = fees.owedToken ?? 0n;
  const owedQuote = fees.owedQuote ?? 0n;
  const to = (claimTo ?? address ?? "") as Address;
  const toProblem = addressProblem(to);
  /**
   * Review round 1, finding 6: on top of `addressProblem`'s empty/invalid/zero checks, refuses the addresses that
   * would waste or permanently lose the fee stream: the current payout again (a costed no-op), the token or the
   * currency (neither can ever move a balance out), the launchpad and the pool manager (the contract's own
   * `BadPayout`, refused here before the wallet rather than only after Confirm).
   */
  function payoutProblemFor(value: string): string | null {
    const base = addressProblem(value);
    if (base) return base;
    const lower = value.toLowerCase();
    if (lower === effectivePayout.toLowerCase()) return "That is already the payout address.";
    if (lower === token.toLowerCase() || lower === launch.quoteAddress.toLowerCase()) {
      return "Fees sent to a token contract can never be moved.";
    }
    if (LAUNCHPAD_ADDRESS && lower === LAUNCHPAD_ADDRESS.toLowerCase()) return "That is the launchpad contract. It cannot receive fees.";
    if (lower === POOL_MANAGER) return "That is the pool manager contract. It cannot receive fees.";
    return null;
  }
  // An empty field is not an error yet: the button stays off until something is typed.
  const payoutProblem = newPayout === "" ? null : payoutProblemFor(newPayout);
  // Review round 1, finding 6: shown in the confirm step and sent to the contract, not the raw typed text, so an
  // all-lowercase paste reads back checksummed like a wallet would show it. Only computed once newPayout is valid.
  const checksummedNewPayout = payoutProblem === null && newPayout !== "" ? getAddress(newPayout) : null;

  // Review round 1, finding 3 and 7: on the wrong network, or with nothing connected, Collect, Claim and Change
  // payout did nothing. "connecting" covers two different waits with the same one plain label, matching
  // TradePanel.tsx's own "Connecting to your wallet…": wagmi still reconnecting a session from a previous visit
  // (isReconnecting), and a wallet client that has not resolved yet for the right chain, including right after a
  // switch (walletClient undefined here even though the chain id already reads correctly).
  const wrongNetwork = isConnected && chainId !== undefined && chainId !== robinhoodChain.id;
  const walletState: WalletState = isReconnecting
    ? "connecting"
    : !isConnected
      ? "disconnected"
      : wrongNetwork
        ? "wrong-network"
        : !walletClient
          ? "connecting"
          : "ready";

  function walletAction() {
    if (walletState === "disconnected") {
      openConnectModal?.();
      return;
    }
    if (walletState === "wrong-network") {
      setError(null);
      setSwitchRefused(false);
      switchChain({ chainId: robinhoodChain.id }, { onError: () => setSwitchRefused(true) });
    }
  }
  /** The button's usual label once the wallet is ready; otherwise what pressing it will do, or why it cannot be pressed. */
  function walletLabel(defaultLabel: string): string {
    if (walletState === "disconnected") return "Connect wallet";
    if (walletState === "wrong-network") return "Switch to Robinhood Chain";
    if (walletState === "connecting") return "Connecting to your wallet…";
    return defaultLabel;
  }

  // Review round 1, finding 3: once the wallet's own chain changes to Robinhood, ask the wallet-client query again
  // rather than wait for it to notice on its own. Its staleTime is Infinity and only an address change invalidates
  // it, so nothing else here would ever refresh it after a switch. Only on the change itself, and keyed on the stable
  // `refetch`: the query result is a new object on every render, so depending on it re-ran this effect, refetched,
  // built a new client, re-rendered and refetched again, for as long as the panel stayed on screen.
  const lastChainRef = useRef(chainId);
  useEffect(() => {
    if (lastChainRef.current === chainId) return;
    lastChainRef.current = chainId;
    if (chainId === robinhoodChain.id) void refetchWalletClient();
  }, [chainId, refetchWalletClient]);

  function stopRefresh() {
    runRef.current += 1;
    if (refreshRef.current !== null) window.clearInterval(refreshRef.current);
    refreshRef.current = null;
  }
  // Marks the panel mounted on every mount, not only the first: React's StrictMode, which the App Router turns on in
  // development, mounts, unmounts and mounts again, and a flag only ever set to false would silence every update after
  // a confirmed write there. The body touches a ref only, never a state setter.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRefresh();
    };
  }, []);

  /**
   * Review round 1, finding 5 and 8: invalidates this token's pair query at once, then every REFRESH_POLL_MS, until
   * `caughtUp` says the store's own copy already reflects the write (Collect's feesCollectedAt moving, or Change
   * payout's payout moving) or REFRESH_MAX_TICKS tries pass, whichever comes first. A nudge only: nothing the panel
   * shows is decided by this poll's own state (see justCollected's render-time check, and the payout override above),
   * only refetched sooner than the store would otherwise be asked. Each run owns its interval and ends itself when a
   * newer run has started, so two runs that overlap cannot leave one behind. The pair query holds null for a token
   * the store does not have, which counts as "not caught up".
   */
  async function startRefresh(caughtUp: (fresh: TokenPair) => boolean) {
    stopRefresh();
    const run = runRef.current;
    let ticks = 0;
    /** One ask. Answers true when this run is over. */
    const tick = async (): Promise<boolean> => {
      ticks += 1;
      try {
        await queryClient.invalidateQueries({ queryKey: keys.pair(pair.id) });
      } catch {
        // A refetch that failed is just a tick that learned nothing.
      }
      if (!mountedRef.current || run !== runRef.current) return true;
      const fresh = queryClient.getQueryData<TokenPair | null>(keys.pair(pair.id));
      return (fresh != null && caughtUp(fresh)) || ticks >= REFRESH_MAX_TICKS;
    };
    // Asks once right away, since there is no reason to make the first poll wait a full REFRESH_POLL_MS.
    if (await tick()) return;
    const id = window.setInterval(() => {
      void tick().then((over) => {
        if (!over) return;
        window.clearInterval(id);
        if (refreshRef.current === id) refreshRef.current = null;
      });
    }, REFRESH_POLL_MS);
    refreshRef.current = id;
  }

  /**
   * Review round 1, finding 2: what a Collect actually moved, read from its own transaction rather than guessed from
   * a click-time snapshot of the uncollected read (which can be up to 30 s stale, and is the combined total before
   * any split). Mirrors how src/lib/launch.ts's confirmLaunch reads its own event, without editing that file: the
   * receipt is already mined by the time this runs, so this is one more read, not a wait.
   */
  async function readCollected(hash: Hex): Promise<CollectedSplit> {
    // Captured into a local so its narrowing below survives into the closures further down: TS does not
    // trust a module-level `const` to still be defined once control re-enters through a callback.
    const launchpadAddress = LAUNCHPAD_ADDRESS;
    if (!publicClient || !launchpadAddress) return "unknown";
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      const [event] = parseEventLogs({
        abi: LAUNCHPAD_EVENTS_ABI,
        eventName: "FeesCollected",
        logs: receipt.logs.filter((log) => isAddressEqual(log.address, launchpadAddress)),
      }).filter((e) => isAddressEqual(e.args.token, token));
      if (!event) return "unknown";
      return {
        payout: event.args.payout,
        tokenToPayout: event.args.tokenToPayout,
        quoteToPayout: event.args.quoteToPayout,
        tokenToPlatform: event.args.tokenFees - event.args.tokenToPayout,
        quoteToPlatform: event.args.quoteFees - event.args.quoteToPayout,
      };
    } catch {
      return "unknown";
    }
  }

  async function run(key: string, pending: string, done: string, start: (deps: LaunchDeps) => Promise<WriteHandle>, onDone?: (handle: WriteHandle) => void) {
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
      onDone?.(handle);
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
    // Review round 1, finding 1: the only reason not to send a Collect is a contract read that has definitely
    // answered "zero". While the read is loading or failed, `u` is undefined and `nothingToCollect` is already
    // false, so this never blocks the press the way an extra `|| !u` guard used to.
    if (nothingToCollect) return;
    const baseline = launch.feesCollectedAt;
    void run("collect", `Collecting ${pair.ticker} fees`, `${pair.ticker} fees collected`, (deps) => collectLaunchFees(token, deps), (handle) => {
      if (!mountedRef.current) return;
      void readCollected(handle.hash).then((split) => {
        if (mountedRef.current) setJustCollected({ baseline, split });
      });
      void startRefresh((fresh) => fresh.launch != null && fresh.launch.feesCollectedAt !== baseline);
    });
  }

  function onConfirmPayout() {
    if (!checksummedNewPayout) return;
    const target = checksummedNewPayout;
    const oldPayoutLower = launch.payout.toLowerCase();
    void run("payout", "Changing the payout", "Payout changed", (deps) => changePayout(token, target, deps), () => {
      if (!mountedRef.current) return;
      setHanded({ from: launch.payout as Address, to: target });
      setNewPayout("");
      setConfirmingPayout(false);
      void startRefresh((fresh) => fresh.launch != null && fresh.launch.payout.toLowerCase() !== oldPayoutLower);
    });
  }
  function onCancelPayout() {
    returnFocusRef.current = true;
    setConfirmingPayout(false);
  }

  // Review round 1, finding 10: focuses the prompt when the confirm step opens (a screen reader then announces the
  // group it labels), and returns focus to the input after Cancel specifically, never on the initial mount and
  // never after a successful Confirm, which can drop this whole section instead of returning to it.
  useEffect(() => {
    if (confirmingPayout) {
      promptRef.current?.focus();
    } else if (returnFocusRef.current) {
      returnFocusRef.current = false;
      payoutInputRef.current?.focus();
    }
  }, [confirmingPayout]);
  // Review round 1, finding 10: Confirm stays disabled for CONFIRM_GUARD_MS after opening.
  useEffect(() => {
    if (!confirmingPayout) return;
    const id = window.setTimeout(() => setConfirmReady(true), CONFIRM_GUARD_MS);
    return () => window.clearTimeout(id);
  }, [confirmingPayout]);

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
          {/* Review round 1, finding 4: this sums every payout the token has ever had (src/lib/launch/read.ts), so
              "To you" here would credit the viewer with fees a past payout received. Only the Uncollected row above,
              which the next Collect actually pays, is about the viewer. */}
          <Line label="To payout" value={both(BigInt(launch.feesCollected.tokenToPayout), BigInt(launch.feesCollected.quoteToPayout))} />
          <Line label="To MaxLong" value={both(BigInt(launch.feesCollected.tokenToPlatform), BigInt(launch.feesCollected.quoteToPlatform))} />
          <div className="mt-1 font-mono text-[10.5px] text-ink-45">
            {launch.feesCollectedAt > 0 ? `Last collected ${fmtAge(ageHours(launch.feesCollectedAt * 1000, now))} ago` : "Not collected yet"}
          </div>
          {/* Review round 1, finding 8: visibility is this one comparison, not a timer-driven setState, so the line
              never disappears just because REFRESH_MAX_TICKS passed while the store was still catching up. */}
          {justCollected && launch.feesCollectedAt === justCollected.baseline ? (
            <div className="mt-1 font-mono text-[10.5px] text-ink-45">
              {justCollected.split === "unknown"
                ? "Collected. Totals update shortly."
                : `Just collected: ${both(justCollected.split.tokenToPayout, justCollected.split.quoteToPayout)} to ${
                    // The address the transaction itself paid, not the panel's current idea of the payout.
                    address && isAddressEqual(justCollected.split.payout, address) ? "you" : "the payout"
                  }, ${both(justCollected.split.tokenToPlatform, justCollected.split.quoteToPlatform)} to MaxLong.`}
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
                    disabled={busy !== null || walletState === "connecting" || (walletState === "ready" && toProblem !== null)}
                    onClick={() => {
                      if (walletState !== "ready") {
                        walletAction();
                        return;
                      }
                      if (toProblem !== null) return;
                      void run(`claim-${label}`, `Claiming ${text}`, `Claimed ${text}`, (deps) => claimOwed(currency, to, deps));
                    }}
                    className={CLAIM_BUTTON}
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
            disabled={busy !== null || walletState === "connecting" || (walletState === "ready" && nothingToCollect)}
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
              <div role="group" aria-labelledby="payout-confirm-prompt">
                <div
                  id="payout-confirm-prompt"
                  ref={promptRef}
                  tabIndex={-1}
                  className="font-mono text-[11px] leading-[1.6] text-ink-60 outline-none"
                >
                  Hand the payout to <span className="break-all text-ink">{checksummedNewPayout}</span>? This is permanent. Only that address can change it again.
                </div>
                <div className="mt-3 flex gap-2">
                  <button type="button" disabled={busy !== null} onClick={onCancelPayout} className={`h-8 flex-1 ${SMALL}`}>
                    Cancel
                  </button>
                  <button type="button" disabled={busy !== null || !confirmReady} onClick={onConfirmPayout} className={`h-8 flex-1 ${SMALL}`}>
                    Confirm
                  </button>
                </div>
              </div>
            ) : (
              <>
                <input
                  ref={payoutInputRef}
                  aria-label="New payout address"
                  placeholder="0x…"
                  className={INPUT}
                  value={newPayout}
                  onChange={(e) => setNewPayout(e.target.value.trim())}
                  spellCheck={false}
                />
                <Reason text={payoutProblem} />
                <button
                  type="button"
                  disabled={busy !== null || walletState === "connecting" || (walletState === "ready" && (newPayout === "" || payoutProblem !== null))}
                  onClick={() => {
                    if (walletState !== "ready") {
                      walletAction();
                      return;
                    }
                    if (newPayout === "" || payoutProblem !== null) return;
                    setConfirmReady(false);
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
        {switchRefused && walletState === "wrong-network" ? (
          <div role="alert" className="font-mono text-[10.5px] text-down">
            Your wallet did not switch. Switch to Robinhood Chain in your wallet and try again.
          </div>
        ) : null}
      </div>
    </div>
  );
}
