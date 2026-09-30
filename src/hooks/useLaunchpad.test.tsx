import { beforeEach, describe, expect, it, vi } from "vitest";
import { robinhoodChain } from "@/lib/chain";
import type { Address } from "@/lib/types";
import { renderHook } from "@/test/dom";
import { useCurrencyConfig, useTokenDeployed } from "./useLaunchpad";

const h = vi.hoisted(() => ({
  seen: vi.fn(),
  refetch: vi.fn(),
  data: undefined as { minValuation: bigint; maxValuation: bigint; creationFee: bigint } | undefined,
  code: vi.fn(),
  bytecode: undefined as string | undefined,
}));

vi.mock("@/lib/launch/address", () => ({
  LAUNCHPAD_ADDRESS: "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a",
  hasLaunchpad: () => true,
}));
vi.mock("wagmi", () => ({
  useReadContract: (p: unknown) => {
    h.seen(p);
    return { data: h.data, refetch: h.refetch };
  },
  useReadContracts: () => ({ data: undefined, refetch: vi.fn() }),
  useBytecode: (p: unknown) => {
    h.code(p);
    return { data: h.bytecode };
  },
}));

const QUOTE = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;

beforeEach(() => {
  h.seen.mockReset();
  h.refetch.mockReset();
  h.data = { minValuation: 5n, maxValuation: 50n, creationFee: 2n };
});

describe("useCurrencyConfig (spec 7.2: a changed creation fee must be re-read, not reloaded)", () => {
  it("re-reads the currency every 30 s and exposes refetch for a PermitMismatch retry", () => {
    const { result } = renderHook(() => useCurrencyConfig(QUOTE));
    expect(h.seen).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "currency", args: [QUOTE], query: expect.objectContaining({ enabled: true, refetchInterval: 30_000 }),
    }));
    expect(result.current).toMatchObject({ min: 5n, max: 50n, creationFee: 2n });
    result.current!.refetch();
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  it("answers undefined until the currency is read", () => {
    h.data = undefined;
    const { result } = renderHook(() => useCurrencyConfig(QUOTE));
    expect(result.current).toBeUndefined();
  });
});

// Fix round 1, ruling 6: the locked card's other way out is the token turning up at its predicted address.
describe("useTokenDeployed", () => {
  const TOKEN = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as Address;

  beforeEach(() => {
    h.code.mockReset();
    h.bytecode = undefined;
  });

  it("reads the token's code on Robinhood Chain every 5 s while watching, and answers whether it is there", () => {
    const { result, rerender } = renderHook(({ watch }) => useTokenDeployed(TOKEN, watch), { initialProps: { watch: true } });
    expect(h.code).toHaveBeenLastCalledWith(expect.objectContaining({
      address: TOKEN, chainId: robinhoodChain.id, query: expect.objectContaining({ enabled: true, refetchInterval: 5_000 }),
    }));
    expect(result.current).toBe(false); // no answer yet
    h.bytecode = "0x";
    rerender({ watch: true });
    expect(result.current).toBe(false); // an empty account
    h.bytecode = "0x6080604052";
    rerender({ watch: true });
    expect(result.current).toBe(true);
    rerender({ watch: false });
    expect(h.code).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ enabled: false }) }));
  });

  it("reads nothing without a token", () => {
    renderHook(() => useTokenDeployed(undefined, true));
    expect(h.code).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ enabled: false }) }));
  });
});
