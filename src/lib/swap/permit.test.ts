import { afterEach, describe, expect, it, vi } from "vitest";
import { hashTypedData } from "viem";
import { PERMIT2_ADDRESS, robinhoodChain } from "@/lib/chain";
import type { Address } from "@/lib/types";
import { permitTypedData, randomNonce } from "./permit";

const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const SPENDER = "0x9999999999999999999999999999999999999999" as Address;
const ARGS = { token: TOKEN, amount: 1234567890n, spender: SPENDER, nonce: 42n, deadline: 1_789_548_200n };

describe("permitTypedData", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses Permit2's own domain, which has no version field", () => {
    const typed = permitTypedData(ARGS);
    expect(typed.domain).toEqual({
      name: "Permit2",
      chainId: robinhoodChain.id,
      verifyingContract: PERMIT2_ADDRESS,
    });
    // A `version` here would change the domain separator and every signature would be rejected.
    expect(Object.keys(typed.domain ?? {}).sort()).toEqual(["chainId", "name", "verifyingContract"]);
    expect(robinhoodChain.id).toBe(4663);
  });

  it("spells the types exactly as PermitHash.sol does", () => {
    const typed = permitTypedData(ARGS);
    expect(typed.primaryType).toBe("PermitTransferFrom");
    expect(typed.types).toEqual({
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
    });
    expect(typed.message).toEqual({
      permitted: { token: TOKEN, amount: 1234567890n },
      spender: SPENDER,
      nonce: 42n,
      deadline: 1_789_548_200n,
    });
  });

  it("hashes to the digest Permit2 will recompute on chain 4663", () => {
    // Golden value, built independently from the Solidity typehashes in
    // permit2/src/libraries/PermitHash.sol and the domain in permit2/src/EIP712.sol.
    expect(hashTypedData(permitTypedData(ARGS))).toBe(
      "0xe4f208cf84e3cffdc0ea8848ae7a5308a2793278b6fc19a89280ad5ef9012f53",
    );
  });
});

describe("randomNonce", () => {
  // stubGlobal rather than spyOn: getRandomValues lives on Crypto.prototype, not on the instance.
  afterEach(() => vi.unstubAllGlobals());

  it("reads 256 bits from the platform's CSPRNG, big-endian", () => {
    const fill = (value: number, last?: number) => (bytes: Uint8Array) => {
      bytes.fill(value);
      if (last !== undefined) bytes[31] = last;
      return bytes;
    };
    vi.stubGlobal("crypto", { getRandomValues: fill(0xff) });
    expect(randomNonce()).toBe(2n ** 256n - 1n);

    vi.stubGlobal("crypto", { getRandomValues: fill(0, 1) });
    expect(randomNonce()).toBe(1n);
  });

  it("does not repeat itself, on the real CSPRNG", () => {
    const seen = new Set<bigint>();
    for (let i = 0; i < 64; i++) seen.add(randomNonce());
    expect(seen.size).toBe(64);
  });
});
