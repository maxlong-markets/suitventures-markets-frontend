"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePublicClient, useWalletClient } from "wagmi";
import { useAppState } from "@/context/AppState";
import { invalidatePairBalances, usePairBalances } from "@/hooks/useTokenBalance";
import { useSwapQuote } from "@/hooks/useMarketsData";
import { hasRouter, launchpadUrl, robinhoodChain } from "@/lib/chain";
import { fmtAmt, fmtQuote, fmtTradeAmt, fmtUsd } from "@/lib/format";
import { originLabel } from "@/lib/markets";
import { toHuman } from "@/lib/quote/math";
import { executeSwap, SwapFailedError, SwapRejectedError, SwapUnconfirmedError } from "@/lib/swap";
import type { Denom, Side, TokenPair } from "@/lib/types";
import { GearIcon, Spinner } from "./ui";

const AMOUNT_RE = /^\d*\.?\d*$/;
const QUICK_PCTS = [25, 50, 75, 100] as const;
const AUTO_SLIPPAGE = 0.5;
const SLIPPAGE_OPTIONS: ReadonlyArray<{ label: string; value: number; auto?: boolean }> = [
  { label: "Auto", value: AUTO_SLIPPAGE, auto: true },
  { label: "0.1%", value: 0.1 },
  { label: "0.5%", value: 0.5 },
  { label: "1%", value: 1 },
];

interface Slippage {
  value: number;
  auto: boolean;
  custom: string;
}

const DEFAULT_SLIPPAGE: Slippage = { value: AUTO_SLIPPAGE, auto: true, custom: "" };

/** The trade panel, or the "not routed" card for pools the router can't reach. */
export default function TradePanel({ pair }: { pair: TokenPair }) {
  if (!pair.tradeable) return <UntradeableCard pair={pair} />;
  // Keyed so every pair starts from a clean form.
  return <TradeForm key={pair.id} pair={pair} />;
}

function UntradeableCard({ pair }: { pair: TokenPair }) {
  const url = launchpadUrl(pair);
  return (
    <div className="border border-hairline px-[22px] py-[34px] text-center">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-40">
        Not routed
      </div>
      <div className="mb-2 mt-3 text-[17px]">Not tradeable here yet</div>
      <div className="text-pretty text-[12.5px] leading-[1.5] text-ink-50">
        This pool can&apos;t be routed through the SuitVentures swap yet.
      </div>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="mt-5 inline-flex h-[34px] items-center border border-wallet-border px-4 font-mono text-[9.5px] uppercase tracking-[0.22em] hover:border-wallet-border-hover hover:bg-wallet-hover"
        >
          <span className="whitespace-nowrap">Trade on {originLabel(pair.origin)} ↗</span>
        </a>
      ) : null}
    </div>
  );
}

function BreakdownRow({
  label,
  value,
  tone = "text-ink",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1">
      <span className="flex-none text-ink-50">{label}</span>
      <span className={`text-right ${tone}`}>{value}</span>
    </div>
  );
}

function SlippagePopover({
  slippage,
  onChange,
  onClose,
  boundary,
}: {
  slippage: Slippage;
  onChange(next: Slippage): void;
  onClose(): void;
  /** Clicks inside this element (the panel) don't close the popover. */
  boundary: React.RefObject<HTMLDivElement | null>;
}) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boundary.current && !boundary.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [boundary, onClose]);

  const onCustom = (raw: string) => {
    if (!AMOUNT_RE.test(raw)) return;
    const num = parseFloat(raw);
    if (num > 0 && num < 50) onChange({ value: num, auto: false, custom: raw });
    else onChange({ ...slippage, custom: raw });
  };

  return (
    <div
      role="dialog"
      aria-label="Max slippage"
      className="absolute bottom-[74px] right-4 z-[8] w-[240px] border border-hairline-strong bg-panel p-[14px] font-mono"
    >
      <div className="flex justify-between text-[10px] uppercase tracking-[0.18em] text-ink-50">
        <span>Max slippage</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="bg-transparent p-0 text-[13px] leading-none text-ink-50 hover:text-ink"
        >
          ×
        </button>
      </div>
      <div className="mt-[10px] grid grid-cols-4 gap-1">
        {SLIPPAGE_OPTIONS.map((o) => {
          const on = o.auto
            ? slippage.auto
            : !slippage.auto && slippage.value === o.value && !slippage.custom;
          return (
            <button
              key={o.label}
              type="button"
              aria-pressed={on}
              onClick={() => onChange({ value: o.value, auto: Boolean(o.auto), custom: "" })}
              className={`h-7 border text-[10.5px] hover:border-hairline-hover ${
                on
                  ? "border-chalk-50 bg-chalk-10 text-chalk"
                  : "border-hairline-strong bg-transparent text-ink-65"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <div className="mt-[6px] flex h-[30px] items-center border border-hairline-strong">
        <input
          value={slippage.custom}
          onChange={(e) => onCustom(e.target.value)}
          placeholder="Custom"
          inputMode="decimal"
          aria-label="Custom slippage"
          className="h-full min-w-0 flex-1 bg-transparent px-[10px] text-[11px] outline-none"
        />
        <span className="pr-[10px] text-[11px] text-ink-45">%</span>
      </div>
      <div className="mt-[10px] text-[10.5px] leading-[1.5] text-ink-45">
        {slippage.value > 1
          ? "High slippage. Your trade may fill at a worse price than quoted."
          : "Your trade reverts if the price moves more than this before it confirms."}
      </div>
    </div>
  );
}

function TradeForm({ pair }: { pair: TokenPair }) {
  const { isConnected, address, isHolder, addToast, updateToast } = useAppState();
  const balances = usePairBalances(pair);
  const publicClient = usePublicClient({ chainId: robinhoodChain.id });
  const { data: walletClient } = useWalletClient({ chainId: robinhoodChain.id });
  const qc = useQueryClient();
  const [side, setSide] = useState<Side>("buy");
  const [denom, setDenom] = useState<Denom>("quote");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState<Slippage>(DEFAULT_SLIPPAGE);
  const [slipOpen, setSlipOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const buy = side === "buy";
  // Display and gating only: every amount that reaches the route or the chain is the string
  // above, never this (Global Constraint 1, ruling 11).
  const amountNum = parseFloat(amount) || 0;
  const payAsset = buy ? pair.quote : pair.ticker;
  const receiveAsset = buy ? pair.ticker : pair.quote;
  const payBalance = buy ? balances.quote : balances.token;
  /** The pay balance to the last wei, for the Max button (ruling 12). */
  const payBalanceText = buy ? balances.quoteText : balances.tokenText;
  const quoteUsd = pair.priceUsd / pair.priceQuote;

  const quoteQuery = useSwapQuote({
    id: pair.id,
    side,
    // The text the user typed, unrounded: `toBase` on the server turns this very string into
    // the amountIn Permit2 transfers.
    amount,
    denom,
    isSuitHolder: isHolder,
    slippagePct: slippage.value,
  });
  const closeSlippage = useCallback(() => setSlipOpen(false), []);

  // Every hook above runs unconditionally. `routable: false` is the Quoter's verdict on this
  // one amount (Task 6 review, I2), not a property of the pool: the "Not routed" card stays
  // reserved for the list-level `pair.tradeable` flag, decided once at the top of this file. A
  // specific amount that can't be routed instead disables the button below with an inline
  // reason, so the input that would let the user shrink the amount is never taken away.
  const quote = quoteQuery.data;

  const call = quote?.call;
  const payAmount = amountNum ? (quote?.payAmount ?? 0) : 0;
  const receiveAmount = amountNum ? (quote?.receiveAmount ?? 0) : 0;
  const impact = quote?.priceImpactPct ?? 0;
  const routerFee = quote?.routerFeePct ?? (isHolder ? 0 : 0.5);
  const poolFee = quote?.poolFeePct;
  const minReceived = quote?.minReceived ?? 0;

  const denomAsset = denom === "quote" ? pair.quote : pair.ticker;
  const denomIsPay = denomAsset === payAsset;
  const outAsset = denomIsPay ? receiveAsset : payAsset;
  const outAmount = denomIsPay ? receiveAmount : payAmount;
  const outUsd = denomIsPay
    ? receiveAmount * (buy ? pair.priceUsd : quoteUsd)
    : payAmount * (buy ? quoteUsd : pair.priceUsd);

  const poolFeeText =
    poolFee == null
      ? "—"
      : `${poolFee.toFixed(2)}%` +
        (pair.origin === "Pons"
          ? " · MemeHook"
          : pair.origin === "LONG"
            ? " · Doppler"
            : "");

  let state: "ready" | "disabled" | "pending" = "ready";
  let reason = "";
  if (!hasRouter()) {
    // The quote route still answers, so every number on the panel is real; only execution
    // is off until NEXT_PUBLIC_SVROUTER_ADDRESS names a deployed router.
    state = "disabled";
    reason = "Trading goes live when the router is deployed";
  } else if (!isConnected) {
    state = "disabled";
    reason = "Connect a wallet to trade.";
  } else if (!amountNum) {
    state = "disabled";
    reason = "Enter an amount.";
  } else if (quoteQuery.isError) {
    state = "disabled";
    reason = "Quote unavailable. Try again.";
  } else if (quote?.routable === false) {
    // The Quoter's verdict on this one amount — typically too large for the pool to fill —
    // not a property of the pool, so the form stays up and the user can type a smaller one.
    state = "disabled";
    reason = "This amount can't be routed through the pool. Try a smaller amount.";
  } else if (payAmount > payBalance) {
    state = "disabled";
    reason = `Insufficient ${payAsset} balance.`;
  } else if (!walletClient || !publicClient) {
    state = "disabled";
    reason = "Connecting to your wallet…";
  } else if (!call || quoteQuery.isPlaceholderData || quoteQuery.isFetching) {
    // No settled execution block yet: the first priced answer is still in flight, the amount
    // just changed and `useSwapQuote`'s placeholder data is still showing the previous amount's
    // answer (never submit that stale `call` — Task 6 review, I1), or this build's data source
    // is the mock, which never asks the route.
    state = "disabled";
    reason = "Fetching a quote…";
  } else if (receiveAmount === 0 || call.amountOutMin === "0") {
    // The honest-zero ruling (route review I2): routable stays true with amountOutMin floored to
    // "0", and checkUint128 in swap.ts rightly refuses to submit a zero minimum — so this button
    // must not promise a trade that can never succeed. `call` is settled here (the branch above
    // already ruled out "still fetching"), so this is the quote's real verdict, not a loading zero.
    state = "disabled";
    reason = "Too small to receive anything. Increase the amount.";
  }
  if (pending) state = "pending";

  const switchSide = (next: Side) => {
    setSide(next);
    setAmount("");
    setDenom(next === "buy" ? "quote" : "token");
  };
  const toggleDenom = () => {
    setDenom((d) => (d === "quote" ? "token" : "quote"));
    setAmount("");
  };
  const onAmount = (raw: string) => {
    if (AMOUNT_RE.test(raw)) setAmount(raw);
  };
  const quick = (pct: number) => {
    setDenom(buy ? "quote" : "token");
    if (!payBalance) {
      setAmount("");
      return;
    }
    // 100 % is the balance to the last wei (spec section 5, ruling 12): the router's fee comes
    // out of the input, so the whole balance is spendable, and a rounded Max would either leave
    // dust behind or trip the insufficient-balance guard. 25/50/75 keep their display rounding —
    // they are a convenience, not a promise about a balance.
    setAmount(
      pct === 100
        ? payBalanceText
        : String(+((payBalance * pct) / 100).toFixed(buy ? 2 : 0)),
    );
  };

  const submit = async () => {
    if (state !== "ready" || !address || !call || !walletClient || !publicClient) return;
    const verb = buy ? "Buying" : "Selling";
    const done = buy ? "Bought" : "Sold";
    const paid = `${fmtTradeAmt(payAmount)} ${payAsset}`;
    setPending(true);
    setSlipOpen(false);
    const toastId = addToast({
      kind: "pending",
      message: `${verb} ${fmtTradeAmt(receiveAmount)} ${receiveAsset} for ${paid}`,
    });
    try {
      const handle = await executeSwap(
        {
          slippagePct: slippage.value,
          // Verbatim: the browser never recomputes an amount the route returned.
          call,
        },
        { wallet: walletClient, publicClient, account: address },
      );
      updateToast(toastId, { hash: handle.hash });
      const receipt = await handle.confirmation;
      // The Trade event's own number, never the quote's: a hook can take a cut on the way
      // out, and the user is told what actually landed in the wallet.
      const received = fmtTradeAmt(Number(toHuman(receipt.amountOut, call.tokenOutDecimals)));
      updateToast(toastId, { kind: "confirmed", message: `${done} ${received} ${receiveAsset} for ${paid}` });
      setAmount("");
      void invalidatePairBalances(qc);
    } catch (err) {
      if (err instanceof SwapUnconfirmedError) {
        // Broadcast, but its outcome could not be read — never "failed" and never "nothing was
        // spent" (that wording invites a duplicate swap). The hash patched onto the toast above
        // survives this merge, so the explorer link stays; the amount is deliberately left as-is
        // (see the absence of setAmount("") below and in this branch).
        updateToast(toastId, { kind: "unconfirmed", message: err.message });
      } else {
        updateToast(toastId, {
          kind: "failed",
          // src/lib/swap.ts owns the wording (spec section 4); duplicating it here would let
          // the two drift.
          message:
            err instanceof SwapRejectedError || err instanceof SwapFailedError
              ? err.message
              : "Swap failed. Nothing was spent.",
        });
      }
    } finally {
      setPending(false);
    }
  };

  const buttonLabel = `${buy ? "Buy" : "Sell"} ${pair.ticker}`;

  return (
    <div ref={panelRef} className="relative border border-hairline p-4">
      <div className="grid grid-cols-2 border border-hairline-strong" role="group" aria-label="Side">
        <button
          type="button"
          aria-pressed={buy}
          onClick={() => switchSide("buy")}
          className={`h-8 font-mono text-[10.5px] uppercase tracking-[0.22em] ${
            buy ? "bg-chalk-10 text-chalk" : "bg-transparent text-ink-50"
          }`}
        >
          Buy
        </button>
        <button
          type="button"
          aria-pressed={!buy}
          onClick={() => switchSide("sell")}
          className={`h-8 border-l border-hairline-strong font-mono text-[10.5px] uppercase tracking-[0.22em] ${
            !buy ? "bg-chalk-10 text-chalk" : "bg-transparent text-ink-50"
          }`}
        >
          Sell
        </button>
      </div>

      <div className="mt-4 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-ink-45">
        <span>{denomIsPay ? "You pay" : "You receive"}</span>
        <span className="normal-case tracking-[0.04em] tabular-nums">
          Balance {fmtAmt(payBalance, buy ? 2 : 0)} {payAsset}
        </span>
      </div>
      <div className="mt-2 flex h-[52px] items-center border border-hairline-strong focus-within:border-hairline-focus">
        <input
          value={amount}
          onChange={(e) => onAmount(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
          autoComplete="off"
          aria-label="Amount"
          className="h-full min-w-0 flex-1 bg-transparent px-3 font-mono text-[20px] tabular-nums outline-none"
        />
        <button
          type="button"
          onClick={toggleDenom}
          title="Switch denomination"
          className="mr-[10px] h-8 whitespace-nowrap border border-hairline-strong bg-transparent px-[10px] font-mono text-[11px] tracking-[0.08em] text-ink hover:border-hairline-hover"
        >
          {denomAsset} <span className="ml-1 text-ink-45">⇅</span>
        </button>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-[6px]">
        {QUICK_PCTS.map((pct) => (
          <button
            key={pct}
            type="button"
            onClick={() => quick(pct)}
            className="h-[26px] border border-hairline-mid bg-transparent font-mono text-[10.5px] tracking-[0.08em] text-ink-70 hover:border-hairline-hover hover:text-ink"
          >
            {pct === 100 ? "Max" : `${pct}%`}
          </button>
        ))}
      </div>

      <div className="mt-[18px] font-mono tabular-nums">
        <div className="text-[10px] uppercase tracking-[0.18em] text-ink-45">
          {denomIsPay ? "You receive" : "You pay"}
        </div>
        <div className="mt-[6px] flex items-baseline gap-2">
          <span className="text-[22px] tracking-[-0.01em]">
            {amountNum ? fmtTradeAmt(outAmount) : "0.00"}
          </span>
          <span className="text-[12px] text-ink-55">{outAsset}</span>
          <span className="ml-auto text-[11px] text-ink-40">
            {amountNum ? (pair.stale ? "—" : `≈ ${fmtUsd(outUsd)}`) : ""}
          </span>
        </div>
      </div>

      <div className="mt-[14px] border-t border-hairline pt-3 font-mono text-[11.5px] tabular-nums">
        <BreakdownRow
          label="Rate"
          value={`1 ${pair.ticker} = ${fmtQuote(pair.priceQuote)} ${pair.quote}`}
        />
        <BreakdownRow
          label="Price impact"
          value={amountNum ? (impact < 0.01 ? "< 0.01%" : `${impact.toFixed(2)}%`) : "—"}
          tone={impact > 3 ? "text-down" : "text-ink"}
        />
        <BreakdownRow
          label="Router fee"
          value={routerFee === 0 ? "0% · Suit holder" : "0.5%"}
          tone={routerFee === 0 ? "text-chalk" : "text-ink"}
        />
        <BreakdownRow label="Pool fee" value={poolFeeText} />
        <BreakdownRow
          label="Min. received"
          value={amountNum ? `${fmtTradeAmt(minReceived)} ${receiveAsset}` : "—"}
        />
        <BreakdownRow label="Network" value="Robinhood Chain · < $0.01" />
      </div>

      <div className="mt-3 flex items-center justify-between font-mono text-[10.5px] text-ink-50">
        <span className="text-[10px] uppercase tracking-[0.18em]">Slippage</span>
        <button
          type="button"
          onClick={() => setSlipOpen((o) => !o)}
          aria-label="Slippage settings"
          aria-expanded={slipOpen}
          className={`flex items-center gap-2 bg-transparent p-0 font-mono text-[11px] tabular-nums hover:text-ink ${
            slippage.value > 1 ? "text-down" : "text-ink-70"
          }`}
        >
          <span>{slippage.auto ? `Auto · ${AUTO_SLIPPAGE}%` : `${slippage.value}%`}</span>
          <GearIcon />
        </button>
      </div>
      {slipOpen ? (
        <SlippagePopover
          slippage={slippage}
          onChange={setSlippage}
          onClose={closeSlippage}
          boundary={panelRef}
        />
      ) : null}

      {state === "ready" ? (
        <button
          type="button"
          onClick={submit}
          className="mt-[14px] h-11 w-full bg-chalk font-mono text-[11px] uppercase tracking-[0.22em] text-onlight hover:bg-white"
        >
          {buttonLabel}
        </button>
      ) : null}
      {state === "disabled" ? (
        <>
          <button
            type="button"
            disabled
            className="mt-[14px] h-11 w-full cursor-not-allowed border border-hairline-mid bg-[rgba(244,238,218,0.06)] font-mono text-[11px] uppercase tracking-[0.22em] text-ink-34"
          >
            {buttonLabel}
          </button>
          <div className="mt-2 text-center font-mono text-[10.5px] text-ink-50">{reason}</div>
        </>
      ) : null}
      {state === "pending" ? (
        <>
          <button
            type="button"
            disabled
            className="mt-[14px] flex h-11 w-full cursor-wait items-center justify-center gap-[10px] bg-[rgba(244,238,218,0.55)] font-mono text-[11px] uppercase tracking-[0.22em] text-onlight"
          >
            <Spinner dark />
            Confirm in wallet
          </button>
          <div className="mt-2 text-center font-mono text-[10.5px] text-ink-50">
            Waiting for your signature.
          </div>
        </>
      ) : null}
    </div>
  );
}
