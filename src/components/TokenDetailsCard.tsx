import { buildFactRows } from "@/lib/tokenFacts";
import type { TokenPair } from "@/lib/types";
import TokenFactsList from "./TokenFactsList";

/**
 * The token's details inside the app, right under the trade panel (30 Sep 2026, the owner's request): the six figures
 * a trader looks for first, then "All details" for the rest. It reads the same live pair the rest of the token view
 * does, so the figures move with the page. `now` is the moment that pair was fetched, handed in by TokenView, so
 * nothing here reads the clock during render.
 */
export default function TokenDetailsCard({ pair, now }: { pair: TokenPair; now: number }) {
  return (
    <section aria-label="Token details" className="mt-6 border border-hairline px-4 pb-1 pt-4">
      <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-40">Token details</div>
      <TokenFactsList rows={buildFactRows(pair, now)} />
    </section>
  );
}
