import type { Address, Hex, PublicClient } from "viem";
import { parseSiweMessage, verifySiweMessage } from "viem/siwe";
import { robinhoodChain } from "@/lib/chain";

/** The one line the wallet shows above the fields. The client builds the message with it; this module is what checks the result. */
export const SIWE_STATEMENT = "Sign in to MaxLong Markets";

export type SiweVerifyInput = { message: string; signature: Hex; expectedNonce: string; domain: string; now: number };

/**
 * EIP-4361 verification for one sign-in. Every field check happens here rather than inside viem's
 * `verifySiweMessage`, which answers one boolean and so cannot say which check failed; the refusals
 * are fixed strings that name no address, nonce, host or message body. `verifySiweMessage` is then
 * asked only about the signature, and it is asked through a client so that a smart account signing
 * through EIP-1271 / ERC-6492 verifies too — an EOA signature recovers offline and needs no node.
 */
export async function verifySiwe(input: SiweVerifyInput, client: PublicClient): Promise<{ address: Address } | { error: string }> {
  const { message, signature, expectedNonce, domain, now } = input;
  const parsed = parseSiweMessage(message);
  if (!parsed.address || !parsed.nonce) return { error: "malformed message" };
  // EIP-4361 defines exactly one version. viem parses `Version:` as free text, so a message
  // claiming another one reaches here intact; there is no version 2 to be lenient towards.
  if (parsed.version !== "1") return { error: "malformed message" };
  if (parsed.domain !== domain) return { error: "wrong domain" };
  if (parsed.chainId !== robinhoodChain.id) return { error: "wrong chain" };
  if (parsed.nonce !== expectedNonce) return { error: "nonce mismatch" };
  const at = new Date(now * 1000);
  // EIP-4361 makes the expiry optional; a sign-in message without one would be replayable forever.
  if (!parsed.expirationTime) return { error: "no expiry" };
  if (Number.isNaN(parsed.expirationTime.getTime()) || parsed.expirationTime <= at) return { error: "expired" };
  if (parsed.notBefore && (Number.isNaN(parsed.notBefore.getTime()) || at < parsed.notBefore)) return { error: "not yet valid" };
  const ok = await verifySiweMessage(client, { message, signature, address: parsed.address, domain, nonce: expectedNonce, time: at });
  if (!ok) return { error: "bad signature" };
  return { address: parsed.address.toLowerCase() as Address };
}
