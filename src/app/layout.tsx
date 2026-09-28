import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Yellowtail } from "next/font/google";
import { headers } from "next/headers";
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
    default: "SuitVentures Markets",
    template: "%s · SuitVentures Markets",
  },
  description:
    "Every memecoin pair on Robinhood Chain — LONG, Pons, Bags and SuitVentures launches in one table, swapped through the SuitVentures router.",
  applicationName: "SuitVentures Markets",
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
      </body>
    </html>
  );
}
