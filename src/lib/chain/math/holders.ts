/**
 * Holder-count delta rule (holder-count upkeep, 2026-09-22 — see
 * .superpowers/sdd/2026-09-21-chain-reader/holder-count-report.md and the design doc's "What is
 * deliberately not indexed"). The chain reader does not index ERC-20 Transfer, so holders_count can
 * no longer be derived by summing transfers; it instead drifts forward from its 17 Sep baseline,
 * moved by the wallets that actually trade. This is the one piece of arithmetic that decides which
 * way it moves for one wallet's one trade.
 *
 * A sibling module of fold.ts, not a part of it, by deliberate choice: fold.ts's own doc comment
 * enumerates exactly what it ports from the old indexer's handlers (and what it deliberately does
 * not); this rule has no indexer equivalent to port at all — the old indexer derived holder counts
 * by replaying Transfer history, which is precisely the cost this task exists to avoid. It belongs
 * with the other new, pure, chain-adjacent math this reader already keeps as its own small modules
 * (price.ts, liquidity.ts, candles.ts, primaryPool.ts, …) rather than grown onto a file whose header
 * is itself a manifest of what was ported and what was not.
 */

/**
 * One wallet's holding of one token, before a trade (or a batch of trades) and after, turned into
 * the signed effect on that token's holder count: zero -> non-zero is a new holder (+1), non-zero ->
 * zero is one fewer (-1), and every other transition — still holding, still not holding, or a wash
 * that nets back to where it started — is 0.
 *
 * Pure and total: never throws, consults nothing but its two arguments, and never guesses. A balance
 * the caller could not read must never be passed in here at all — see run.ts's computeHolderDeltas,
 * which counts that case as "unknown" instead of calling this, exactly so an absent read can never
 * silently masquerade as a 0 balance and produce a false -1.
 */
export function holderDelta(before: bigint, after: bigint): -1 | 0 | 1 {
  const wasHolder = before > 0n;
  const isHolder = after > 0n;
  if (wasHolder === isHolder) return 0;
  return isHolder ? 1 : -1;
}
