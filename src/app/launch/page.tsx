import type { Metadata } from "next";
import LaunchForm from "@/components/LaunchForm";
import YourLaunches from "@/components/YourLaunches";
import { fmtInt } from "@/lib/format";
import { POOL_FEE_PCT } from "@/lib/launch";
import { hasLaunchpad } from "@/lib/launch/address";
import { SUPPLY, TOKEN_DECIMALS } from "@/lib/launch/math";

export const metadata: Metadata = { title: "Launch" };

/**
 * UX review, should fix 1: the model in three plain lines, before anyone pays, claiming no more than the contract does (fix
 * round 1, ruling 2). The launchpad places the whole supply in the pool as liquidity and never removes it, though the tokens
 * leave the pool as people buy; the launch sends the creator nothing but the first buy; other people can add liquidity to
 * the same pool, so the launch's earns only its part of the fee, which `collectFees` pays out. The no-break space keeps a
 * number with its percent sign (ruling 10).
 */
const MODEL = [
  `A fixed supply of ${fmtInt(Number(SUPPLY / 10n ** BigInt(TOKEN_DECIMALS)))} tokens goes into a Uniswap v4 pool as liquidity that nobody can withdraw.`,
  "Launching gives you no tokens. To start with some, make a first buy in the same transaction.",
  `Every trade pays a ${POOL_FEE_PCT}\u{A0}% pool fee. The part earned by the launch's locked liquidity is paid out when anyone presses Collect on the token's page.`,
];

/** Spec 7.2: while NEXT_PUBLIC_LAUNCHPAD_ADDRESS is unset the page shows only this card, in TradePanel's card recipe. */
function NotLive() {
  return (
    <div className="mt-5 border border-hairline px-[22px] py-[34px] text-center">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-40">Launch</div>
      <div className="mb-2 mt-3 text-[17px]">Launching is not live yet</div>
      <div className="text-pretty text-[12.5px] leading-[1.5] text-ink-50">Token launches open here once the launchpad contract is deployed.</div>
    </div>
  );
}

export default function LaunchPage() {
  return (
    <section className="px-4 pb-8 tablet:px-5 desktop:px-6">
      <div className="mt-[18px] flex items-baseline gap-[14px]">
        <h1 className="text-[18px] font-medium tracking-[-0.01em]">Launch a token</h1>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-40">Uniswap v4 · Robinhood Chain</span>
      </div>
      {hasLaunchpad() ? (
        <>
          <ul className="mt-3 max-w-[720px] space-y-1 text-pretty text-[12.5px] leading-[1.5] text-ink-50">
            {MODEL.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <LaunchForm />
          {/* Amended 30 Sep 2026: the connected wallet's own launches, shown only once it has one. */}
          <YourLaunches />
        </>
      ) : (
        <NotLive />
      )}
    </section>
  );
}
