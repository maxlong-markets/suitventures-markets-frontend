import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "@/lib/types";
import { renderHook } from "@/test/dom";
import { useCurrencyConfig } from "./useLaunchpad";

const h = vi.hoisted(() => ({
  seen: vi.fn(),
  refetch: vi.fn(),
  data: undefined as { minValuation: bigint; maxValuation: bigint; creationFee: bigint } | undefined,
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
