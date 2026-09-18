import type { TypedDataDefinition } from "viem";
import { PERMIT2_ADDRESS, robinhoodChain } from "@/lib/chain";
import type { Address } from "@/lib/types";

/**
 * The EIP-712 types Permit2 hashes in `PermitHash.sol`:
 *
 *   PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)
 *   TokenPermissions(address token,uint256 amount)
 *
 * The signed message names the spender even though the calldata struct does not: on chain Permit2
 * hashes `msg.sender` into the same slot, which is what binds a signature to this router alone.
 */
export const PERMIT_TRANSFER_FROM_TYPES = {
  PermitTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const;

/**
 * Permit2's domain is `EIP712Domain(string name,uint256 chainId,address verifyingContract)` with the
 * name "Permit2" — no `version`. Adding one changes the domain separator, and every signature would
 * come back as an invalid signer.
 */
export function permitTypedData(args: {
  token: Address;
  amount: bigint;
  spender: Address;
  nonce: bigint;
  deadline: bigint;
}): TypedDataDefinition {
  return {
    domain: { name: "Permit2", chainId: robinhoodChain.id, verifyingContract: PERMIT2_ADDRESS },
    types: PERMIT_TRANSFER_FROM_TYPES,
    primaryType: "PermitTransferFrom",
    message: {
      permitted: { token: args.token, amount: args.amount },
      spender: args.spender,
      nonce: args.nonce,
      deadline: args.deadline,
    },
  };
}

/**
 * 256 random bits. Permit2 nonces are unordered bits in a bitmap, not a counter, so a fresh random
 * one needs no read and no coordination; a collision reverts the transaction rather than mis-spending.
 */
export function randomNonce(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let nonce = 0n;
  for (const byte of bytes) nonce = (nonce << 8n) | BigInt(byte);
  return nonce;
}
