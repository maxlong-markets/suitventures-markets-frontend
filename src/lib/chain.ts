import { defineChain } from "viem";
import type { Address, Origin, TokenPair } from "./types";

/** The chain's own public JSON-RPC node: 40 calls per address per rolling second (src/lib/chain/pacing.ts). */
export const PUBLIC_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

/**
 * The browser's RPC endpoints in the order wagmi tries them (src/lib/wagmi.ts): the public node first,
 * then NEXT_PUBLIC_RPC_URL as the backup when the public one refuses a visitor's burst. An unset
 * `NEXT_PUBLIC_*` reaches the bundle as the empty string, and anything that is not an http(s) URL or
 * that is the public node itself adds nothing. The one exception is the local fork harness
 * (scripts/fork/deploy-local.mts writes a 127.0.0.1 anvil URL into .env.fork): a loopback endpoint
 * is the ONLY endpoint, since a fork test that quietly read mainnet first would test nothing.
 */
export const BROWSER_RPC_URLS: readonly string[] = (() => {
  const url = process.env.NEXT_PUBLIC_RPC_URL || "";
  if (!/^https?:\/\//.test(url) || url === PUBLIC_RPC_URL) return [PUBLIC_RPC_URL];
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" ? [url] : [PUBLIC_RPC_URL, url];
})();

/** Robinhood Chain — Arbitrum Orbit L2, chain id 4663, gas in ETH. */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    // The public node is the chain's default everywhere (23 Sep 2026, per Kobe: public first, the
    // paid endpoint only as a backup). The browser's wagmi transport (src/lib/wagmi.ts) adds
    // NEXT_PUBLIC_RPC_URL behind it; the server's client (src/lib/chain/onchain.ts) reads
    // CHAIN_RPC_URL / CHAIN_RPC_FALLBACK_URL and never touches NEXT_PUBLIC_RPC_URL.
    default: { http: [BROWSER_RPC_URLS[0]!] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
});

export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";

export function txUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

/** Per-origin launchpad page for a token; empty pattern = no link yet. `{address}` is replaced with the lowercase token address. Patterns come from MAXLONG (README section 2). */
export const LAUNCHPAD_URL_PATTERNS: Partial<Record<Origin, string>> = { LONG: "", Pons: "" };

/**
 * Where an untradeable pool sends the user instead: the origin's launchpad page for this
 * token, or `undefined` when the origin has no pattern yet (`UntradeableCard` then renders
 * its text without a button, exactly as before this existed).
 */
export function launchpadUrl(pair: Pick<TokenPair, "origin" | "address">): string | undefined {
  const pattern = LAUNCHPAD_URL_PATTERNS[pair.origin];
  if (!pattern) return undefined;
  return pattern.replaceAll("{address}", pair.address.toLowerCase());
}

/** Uniswap v4's convention for "this pool has no hook contract" (TokenPair.hookAddress). */
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Permit2, the same canonical address on every chain it is deployed to. */
export const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** Uniswap's Universal Router on 4663 (contracts spec section 2). */
export const UNIVERSAL_ROUTER_ADDRESS: Address = "0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99";

/** The V4 Quoter on 4663. The contracts fork suite asserts it agrees with the Universal Router to the wei on all three live pools. */
export const V4_QUOTER_ADDRESS: Address = "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * SVRouter is a deployment choice rather than a chain fact, so it stays an environment variable.
 * An unset `NEXT_PUBLIC_*` reaches the bundle as the empty string, and a malformed one would be
 * signed against, so anything that is not an address is `undefined`: execution is disabled, the
 * quote route is not. `process.env.NEXT_PUBLIC_…` is substituted at build time and must therefore
 * be read by direct member access, which is what happens twice below.
 */
export const SVROUTER_ADDRESS: Address | undefined = ADDRESS.test(process.env.NEXT_PUBLIC_SVROUTER_ADDRESS ?? "")
  ? (process.env.NEXT_PUBLIC_SVROUTER_ADDRESS as Address)
  : undefined;

/** false renders the panel's "trading goes live when the router is deployed" state; the quote still prices. */
export function hasRouter(): boolean {
  return SVROUTER_ADDRESS !== undefined;
}
