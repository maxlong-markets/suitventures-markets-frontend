import { cookieStorage, createStorage } from "wagmi";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rabbyWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { fallback, http } from "wagmi";
import { BROWSER_RPC_URLS, robinhoodChain } from "./chain";

/**
 * RainbowKit refuses to build its connectors with an empty project id, so a
 * placeholder keeps the app booting for injected wallets. The WalletConnect
 * QR flow needs the real id from https://dashboard.reown.com.
 */
const PLACEHOLDER_PROJECT_ID = "set-NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID";

export const projectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || PLACEHOLDER_PROJECT_ID;

export const hasWalletConnectProjectId = projectId !== PLACEHOLDER_PROJECT_ID;

export const wagmiConfig = getDefaultConfig({
  appName: "SuitVentures Markets",
  projectId,
  chains: [robinhoodChain],
  // Public node first, the paid endpoint (NEXT_PUBLIC_RPC_URL) only when the public one refuses or
  // fails (23 Sep 2026; BROWSER_RPC_URLS in ./chain.ts has the order and the fork exception). Every
  // visitor is their own address to the public node, so its 40-calls-a-second budget is per visitor
  // here; batches stay within it so one burst is one request.
  transports: {
    [robinhoodChain.id]: fallback(BROWSER_RPC_URLS.map((url) => http(url, { batch: { batchSize: 40, wait: 16 } }))),
  },
  // The connect modal lists exactly these, in this order (handoff spec).
  // `injectedWallet` leads as the "Browser Wallet" fallback for any browser
  // wallet: it connects straight to whatever `window.ethereum` the page has,
  // so an extension the branded tiles below fail to detect still works.
  wallets: [
    {
      groupName: "Popular",
      wallets: [
        injectedWallet,
        metaMaskWallet,
        rabbyWallet,
        coinbaseWallet,
        walletConnectWallet,
      ],
    },
  ],
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
});

