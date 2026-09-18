import { defineChain } from "viem";
import type { Address, Origin } from "./types";

/** Robinhood Chain — Arbitrum Orbit L2, chain id 4663, gas in ETH. */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      // An empty NEXT_PUBLIC_RPC_URL means "use the public RPC".
      http: [
        process.env.NEXT_PUBLIC_RPC_URL ||
          "https://rpc.mainnet.chain.robinhood.com",
      ],
    },
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

/** Where an untradeable pool sends the user instead; no origin has a URL yet. */
export const ORIGIN_URLS: Partial<Record<Origin, string>> = {};

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
