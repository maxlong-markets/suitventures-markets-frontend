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
  });
  it("uses the dedicated gateway's origin, trailing slashes dropped", () => {
    vi.stubEnv("FILEBASE_GATEWAY_URL", "https://maxlong.myfilebase.com/");
    expect(filebaseGatewayBase()).toBe("https://maxlong.myfilebase.com");
  });
});
