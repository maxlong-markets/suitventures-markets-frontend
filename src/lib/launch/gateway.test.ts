import { afterEach, describe, expect, it, vi } from "vitest";
import { FILEBASE_GATEWAY_FALLBACK, filebaseGatewayBase } from "./gateway";

afterEach(() => vi.unstubAllEnvs());

describe("filebaseGatewayBase (spec 5.6)", () => {
  it("falls back to Filebase's public gateway while FILEBASE_GATEWAY_URL is unset, empty or not an https origin", () => {
    expect(FILEBASE_GATEWAY_FALLBACK).toBe("https://ipfs.filebase.io");
    vi.stubEnv("FILEBASE_GATEWAY_URL", "");
    expect(filebaseGatewayBase()).toBe(FILEBASE_GATEWAY_FALLBACK);
    vi.stubEnv("FILEBASE_GATEWAY_URL", "http://gw.example.test");
    expect(filebaseGatewayBase()).toBe(FILEBASE_GATEWAY_FALLBACK);
    vi.stubEnv("FILEBASE_GATEWAY_URL", "https://gw.example.test/ipfs");
    expect(filebaseGatewayBase()).toBe(FILEBASE_GATEWAY_FALLBACK);
    for (const bad of [
      "https://user:pw@gw.example.test", "https://gw.example.test:8443", "https://gw.example.test/?x=1",
      "https://gw.example.test/#f", "https://gw.example.test?", "https://GW.example.test", "https://gw.example.test//",
      "not a url", "https://",
    ]) {
      vi.stubEnv("FILEBASE_GATEWAY_URL", bad);
      expect(filebaseGatewayBase(), bad).toBe(FILEBASE_GATEWAY_FALLBACK);
    }
  });
  it("uses the dedicated gateway's origin, one trailing slash and surrounding space dropped", () => {
    vi.stubEnv("FILEBASE_GATEWAY_URL", "https://maxlong.myfilebase.com/");
    expect(filebaseGatewayBase()).toBe("https://maxlong.myfilebase.com");
    vi.stubEnv("FILEBASE_GATEWAY_URL", "  https://maxlong.myfilebase.com  ");
    expect(filebaseGatewayBase()).toBe("https://maxlong.myfilebase.com");
  });
});
