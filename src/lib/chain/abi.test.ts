import { describe, expect, it } from "vitest";
import { toEventSelector } from "viem";
import { POOL_MANAGER, POOL_MANAGER_EVENTS_ABI, TOPIC0 } from "./abi";

// Canonical (type-only, no param names/indexed) signatures, copied from the indexer's
// config.yaml, so topic0 is pinned independently of how abi.ts spells the human-readable form.
const INITIALIZE_CANONICAL = "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)";
const SWAP_CANONICAL = "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)";
const MODIFY_LIQUIDITY_CANONICAL = "ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)";

describe("POOL_MANAGER", () => {
  it("is the deployed address, already lowercase", () => {
    expect(POOL_MANAGER).toBe("0x8366a39cc670b4001a1121b8f6a443a643e40951");
    expect(POOL_MANAGER).toBe(POOL_MANAGER.toLowerCase());
  });
});

describe("POOL_MANAGER_EVENTS_ABI", () => {
  it("carries exactly Initialize, Swap and ModifyLiquidity", () => {
    expect(POOL_MANAGER_EVENTS_ABI.map((item) => item.name).sort()).toEqual(["Initialize", "ModifyLiquidity", "Swap"]);
  });

  it("gives each event its exact indexed/non-indexed layout", () => {
    const byName = Object.fromEntries(POOL_MANAGER_EVENTS_ABI.map((item) => [item.name, item]));
    expect(byName.Initialize?.inputs.map((i) => [i.name, i.type, "indexed" in i ? i.indexed : false])).toEqual([
      ["id", "bytes32", true],
      ["currency0", "address", true],
      ["currency1", "address", true],
      ["fee", "uint24", false],
      ["tickSpacing", "int24", false],
      ["hooks", "address", false],
      ["sqrtPriceX96", "uint160", false],
      ["tick", "int24", false],
    ]);
    expect(byName.Swap?.inputs.map((i) => [i.name, i.type, "indexed" in i ? i.indexed : false])).toEqual([
      ["id", "bytes32", true],
      ["sender", "address", true],
      ["amount0", "int128", false],
      ["amount1", "int128", false],
      ["sqrtPriceX96", "uint160", false],
      ["liquidity", "uint128", false],
      ["tick", "int24", false],
      ["fee", "uint24", false],
    ]);
    expect(byName.ModifyLiquidity?.inputs.map((i) => [i.name, i.type, "indexed" in i ? i.indexed : false])).toEqual([
      ["id", "bytes32", true],
      ["sender", "address", true],
      ["tickLower", "int24", false],
      ["tickUpper", "int24", false],
      ["liquidityDelta", "int256", false],
      ["salt", "bytes32", false],
    ]);
  });
});

describe("TOPIC0", () => {
  it("pins Initialize's topic0 to the Solidity signature", () => {
    expect(TOPIC0.initialize).toBe(toEventSelector(INITIALIZE_CANONICAL));
    expect(TOPIC0.initialize).toBe("0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438");
  });
  it("pins Swap's topic0 to the Solidity signature", () => {
    expect(TOPIC0.swap).toBe(toEventSelector(SWAP_CANONICAL));
    expect(TOPIC0.swap).toBe("0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f");
  });
  it("pins ModifyLiquidity's topic0 to the Solidity signature", () => {
    expect(TOPIC0.modifyLiquidity).toBe(toEventSelector(MODIFY_LIQUIDITY_CANONICAL));
    expect(TOPIC0.modifyLiquidity).toBe("0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec");
  });
  it("are all distinct", () => {
    const values = Object.values(TOPIC0);
    expect(new Set(values).size).toBe(values.length);
  });
});
