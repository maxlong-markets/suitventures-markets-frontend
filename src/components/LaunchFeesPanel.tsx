"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isAddress, isAddressEqual, parseEventLogs } from "viem";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { useAppState } from "@/context/AppState";
import { useLaunchFees } from "@/hooks/useLaunchpad";
import { keys } from "@/hooks/useMarketsData";
import { LAUNCHPAD_EVENTS_ABI } from "@/lib/chain/abi";
import { robinhoodChain, ZERO_ADDRESS } from "@/lib/chain";
import { ageHours, fmtAge, fmtAmt, short } from "@/lib/format";
import {
  LAUNCH_MESSAGES, LaunchFailedError, LaunchRejectedError, LaunchUnconfirmedError, claimOwed, collectLaunchFees,
  type LaunchDeps, type WriteHandle,
} from "@/lib/launch";
import { LAUNCHPAD_ADDRESS } from "@/lib/launch/address";
import { toHuman } from "@/lib/quote/math";
import type { Address, Hex, LaunchInfo, TokenPair } from "@/lib/types";

const BUTTON = "h-9 w-full bg-chalk font-mono text-[10.5px] uppercase tracking-[0.22em] text-onlight hover:bg-white disabled:cursor-not-allowed disabled:bg-[rgba(244,238,218,0.06)] disabled:text-ink-34";
/** Claim's own label can grow long ("Switch to Robinhood Chain"); min-h instead of a fixed h keeps a wrapped label from
 * spilling past the border at 320 px. */
const CLAIM_BUTTON = "min-h-8 border border-hairline-btn bg-transparent px-3 py-1 font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink hover:border-hairline-hover disabled:cursor-not-allowed disabled:text-ink-34";
const INPUT = "h-8 w-full border border-hairline-strong bg-transparent px-2 font-mono text-[11px] outline-none focus:border-hairline-focus";

/**
 * How often, and for how long, the panel keeps asking the store for this token after a Collect: the contract's own
 * reads update at once, but the store can lag a fold cycle behind. Counted in ticks, not by reading the clock, so
 * nothing here calls an impure API from a plain function the react-compiler cannot prove runs outside render.
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

type WalletState = "disconnected" | "wrong-network" | "connecting" | "ready";

/** What one Collect transaction's own `FeesCollected` log paid the payout address. "unknown" when the receipt or the
 * event could not be read: the collection still went through. */
type PaidToPayout = { token: bigint; quote: bigint } | "unknown";
type JustCollected = { baseline: number; paid: PaidToPayout };

type Props = { pair: TokenPair; launch: LaunchInfo; now: number };

/** The coin's owner: the wallet its fees are paid to, or the wallet that launched it. */
function isOwner(address: string | undefined, launch: LaunchInfo): boolean {
  if (!address) return false;
  const a = address.toLowerCase();
  return a === launch.payout.toLowerCase() || a === launch.creator.toLowerCase();
}

/**
 * The launch's fee panel under the trade panel (instant launchpad design, section 7.3, amended 30 Sep 2026 at the
 * owner's request). It is for the coin's owner only: the payout address or the creator. Every other visitor sees
 * nothing here. It shows the owner's own side: what the launch's liquidity has earned for the payout address and not
 * yet collected, read live from the contract; what the payout address was paid so far, summed by the store; Collect;
 * and anything owed to the connected wallet, with a claim to an address it picks. MaxLong's share is not shown, and
 * the payout address can no longer be changed from the site (the contract's `setPayout` is untouched). The two
 * figures carry no "to you" or "to payout" label: both are the owner's. Only a creator whose fees go to another
 * address is told which one.
 */
export default function LaunchFeesPanel(props: Props) {
  const { address } = useAppState();
  if (!isOwner(address, props.launch)) return null;
  return <OwnerFees {...props} />;
}

function OwnerFees({ pair, launch, now }: Props) {
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
  // A switch the wallet refused. Shown only while the wallet is still on the wrong network, so it cannot sit beside
  // working buttons after the owner switches from the wallet itself.
  const [switchRefused, setSwitchRefused] = useState(false);
  // What this Collect paid the payout address (read from its own receipt, not a click-time guess), plus the store's
  // feesCollectedAt right before it. Shown only while those still match: the render-time comparison itself decides
  // visibility, so nothing needs to clear this on a timer.
  const [justCollected, setJustCollected] = useState<JustCollected | null>(null);
  const refreshRef = useRef<number | null>(null);
  // Which refresh run is current. A run that finds another has started since, or that the panel stopped, ends itself,
  // so two writes confirming close together can never leave an interval nobody owns.
  const runRef = useRef(0);
  // An async write can still be waiting on a confirmation after this panel has already unmounted.
  const mountedRef = useRef(true);

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

  // On the wrong network, or with nothing connected, Collect and Claim say what pressing them will do instead of
  // doing nothing. "connecting" covers two waits with one plain label, matching TradePanel.tsx's own: wagmi still
  // reconnecting a session from a previous visit, and a wallet client that has not resolved yet for the right chain,
  // including right after a switch.
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

  // Once the wallet's own chain changes to Robinhood, ask the wallet-client query again rather than wait for it to
  // notice on its own. Its staleTime is Infinity and only an address change invalidates it, so nothing else here
  // would ever refresh it after a switch. Only on the change itself, and keyed on the stable `refetch`: the query
  // result is a new object on every render, so depending on it re-ran this effect, refetched, built a new client,
  // re-rendered and refetched again, for as long as the panel stayed on screen.
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
   * Invalidates this token's pair query at once, then every REFRESH_POLL_MS, until `caughtUp` says the store's own
   * copy already reflects the Collect (its feesCollectedAt moving) or REFRESH_MAX_TICKS tries pass, whichever comes
   * first. A nudge only: nothing the panel shows is decided by this poll's own state (see justCollected's
   * render-time check), only refetched sooner than the store would otherwise be asked. Each run owns its interval and
   * ends itself when a newer run has started, so two runs that overlap cannot leave one behind. The pair query holds
   * null for a token the store does not have, which counts as "not caught up".
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
   * What a Collect paid the payout address, read from its own transaction rather than guessed from a click-time
   * snapshot of the uncollected read (which can be up to 30 s stale). Only a log from the launchpad itself, for this
   * token, counts: anyone can emit a look-alike event from another contract, and one transaction can carry another
   * token's collection. The receipt is already mined by the time this runs, so this is one more read, not a wait.
   */
  async function readPaid(hash: Hex): Promise<PaidToPayout> {
    // Captured into a local so its narrowing below survives into the closures further down.
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
      return { token: event.args.tokenToPayout, quote: event.args.quoteToPayout };
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
    // The only reason not to send a Collect is a contract read that has definitely answered "zero". While the read is
    // loading or failed, `u` is undefined and `nothingToCollect` is already false, so the press still collects.
    if (nothingToCollect) return;
    const baseline = launch.feesCollectedAt;
    void run("collect", `Collecting ${pair.ticker} fees`, `${pair.ticker} fees collected`, (deps) => collectLaunchFees(token, deps), (handle) => {
      if (!mountedRef.current) return;
      void readPaid(handle.hash).then((paid) => {
        if (mountedRef.current) setJustCollected({ baseline, paid });
      });
      void startRefresh((fresh) => fresh.launch != null && fresh.launch.feesCollectedAt !== baseline);
    });
  }

  return (
    <div className="mt-6 border border-hairline p-4">
      <div className="mb-3 font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-40">Pool fees</div>
      <div className="flex flex-col gap-3">
        <div>
          {fees.uncollectedFailed ? (
            <div className="py-[3px] font-mono text-[11px] text-ink-50">Could not read the uncollected fees just now.</div>
          ) : (
            <Line label="Uncollected" value={u ? both(u.tokenToPayout, u.quoteToPayout) : "Reading…"} />
          )}
          {/* What every payout address this token has had was paid so far, summed by the store. */}
          <Line label="Collected so far" value={both(BigInt(launch.feesCollected.tokenToPayout), BigInt(launch.feesCollected.quoteToPayout))} />
          <div className="mt-1 font-mono text-[10.5px] text-ink-45">
            {launch.feesCollectedAt > 0 ? `Last collected ${fmtAge(ageHours(launch.feesCollectedAt * 1000, now))} ago` : "Not collected yet"}
          </div>
          {/* Only a creator whose fees go to another address needs telling where they go. */}
          {isPayout ? null : <div className="mt-1 font-mono text-[10.5px] text-ink-45">Paid to {short(launch.payout)}.</div>}
          {justCollected && launch.feesCollectedAt === justCollected.baseline ? (
            <div className="mt-1 font-mono text-[10.5px] text-ink-45">
              {justCollected.paid === "unknown"
                ? "Collected. Totals update shortly."
                : `Just collected: ${both(justCollected.paid.token, justCollected.paid.quote)}.`}
            </div>
          ) : null}
        </div>

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
            className={BUTTON}
          >
            {walletLabel("Collect fees")}
          </button>
          {walletState === "ready" && nothingToCollect ? <div className="mt-2 text-center font-mono text-[10.5px] text-ink-50">Nothing to collect yet.</div> : null}
        </div>

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
