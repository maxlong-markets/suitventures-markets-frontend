"use client";

import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { useBytecode, useReadContract, useReadContracts } from "wagmi";
import { robinhoodChain } from "@/lib/chain";
import { svLaunchpadAbi } from "@/lib/launch/abi";
import { LAUNCHPAD_ADDRESS } from "@/lib/launch/address";
import { erc20Abi } from "@/lib/swap/abi";
import type { Address } from "@/lib/types";

/**
 * The launchpad's contract reads (instant launchpad design, sections 7.2 and 7.3). Every figure the form and the fee
 * panel show about the contract's settings is read live: the creator share, router fee and first-buy cap are never
 * hard-coded. Nothing is read while NEXT_PUBLIC_LAUNCHPAD_ADDRESS is unset.
 */
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const LIVE = LAUNCHPAD_ADDRESS !== undefined;
const LAUNCHPAD = { address: LAUNCHPAD_ADDRESS ?? ZERO, abi: svLaunchpadAbi, chainId: robinhoodChain.id } as const;

export type LaunchSettings = {
  allowed?: boolean;
  launchesToday?: number;
  dailyLimit?: number;
  routerFeeBps?: number;
  creatorShareBps?: number;
  firstBuyCapBps?: number;
  /** The launchpad's `hook()` setting. Non-zero means future launches would carry a hook; the form refuses to launch then. */
  hook?: Address;
};

export function useLaunchSettings(account?: Address): LaunchSettings {
  const { data } = useReadContracts({
    contracts: [
      { ...LAUNCHPAD, functionName: "routerFeeBps" },
      { ...LAUNCHPAD, functionName: "creatorShareBps" },
      { ...LAUNCHPAD, functionName: "firstBuyCapBps" },
      { ...LAUNCHPAD, functionName: "dailyLaunchLimit" },
      { ...LAUNCHPAD, functionName: "isAllowedLauncher", args: [account ?? ZERO] },
      { ...LAUNCHPAD, functionName: "launchesToday", args: [account ?? ZERO] },
      { ...LAUNCHPAD, functionName: "hook" },
    ],
    query: { enabled: LIVE, refetchInterval: 30_000 },
  });
  const at = <T,>(i: number): T | undefined => (data?.[i]?.status === "success" ? (data[i]!.result as T) : undefined);
  const today = at<bigint>(5);
  return {
    routerFeeBps: at<number>(0),
    creatorShareBps: at<number>(1),
    firstBuyCapBps: at<number>(2),
    dailyLimit: at<number>(3),
    allowed: account ? at<boolean>(4) : undefined,
    launchesToday: account && today !== undefined ? Number(today) : undefined,
    hook: at<Address>(6),
  };
}

export type CurrencyBounds = { min: bigint; max: bigint; creationFee: bigint };
/** The bounds plus `refetch`, so a PermitMismatch retry can re-read a creation fee the owner just changed. */
export type CurrencyConfig = CurrencyBounds & { refetch(): void };

/** Re-read every 30 s like the settings: the creation fee can change under an open form (spec 7.2, PermitMismatch). */
export function useCurrencyConfig(quote?: Address): CurrencyConfig | undefined {
  const { data, refetch } = useReadContract({
    ...LAUNCHPAD,
    functionName: "currency",
    args: [quote ?? ZERO],
    query: { enabled: LIVE && quote !== undefined, refetchInterval: 30_000 },
  });
  return data
    ? { min: data.minValuation, max: data.maxValuation, creationFee: data.creationFee, refetch: () => void refetch() }
    : undefined;
}

function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

export type OpeningInput = { account?: Address; salt: Hex; name: string; symbol: string; quote?: Address; valuation: bigint | null };
export type Opening = { token?: Address; openTick?: number; snapped?: bigint; pending: boolean };

/**
 * The snapped preview (spec 7.2): `predictToken` for the currency order, then `openingFor` for V', re-read 300 ms after
 * the last change to name, symbol, currency or valuation. Spec 14.20: the contract answers, the app ports no TickMath.
 */
export function useOpening(input: OpeningInput): Opening {
  const key = JSON.stringify([input.account ?? "", input.salt, input.name, input.symbol, input.quote ?? "", input.valuation?.toString() ?? ""]);
  const settled = useDebounced(key, 300);
  const [account, salt, name, symbol, quote, valuation] = JSON.parse(settled) as string[];
  const ready = LIVE && account !== "" && name !== "" && symbol !== "" && quote !== "" && valuation !== "";
  const predicted = useReadContract({
    ...LAUNCHPAD,
    functionName: "predictToken",
    args: [(account || ZERO) as Address, salt as Hex, name!, symbol!],
    query: { enabled: ready },
  });
  const token = predicted.data;
  const opening = useReadContract({
    ...LAUNCHPAD,
    functionName: "openingFor",
    args: [token ?? ZERO, (quote || ZERO) as Address, valuation ? BigInt(valuation) : 0n],
    query: { enabled: ready && token !== undefined },
  });
  return {
    token,
    openTick: opening.data?.[0],
    snapped: opening.data?.[2],
    pending: key !== settled || predicted.isFetching || opening.isFetching,
  };
}

/**
 * Whether the token's code is on chain, re-read every 5 s while `watch` is on. The form watches the predicted address while
 * a launch's outcome is unknown: the token turning up is, with "Start a new launch", the only way out (fix round 1, ruling 6).
 */
export function useTokenDeployed(token: Address | undefined, watch: boolean): boolean {
  const { data } = useBytecode({
    address: token,
    chainId: robinhoodChain.id,
    query: { enabled: watch && token !== undefined, refetchInterval: 5_000 },
  });
  return data !== undefined && data !== null && data !== "0x";
}

export function useTokenBalanceOf(token?: Address, account?: Address): bigint | undefined {
  const { data } = useReadContract({
    address: token ?? ZERO,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account ?? ZERO],
    chainId: robinhoodChain.id,
    query: { enabled: token !== undefined && account !== undefined, refetchInterval: 10_000 },
  });
  return data;
}

export type PendingFees = {
  tokenFees: bigint; quoteFees: bigint; tokenToPayout: bigint; quoteToPayout: bigint; tokenToFeeWallet: bigint; quoteToFeeWallet: bigint;
};
export type LaunchFees = {
  uncollected?: PendingFees;
  /** The view could not be read: the panel must say so, never show zeros (Review Focus 5). */
  uncollectedFailed: boolean;
  owedToken?: bigint;
  owedQuote?: bigint;
  refetch(): void;
};

/** Spec 7.3: `uncollectedFees(token)` every 30 s, and the connected wallet's `owed` balance in both currencies. */
export function useLaunchFees(token: Address, quote: Address, account?: Address): LaunchFees {
  const fees = useReadContract({ ...LAUNCHPAD, functionName: "uncollectedFees", args: [token], query: { enabled: LIVE, refetchInterval: 30_000 } });
  const owed = useReadContracts({
    contracts: [
      { ...LAUNCHPAD, functionName: "owed", args: [account ?? ZERO, token] },
      { ...LAUNCHPAD, functionName: "owed", args: [account ?? ZERO, quote] },
    ],
    query: { enabled: LIVE && account !== undefined, refetchInterval: 30_000 },
  });
  const owedAt = (i: number) => (owed.data?.[i]?.status === "success" ? (owed.data[i]!.result as bigint) : undefined);
  return {
    uncollected: fees.data,
    uncollectedFailed: fees.isError && fees.data === undefined,
    owedToken: account ? owedAt(0) : undefined,
    owedQuote: account ? owedAt(1) : undefined,
    refetch: () => {
      void fees.refetch();
      void owed.refetch();
    },
  };
}
