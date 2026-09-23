import type { TransferEvent } from "@/lib/chain/types";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Balance deltas of one slice of a token's Transfer events (design section 4, step 4): `from` loses `value`,
 * `to` gains it, the zero address (mint/burn counterparty) is never a wallet. A wallet whose net change over the
 * slice is zero gets no entry, so applySlice never writes a row it would delete in the same statement. Pure.
 */
export function foldTransfers(transfers: readonly TransferEvent[]): Map<string, bigint> {
  const deltas = new Map<string, bigint>();
  const add = (wallet: string, delta: bigint): void => {
    const key = wallet.toLowerCase();
    if (key === ZERO_ADDRESS || delta === 0n) return;
    const next = (deltas.get(key) ?? 0n) + delta;
    if (next === 0n) deltas.delete(key);
    else deltas.set(key, next);
  };
  for (const t of transfers) {
    add(t.from, -t.value);
    add(t.to, t.value);
  }
  return deltas;
}
