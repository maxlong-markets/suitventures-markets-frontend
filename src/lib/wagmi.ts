import { cookieStorage, createStorage } from "wagmi";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  metaMaskWallet,
  rabbyWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { robinhoodChain } from "./chain";

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
  // The connect modal lists exactly these, in this order (handoff spec).
  wallets: [
    {
      groupName: "Popular",
      wallets: [metaMaskWallet, rabbyWallet, coinbaseWallet, walletConnectWallet],
    },
  ],
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
});

