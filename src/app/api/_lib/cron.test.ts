import { afterEach, describe, expect, it, vi } from "vitest";
import { isCronAuthorized } from "./cron";

const req = (auth?: string) => new Request("http://localhost/api/internal/sync", { headers: auth === undefined ? {} : { authorization: auth } });
afterEach(() => vi.unstubAllEnvs());

describe("isCronAuthorized", () => {
  it("refuses everything while CRON_SECRET is unset", () => {
    vi.stubEnv("CRON_SECRET", undefined);
    expect(isCronAuthorized(req("Bearer s3cret"))).toBe(false);
  });
  it("refuses a missing, wrong, longer or bare token", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isCronAuthorized(req())).toBe(false);
    expect(isCronAuthorized(req("Bearer nope!!"))).toBe(false);
    expect(isCronAuthorized(req("Bearer s3cret1"))).toBe(false);
    expect(isCronAuthorized(req("s3cret"))).toBe(false);
  });
  it("accepts exactly Bearer <CRON_SECRET>", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isCronAuthorized(req("Bearer s3cret"))).toBe(true);
  });
});
