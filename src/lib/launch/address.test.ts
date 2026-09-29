import { describe, expect, it } from "vitest";
import { parseLaunchpadAddress } from "./address";

describe("parseLaunchpadAddress", () => {
  it("is undefined for an unset, empty or malformed value, so the launchpad reads as not live", () => {
    expect(parseLaunchpadAddress(undefined)).toBeUndefined();
    expect(parseLaunchpadAddress("")).toBeUndefined(); // an unset NEXT_PUBLIC_* reaches the bundle as ""
    expect(parseLaunchpadAddress("0x1234")).toBeUndefined();
    expect(parseLaunchpadAddress("5555555555555555555555555555555555555555")).toBeUndefined();
  });
  it("keeps a well-formed address as given", () => {
    expect(parseLaunchpadAddress("0x5555555555555555555555555555555555555555")).toBe("0x5555555555555555555555555555555555555555");
    expect(parseLaunchpadAddress("0xAbCdEf0000000000000000000000000000000000")).toBe("0xAbCdEf0000000000000000000000000000000000");
  });
});
