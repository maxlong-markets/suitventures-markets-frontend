"use client";

import { type ReactNode } from "react";
import { cookieToInitialState, WagmiProvider } from "wagmi";
import {
  QueryClient,
  QueryClientProvider,
  defaultShouldDehydrateQuery,
} from "@tanstack/react-query";
import { darkTheme, RainbowKitProvider, type Theme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { wagmiConfig } from "@/lib/wagmi";
import { robinhoodChain } from "@/lib/chain";
import { DataSourceProvider } from "./DataSource";
import { AppStateProvider } from "./AppState";

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
      },
      dehydrate: {
        shouldDehydrateQuery: (q) =>
          defaultShouldDehydrateQuery(q) || q.state.status === "pending",
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient(): QueryClient {
  if (typeof window === "undefined") return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

const MONO =
  '"SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace';

/**
 * RainbowKit's modal in the handoff's theme: panel background, hairline
 * borders, chalk as the single accent, mono voice, no radius anywhere.
 */
function buildTheme(): Theme {
  const t = darkTheme({
    accentColor: "#F4EEDA",
    accentColorForeground: "#050506",
    borderRadius: "none",
    fontStack: "system",
    overlayBlur: "none",
  });
  t.colors.modalBackground = "#35373C";
  t.colors.modalBackdrop = "rgba(5, 5, 6, 0.78)";
  t.colors.modalBorder = "rgba(240, 232, 214, 0.22)";
  t.colors.modalText = "#FDFCF9";
  t.colors.modalTextDim = "rgba(250, 248, 244, 0.55)";
  t.colors.modalTextSecondary = "rgba(250, 248, 244, 0.72)";
  t.colors.generalBorder = "rgba(240, 232, 214, 0.22)";
  t.colors.generalBorderDim = "rgba(240, 232, 214, 0.16)";
  t.colors.menuItemBackground = "rgba(250, 248, 244, 0.07)";
  t.colors.profileForeground = "#2B2D31";
  t.colors.profileAction = "rgba(240, 232, 214, 0.1)";
  t.colors.profileActionHover = "rgba(240, 232, 214, 0.18)";
  t.colors.closeButtonBackground = "transparent";
  t.colors.closeButton = "rgba(250, 248, 244, 0.7)";
  t.colors.actionButtonBorder = "rgba(240, 232, 214, 0.22)";
  t.colors.actionButtonBorderMobile = "rgba(240, 232, 214, 0.22)";
  t.colors.actionButtonSecondaryBackground = "rgba(240, 232, 214, 0.12)";
  t.colors.selectedOptionBorder = "rgba(244, 238, 218, 0.7)";
  t.colors.downloadBottomCardBackground = "#2B2D31";
  t.colors.downloadTopCardBackground = "#2B2D31";
  t.colors.connectButtonBackground = "transparent";
  t.colors.connectButtonInnerBackground = "transparent";
  t.colors.connectButtonText = "#F4F2EE";
  t.fonts.body = MONO;
  t.shadows = {
    connectButton: "none",
    dialog: "none",
    profileDetailsAction: "none",
    selectedOption: "none",
    selectedWallet: "none",
    walletLogo: "none",
  };
  return t;
}

const theme = buildTheme();

export default function Providers({
  children,
  cookies,
}: {
  children: ReactNode;
  cookies: string | null;
}) {
  const queryClient = getQueryClient();
  const initialState = cookieToInitialState(wagmiConfig, cookies);

  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={theme}
          modalSize="wide"
          initialChain={robinhoodChain.id}
          appInfo={{ appName: "SuitVentures Markets" }}
        >
          <DataSourceProvider>
            <AppStateProvider>{children}</AppStateProvider>
          </DataSourceProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
