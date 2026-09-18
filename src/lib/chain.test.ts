import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LAUNCHPAD_URL_PATTERNS,
  PERMIT2_ADDRESS,
  UNIVERSAL_ROUTER_ADDRESS,
  V4_QUOTER_ADDRESS,
  launchpadUrl,
  robinhoodChain,
} from "./chain";
import type { Address } from "./types";

/** The module reads NEXT_PUBLIC_SVROUTER_ADDRESS once, at import, so a stubbed value needs a fresh module. */
async function reload(value: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SVROUTER_ADDRESS", value);
  return import("./chain");
}

describe("chain constants", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("pins Permit2, the Universal Router and the V4 Quoter as chain facts, not environment variables", () => {
    expect(robinhoodChain.id).toBe(4663);
    expect(PERMIT2_ADDRESS).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
    expect(UNIVERSAL_ROUTER_ADDRESS).toBe("0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99");
    expect(V4_QUOTER_ADDRESS).toBe("0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94");
  });

  it("has no router until one is deployed, which disables execution and nothing else", async () => {
    const m = await reload("");
    expect(m.SVROUTER_ADDRESS).toBeUndefined();
    expect(m.hasRouter()).toBe(false);
  });

  it("takes a configured router address", async () => {
    const m = await reload("0x1111111111111111111111111111111111111111");
    expect(m.SVROUTER_ADDRESS).toBe("0x1111111111111111111111111111111111111111");
    expect(m.hasRouter()).toBe(true);
  });

  it("ignores a malformed router address rather than signing a permit against it", async () => {
    for (const bad of ["not-an-address", "0x1234", "0x111111111111111111111111111111111111111", "0xzzzz111111111111111111111111111111111111"]) {
      const m = await reload(bad);
      expect(m.SVROUTER_ADDRESS).toBeUndefined();
      expect(m.hasRouter()).toBe(false);
    }
  });
});

describe("launchpadUrl", () => {
  const MIXED_CASE = "0xABCDEF0123456789ABCDEF0123456789ABCDEF01" as Address;
  const LOWER = "0xabcdef0123456789abcdef0123456789abcdef01";

  afterEach(() => {
    // A couple of tests below mutate the exported pattern map to exercise substitution;
    // restore the shipped (currently empty, per spec section 3) patterns afterward so no
    // test's mutation leaks into another.
    LAUNCHPAD_URL_PATTERNS.LONG = "";
    LAUNCHPAD_URL_PATTERNS.Pons = "";
  });

  it("substitutes {address} with the token address", () => {
    LAUNCHPAD_URL_PATTERNS.LONG = "https://longmarkets.example/token/{address}";
    expect(launchpadUrl({ origin: "LONG", address: LOWER as Address })).toBe(
      "https://longmarkets.example/token/0xabcdef0123456789abcdef0123456789abcdef01",
    );
  });

  it("lowercases a mixed-case address before substituting", () => {
    LAUNCHPAD_URL_PATTERNS.Pons = "https://bags.example/{address}/trade";
    expect(launchpadUrl({ origin: "Pons", address: MIXED_CASE })).toBe(
      `https://bags.example/${LOWER}/trade`,
    );
  });

  it("returns undefined for an empty pattern", () => {
    // LAUNCHPAD_URL_PATTERNS.LONG ships empty until MAXLONG has a page (spec section 3).
    expect(launchpadUrl({ origin: "LONG", address: MIXED_CASE })).toBeUndefined();
  });

  it("returns undefined for an origin with no pattern at all", () => {
    expect(launchpadUrl({ origin: "Uniswap", address: MIXED_CASE })).toBeUndefined();
  });
});
