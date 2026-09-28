import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address } from "@/lib/types";
import { renderHook } from "@/test/dom";
import { ZERO_ADDRESS } from "@/lib/chain";

const h = vi.hoisted(() => ({
  // balanceOf(SuitsNFT, wallet) — the only read useSuitsAccess makes, and the first read
  // useIsSuitHolder makes. isLoading/isError/refetch let tests drive useSuitsAccess's five
  // statuses without simulating react-query's actual state machine.
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
 * survives `resetModules`. Returns the whole module rather than one export, since cases below
 * exercise `useIsSuitHolder`, `useSuitsAccess`, and `gateEnabled` from the same environment.
 */
async function load(env: { nft?: string; mock?: string; router?: string; gate?: string }) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SUITS_NFT_ADDRESS", env.nft);
  vi.stubEnv("NEXT_PUBLIC_MOCK_SUIT_HOLDER", env.mock);
  vi.stubEnv("NEXT_PUBLIC_SVROUTER_ADDRESS", env.router);
  vi.stubEnv("NEXT_PUBLIC_TOKEN_GATE", env.gate);
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

describe("useSuitsAccess", () => {
  afterEach(resetMocks);

  it("is idle with no wallet connected", async () => {
    const { useSuitsAccess } = await load({ nft: NFT });
    const { result } = renderHook(() => useSuitsAccess());
    expect(result.current).toEqual({ status: "idle" });
  });

  it("is idle when the NFT address isn't configured, even with a wallet connected", async () => {
    const { useSuitsAccess } = await load({});
    const { result } = renderHook(() => useSuitsAccess(WALLET));
    expect(result.current).toEqual({ status: "idle" });
  });

  it("is checking while react-query still reports the read as loading", async () => {
    const { useSuitsAccess } = await load({ nft: NFT });
    h.balance.isLoading = true;
    const { result } = renderHook(() => useSuitsAccess(WALLET));
    expect(result.current).toEqual({ status: "checking" });
  });

  it("enables the read only once there is a wallet and a configured NFT", async () => {
    const { useSuitsAccess } = await load({ nft: NFT });
    renderHook(() => useSuitsAccess(WALLET));
    expect(h.seen.mock.calls[0][0]).toMatchObject({
      address: NFT,
      functionName: "balanceOf",
      args: [WALLET],
      chainId: 4663,
      // A denied visitor's only way out is buying a Suit in another tab; without this they would
      // sit on "No Suit on this wallet" until they thought to reload.
      query: { enabled: true, refetchOnWindowFocus: true },
    });
  });

  // The render that used to flash "no Suit" at a genuine holder: `enabled` has just flipped
  // true because a wallet connected, so react-query is pending but not yet fetching — every
  // flag reads false while `data` is still undefined. Nothing has been answered here, and
  // anything but "checking" is a lie.
  it("is checking when no flag is set but no answer has arrived either", async () => {
    const { useSuitsAccess } = await load({ nft: NFT });
    h.balance.isLoading = false;
    h.balance.isError = false;
    h.balance.data = undefined;
    const { result } = renderHook(() => useSuitsAccess(WALLET));
    expect(result.current).toEqual({ status: "checking" });
  });

  // A background refetch failing must not evict a holder who is already inside.
  it("keeps a known count when a later refetch errors", async () => {
    const { useSuitsAccess } = await load({ nft: NFT });
    h.balance.data = BigInt(1);
    h.balance.isError = true;
    const { result } = renderHook(() => useSuitsAccess(WALLET));
    expect(result.current).toEqual({ status: "granted", count: BigInt(1) });
  });

  it("is granted once balanceOf confirms a positive count", async () => {
    const { useSuitsAccess } = await load({ nft: NFT });
    h.balance.data = BigInt(3);
    const { result } = renderHook(() => useSuitsAccess(WALLET));
    expect(result.current).toEqual({ status: "granted", count: BigInt(3) });
  });

  it("is denied once balanceOf confirms zero — a real answer, not a failure", async () => {
    const { useSuitsAccess } = await load({ nft: NFT });
    h.balance.data = BigInt(0);
    const { result } = renderHook(() => useSuitsAccess(WALLET));
    expect(result.current).toEqual({ status: "denied", count: BigInt(0) });
  });

  it("is error when the read fails — distinct from denied, and never reported as owning nothing", async () => {
    const { useSuitsAccess } = await load({ nft: NFT });
    h.balance.isError = true;
    const { result } = renderHook(() => useSuitsAccess(WALLET));
    expect(result.current.status).toBe("error");
    expect(result.current).not.toMatchObject({ status: "denied" });
  });

  it("error's retry calls the underlying refetch", async () => {
    const { useSuitsAccess } = await load({ nft: NFT });
    h.balance.isError = true;
    const { result } = renderHook(() => useSuitsAccess(WALLET));
    if (result.current.status !== "error") throw new Error("expected error status");
    result.current.retry();
    expect(h.balance.refetch).toHaveBeenCalledTimes(1);
  });
});

describe("gateEnabled", () => {
  afterEach(resetMocks);

  it("is off when NEXT_PUBLIC_TOKEN_GATE is \"off\", even with an NFT address configured", async () => {
    const { gateEnabled } = await load({ nft: NFT, gate: "off" });
    expect(gateEnabled()).toBe(false);
  });

  it("is off when the NFT address is unset", async () => {
    const { gateEnabled } = await load({});
    expect(gateEnabled()).toBe(false);
  });

  it("is on when the NFT address is configured and the flag isn't \"off\"", async () => {
    const { gateEnabled } = await load({ nft: NFT });
    expect(gateEnabled()).toBe(true);
  });
});
