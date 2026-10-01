import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Yellowtail } from "next/font/google";
import { headers } from "next/headers";
import { Analytics } from "@vercel/analytics/next";
import Providers from "@/context/Providers";
import TokenGate from "@/components/TokenGate";
import TopBar from "@/components/TopBar";
import ToastStack from "@/components/ToastStack";
import SignModal from "@/components/SignModal";
import "./globals.css";

// Wordmark only. Helvetica Neue and SF Mono come from the system stacks.
const yellowtail = Yellowtail({
  variable: "--font-yellowtail",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: {
    default: "MaxLong Markets",
    template: "%s · MaxLong Markets",
  },
  // Under 160 characters so Google shows it whole, and written as one self-contained factual
  // sentence pair, because an AI search engine quotes a line like this verbatim — so every
  // entity in it has to be real. "Bags" was named here before and is not a launchpad this app
  // recognises (Origin in src/lib/types.ts); a wrong fact is worse than a vague one, since it
  // gets repeated. "Stock-paired" is the part nothing else on this chain can claim.
  description:
    "Every memecoin pair on Robinhood Chain, in one table. Live prices, volume and holders for stock-paired tokens from LONG, Pons and any Uniswap v4 pool.",
  applicationName: "MaxLong Markets",
};

export const viewport: Viewport = {
  themeColor: "#1f2125",
  colorScheme: "dark",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // wagmi's cookie storage: the wallet state hydrates without a flash.
  const cookies = (await headers()).get("cookie");

  return (
    <html lang="en" className={`${yellowtail.variable} h-full antialiased`}>
      <body className="min-h-full">
        <Providers cookies={cookies}>
          {/* ToastStack and SignModal stay outside the gate: they are portals owned by
              Providers, not part of the app a non-holder must not see (design doc §4.4). */}
          <TokenGate>
            <TopBar />
            <main>{children}</main>
          </TokenGate>
          <ToastStack />
          <SignModal />
        </Providers>
        {/* Vercel Web Analytics (1 Oct 2026): page views only, no cookies. Outside the gate so a visitor
            turned away at the door still counts as a view; it renders nothing and needs no provider. */}
        <Analytics />
      </body>
    </html>
  );
}
