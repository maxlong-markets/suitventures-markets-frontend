import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address } from "@/lib/types";
import { renderHook } from "@/test/dom";

const h = vi.hoisted(() => ({
  read: { data: undefined as bigint | undefined },
  seen: vi.fn(),
}));

vi.mock("wagmi", () => ({
  useReadContract: (p: unknown) => {
    h.seen(p);
    return h.read;
  },
}));

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const NFT = "0x2222222222222222222222222222222222222222";

/**
 * `SUITS_NFT_ADDRESS` is read once at module load, so each case re-imports the module with
 * its own environment. The `wagmi` mock is registered per file and survives `resetModules`.
 */
async function load(env: { nft?: string; mock?: string }) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SUITS_NFT_ADDRESS", env.nft);
  vi.stubEnv("NEXT_PUBLIC_MOCK_SUIT_HOLDER", env.mock);
  return (await import("./suits")).useIsSuitHolder;
}

describe("useIsSuitHolder", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    h.seen.mockClear();
    h.read.data = undefined;
  });

  it("is false without an address, and leaves the read disabled", async () => {
    const useIsSuitHolder = await load({});
    const { result } = renderHook(() => useIsSuitHolder());
    expect(result.current).toBe(false);
    expect(h.seen.mock.calls[0][0]).toMatchObject({ query: { enabled: false } });
  });

  it("reports NOT a holder in an unconfigured build", async () => {
    const useIsSuitHolder = await load({});
    expect(renderHook(() => useIsSuitHolder(WALLET)).result.current).toBe(false);
  });

  it("reports NOT a holder when the mock flag is anything but \"true\"", async () => {
    const useIsSuitHolder = await load({ mock: "yes" });
    expect(renderHook(() => useIsSuitHolder(WALLET)).result.current).toBe(false);
  });

  it("still demos the 0% state when the mock flag is exactly \"true\"", async () => {
    const useIsSuitHolder = await load({ mock: "true" });
    expect(renderHook(() => useIsSuitHolder(WALLET)).result.current).toBe(true);
  });

  it("ignores the mock flag once the NFT address is configured", async () => {
    const useIsSuitHolder = await load({ nft: NFT, mock: "true" });
    h.read.data = BigInt(0);
    expect(renderHook(() => useIsSuitHolder(WALLET)).result.current).toBe(false);
  });

  it("is a holder when balanceOf is above zero", async () => {
    const useIsSuitHolder = await load({ nft: NFT });
    h.read.data = BigInt(2);
    const { result } = renderHook(() => useIsSuitHolder(WALLET));
    expect(result.current).toBe(true);
    expect(h.seen.mock.calls[0][0]).toMatchObject({
      address: NFT,
      functionName: "balanceOf",
      args: [WALLET],
      chainId: 4663,
      query: { enabled: true },
    });
  });
});
