import { createPublicClient, custom, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { describe, expect, it } from "vitest";
import { robinhoodChain } from "@/lib/chain";
import { SIWE_STATEMENT, verifySiwe } from "./siwe";

/** Foundry's first published anvil account, printed by `anvil` on every start. Public knowledge; it holds nothing anywhere. */
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(KEY);
const ADDRESS = account.address.toLowerCase();
const DOMAIN = "longmarkets.xyz";
const NONCE = "a1b2c3d4e5f60718";
const NOW = 1_789_000_000;
const at = (sec: number) => new Date(sec * 1000);

/**
 * An EOA signature recovers offline, but viem still tries the ERC-6492 validator first, so the
 * client must answer exactly one `eth_call`. 32 zero bytes means "not a contract account", after
 * which viem falls back to ECDSA recovery — the production path for a wallet EOA, and the reason
 * a smart account (EIP-1271) needs a real client here while this test needs no network.
 */
function mockClient(seen: string[] = []): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    transport: custom({
      async request({ method }) {
        seen.push(method);
        if (method === "eth_call") return `0x${"00".repeat(32)}`;
        if (method === "eth_chainId") return "0x1237";
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
}

type Fields = Parameters<typeof createSiweMessage>[0];
const fields = (over: Partial<Fields> = {}): Fields => ({
  address: account.address,
  chainId: robinhoodChain.id,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `https://${DOMAIN}`,
  version: "1",
  statement: SIWE_STATEMENT,
  issuedAt: at(NOW),
  expirationTime: at(NOW + 7 * 86_400),
  ...over,
});

async function signed(over: Partial<Fields> = {}): Promise<{ message: string; signature: Hex }> {
  const message = createSiweMessage(fields(over));
  return { message, signature: await account.signMessage({ message }) };
}

const verify = async (over: Partial<Fields> = {}, patch: Partial<{ signature: Hex; expectedNonce: string; domain: string; now: number }> = {}) => {
  const { message, signature } = await signed(over);
  return verifySiwe({ message, signature, expectedNonce: NONCE, domain: DOMAIN, now: NOW, ...patch }, mockClient());
};

describe("verifySiwe", () => {
  it("accepts a real message signed by a real key and answers the lowercase address", async () => {
    const seen: string[] = [];
    const { message, signature } = await signed();
    expect(message).toContain(`Chain ID: ${robinhoodChain.id}`);
    expect(message).toContain(SIWE_STATEMENT);
    const result = await verifySiwe({ message, signature, expectedNonce: NONCE, domain: DOMAIN, now: NOW }, mockClient(seen));
    expect(result).toEqual({ address: ADDRESS });
    expect(seen).toEqual(["eth_call"]); // the client is consulted for the contract-account case only
  });

  it("still accepts an EOA signature when the node is unreachable, because recovery is offline", async () => {
    const { message, signature } = await signed();
    const dead = createPublicClient({
      chain: robinhoodChain,
      transport: custom({
        async request() {
          throw new Error("node down");
        },
      }),
    });
    await expect(verifySiwe({ message, signature, expectedNonce: NONCE, domain: DOMAIN, now: NOW }, dead)).resolves.toEqual({ address: ADDRESS });
  });

  it("refuses a message for another site", async () => {
    await expect(verify({ domain: "evil.example", uri: "https://evil.example" })).resolves.toEqual({ error: "wrong domain" });
  });

  it("refuses a message for another chain", async () => {
    await expect(verify({ chainId: 1 })).resolves.toEqual({ error: "wrong chain" });
  });

  it("refuses a nonce the server did not issue", async () => {
    await expect(verify({ nonce: "99887766554433221" })).resolves.toEqual({ error: "nonce mismatch" });
    await expect(verify({}, { expectedNonce: "99887766554433221" })).resolves.toEqual({ error: "nonce mismatch" });
  });

  it("refuses an expired message, and one that is not valid yet", async () => {
    await expect(verify({ expirationTime: at(NOW - 1) })).resolves.toEqual({ error: "expired" });
    await expect(verify({ expirationTime: at(NOW) })).resolves.toEqual({ error: "expired" });
    await expect(verify({ notBefore: at(NOW + 60) })).resolves.toEqual({ error: "not yet valid" });
    await expect(verify({ notBefore: at(NOW) })).resolves.toEqual({ address: ADDRESS });
  });

  it("refuses a message with no expiry at all", async () => {
    await expect(verify({ expirationTime: undefined })).resolves.toEqual({ error: "no expiry" });
  });

  it("refuses a signature that belongs to another message, and anything that is not a signature", async () => {
    const other = await signed({ nonce: "99887766554433221" });
    await expect(verify({}, { signature: other.signature })).resolves.toEqual({ error: "bad signature" });
    for (const junk of ["0x", "0xdead", "not-a-signature"] as Hex[]) {
      await expect(verify({}, { signature: junk })).resolves.toEqual({ error: "bad signature" });
    }
  });

  it("refuses anything that is not an EIP-4361 message", async () => {
    for (const junk of ["", "hello", "longmarkets.xyz wants you to sign in"]) {
      await expect(
        verifySiwe({ message: junk, signature: "0x00", expectedNonce: NONCE, domain: DOMAIN, now: NOW }, mockClient()),
      ).resolves.toEqual({ error: "malformed message" });
    }
  });

  it("never names the domain, the nonce or the address in a refusal", async () => {
    const result = await verify({ domain: "evil.example", uri: "https://evil.example" });
    expect(JSON.stringify(result)).not.toMatch(/evil|0x|a1b2c3/i);
  });
});
