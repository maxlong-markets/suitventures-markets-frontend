import type { Metadata } from "next";
import TradersBoard from "@/components/TradersBoard";

export const metadata: Metadata = { title: "Traders" };

export default function TradersPage() {
  return (
    <section className="px-4 pb-8 tablet:px-5 desktop:px-6">
      <div className="mt-[18px] flex items-baseline gap-[14px]">
        <h1 className="text-[18px] font-medium tracking-[-0.01em]">Top traders</h1>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-40">
          Last 24 hours
        </span>
      </div>
      <TradersBoard />
    </section>
  );
}
