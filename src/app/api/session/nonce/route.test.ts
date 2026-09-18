import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONCE_COOKIE, sessionSecret, verifyNonce } from "@/lib/session/cookie";
import { nowSec } from "@/lib/time";
import { GET } from "./route";

const SECRET = "0123456789abcdef0123456789abcdef";
const call = () => GET();

beforeEach(() => vi.stubEnv("SESSION_SECRET", SECRET));
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/session/nonce", () => {
  it("answers a fresh nonce and sets it as an HttpOnly, SameSite=Lax, ten-minute cookie", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { nonce } = (await res.json()) as { nonce: string };
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    const [cookie] = res.headers.getSetCookie();
    expect(cookie).toMatch(/^svm_nonce=/);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=lax/i);
    expect(cookie).toMatch(/;\s*Path=\//);
    expect(cookie).toMatch(/;\s*Max-Age=600\b/);
    expect(cookie).not.toMatch(/Secure/i);
    // The cookie is the nonce's only server-side record: it must verify back to exactly what was answered.
    expect(verifyNonce(res.cookies.get(NONCE_COOKIE)?.value ?? "", sessionSecret() ?? "", nowSec())).toBe(nonce);
  });

  it("never answers the same nonce twice", async () => {
    const one = (await (await call()).json()) as { nonce: string };
    const two = (await (await call()).json()) as { nonce: string };
    expect(one.nonce).not.toBe(two.nonce);
  });

  it("marks the cookie Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await call()).headers.getSetCookie()[0]).toMatch(/;\s*Secure/i);
  });

  it("answers 503 while SESSION_SECRET is unset, and sets no cookie", async () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.getSetCookie()).toEqual([]);
    await expect(res.json()).resolves.toEqual({ error: "sessions not configured" });
  });
});
