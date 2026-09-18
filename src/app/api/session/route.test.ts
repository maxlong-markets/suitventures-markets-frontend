import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONCE_COOKIE, SESSION_COOKIE, SESSION_TTL_SEC, newNonce, signNonce, signSession, verifySession } from "@/lib/session/cookie";
import type { SiweVerifyInput } from "@/lib/session/siwe";
import { CLIENT_LIMIT, resetRateLimit } from "@/lib/social/rateLimit";
import { nowSec } from "@/lib/time";
import type { Address } from "@/lib/types";
import { DELETE, GET, POST } from "./route";

const { verifySiwe } = vi.hoisted(() => ({
  verifySiwe: vi.fn<(input: SiweVerifyInput, client: unknown) => Promise<{ address: Address } | { error: string }>>(),
}));
// The real verifier has its own test with real signatures and a mock transport; here the route's own
// job is under test — the nonce cookie, the domain it passes on, and the two cookies it writes.
vi.mock("@/lib/session/siwe", () => ({ verifySiwe, SIWE_STATEMENT: "Sign in to SuitVentures Markets" }));

const SECRET = "0123456789abcdef0123456789abcdef";
const ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as Address;
// The real verifier is mocked here, so this only has to be a plausible string of the right shape.
const MESSAGE = [
  "localhost:3000 wants you to sign in with your Ethereum account:",
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "",
  "Sign in to SuitVentures Markets",
  "",
  "URI: http://localhost:3000",
  "Version: 1",
  "Chain ID: 4663",
  "Nonce: a1b2c3d4e5f60718",
  "Issued At: 2026-09-19T00:00:00.000Z",
  "Expiration Time: 2026-09-26T00:00:00.000Z",
].join("\n");
const SIG = "0xabc123";

const post = (body: unknown, cookie?: string, host = "localhost:3000") =>
  POST(
    new Request("http://localhost:3000/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", host, ...(cookie ? { cookie } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const nonceCookie = (nonce: string) => `${NONCE_COOKIE}=${signNonce(nonce, SECRET)}`;
const sessionCookie = (over: Partial<{ exp: number }> = {}) =>
  `${SESSION_COOKIE}=${signSession({ address: ADDR, iat: nowSec(), exp: nowSec() + SESSION_TTL_SEC, ...over }, SECRET)}`;

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SECRET);
  resetRateLimit();
  verifySiwe.mockReset();
  verifySiwe.mockResolvedValue({ address: ADDR });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("POST /api/session", () => {
  it("verifies the message against the nonce cookie, sets a seven-day session and spends the nonce", async () => {
    const nonce = newNonce();
    const res = await post({ message: MESSAGE, signature: SIG }, nonceCookie(nonce));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ address: ADDR });
    expect(verifySiwe).toHaveBeenCalledTimes(1);
    expect(verifySiwe.mock.calls[0][0]).toMatchObject({ message: MESSAGE, signature: SIG, expectedNonce: nonce, domain: "localhost:3000" });
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("svm_session="));
    expect(session).toMatch(/;\s*HttpOnly/i);
    expect(session).toMatch(/;\s*SameSite=lax/i);
    expect(session).toMatch(/;\s*Path=\//);
    expect(session).toMatch(/;\s*Max-Age=604800\b/);
    expect(session).not.toMatch(/Secure/i);
    expect(cookies.find((c) => c.startsWith("svm_nonce="))).toMatch(/;\s*Max-Age=0\b/);
    expect(verifySession(res.cookies.get(SESSION_COOKIE)?.value ?? "", SECRET, nowSec())).toMatchObject({ address: ADDR });
  });

  it("uses the host the browser actually asked for as the expected domain", async () => {
    await post({ message: MESSAGE, signature: SIG }, nonceCookie(newNonce()), "longmarkets.xyz");
    expect(verifySiwe.mock.calls[0][0].domain).toBe("longmarkets.xyz");
  });

  it("refuses to reuse a nonce: the second post with the same message has no nonce cookie left", async () => {
    const nonce = newNonce();
    expect((await post({ message: MESSAGE, signature: SIG }, nonceCookie(nonce))).status).toBe(200);
    const replay = await post({ message: MESSAGE, signature: SIG });
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toEqual({ error: "no nonce" });
    expect(verifySiwe).toHaveBeenCalledTimes(1);
  });

  it("clears the nonce cookie even when verification fails, and reports the verifier's reason", async () => {
    verifySiwe.mockResolvedValue({ error: "wrong domain" });
    const res = await post({ message: MESSAGE, signature: SIG }, nonceCookie(newNonce()));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "wrong domain" });
    expect(res.headers.getSetCookie().find((c) => c.startsWith("svm_nonce="))).toMatch(/;\s*Max-Age=0\b/);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("svm_session="))).toBe(false);
  });

  it("clears the nonce cookie, says nothing about the error and logs nothing from it when verification throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // The shape of a real viem failure: the message carries the signed data and the RPC URL.
    verifySiwe.mockRejectedValue(
      new Error(`HTTP request failed. URL: https://rpc.internal/abcdef body: {"params":["${ADDR}","${SIG}"]}`),
    );
    const res = await post({ message: MESSAGE, signature: SIG }, nonceCookie(newNonce()));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "internal error" });
    // Every terminal answer clears the nonce cookie, this thrown path included.
    expect(res.headers.getSetCookie().find((c) => c.startsWith("svm_nonce="))).toMatch(/;\s*Max-Age=0\b/);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("svm_session="))).toBe(false);
    // Global Constraint 4: neither the address, the signature nor the RPC URL reaches the log.
    expect(error).toHaveBeenCalledWith("internal error: Error: sign-in verification failed");
    error.mockRestore();
  });

  it("refuses a forged, an expired and an absent nonce cookie", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_789_000_000_000);
    const stale = nonceCookie(newNonce());
    vi.setSystemTime(1_789_000_601_000); // 601 s later: past NONCE_TTL_SEC
    expect((await post({ message: MESSAGE, signature: SIG }, stale)).status).toBe(401);
    vi.useRealTimers();
    expect((await post({ message: MESSAGE, signature: SIG }, `${NONCE_COOKIE}=forged`)).status).toBe(401);
    expect((await post({ message: MESSAGE, signature: SIG })).status).toBe(401);
    expect(verifySiwe).not.toHaveBeenCalled();
  });

  it("refuses a body that is not a sign-in, before touching the nonce", async () => {
    for (const body of ["not json", {}, { message: MESSAGE }, { signature: SIG }, { message: 7, signature: SIG }, { message: "x".repeat(4097), signature: SIG }]) {
      const res = await post(body, nonceCookie(newNonce()));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "bad body" });
    }
    expect(verifySiwe).not.toHaveBeenCalled();
  });

  it("answers 503 while SESSION_SECRET is unset", async () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    const res = await post({ message: MESSAGE, signature: SIG }, nonceCookie(newNonce()));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "sessions not configured" });
  });

  it("marks the session cookie Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await post({ message: MESSAGE, signature: SIG }, nonceCookie(newNonce()));
    expect(res.headers.getSetCookie().find((c) => c.startsWith("svm_session="))).toMatch(/;\s*Secure/i);
  });

  it("creates the verification client with a five-second timeout and a single retry", async () => {
    await post({ message: MESSAGE, signature: SIG }, nonceCookie(newNonce()));
    const usedClient = verifySiwe.mock.calls[0][1] as { transport: { timeout: number; retryCount: number } };
    expect(usedClient.transport.timeout).toBe(5_000);
    expect(usedClient.transport.retryCount).toBe(1);
  });

  it("uses SESSION_DOMAIN over the Host header when it is set", async () => {
    vi.stubEnv("SESSION_DOMAIN", "suitventures-markets-frontend.vercel.app");
    await post({ message: MESSAGE, signature: SIG }, nonceCookie(newNonce()), "attacker-controlled.example");
    expect(verifySiwe.mock.calls[0][0].domain).toBe("suitventures-markets-frontend.vercel.app");
  });

  it("falls back to the Host header when SESSION_DOMAIN is unset", async () => {
    await post({ message: MESSAGE, signature: SIG }, nonceCookie(newNonce()), "longmarkets.xyz");
    expect(verifySiwe.mock.calls[0][0].domain).toBe("longmarkets.xyz");
  });

  it("refuses a nonce already spent by an earlier successful sign-in, even though the cookie itself is still valid", async () => {
    const cookie = nonceCookie(newNonce());
    expect((await post({ message: MESSAGE, signature: SIG }, cookie)).status).toBe(200);
    const replay = await post({ message: MESSAGE, signature: SIG }, cookie); // the same cookie, resent
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toEqual({ error: "nonce already used" });
    expect(replay.headers.getSetCookie().find((c) => c.startsWith("svm_nonce="))).toMatch(/;\s*Max-Age=0\b/);
    expect(verifySiwe).toHaveBeenCalledTimes(1); // the replay never reaches the verifier
  });

  it("does not spend the nonce on a refusal, so a corrected retry against the same nonce still works", async () => {
    verifySiwe.mockResolvedValueOnce({ error: "bad signature" });
    const cookie = nonceCookie(newNonce());
    expect((await post({ message: MESSAGE, signature: SIG }, cookie)).status).toBe(401);
    const retry = await post({ message: MESSAGE, signature: SIG }, cookie);
    expect(retry.status).toBe(200);
  });

  it("clears the nonce cookie on every terminal answer, including 400, 401 and 503", async () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    const unconfigured = await post({ message: MESSAGE, signature: SIG }, nonceCookie(newNonce()));
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.headers.getSetCookie().find((c) => c.startsWith("svm_nonce="))).toMatch(/;\s*Max-Age=0\b/);
    vi.stubEnv("SESSION_SECRET", SECRET);
    const badBody = await post({}, nonceCookie(newNonce()));
    expect(badBody.status).toBe(400);
    expect(badBody.headers.getSetCookie().find((c) => c.startsWith("svm_nonce="))).toMatch(/;\s*Max-Age=0\b/);
    const noNonce = await post({ message: MESSAGE, signature: SIG });
    expect(noNonce.status).toBe(401);
    expect(noNonce.headers.getSetCookie().find((c) => c.startsWith("svm_nonce="))).toMatch(/;\s*Max-Age=0\b/);
  });

  it("answers 429 once the client IP's pre-auth budget is spent, before touching the body or the nonce", async () => {
    for (let i = 0; i < CLIENT_LIMIT; i++) {
      expect((await post({ message: MESSAGE, signature: SIG }, nonceCookie(newNonce()))).status).toBe(200);
    }
    const res = await post({ message: MESSAGE, signature: SIG }, nonceCookie(newNonce()));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    await expect(res.text()).resolves.toBe("too many requests");
  });
});

describe("GET /api/session", () => {
  const get = (cookie?: string) => GET(new Request("http://localhost:3000/api/session", { headers: cookie ? { cookie } : {} }));

  it("answers the signed-in address", async () => {
    const res = await get(sessionCookie());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ address: ADDR });
  });

  it("answers 401 without a cookie and for an expired one", async () => {
    expect((await get()).status).toBe(401);
    expect((await get(sessionCookie({ exp: nowSec() - 1 }))).status).toBe(401);
  });

  it("answers 503 while SESSION_SECRET is unset", async () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    expect((await get(sessionCookie())).status).toBe(503);
  });
});

describe("DELETE /api/session", () => {
  it("answers 204 and clears both cookies, configured or not", async () => {
    for (const secret of [SECRET, undefined]) {
      vi.stubEnv("SESSION_SECRET", secret);
      const res = await DELETE();
      expect(res.status).toBe(204);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const cookies = res.headers.getSetCookie();
      expect(cookies.find((c) => c.startsWith("svm_session="))).toMatch(/;\s*Max-Age=0\b/);
      expect(cookies.find((c) => c.startsWith("svm_nonce="))).toMatch(/;\s*Max-Age=0\b/);
    }
  });
});
