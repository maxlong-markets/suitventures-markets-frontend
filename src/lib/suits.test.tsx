import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address } from "@/lib/types";
import { renderHook } from "@/test/dom";
import { ZERO_ADDRESS } from "@/lib/chain";

const h = vi.hoisted(() => ({
  // balanceOf(SuitsNFT, wallet) — the first read useIsSuitHolder makes.
  balance: {
    data: undefined as bigint | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  // SVRouter.suitsNft() — useIsSuitHolder's second read, the fee-perk gate.
  suitsNft: { data: undefined as string | undefined },
  seen: vi.fn(),
}));

vi.mock("wagmi", () => ({
  useReadContract: (p: { functionName?: string }) => {
    h.seen(p);
    return p.functionName === "suitsNft" ? h.suitsNft : h.balance;
  },
}));

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
// The real Suits collection, lowercase as an env var delivers it. It has to be an address with
// letters in it: viem decodes an `address` return value checksummed, so what SVRouter.suitsNft()
// actually hands back once setSuitsNft is called is the mixed-case form below, and the two
// toLowerCase() calls in useIsSuitHolder are the only thing making that comparison hold. An
// all-digit stand-in cannot tell the difference and would let a "simplification" to === through.
const NFT = "0x05c2174aa494bbdf72aeeab0ca3c10216d33b297";
const NFT_CHECKSUMMED = "0x05c2174Aa494bBDF72AEEab0Ca3C10216d33B297";
const ROUTER = "0x3333333333333333333333333333333333333333";
const OTHER_NFT = "0x4444444444444444444444444444444444444444";

/**
 * `SUITS_NFT_ADDRESS` and `SVROUTER_ADDRESS` are read once at module load, so each case
 * re-imports the module with its own environment. The `wagmi` mock is registered per file and
 * survives `resetModules`.
 */
async function load(env: { nft?: string; mock?: string; router?: string }) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SUITS_NFT_ADDRESS", env.nft);
  vi.stubEnv("NEXT_PUBLIC_MOCK_SUIT_HOLDER", env.mock);
  vi.stubEnv("NEXT_PUBLIC_SVROUTER_ADDRESS", env.router);
  return await import("./suits");
}

function resetMocks() {
  vi.unstubAllEnvs();
  h.seen.mockClear();
  h.balance.data = undefined;
  h.balance.isLoading = false;
  h.balance.isError = false;
  h.balance.refetch.mockClear();
  h.suitsNft.data = undefined;
}

describe("useIsSuitHolder", () => {
  afterEach(resetMocks);

  it("is false without an address, and leaves the read disabled", async () => {
    const { useIsSuitHolder } = await load({});
    const { result } = renderHook(() => useIsSuitHolder());
    expect(result.current).toBe(false);
    expect(h.seen.mock.calls[0][0]).toMatchObject({ query: { enabled: false } });
  });

  it("reports NOT a holder in an unconfigured build", async () => {
    const { useIsSuitHolder } = await load({});
    expect(renderHook(() => useIsSuitHolder(WALLET)).result.current).toBe(false);
  });

  it("reports NOT a holder when the mock flag is anything but \"true\"", async () => {
    const { useIsSuitHolder } = await load({ mock: "yes" });
    expect(renderHook(() => useIsSuitHolder(WALLET)).result.current).toBe(false);
  });

  it("still demos the 0% state when the mock flag is exactly \"true\"", async () => {
    const { useIsSuitHolder } = await load({ mock: "true" });
    expect(renderHook(() => useIsSuitHolder(WALLET)).result.current).toBe(true);
  });

  it("ignores the mock flag once the NFT address is configured", async () => {
    const { useIsSuitHolder } = await load({ nft: NFT, mock: "true" });
    h.balance.data = BigInt(0);
    expect(renderHook(() => useIsSuitHolder(WALLET)).result.current).toBe(false);
  });

  // Regression tests for the fee/access split (design §3): balanceOf > 0 alone must never be
  // enough. SVRouter.suitsNft() being the zero address is the live, verified state of the
  // chain today — this is the exact bug the split exists to prevent, not a hypothetical.
  it("is NOT a holder for the fee perk when SVROUTER_ADDRESS isn't configured at all", async () => {
    const { useIsSuitHolder } = await load({ nft: NFT });
    h.balance.data = BigInt(2);
    expect(renderHook(() => useIsSuitHolder(WALLET)).result.current).toBe(false);
  });

  it("is NOT a holder for the fee perk when the router's suitsNft is the zero address", async () => {
    const { useIsSuitHolder } = await load({ nft: NFT, router: ROUTER });
    h.balance.data = BigInt(2);
    h.suitsNft.data = ZERO_ADDRESS;
    expect(renderHook(() => useIsSuitHolder(WALLET)).result.current).toBe(false);
  });

  it("is NOT a holder for the fee perk when the router's suitsNft points at a different NFT", async () => {
    const { useIsSuitHolder } = await load({ nft: NFT, router: ROUTER });
    h.balance.data = BigInt(2);
    h.suitsNft.data = OTHER_NFT;
    expect(renderHook(() => useIsSuitHolder(WALLET)).result.current).toBe(false);
  });

  // The case that will actually happen on the day Kobe calls setSuitsNft: the env var is
  // lowercase, viem returns the checksummed form, and only the case-insensitive compare matches.
  it("is a holder once the router's suitsNft matches, comparing checksummed against lowercase", async () => {
    const { useIsSuitHolder } = await load({ nft: NFT, router: ROUTER });
    expect(NFT_CHECKSUMMED).not.toBe(NFT); // the whole point: these differ by case alone
    expect(NFT_CHECKSUMMED.toLowerCase()).toBe(NFT);
    h.balance.data = BigInt(2);
    h.suitsNft.data = NFT_CHECKSUMMED;
    const { result } = renderHook(() => useIsSuitHolder(WALLET));
    expect(result.current).toBe(true);
    expect(h.seen.mock.calls[1][0]).toMatchObject({
      address: ROUTER,
      functionName: "suitsNft",
      chainId: 4663,
      query: { enabled: true },
    });
  });

  it("still requires balanceOf > 0 even when the router matches", async () => {
    const { useIsSuitHolder } = await load({ nft: NFT, router: ROUTER });
    h.balance.data = BigInt(0);
    h.suitsNft.data = NFT;
    expect(renderHook(() => useIsSuitHolder(WALLET)).result.current).toBe(false);
  });
});
