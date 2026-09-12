import { defineChain } from "viem";

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

/** Where an untradeable pool sends the user instead. Bags has no known URL yet. */
export const LAUNCHPAD_URLS: Record<string, string | undefined> = {
  Bags: undefined, // TODO: Bags dapp URL once confirmed
};
