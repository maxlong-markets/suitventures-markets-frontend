# Social layer (M4) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a wallet signs in once per device through Sign-In with Ethereum, its watchlist and votes live in the market store and follow it anywhere, bull and bear counts are real on the table and the token page, and a 24-hour top-traders board has its own page.

**Architecture:** an HttpOnly HMAC session cookie is the only identity the user routes trust; watchlists, votes and their counts live in two new tables in the market store; the traders board is one grouped query over the store's ten-day trades.

**Tech Stack:** Next.js 16 App Router, viem 2.56 (`viem/siwe`), wagmi 3.7, TanStack Query 5, Vitest 4 (`node` and `dom` projects), PGlite for database tests.

**Spec:** `docs/superpowers/specs/2026-09-18-social-layer-m4-design.md`

## Global Constraints

- The wallet in every `/api/me/*` route comes only from the session cookie; the client never sends an address for user data.
- `SESSION_SECRET` unset never breaks reads: the session and user routes answer 503, the client's reads answer empty or null, writes fail visibly.
- No `number` holds a token amount on an execution path; the board's USD figures are display only.
- No secret, address or URL in a log, error or response beyond what the route must answer.
- Every new file has a test file beside it; every route has a handler test.
- The demo data source keeps its browser-local watchlist and votes.
- Gates at every commit: `npm test`, `npx tsc --noEmit`, `npx eslint .` (zero warnings), `npm run build`.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` then `Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467`.
- Never print, commit or push `.env.local`.

## Verified facts (18 Sep 2026, installed packages and the real indexer)

- **viem's SIWE helpers live at `viem/siwe`, not `viem`.** `createSiweMessage`, `parseSiweMessage`, `validateSiweMessage` and `verifySiweMessage` are exported there; `verifySiweMessage` is a client action, `verifySiweMessage(client, { message, signature, … })`. `generateSiweNonce()` is exported there too but is NOT used: in 2.56.3 it is `uid(96)`, `Math.random()` over a shared buffer whose index advances one character per call, so successive nonces overlap in 95 of 96 characters. The nonce route issues `randomBytes(16).toString("hex")` from `node:crypto`. Importing them from `viem` yields `undefined` at runtime with no type error in some paths, so every import is checked.
- The indexer records `Swap.wallet` as the transaction sender (`handlers/poolManager.ts:206`, `event.transaction.from`), so the board credits people, not routers.
- `market.quotes.usd_price` exists (nullable); `market.swaps` carries `wallet`, `amount_quote`, `ts`, `pool_id`, `token_id` and is pruned to ten days.
- `SignModal` today signs a client-made message nobody verifies; `AppState` keeps `{ address, signature }` in memory only.
- `LocalWatchStore` (`src/lib/data/localStore.ts`) is imported only by the Envio data source; the demo source has its own identical storage. When the Envio source stops using it, the file has no importer.

## Rulings that override the task text below

1. **Reads never fail closed on a missing session or an unconfigured secret.** `watchlist()`, `votes()` and `session()` answer `[]`, `{}` and `null` on 401 and on 503; `setWatch()` and `vote()` throw so the optimistic update rolls back. The demo source answers the same three values while nobody has signed in, and its two writes throw the same way — a read must never throw in either source.
2. **Query keys for user data are plain constants** (`keys.watchlist`, `keys.votes`) and the hooks take `enabled`; `AppState` drops both caches whenever the session is not the connected wallet.
3. **`completeSign(sign, address)`** takes the signer and the address: `SignModal` hands over `signMessageAsync`; the data source builds the SIWE message and runs the exchange. The modal keeps its UI and shows a description rather than the message, which exists only at sign time.
4. **`signOut()` exists, is tested, and is not wired to wallet disconnection**: calling it on `isConnected === false` would clear a good cookie during hydration. A sign-out control is M5.
5. **`TraderRow` is declared exactly once in `src/lib/types.ts`, by Task 2 Step 3**, and re-exported from the store module (`export type { TraderRow } from "@/lib/types";`, already in Task 2's `store.ts`); client components import it from `types`. Task 5 adds only `TradersBy` and the `traders` method — it must not re-declare the row.
6. **`MarketsDataSource.vote` returns `Promise<VoteDir | null>`**, the resulting state, matching the route.
7. **Address comparisons between the cookie (lowercase) and the wallet (checksummed) are case-insensitive.**
8. **A 503 from `/api/traders` whose body carries `code: "no-store"` is `StoreUnavailableError`**; any other 503 (the database being unavailable) is an ordinary failure, so the board distinguishes "no store yet" from "request failed" without string matching.
9. **`src/lib/data/localStore.ts` is deleted** with its only importer; the demo source's own storage is untouched.
10. **Task 6 commits twice**: the frontend repo and, separately, the workspace README with the frontend gitlink.
11. **The nonce is `randomBytes(16)` hex**, never viem's `generateSiweNonce` (see the verified facts).
12. **`verifySiwe` checks domain, chain, nonce, `expirationTime` and `notBefore` itself and asks viem only about the signature**, so each failure has its own error string; `verifySiweMessage` alone answers one boolean.
13. **`/api/votes` without a database answers zeros**, not 503: counts are decoration, not identity.
14. **The board prices with `coalesce(usd_price, 0)` and ignores feed staleness**: dropping stale feeds would empty the whole board during a price-feed outage; a stale feed is flagged elsewhere.
15. **`signNonce(nonce, secret)` reads the clock itself**, as drafted; its test uses fake timers.
16. **The commit trailer is `Claude Fable 5.1`**, this session's model, on every commit, whatever a generic reminder says. **Open before Task 1's commit:** an executing session may carry a different attribution line (`Claude Opus 5 (1M context)` was current on 18 Sep 2026). The two cannot both be right on one commit — ask Kobe which name goes on the six M4 commits, and use that answer in all six.
17. **`.env.example` gains `SESSION_SECRET` exactly once, in Task 1 Step 11**, in the file's bottom-half inline style. Task 6 Step 1 only *verifies* the line is there and commits nothing of `.env.example`; a second append would leave two `SESSION_SECRET=` keys and fail Task 6's own `grep`.

---
### Task 1: Sign-in — the session cookie, SIWE verification and the session routes

**Files:**
- Create: `src/lib/session/cookie.ts`, `src/lib/session/siwe.ts`, `src/app/api/_lib/session.ts`, `src/app/api/session/nonce/route.ts`, `src/app/api/session/route.ts`
- Modify: `src/app/api/_lib/respond.ts` (three answer helpers: `noStore`, `unauthorized`, `tooManyRequests`), `.env.example` (`SESSION_SECRET`)
- Test: `src/lib/session/cookie.test.ts`, `src/lib/session/siwe.test.ts`, `src/app/api/_lib/session.test.ts`, `src/app/api/session/nonce/route.test.ts`, `src/app/api/session/route.test.ts`, `src/app/api/_lib/respond.test.ts` (one new `describe`)

**Interfaces:**
- Consumes: `Address` from `src/lib/types.ts`; `nowSec` from `src/lib/time.ts`; `robinhoodChain` from `src/lib/chain.ts`; `badRequest`, `failure` from `src/app/api/_lib/respond.ts`; `NextResponse` from `next/server`; `createHmac`, `randomBytes`, `timingSafeEqual` from `node:crypto`; `parseSiweMessage` and `verifySiweMessage` from `viem/siwe` (never from `viem`; `verifySiweMessage` is a client action, called as `verifySiweMessage(client, { … })`), `createPublicClient`, `http`, `custom` and the types `PublicClient`, `Hex`, `Address` from `viem`; `createSiweMessage` from `viem/siwe` and `privateKeyToAccount` from `viem/accounts` in the tests only.
- Produces: `SESSION_COOKIE`, `NONCE_COOKIE`, `SESSION_TTL_SEC`, `NONCE_TTL_SEC`, `SessionPayload`, `signSession`, `verifySession`, `signNonce`, `verifyNonce`, `newNonce`, `sessionSecret` from `src/lib/session/cookie.ts`; `SiweVerifyInput`, `SIWE_STATEMENT`, `verifySiwe` from `src/lib/session/siwe.ts`; `cookieValue`, `readSession`, `requireSession`, `notConfigured`, `setCookie`, `clearCookie` from `src/app/api/_lib/session.ts`; `noStore`, `unauthorized`, `tooManyRequests` from `src/app/api/_lib/respond.ts`; `GET` from `src/app/api/session/nonce/route.ts`; `GET`, `POST`, `DELETE` from `src/app/api/session/route.ts`. Signatures exactly as in the contract; `newNonce`, `SIWE_STATEMENT`, `cookieValue`, `notConfigured`, `setCookie`, `clearCookie` and the three respond helpers are the additions. Task 3 consumes `requireSession` and `tooManyRequests`; the client task consumes `SIWE_STATEMENT` and the two routes.

Decisions where the contract is silent (each one line):
- **`newNonce()` lives in `cookie.ts` and viem's `generateSiweNonce()` is not used.** viem 2.56.3 implements it as `uid(96)`: `Math.random()` over a 512-character shared buffer whose index advances **one** character per call, so two successive nonces overlap in 95 of their 96 characters and none of it is CSPRNG. `randomBytes(16).toString("hex")` is 32 alphanumeric characters, which satisfies EIP-4361's "at least 8, alphanumeric" rule that `createSiweMessage` enforces.
- **The token format is `base64url(json).base64url(hmac-sha256(base64url(json)))`** for both cookies, sealed and opened by one pair of private helpers, so the session and the nonce cannot disagree about the format. The MAC covers the base64url body, not the raw JSON, so nothing depends on `JSON.stringify` key order surviving a round trip.
- **`timingSafeEqual` is called only on equal lengths**, which is checked first and returned as a plain `false`: the function throws on a length mismatch, and the length of an HMAC is not a secret.
- **`cookieValue` never throws.** It runs before every route's own `try`, on a header the caller controls, and `decodeURIComponent("%")` raises `URIError`; a value that is not valid percent-encoding is answered as `null`, so a corrupt cookie reads as "no cookie" and the routes answer 401 or 503 rather than 500.
- **The POST's `catch` logs nothing from the error and spends the nonce.** viem's `CallExecutionError`/`BaseError` messages embed the request `data` — the address and the signature — and sometimes the RPC URL, against Global Constraint 4 and this module's own "no address, nonce, host or message body" promise; the catch answers `failure(new Error("sign-in verification failed"))` and clears `svm_nonce`, so the single-use rule holds on the thrown path as well as the refused one.
- **`verifySession` re-checks the address shape** (`/^0x[0-9a-f]{40}$/`) after parsing. A token signed with the real secret still has to carry a lowercase address, because that string is concatenated into no SQL but is the primary key of every row the user owns.
- **`signNonce` reads the clock itself** (`nowSec()`), because the contract gives it no `now`; the expiry travels inside the sealed body as well as in `Max-Age`, so a browser that keeps the cookie past its window still cannot use it.
- **`siwe.ts` does not import `server-only`, `cookie.ts` does.** Only `cookie.ts` touches `SESSION_SECRET`; `siwe.ts` is pure viem, and the client task needs `SIWE_STATEMENT` from it to build the very message this module verifies.
- **`verifySiwe` makes every check itself before calling `verifySiweMessage`**, which returns one boolean and so cannot say why. Each refusal is a distinct fixed string — `malformed message`, `wrong domain`, `wrong chain`, `nonce mismatch`, `no expiry`, `expired`, `not yet valid`, `bad signature` — and none of them contains an address, a nonce, a host or a message body.
- **An `expirationTime` is required.** EIP-4361 makes the field optional; a sign-in message without one would let a leaked signature be replayed forever against a re-issued nonce, and the client always sets it (spec section 2).
- **A malformed signature is `bad signature`, not an exception.** Probed against viem 2.56.3: `"not-a-signature"`, `"0x"` and `"0xdead"` all make `verifySiweMessage` return `false` without throwing, so the route needs no hex guard of its own.
- **The expected domain is the request's own `host` header**, falling back to `new URL(req.url).host`. That is exactly what the browser puts in the message, and on Vercel the header already carries the public hostname.
- **The POST clears `svm_nonce` on every terminal answer**, success or refusal, so a nonce is single-use even when the signature was wrong. The client fetches a fresh nonce before every signature, so it never needs the old one.
- **`DELETE` works while `SESSION_SECRET` is unset.** Clearing a cookie needs no key, and a user must always be able to sign out.
- **`SESSION_TTL_SEC` is both the cookie `Max-Age` and the sealed `exp`**, so a stolen cookie that outlives its browser still expires on the server.
- **Every address this task answers or stores is lowercase**, including the one in `GET /api/session`. A wallet reports its address checksummed, so the client-side comparison that decides "this session belongs to the connected wallet" must be case-insensitive; the server never compares addresses at all.

- [ ] **Step 1: Write the failing cookie test**

`src/lib/session/cookie.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address } from "@/lib/types";
import {
  NONCE_COOKIE,
  NONCE_TTL_SEC,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  newNonce,
  sessionSecret,
  signNonce,
  signSession,
  verifyNonce,
  verifySession,
} from "./cookie";

const SECRET = "0123456789abcdef0123456789abcdef"; // exactly 32 characters, the minimum
const OTHER = "fedcba9876543210fedcba9876543210";
const ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as Address;
const MIXED = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const NOW = 1_789_000_000;

/** The wire format, written out once here so the test pins it rather than trusting the module. */
const forge = (json: string, secret = SECRET) => {
  const body = Buffer.from(json, "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("session cookie", () => {
  it("names the two cookies and their lifetimes", () => {
    expect(SESSION_COOKIE).toBe("svm_session");
    expect(NONCE_COOKIE).toBe("svm_nonce");
    expect(SESSION_TTL_SEC).toBe(604_800);
    expect(NONCE_TTL_SEC).toBe(600);
  });

  it("round-trips a payload, lowercases the address and uses base64url(payload).base64url(hmac)", () => {
    const token = signSession({ address: MIXED, iat: NOW, exp: NOW + SESSION_TTL_SEC }, SECRET);
    expect(token).toBe(forge(JSON.stringify({ address: ADDR, iat: NOW, exp: NOW + SESSION_TTL_SEC })));
    expect(token.split(".")).toHaveLength(2);
    expect(verifySession(token, SECRET, NOW)).toEqual({ address: ADDR, iat: NOW, exp: NOW + SESSION_TTL_SEC });
  });

  it("refuses a tampered body, a tampered signature, the wrong secret and anything that is not a token", () => {
    const token = signSession({ address: ADDR, iat: NOW, exp: NOW + 60 }, SECRET);
    const [body, sig] = token.split(".");
    const other = signSession({ address: `0x${"22".repeat(20)}` as Address, iat: NOW, exp: NOW + 60 }, SECRET);
    const [otherBody, otherSig] = other.split(".");
    expect(verifySession(`${otherBody}.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifySession(`${body}.${otherSig}`, SECRET, NOW)).toBeNull();
    expect(verifySession(token, OTHER, NOW)).toBeNull();
    expect(verifySession(`${body}.${sig}x`, SECRET, NOW)).toBeNull(); // different length: no throw from timingSafeEqual
    expect(verifySession(body, SECRET, NOW)).toBeNull();
    expect(verifySession(`${body}.${sig}.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifySession("", SECRET, NOW)).toBeNull();
    expect(verifySession(".", SECRET, NOW)).toBeNull();
  });

  it("refuses a correctly signed token whose payload is not a session", () => {
    for (const junk of [
      "null",
      '"hello"',
      "{}",
      '{"address":"nope","iat":1,"exp":9999999999}',
      `{"address":"${MIXED}","iat":1,"exp":9999999999}`, // checksummed: the identity must be lowercase
      `{"address":"${ADDR}","iat":"1","exp":9999999999}`,
      "not json at all",
    ]) {
      expect(verifySession(forge(junk), SECRET, NOW)).toBeNull();
    }
  });

  it("refuses a token at and after its expiry", () => {
    const token = signSession({ address: ADDR, iat: NOW, exp: NOW + 60 }, SECRET);
    expect(verifySession(token, SECRET, NOW + 59)).not.toBeNull();
    expect(verifySession(token, SECRET, NOW + 60)).toBeNull();
    expect(verifySession(token, SECRET, NOW + 61)).toBeNull();
  });

  it("mints an EIP-4361-shaped nonce that never repeats or overlaps", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => newNonce()));
    expect(nonces.size).toBe(50);
    for (const n of nonces) expect(n).toMatch(/^[0-9a-f]{32}$/);
  });

  it("round-trips a nonce and expires it after ten minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const nonce = newNonce();
    const token = signNonce(nonce, SECRET);
    expect(verifyNonce(token, SECRET, NOW)).toBe(nonce);
    expect(verifyNonce(token, SECRET, NOW + NONCE_TTL_SEC - 1)).toBe(nonce);
    expect(verifyNonce(token, SECRET, NOW + NONCE_TTL_SEC)).toBeNull();
    expect(verifyNonce(token, OTHER, NOW)).toBeNull();
    expect(verifyNonce(forge('{"n":"abc"}'), SECRET, NOW)).toBeNull();
  });

  it("reads SESSION_SECRET only when it is long enough to be a key", () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    expect(sessionSecret()).toBeNull();
    vi.stubEnv("SESSION_SECRET", "");
    expect(sessionSecret()).toBeNull();
    vi.stubEnv("SESSION_SECRET", "x".repeat(31));
    expect(sessionSecret()).toBeNull();
    vi.stubEnv("SESSION_SECRET", "x".repeat(32));
    expect(sessionSecret()).toBe("x".repeat(32));
  });
});
```

Run: `npx vitest run src/lib/session/cookie.test.ts`
Expected: FAIL — `Failed to resolve import "./cookie"`, the module does not exist yet.

- [ ] **Step 2: Write `src/lib/session/cookie.ts`**

```ts
import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { nowSec } from "@/lib/time";
import type { Address } from "@/lib/types";

export const SESSION_COOKIE = "svm_session";
export const NONCE_COOKIE = "svm_nonce";
export const SESSION_TTL_SEC = 7 * 86_400;
export const NONCE_TTL_SEC = 600;

/** The address is always lowercase: it is the only identity the user routes trust, and the primary key of every row the user owns. */
export type SessionPayload = { address: Address; iat: number; exp: number };

const LOWER_ADDRESS = /^0x[0-9a-f]{40}$/;

const mac = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("base64url");

/** `base64url(json).base64url(hmac-sha256)`. The MAC covers the encoded body, so nothing depends on key order surviving a round trip. */
function seal(value: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${body}.${mac(body, secret)}`;
}

/** The parsed body of a token whose signature matches, else null. */
function open(token: string, secret: string): unknown {
  const dot = token.indexOf(".");
  if (dot <= 0 || token.indexOf(".", dot + 1) !== -1) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "utf8");
  const want = Buffer.from(mac(body, secret), "utf8");
  // timingSafeEqual throws on a length mismatch, and the length of an HMAC is not a secret.
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function signSession(p: SessionPayload, secret: string): string {
  return seal({ address: p.address.toLowerCase(), iat: p.iat, exp: p.exp }, secret);
}

export function verifySession(token: string, secret: string, now: number): SessionPayload | null {
  const v = open(token, secret) as Partial<SessionPayload> | null;
  if (!v || typeof v.address !== "string" || typeof v.iat !== "number" || typeof v.exp !== "number") return null;
  if (!LOWER_ADDRESS.test(v.address)) return null;
  if (v.exp <= now) return null;
  return { address: v.address as Address, iat: v.iat, exp: v.exp };
}

/**
 * 16 CSPRNG bytes as hex: 32 alphanumeric characters, which is what EIP-4361 (and viem's own
 * `createSiweMessage`) requires. viem's `generateSiweNonce()` is deliberately not used: it is
 * `Math.random()` over a shared buffer whose index advances one character per call, so two
 * successive nonces overlap in 95 of their 96 characters.
 */
export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

/** The value of the `svm_nonce` cookie. The window travels inside the sealed body as well as in Max-Age, so a kept cookie still cannot outlive it. */
export function signNonce(nonce: string, secret: string): string {
  return seal({ n: nonce, exp: nowSec() + NONCE_TTL_SEC }, secret);
}

export function verifyNonce(token: string, secret: string, now: number): string | null {
  const v = open(token, secret) as { n?: unknown; exp?: unknown } | null;
  if (!v || typeof v.n !== "string" || typeof v.exp !== "number") return null;
  if (v.exp <= now) return null;
  return v.n;
}

/** `process.env.SESSION_SECRET`, null when unset or shorter than 32 characters (256 bits written as hex is 64). */
export function sessionSecret(): string | null {
  const secret = process.env.SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}
```

Run: `npx vitest run src/lib/session/cookie.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 3: Write the failing SIWE test**

`src/lib/session/siwe.test.ts`:

```ts
import { createPublicClient, custom, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { describe, expect, it } from "vitest";
import { robinhoodChain } from "@/lib/chain";
import { SIWE_STATEMENT, verifySiwe } from "./siwe";

/** Foundry's first published anvil account, printed by `anvil` on every start. Public knowledge; it holds nothing anywhere. */
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(KEY);
const ADDRESS = account.address.toLowerCase();
const DOMAIN = "longmarkets.xyz";
const NONCE = "a1b2c3d4e5f60718";
const NOW = 1_789_000_000;
const at = (sec: number) => new Date(sec * 1000);

/**
 * An EOA signature recovers offline, but viem still tries the ERC-6492 validator first, so the
 * client must answer exactly one `eth_call`. 32 zero bytes means "not a contract account", after
 * which viem falls back to ECDSA recovery — the production path for a wallet EOA, and the reason
 * a smart account (EIP-1271) needs a real client here while this test needs no network.
 */
function mockClient(seen: string[] = []): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    transport: custom({
      async request({ method }) {
        seen.push(method);
        if (method === "eth_call") return `0x${"00".repeat(32)}`;
        if (method === "eth_chainId") return "0x1237";
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
}

type Fields = Parameters<typeof createSiweMessage>[0];
const fields = (over: Partial<Fields> = {}): Fields => ({
  address: account.address,
  chainId: robinhoodChain.id,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `https://${DOMAIN}`,
  version: "1",
  statement: SIWE_STATEMENT,
  issuedAt: at(NOW),
  expirationTime: at(NOW + 7 * 86_400),
  ...over,
});

async function signed(over: Partial<Fields> = {}): Promise<{ message: string; signature: Hex }> {
  const message = createSiweMessage(fields(over));
  return { message, signature: await account.signMessage({ message }) };
}

const verify = async (over: Partial<Fields> = {}, patch: Partial<{ signature: Hex; expectedNonce: string; domain: string; now: number }> = {}) => {
  const { message, signature } = await signed(over);
  return verifySiwe({ message, signature, expectedNonce: NONCE, domain: DOMAIN, now: NOW, ...patch }, mockClient());
};

describe("verifySiwe", () => {
  it("accepts a real message signed by a real key and answers the lowercase address", async () => {
    const seen: string[] = [];
    const { message, signature } = await signed();
    expect(message).toContain(`Chain ID: ${robinhoodChain.id}`);
    expect(message).toContain(SIWE_STATEMENT);
    const result = await verifySiwe({ message, signature, expectedNonce: NONCE, domain: DOMAIN, now: NOW }, mockClient(seen));
    expect(result).toEqual({ address: ADDRESS });
    expect(seen).toEqual(["eth_call"]); // the client is consulted for the contract-account case only
  });

  it("still accepts an EOA signature when the node is unreachable, because recovery is offline", async () => {
    const { message, signature } = await signed();
    const dead = createPublicClient({
      chain: robinhoodChain,
      transport: custom({
        async request() {
          throw new Error("node down");
        },
      }),
    });
    await expect(verifySiwe({ message, signature, expectedNonce: NONCE, domain: DOMAIN, now: NOW }, dead)).resolves.toEqual({ address: ADDRESS });
  });

  it("refuses a message for another site", async () => {
    await expect(verify({ domain: "evil.example", uri: "https://evil.example" })).resolves.toEqual({ error: "wrong domain" });
  });

  it("refuses a message for another chain", async () => {
    await expect(verify({ chainId: 1 })).resolves.toEqual({ error: "wrong chain" });
  });

  it("refuses a nonce the server did not issue", async () => {
    await expect(verify({ nonce: "99887766554433221" })).resolves.toEqual({ error: "nonce mismatch" });
    await expect(verify({}, { expectedNonce: "99887766554433221" })).resolves.toEqual({ error: "nonce mismatch" });
  });

  it("refuses an expired message, and one that is not valid yet", async () => {
    await expect(verify({ expirationTime: at(NOW - 1) })).resolves.toEqual({ error: "expired" });
    await expect(verify({ expirationTime: at(NOW) })).resolves.toEqual({ error: "expired" });
    await expect(verify({ notBefore: at(NOW + 60) })).resolves.toEqual({ error: "not yet valid" });
    await expect(verify({ notBefore: at(NOW) })).resolves.toEqual({ address: ADDRESS });
  });

  it("refuses a message with no expiry at all", async () => {
    await expect(verify({ expirationTime: undefined })).resolves.toEqual({ error: "no expiry" });
  });

  it("refuses a signature that belongs to another message, and anything that is not a signature", async () => {
    const other = await signed({ nonce: "99887766554433221" });
    await expect(verify({}, { signature: other.signature })).resolves.toEqual({ error: "bad signature" });
    for (const junk of ["0x", "0xdead", "not-a-signature"] as Hex[]) {
      await expect(verify({}, { signature: junk })).resolves.toEqual({ error: "bad signature" });
    }
  });

  it("refuses anything that is not an EIP-4361 message", async () => {
    for (const junk of ["", "hello", "longmarkets.xyz wants you to sign in"]) {
      await expect(
        verifySiwe({ message: junk, signature: "0x00", expectedNonce: NONCE, domain: DOMAIN, now: NOW }, mockClient()),
      ).resolves.toEqual({ error: "malformed message" });
    }
  });

  it("never names the domain, the nonce or the address in a refusal", async () => {
    const result = await verify({ domain: "evil.example", uri: "https://evil.example" });
    expect(JSON.stringify(result)).not.toMatch(/evil|0x|a1b2c3/i);
  });
});
```

Run: `npx vitest run src/lib/session/siwe.test.ts`
Expected: FAIL — `Failed to resolve import "./siwe"`.

- [ ] **Step 4: Write `src/lib/session/siwe.ts`**

```ts
import type { Address, Hex, PublicClient } from "viem";
import { parseSiweMessage, verifySiweMessage } from "viem/siwe";
import { robinhoodChain } from "@/lib/chain";

/** The one line the wallet shows above the fields. The client builds the message with it; this module is what checks the result. */
export const SIWE_STATEMENT = "Sign in to SuitVentures Markets";

export type SiweVerifyInput = { message: string; signature: Hex; expectedNonce: string; domain: string; now: number };

/**
 * EIP-4361 verification for one sign-in. Every field check happens here rather than inside viem's
 * `verifySiweMessage`, which answers one boolean and so cannot say which check failed; the refusals
 * are fixed strings that name no address, nonce, host or message body. `verifySiweMessage` is then
 * asked only about the signature, and it is asked through a client so that a smart account signing
 * through EIP-1271 / ERC-6492 verifies too — an EOA signature recovers offline and needs no node.
 */
export async function verifySiwe(input: SiweVerifyInput, client: PublicClient): Promise<{ address: Address } | { error: string }> {
  const { message, signature, expectedNonce, domain, now } = input;
  const parsed = parseSiweMessage(message);
  if (!parsed.address || !parsed.nonce) return { error: "malformed message" };
  if (parsed.domain !== domain) return { error: "wrong domain" };
  if (parsed.chainId !== robinhoodChain.id) return { error: "wrong chain" };
  if (parsed.nonce !== expectedNonce) return { error: "nonce mismatch" };
  const at = new Date(now * 1000);
  // EIP-4361 makes the expiry optional; a sign-in message without one would be replayable forever.
  if (!parsed.expirationTime) return { error: "no expiry" };
  if (Number.isNaN(parsed.expirationTime.getTime()) || parsed.expirationTime <= at) return { error: "expired" };
  if (parsed.notBefore && (Number.isNaN(parsed.notBefore.getTime()) || at < parsed.notBefore)) return { error: "not yet valid" };
  const ok = await verifySiweMessage(client, { message, signature, address: parsed.address, domain, nonce: expectedNonce, time: at });
  if (!ok) return { error: "bad signature" };
  return { address: parsed.address.toLowerCase() as Address };
}
```

Run: `npx vitest run src/lib/session/siwe.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Write the failing respond-helper tests**

Append to `src/app/api/_lib/respond.test.ts`, and extend its import line to `import { failure, noStore, tooManyRequests, unauthorized } from "./respond";`:

```ts
describe("answers that must never be cached", () => {
  it("serves a user's own data with no-store", async () => {
    const res = noStore(["0xabc"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual(["0xabc"]);
  });

  it("answers 401 with a fixed reason and no-store", async () => {
    const res = unauthorized("not signed in");
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ error: "not signed in" });
  });

  it("answers 429 with a plain body and a retry hint", async () => {
    const res = tooManyRequests();
    expect(res.status).toBe(429);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    await expect(res.text()).resolves.toBe("too many requests");
  });
});
```

Run: `npx vitest run src/app/api/_lib/respond.test.ts`
Expected: FAIL — `noStore is not a function` (Vitest's SSR transform hands back `undefined` for exports that do not exist).

- [ ] **Step 6: Add the three helpers to `src/app/api/_lib/respond.ts`**

Append to the end of `src/app/api/_lib/respond.ts`:

```ts
/** A user's own data: no CDN, no browser cache, no shared copy of one wallet's watchlist. */
export function noStore<T>(data: T): NextResponse {
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}

/** 401 for a missing or unusable session. `error` is always a fixed constant: never an address, never a nonce. */
export function unauthorized(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

/** 429 for a wallet past its write budget (Task 3). A plain body: there is nothing here worth parsing. */
export function tooManyRequests(): NextResponse {
  return new NextResponse("too many requests", {
    status: 429,
    headers: { "Cache-Control": "no-store", "Retry-After": "60", "Content-Type": "text/plain; charset=utf-8" },
  });
}
```

Run: `npx vitest run src/app/api/_lib/respond.test.ts`
Expected: PASS (the file's existing cases plus 3).

- [ ] **Step 7: Write the failing session-reader test**

`src/app/api/_lib/session.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, SESSION_TTL_SEC, signSession } from "@/lib/session/cookie";
import { nowSec } from "@/lib/time";
import type { Address } from "@/lib/types";
import { cookieValue, readSession, requireSession } from "./session";

const SECRET = "0123456789abcdef0123456789abcdef";
const ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as Address;
const token = (over: Partial<{ address: Address; iat: number; exp: number }> = {}) =>
  signSession({ address: ADDR, iat: nowSec(), exp: nowSec() + SESSION_TTL_SEC, ...over }, SECRET);
const req = (cookie?: string) => new Request("http://localhost:3000/api/me/watchlist", { headers: cookie ? { cookie } : {} });

beforeEach(() => vi.stubEnv("SESSION_SECRET", SECRET));
afterEach(() => vi.unstubAllEnvs());

describe("cookieValue", () => {
  it("reads one cookie out of a header, whitespace and neighbours and all", () => {
    expect(cookieValue("a=1; svm_session=xyz; b=2", SESSION_COOKIE)).toBe("xyz");
    expect(cookieValue("svm_session=xyz", SESSION_COOKIE)).toBe("xyz");
    expect(cookieValue("  svm_session = xyz ", SESSION_COOKIE)).toBe("xyz");
    expect(cookieValue("svm_session%20", SESSION_COOKIE)).toBeNull();
    expect(cookieValue("svm_session_other=xyz", SESSION_COOKIE)).toBeNull();
    expect(cookieValue("novalue", SESSION_COOKIE)).toBeNull();
    expect(cookieValue(null, SESSION_COOKIE)).toBeNull();
  });

  it("treats a cookie that is not valid percent-encoding as absent instead of throwing", () => {
    // `decodeURIComponent("%")` throws `URIError`. A cookie is attacker-supplied text and this
    // function is called outside every route's `try`, so an un-guarded decode is a 500 anyone
    // can trigger with one character.
    expect(cookieValue("svm_session=%", SESSION_COOKIE)).toBeNull();
    expect(cookieValue("a=1; svm_session=%ZZ; b=2", SESSION_COOKIE)).toBeNull();
    expect(cookieValue("svm_session=%E0%A4%A", SESSION_COOKIE)).toBeNull();
    // Valid escapes still decode.
    expect(cookieValue("svm_session=a%2Eb", SESSION_COOKIE)).toBe("a.b");
  });
});

describe("readSession", () => {
  it("answers the payload for a valid cookie", () => {
    expect(readSession(req(`${SESSION_COOKIE}=${token()}`))?.address).toBe(ADDR);
  });
  it("answers null without a cookie, with junk, with an expired token and with the wrong secret", () => {
    expect(readSession(req())).toBeNull();
    expect(readSession(req(`${SESSION_COOKIE}=junk`))).toBeNull();
    expect(readSession(req(`${SESSION_COOKIE}=${token({ exp: nowSec() - 1 })}`))).toBeNull();
    vi.stubEnv("SESSION_SECRET", "fedcba9876543210fedcba9876543210");
    expect(readSession(req(`${SESSION_COOKIE}=${token()}`))).toBeNull();
  });
  it("answers null while SESSION_SECRET is unset, without reading the cookie", () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    expect(readSession(req(`${SESSION_COOKIE}=${token()}`))).toBeNull();
  });
});

describe("requireSession", () => {
  it("hands back the payload when the cookie is good", () => {
    const result = requireSession(req(`${SESSION_COOKIE}=${token()}`));
    expect(result).not.toBeInstanceOf(Response);
    expect((result as { address: Address }).address).toBe(ADDR);
  });

  it("answers 401 without a session", async () => {
    const res = requireSession(req());
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
    expect((res as Response).headers.get("Cache-Control")).toBe("no-store");
    await expect((res as Response).json()).resolves.toEqual({ error: "not signed in" });
  });

  it("answers 503 while SESSION_SECRET is unset, so an unconfigured deploy reads as unconfigured and not as signed out", async () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    const res = requireSession(req(`${SESSION_COOKIE}=${token()}`)) as Response;
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("60");
    await expect(res.json()).resolves.toEqual({ error: "sessions not configured" });
  });

  it("answers 401, not 500, for a corrupt cookie", async () => {
    // The whole reason `cookieValue` guards its decode: this header reaches `requireSession`
    // before any route's `try`, so an exception here would be a 500 from every /api/me/* route.
    const res = requireSession(req(`${SESSION_COOKIE}=%`)) as Response;
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "not signed in" });
  });
});
```

Run: `npx vitest run src/app/api/_lib/session.test.ts`
Expected: FAIL — `Failed to resolve import "./session"`.

- [ ] **Step 8: Write `src/app/api/_lib/session.ts`**

```ts
import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionSecret, verifySession, type SessionPayload } from "@/lib/session/cookie";
import { nowSec } from "@/lib/time";
import { unauthorized } from "./respond";

/**
 * One cookie's value out of a raw `Cookie` header. Route handlers are tested by calling them with a
 * plain `Request`, where `next/headers` has no request scope to read, so nothing here uses it.
 */
export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // `decodeURIComponent("%")` throws `URIError`, and this runs before every route's own
      // `try`: an un-guarded decode would turn one corrupt character into a 500 from every
      // /api/me/* route and from both session routes. A cookie that is not valid
      // percent-encoding is no cookie, which is the answer that makes them all say 401.
      return null;
    }
  }
  return null;
}

/** The signed-in wallet, or null: no cookie, a bad signature, an expired token, or no key configured. */
export function readSession(req: Request): SessionPayload | null {
  const secret = sessionSecret();
  if (!secret) return null;
  const token = cookieValue(req.headers.get("cookie"), SESSION_COOKIE);
  return token ? verifySession(token, secret, nowSec()) : null;
}

/** 503 while SESSION_SECRET is unset: sign-in is not broken, it is not deployed, and the client stays read-only. */
export function notConfigured(): NextResponse {
  return NextResponse.json(
    { error: "sessions not configured" },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" } },
  );
}

/** The payload, or the answer to return as-is. `NextResponse extends Response`, so callers test with `instanceof Response`. */
export function requireSession(req: Request): SessionPayload | Response {
  if (!sessionSecret()) return notConfigured();
  return readSession(req) ?? unauthorized("not signed in");
}

/** Secure only in production: a local http:// dev server would silently drop a Secure cookie. */
const isProd = () => process.env.NODE_ENV === "production";

export function setCookie(res: NextResponse, name: string, value: string, maxAge: number): void {
  res.cookies.set({ name, value, httpOnly: true, sameSite: "lax", path: "/", secure: isProd(), maxAge });
}

export function clearCookie(res: NextResponse, name: string): void {
  res.cookies.set({ name, value: "", httpOnly: true, sameSite: "lax", path: "/", secure: isProd(), maxAge: 0 });
}
```

Run: `npx vitest run src/app/api/_lib/session.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 9: Write the failing route tests**

`src/app/api/session/nonce/route.test.ts`:

```ts
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
```

`src/app/api/session/route.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONCE_COOKIE, SESSION_COOKIE, SESSION_TTL_SEC, newNonce, signNonce, signSession, verifySession } from "@/lib/session/cookie";
import type { SiweVerifyInput } from "@/lib/session/siwe";
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

  it("spends the nonce even when verification fails, and reports the verifier's reason", async () => {
    verifySiwe.mockResolvedValue({ error: "wrong domain" });
    const res = await post({ message: MESSAGE, signature: SIG }, nonceCookie(newNonce()));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "wrong domain" });
    expect(res.headers.getSetCookie().find((c) => c.startsWith("svm_nonce="))).toMatch(/;\s*Max-Age=0\b/);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("svm_session="))).toBe(false);
  });

  it("spends the nonce, says nothing about the error and logs nothing from it when verification throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // The shape of a real viem failure: the message carries the signed data and the RPC URL.
    verifySiwe.mockRejectedValue(
      new Error(`HTTP request failed. URL: https://rpc.internal/abcdef body: {"params":["${ADDR}","${SIG}"]}`),
    );
    const res = await post({ message: MESSAGE, signature: SIG }, nonceCookie(newNonce()));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "internal error" });
    // Single use on this path too: a nonce a thrown verification has spoken for is spent.
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
```

Run: `npx vitest run src/app/api/session`
Expected: FAIL — both files fail to resolve `./route`.

- [ ] **Step 10: Write the two session routes**

`src/app/api/session/nonce/route.ts`:

```ts
import { NextResponse } from "next/server";
import { NONCE_COOKIE, NONCE_TTL_SEC, newNonce, sessionSecret, signNonce } from "@/lib/session/cookie";
import { notConfigured, setCookie } from "../../_lib/session";

export const dynamic = "force-dynamic";

/** A fresh nonce and the HMAC of it, in a ten-minute cookie. The server keeps no nonce store: the cookie is the record. */
export async function GET() {
  const secret = sessionSecret();
  if (!secret) return notConfigured();
  const nonce = newNonce();
  const res = NextResponse.json({ nonce }, { headers: { "Cache-Control": "no-store" } });
  setCookie(res, NONCE_COOKIE, signNonce(nonce, secret), NONCE_TTL_SEC);
  return res;
}
```

`src/app/api/session/route.ts`:

```ts
import { NextResponse } from "next/server";
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { robinhoodChain } from "@/lib/chain";
import { NONCE_COOKIE, SESSION_COOKIE, SESSION_TTL_SEC, sessionSecret, signSession, verifyNonce } from "@/lib/session/cookie";
import { verifySiwe } from "@/lib/session/siwe";
import { nowSec } from "@/lib/time";
import { badRequest, failure, noStore, unauthorized } from "../_lib/respond";
import { clearCookie, cookieValue, notConfigured, requireSession, setCookie } from "../_lib/session";

export const dynamic = "force-dynamic";

/** Long enough for any EIP-4361 message with resources; short enough that nothing large is hashed on an unauthenticated path. */
const MAX_MESSAGE = 4096;

let client: PublicClient | null = null;
/** Only a smart account (EIP-1271 / ERC-6492) makes this client talk to the chain; an EOA signature recovers offline. */
function publicClient(): PublicClient {
  if (!client) client = createPublicClient({ chain: robinhoodChain, transport: http(process.env.ROBINHOOD_RPC_URL || undefined) });
  return client;
}

/** The domain the browser signed against. Vercel rewrites `host` to the public hostname; `req.url` is the fallback for a direct Node request. */
const hostOf = (req: Request) => req.headers.get("host") ?? new URL(req.url).host;

export async function POST(req: Request) {
  const secret = sessionSecret();
  if (!secret) return notConfigured();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("bad body");
  }
  const { message, signature } = (body ?? {}) as { message?: unknown; signature?: unknown };
  if (typeof message !== "string" || message.length === 0 || message.length > MAX_MESSAGE || typeof signature !== "string") {
    return badRequest("bad body");
  }
  const cookie = cookieValue(req.headers.get("cookie"), NONCE_COOKIE);
  const nonce = cookie ? verifyNonce(cookie, secret, nowSec()) : null;
  if (!nonce) return unauthorized("no nonce");
  try {
    const result = await verifySiwe(
      { message, signature: signature as Hex, expectedNonce: nonce, domain: hostOf(req), now: nowSec() },
      publicClient(),
    );
    // Single use either way: a nonce that has been spoken for is spent, so a wrong guess cannot be retried against it.
    if ("error" in result) {
      const res = unauthorized(result.error);
      clearCookie(res, NONCE_COOKIE);
      return res;
    }
    const iat = nowSec();
    const res = noStore({ address: result.address });
    setCookie(res, SESSION_COOKIE, signSession({ address: result.address, iat, exp: iat + SESSION_TTL_SEC }, secret), SESSION_TTL_SEC);
    clearCookie(res, NONCE_COOKIE);
    return res;
  } catch {
    // Nothing from the error is logged or answered: viem's `BaseError` messages embed the request
    // `data` — which carries the address and the signature — and sometimes the RPC URL (Global
    // Constraint 4). The nonce is spent here too, so a verification that threw cannot be retried
    // against it.
    const res = failure(new Error("sign-in verification failed"));
    clearCookie(res, NONCE_COOKIE);
    return res;
  }
}

export async function GET(req: Request) {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  return noStore({ address: session.address });
}

/** Signing out needs no key, so this works even while SESSION_SECRET is unset. */
export async function DELETE() {
  const res = new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  clearCookie(res, SESSION_COOKIE);
  clearCookie(res, NONCE_COOKIE);
  return res;
}
```

Run: `npx vitest run src/app/api/session`
Expected: PASS (nonce route 4 tests, session route 13 tests).

- [ ] **Step 11: Document the new variable and run every gate**

Append to the end of `.env.example`, after the `SYNC_INTERVAL_SEC` line. This is the **only** place
in the plan that writes this block (Ruling 17): everything below the `# Market store (server-only)`
heading is a server variable with an inline comment beside it, so the new one takes that form and
gets its own heading, and Task 6 Step 1 merely checks that the line is here.

```
# Social layer (server-only)
SESSION_SECRET=          # 32 random bytes, `openssl rand -hex 32`; unset → sign-in and user data off, reads unaffected
```

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green. `npm run build` lists `/api/session` and `/api/session/nonce` as dynamic routes (ƒ). `grep -rn "SESSION_SECRET" src` matches only `src/lib/session/cookie.ts` (once) and the four test files that stub it: nothing else reads the key.

- [ ] **Step 12: Commit**

```bash
git add src/lib/session/cookie.ts src/lib/session/cookie.test.ts src/lib/session/siwe.ts src/lib/session/siwe.test.ts \
  src/app/api/_lib/session.ts src/app/api/_lib/session.test.ts src/app/api/_lib/respond.ts src/app/api/_lib/respond.test.ts \
  src/app/api/session/route.ts src/app/api/session/route.test.ts \
  src/app/api/session/nonce/route.ts src/app/api/session/nonce/route.test.ts .env.example
git commit -m "Verify Sign-In with Ethereum and keep the wallet in an HttpOnly session cookie" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---
### Task 2: The social store — watchlist, votes, counts, the traders query and the write budget

**Files:**
- Create: `supabase/migrations/20260919000000_social.sql`, `src/lib/social/store.ts`, `src/lib/social/rateLimit.ts`
- Modify: `src/lib/types.ts` — one added type, `TraderRow`, and nothing else. `MarketsDataSource` belongs to the data-source task; this task does not touch it.
- Test: `src/lib/social/store.test.ts`, `src/lib/social/rateLimit.test.ts`
- Not modified: `src/lib/db/migrate.test.ts` asserts its table list with `expect.arrayContaining`, so two new tables do not break it.

**Interfaces:**
- Consumes: `Db` from `src/lib/db/client.ts`; `Address`, `TraderRow`, `VoteDir` from `src/lib/types.ts`; `testDb()` from `src/test/db.ts` in the test.
- Produces: `TraderRow` from `src/lib/types.ts`; `MAX_VOTE_IDS`, `VoteCount`, `watchlist`, `setWatch`, `votes`, `toggleVote`, `voteCounts`, `topTraders` and a type-only re-export of `TraderRow` from `src/lib/social/store.ts`; `WRITE_LIMIT`, `WINDOW_SEC`, `allowWrite`, `pruneRateLimit`, `resetRateLimit`, `rateLimitSize` from `src/lib/social/rateLimit.ts`. Signatures exactly as in the contract; `MAX_VOTE_IDS`, `VoteCount` and the four rate-limit extras are the additions. Task 3 consumes all of them; the traders task consumes `topTraders` and the page consumes `TraderRow`.

Decisions where the contract is silent (each one line):
- **`TraderRow` is declared in `src/lib/types.ts`, not in the store.** The `/traders` page renders it in a client component, and `src/lib/social/store.ts` starts with `import "server-only"`, so a client import of the type from there would pull the server marker into the bundle. `store.ts` re-exports the type so the contract's name still lives beside the query that produces it. Nothing else in `types.ts` changes in this task.
- **The migration is the spec's three statements verbatim** — two tables and `votes_token` — in a new file, because `20260917000000_market.sql` is frozen and `migrate()` applies whole files in name order inside one transaction each.
- **No foreign key to `market.tokens`.** A user may star a token the store has not synced yet (the token page answers from either backend), and a sync that rewrites tokens must never cascade a user's own rows away.
- **`toggleVote` runs in `db.tx`, not in one CTE.** A `delete … returning` and an `insert … on conflict` over the same primary key in a single statement is the one construction Postgres documents as unsupported ("cannot affect row a second time"); the two branches here are mutually exclusive, so the transaction is both obviously correct and free of that question. It costs one extra round trip on a write a user makes by hand.
- **`watchlist` is ordered newest first** (`created_at desc, token_id`), so the `/watchlist` page has a stable order without sorting client-side, and the tie-break keeps it deterministic when two rows share a second.
- **`voteCounts` fills zeros for every id asked about**, including ids no one has voted on, so a caller never has to distinguish "no votes" from "not in the answer".
- **`voteCounts` throws `RangeError` above `MAX_VOTE_IDS`.** The route checks the cap first and answers 400; the store's own check is what stops an internal caller from sending an unbounded array at the database.
- **`topTraders` prices with `coalesce(usd_price, 0)` and ignores feed staleness.** Dropping a stale feed to zero would empty the whole board during a Chainlink outage, and the board is a display ranking, not an execution number (Global Constraint 1 is untouched: no amount here is on an execution path).
- **`count(*)::int` and `count(distinct …)::int`.** `count()` is `int8`, which the driver hands back as a string; the cast makes both a `number` at the wire, which is what `TraderRow` promises.
- **The ordering key is a constant lookup, never interpolated user input.** `by` is already narrowed to `"volume" | "trades"` by its type, and both order clauses are written out in the module.
- **`allowWrite` counts in seconds, like every other clock in the repo** (`nowSec()`), and keeps a timestamp per write rather than a bucket, so the window really rolls rather than resetting on the minute.
- **The map prunes itself**: each call drops its own wallet's expired entries, and a sweep runs when more than 5 000 wallets are tracked. `resetRateLimit()` and `rateLimitSize()` exist for the tests, like `resetDb()`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/20260919000000_social.sql`:

```sql
-- M4 social layer (spec section 3): the two tables the app stores that are not on-chain, both keyed by the
-- wallet the session cookie proves. No foreign key to market.tokens on purpose — a user may star a token the
-- store has not synced yet, and a sync that rewrites tokens must never cascade a user's own rows away.
create table market.watchlist (
  wallet text not null,
  token_id text not null,
  created_at int not null,
  primary key (wallet, token_id)
);

create table market.votes (
  wallet text not null,
  token_id text not null,
  dir text not null check (dir in ('bull','bear')),
  updated_at int not null,
  primary key (wallet, token_id)
);

-- The public counts query groups by (token_id, dir) for up to 500 tokens at a time; this index is the whole of it.
create index votes_token on market.votes (token_id, dir);
```

Run: `npx vitest run src/lib/db/migrate.test.ts`
Expected: PASS (3 tests). The new file is applied last in name order and recorded in `market.schema_migrations`.

- [ ] **Step 2: Write the failing store test**

`src/lib/social/store.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import type { Address } from "@/lib/types";
import { testDb } from "@/test/db";
import { MAX_VOTE_IDS, setWatch, toggleVote, topTraders, voteCounts, votes, watchlist } from "./store";

const addr = (c: string) => `0x${c.repeat(40)}` as Address;
const T1 = addr("1"), T2 = addr("2"), T3 = addr("3"), T9 = addr("9");
const W1 = addr("a"), W2 = addr("b"), W3 = addr("c");
const USD = addr("d"), NOFEED = addr("e");
const POOL_1 = `0x${"1".repeat(64)}`, POOL_2 = `0x${"2".repeat(64)}`, POOL_3 = `0x${"3".repeat(64)}`;
const NOW = 1_789_000_000;
const DAY_AGO = NOW - 86_400;

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.exec("truncate market.votes, market.watchlist, market.swaps, market.pools, market.quotes");
});

const quote = (id: string, usdPrice: number | null) =>
  db.query("insert into market.quotes (id, address, symbol, name, decimals, enabled, usd_price) values ($1, $1, 'NVDA', 'NVIDIA', 18, true, $2)", [id, usdPrice]);
const pool = (id: string, tokenId: string, quoteId: string) =>
  db.query(
    `insert into market.pools (id, token_id, quote_id, token_is_currency0, hooks, fee, tick_spacing, origin, created_at, price_quote, swap_count, volume_quote_all_time, synced_at)
     values ($1, $2, $3, true, $4, 3000, 60, 'LONG', $5, 1, 0, 0, $5)`,
    [id, tokenId, quoteId, addr("0"), NOW - 200_000],
  );
const swap = (tx: string, poolId: string, tokenId: string, ts: number, wallet: string, amountQuote: number) =>
  db.query(
    `insert into market.swaps (tx_hash, log_index, pool_id, token_id, ts, side, amount_token, amount_quote, price_quote, wallet)
     values ($1, 0, $2, $3, $4, 'buy', 1, $5, 1, $6)`,
    [tx, poolId, tokenId, ts, amountQuote, wallet],
  );

/**
 * One quote priced at $100 and one with no feed at all.
 *   W1: 2 quote units on T1 and 3 on T2, both inside the day → $500 over 2 trades and 2 tokens,
 *       plus 99 units 25 hours ago that the window must not count.
 *   W2: two halves on T1 ($100) and 1000 units of the unpriced quote on T3 → $100 over 3 trades, 2 tokens.
 * So the two orderings disagree, which is the point of the `by` parameter.
 */
async function seedTrades() {
  await quote(USD, 100);
  await quote(NOFEED, null);
  await pool(POOL_1, T1, USD);
  await pool(POOL_2, T2, USD);
  await pool(POOL_3, T3, NOFEED);
  await swap("0xa1", POOL_1, T1, NOW - 100, W1, 2);
  await swap("0xa2", POOL_2, T2, NOW - 200, W1, 3);
  await swap("0xa3", POOL_1, T1, NOW - 90_000, W1, 99); // 25 hours ago: outside the window
  await swap("0xb1", POOL_1, T1, NOW - 300, W2, 0.5);
  await swap("0xb2", POOL_1, T1, NOW - 400, W2, 0.5);
  await swap("0xb3", POOL_3, T3, NOW - 500, W2, 1000); // no feed: no USD volume, still a trade
}

describe("watchlist", () => {
  it("adds, removes and is idempotent both ways", async () => {
    await setWatch(db, W1, T1, true, NOW);
    await setWatch(db, W1, T1, true, NOW + 5); // same row again: no duplicate, no error
    expect(await watchlist(db, W1)).toEqual([T1]);
    await setWatch(db, W1, T2, true, NOW + 10);
    expect(await watchlist(db, W1)).toEqual([T2, T1]); // newest first
    await setWatch(db, W1, T1, false, NOW + 20);
    await setWatch(db, W1, T1, false, NOW + 30); // removing what is gone is not an error
    expect(await watchlist(db, W1)).toEqual([T2]);
  });

  it("keeps the first created_at when the same token is starred twice", async () => {
    await setWatch(db, W1, T1, true, NOW);
    await setWatch(db, W1, T1, true, NOW + 500);
    expect(await db.query("select created_at from market.watchlist where wallet = $1", [W1])).toEqual([{ created_at: NOW }]);
  });

  it("keeps wallets apart", async () => {
    await setWatch(db, W1, T1, true, NOW);
    await setWatch(db, W2, T2, true, NOW);
    expect(await watchlist(db, W1)).toEqual([T1]);
    expect(await watchlist(db, W2)).toEqual([T2]);
    expect(await watchlist(db, W3)).toEqual([]);
  });
});

describe("votes", () => {
  it("casts, switches and clears", async () => {
    expect(await toggleVote(db, W1, T1, "bull", NOW)).toBe("bull");
    expect(await votes(db, W1)).toEqual({ [T1]: "bull" });
    expect(await toggleVote(db, W1, T1, "bear", NOW + 1)).toBe("bear"); // the other direction switches
    expect(await votes(db, W1)).toEqual({ [T1]: "bear" });
    expect(await toggleVote(db, W1, T1, "bear", NOW + 2)).toBeNull(); // the same direction clears
    expect(await votes(db, W1)).toEqual({});
    expect(await toggleVote(db, W1, T1, "bear", NOW + 3)).toBe("bear"); // and casts again
  });

  it("stamps updated_at on every write", async () => {
    await toggleVote(db, W1, T1, "bull", NOW);
    await toggleVote(db, W1, T1, "bear", NOW + 77);
    expect(await db.query("select dir, updated_at from market.votes where wallet = $1", [W1])).toEqual([{ dir: "bear", updated_at: NOW + 77 }]);
  });

  it("keeps one vote per wallet per token and answers the whole map", async () => {
    await toggleVote(db, W1, T1, "bull", NOW);
    await toggleVote(db, W1, T2, "bear", NOW);
    await toggleVote(db, W2, T1, "bear", NOW);
    expect(await votes(db, W1)).toEqual({ [T1]: "bull", [T2]: "bear" });
    expect(await votes(db, W2)).toEqual({ [T1]: "bear" });
    expect(await votes(db, W3)).toEqual({});
  });
});

describe("voteCounts", () => {
  it("counts both directions per token and answers zeros for the rest", async () => {
    await toggleVote(db, W1, T1, "bull", NOW);
    await toggleVote(db, W2, T1, "bull", NOW);
    await toggleVote(db, W3, T1, "bear", NOW);
    await toggleVote(db, W1, T2, "bear", NOW);
    expect(await voteCounts(db, [T1, T2, T9])).toEqual({
      [T1]: { bull: 2, bear: 1 },
      [T2]: { bull: 0, bear: 1 },
      [T9]: { bull: 0, bear: 0 },
    });
  });

  it("answers an empty map for no ids and never queries a token it was not asked about", async () => {
    await toggleVote(db, W1, T1, "bull", NOW);
    expect(await voteCounts(db, [])).toEqual({});
    expect(await voteCounts(db, [T2])).toEqual({ [T2]: { bull: 0, bear: 0 } });
  });

  it("serves the full page of ids and refuses more", async () => {
    const ids = Array.from({ length: MAX_VOTE_IDS }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    expect(Object.keys(await voteCounts(db, ids))).toHaveLength(MAX_VOTE_IDS);
    await expect(voteCounts(db, [...ids, T1])).rejects.toThrow(RangeError);
  });
});

describe("topTraders", () => {
  it("ranks by USD volume, converting through each pool's quote price", async () => {
    await seedTrades();
    expect(await topTraders(db, { sinceTs: DAY_AGO, by: "volume", limit: 50 })).toEqual([
      { wallet: W1, volumeUsd: 500, trades: 2, tokens: 2 },
      { wallet: W2, volumeUsd: 100, trades: 3, tokens: 2 },
    ]);
  });

  it("ranks by trade count, which puts the other wallet first", async () => {
    await seedTrades();
    expect((await topTraders(db, { sinceTs: DAY_AGO, by: "trades", limit: 50 })).map((r) => r.wallet)).toEqual([W2, W1]);
  });

  it("counts a trade in an unpriced quote asset without inventing volume for it", async () => {
    await seedTrades();
    const [, second] = await topTraders(db, { sinceTs: DAY_AGO, by: "volume", limit: 50 });
    expect(second).toEqual({ wallet: W2, volumeUsd: 100, trades: 3, tokens: 2 }); // the 1000-unit trade added a trade and a token, no dollars
  });

  it("obeys the window and the limit", async () => {
    await seedTrades();
    // NOW − 150 keeps only `0xa1` (NOW − 100). W1's second trade sits at NOW − 200 and W2's
    // earliest at NOW − 300, so both fall outside — which is the exclusion this case is for.
    // (NOW − 250 would still have caught `0xa2`: the window is `ts >= sinceTs`.)
    expect(await topTraders(db, { sinceTs: NOW - 150, by: "volume", limit: 50 })).toEqual([{ wallet: W1, volumeUsd: 200, trades: 1, tokens: 1 }]);
    // The boundary is inclusive: asking from exactly the second `0xa2` was written in keeps it.
    expect(await topTraders(db, { sinceTs: NOW - 200, by: "volume", limit: 50 })).toEqual([{ wallet: W1, volumeUsd: 500, trades: 2, tokens: 2 }]);
    expect(await topTraders(db, { sinceTs: DAY_AGO, by: "volume", limit: 1 })).toHaveLength(1);
    expect(await topTraders(db, { sinceTs: NOW + 1, by: "volume", limit: 50 })).toEqual([]);
  });

  it("breaks a tie by wallet, so the board never reshuffles between reads", async () => {
    await quote(USD, 100);
    await pool(POOL_1, T1, USD);
    await swap("0xc1", POOL_1, T1, NOW - 10, W3, 1);
    await swap("0xc2", POOL_1, T1, NOW - 10, W2, 1);
    await swap("0xc3", POOL_1, T1, NOW - 10, W1, 1);
    for (const by of ["volume", "trades"] as const) {
      expect((await topTraders(db, { sinceTs: DAY_AGO, by, limit: 50 })).map((r) => r.wallet)).toEqual([W1, W2, W3]);
    }
  });

  it("answers nothing at all when no one has traded", async () => {
    expect(await topTraders(db, { sinceTs: DAY_AGO, by: "volume", limit: 50 })).toEqual([]);
  });
});
```

Run: `npx vitest run src/lib/social/store.test.ts`
Expected: FAIL — `Failed to resolve import "./store"`.

- [ ] **Step 3: Declare `TraderRow` in `src/lib/types.ts`, then write `src/lib/social/store.ts`**

Append to the end of `src/lib/types.ts`:

```ts
/**
 * One row of the top-traders board (M4 spec section 4): a wallet's last-24h volume in USD, its trade
 * count and the number of distinct tokens it traded. It lives here rather than in
 * `src/lib/social/store.ts`, which is `server-only`, because the `/traders` page renders these rows in
 * a client component.
 *
 * This is the **only** declaration of the type in the plan (Ruling 5): Task 5 adds `TradersBy` beside
 * it and the `traders` method to `MarketsDataSource`, and re-declares nothing.
 */
export interface TraderRow {
  wallet: Address;
  /**
   * Display only: the 24-hour volume already converted through the pool's quote asset and its USD
   * price. Never an execution amount, so a float is the right shape for it (Global Constraint 1
   * governs amounts the chain will see; this one it never does).
   */
  volumeUsd: number;
  trades: number;
  /** Distinct tokens this wallet traded in the window. */
  tokens: number;
}
```

`src/lib/social/store.ts`:

```ts
import "server-only";
import type { Db } from "@/lib/db/client";
import type { Address, TraderRow, VoteDir } from "@/lib/types";

export type VoteCount = { bull: number; bear: number };
/** The board's row type is declared in `types.ts` (the page is a client component); the name still lives beside the query that fills it. */
export type { TraderRow } from "@/lib/types";

/** The public counts route's cap, and the most ids one grouped query is ever asked for. */
export const MAX_VOTE_IDS = 500;

const WATCHLIST_SQL = "select token_id from market.watchlist where wallet = $1 order by created_at desc, token_id";
const ADD_WATCH_SQL = "insert into market.watchlist (wallet, token_id, created_at) values ($1, $2, $3) on conflict (wallet, token_id) do nothing";
const DROP_WATCH_SQL = "delete from market.watchlist where wallet = $1 and token_id = $2";
const VOTES_SQL = "select token_id, dir from market.votes where wallet = $1";
const CLEAR_VOTE_SQL = "delete from market.votes where wallet = $1 and token_id = $2 and dir = $3 returning dir";
const CAST_VOTE_SQL = `insert into market.votes (wallet, token_id, dir, updated_at) values ($1, $2, $3, $4)
  on conflict (wallet, token_id) do update set dir = excluded.dir, updated_at = excluded.updated_at returning dir`;
const COUNTS_SQL = "select token_id, dir, count(*)::int as n from market.votes where token_id = any($1::text[]) group by token_id, dir";
/**
 * `amount_quote` is denominated in the pool's quote asset, so each row is priced through that asset's feed.
 * `coalesce(usd_price, 0)`: a quote with no feed (or none yet) contributes no dollars and still counts as a
 * trade, which is honest — the alternative, dropping those rows, would hide a wallet's activity entirely.
 */
const TRADERS_SQL = (order: string) => `select s.wallet, sum(s.amount_quote * coalesce(q.usd_price, 0)) as volume_usd,
  count(*)::int as trades, count(distinct s.token_id)::int as tokens
  from market.swaps s join market.pools p on p.id = s.pool_id join market.quotes q on q.id = p.quote_id
  where s.ts >= $1 group by s.wallet order by ${order} limit $2`;
/** Not user input: `by` is a two-value union and both clauses are written out here. The wallet tie-break keeps the board stable between reads. */
const TRADERS_ORDER: Record<"volume" | "trades", string> = {
  volume: "volume_usd desc, s.wallet",
  trades: "trades desc, s.wallet",
};

/** The wallet's starred token ids, newest first. */
export async function watchlist(db: Db, wallet: string): Promise<string[]> {
  const rows = await db.query<{ token_id: string }>(WATCHLIST_SQL, [wallet]);
  return rows.map((r) => r.token_id);
}

/** Idempotent both ways: starring twice keeps the first `created_at`, unstarring what is gone is a no-op. */
export async function setWatch(db: Db, wallet: string, tokenId: string, on: boolean, now: number): Promise<void> {
  if (on) await db.query(ADD_WATCH_SQL, [wallet, tokenId, now]);
  else await db.query(DROP_WATCH_SQL, [wallet, tokenId]);
}

export async function votes(db: Db, wallet: string): Promise<Record<string, VoteDir>> {
  const rows = await db.query<{ token_id: string; dir: VoteDir }>(VOTES_SQL, [wallet]);
  return Object.fromEntries(rows.map((r) => [r.token_id, r.dir]));
}

/**
 * The toggle the app already has: the same direction clears the vote and answers null, the other switches it.
 * One transaction rather than one statement — a `delete … returning` and an `insert … on conflict` over the same
 * primary key in a single statement is the case Postgres documents as unsupported, and the two branches here are
 * mutually exclusive anyway, so this is the same atomicity without that question.
 */
export async function toggleVote(db: Db, wallet: string, tokenId: string, dir: VoteDir, now: number): Promise<VoteDir | null> {
  return db.tx(async (t) => {
    const cleared = await t.query<{ dir: VoteDir }>(CLEAR_VOTE_SQL, [wallet, tokenId, dir]);
    if (cleared.length > 0) return null;
    const cast = await t.query<{ dir: VoteDir }>(CAST_VOTE_SQL, [wallet, tokenId, dir, now]);
    return cast[0]?.dir ?? dir;
  });
}

/** One grouped query for up to `MAX_VOTE_IDS` tokens. Every id asked about is in the answer, zeroed when nobody has voted. */
export async function voteCounts(db: Db, tokenIds: readonly string[]): Promise<Record<string, VoteCount>> {
  if (tokenIds.length > MAX_VOTE_IDS) throw new RangeError(`voteCounts takes at most ${MAX_VOTE_IDS} ids`);
  const out: Record<string, VoteCount> = {};
  for (const id of tokenIds) out[id] = { bull: 0, bear: 0 };
  if (tokenIds.length === 0) return out;
  const rows = await db.query<{ token_id: string; dir: VoteDir; n: number }>(COUNTS_SQL, [tokenIds]);
  for (const row of rows) {
    const count = out[row.token_id];
    if (count) count[row.dir] = Number(row.n);
  }
  return out;
}

/** The traders board: one grouped scan of `market.swaps` since `sinceTs`, priced through each pool's quote asset. */
export async function topTraders(db: Db, opts: { sinceTs: number; by: "volume" | "trades"; limit: number }): Promise<TraderRow[]> {
  const rows = await db.query<{ wallet: string; volume_usd: number | null; trades: number; tokens: number }>(
    TRADERS_SQL(TRADERS_ORDER[opts.by]),
    [opts.sinceTs, opts.limit],
  );
  return rows.map((r) => ({ wallet: r.wallet as Address, volumeUsd: r.volume_usd ?? 0, trades: r.trades, tokens: r.tokens }));
}
```

Run: `npx vitest run src/lib/social/store.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 4: Write the failing rate-limit test**

`src/lib/social/rateLimit.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { WINDOW_SEC, WRITE_LIMIT, allowWrite, pruneRateLimit, rateLimitSize, resetRateLimit } from "./rateLimit";

const NOW = 1_789_000_000;
const W1 = `0x${"a".repeat(40)}`;
const W2 = `0x${"b".repeat(40)}`;

beforeEach(() => resetRateLimit());

describe("allowWrite", () => {
  it("allows sixty writes a minute and refuses the sixty-first", () => {
    expect(WRITE_LIMIT).toBe(60);
    expect(WINDOW_SEC).toBe(60);
    for (let i = 0; i < WRITE_LIMIT; i++) expect(allowWrite(W1, NOW)).toBe(true);
    expect(allowWrite(W1, NOW)).toBe(false);
    expect(allowWrite(W1, NOW)).toBe(false); // a refusal does not consume budget of its own
  });

  it("stays refused until the window has actually rolled past those writes", () => {
    for (let i = 0; i < WRITE_LIMIT; i++) allowWrite(W1, NOW);
    expect(allowWrite(W1, NOW + WINDOW_SEC - 1)).toBe(false);
    expect(allowWrite(W1, NOW + WINDOW_SEC)).toBe(true);
  });

  it("rolls rather than resetting: an old write leaving the window frees exactly one slot", () => {
    allowWrite(W1, NOW);
    for (let i = 1; i < WRITE_LIMIT; i++) allowWrite(W1, NOW + 30);
    expect(allowWrite(W1, NOW + 30)).toBe(false);
    expect(allowWrite(W1, NOW + 60)).toBe(true); // only the first write has aged out
    expect(allowWrite(W1, NOW + 60)).toBe(false);
  });

  it("counts every wallet on its own", () => {
    for (let i = 0; i < WRITE_LIMIT; i++) allowWrite(W1, NOW);
    expect(allowWrite(W1, NOW)).toBe(false);
    expect(allowWrite(W2, NOW)).toBe(true);
  });
});

describe("pruning", () => {
  it("forgets a wallet whose window has emptied and keeps one that is still inside it", () => {
    allowWrite(W1, NOW);
    allowWrite(W2, NOW + 40);
    expect(rateLimitSize()).toBe(2);
    pruneRateLimit(NOW + 61);
    expect(rateLimitSize()).toBe(1);
    pruneRateLimit(NOW + 200);
    expect(rateLimitSize()).toBe(0);
  });

  it("sweeps itself once it is tracking more wallets than it should", () => {
    for (let i = 0; i <= 5_000; i++) allowWrite(`0x${i.toString(16).padStart(40, "0")}`, NOW);
    expect(rateLimitSize()).toBe(5_001);
    expect(allowWrite(W1, NOW + WINDOW_SEC + 1)).toBe(true);
    expect(rateLimitSize()).toBe(1); // every wallet from the first minute is gone
  });
});
```

Run: `npx vitest run src/lib/social/rateLimit.test.ts`
Expected: FAIL — `Failed to resolve import "./rateLimit"`.

- [ ] **Step 5: Write `src/lib/social/rateLimit.ts`**

```ts
/**
 * A per-wallet write budget, counted in this process only: another serverless instance keeps its own
 * map, so the real ceiling is the cap times the number of live instances. That is deliberate for M4
 * (spec section 3) — it bounds a single client's runaway loop, and M5 verifies rate limiting under
 * load properly. Nothing here is a security control.
 */
export const WRITE_LIMIT = 60;
export const WINDOW_SEC = 60;

/** Above this many tracked wallets, one sweep drops every wallet whose window has emptied. */
const SWEEP_AT = 5_000;

const hits = new Map<string, number[]>();

/** true when this write fits the wallet's last rolling minute, and counts it; false when it does not. */
export function allowWrite(wallet: string, now: number): boolean {
  const since = now - WINDOW_SEC;
  const kept = (hits.get(wallet) ?? []).filter((t) => t > since);
  if (kept.length >= WRITE_LIMIT) {
    hits.set(wallet, kept);
    return false;
  }
  kept.push(now);
  hits.set(wallet, kept);
  if (hits.size > SWEEP_AT) pruneRateLimit(now);
  return true;
}

/** Drops every wallet with nothing left inside the window. Called automatically when the map grows; exported so a caller can sweep on demand. */
export function pruneRateLimit(now: number): void {
  const since = now - WINDOW_SEC;
  for (const [wallet, times] of hits) {
    const kept = times.filter((t) => t > since);
    if (kept.length === 0) hits.delete(wallet);
    else hits.set(wallet, kept);
  }
}

/** Tests only: forget every wallet. */
export function resetRateLimit(): void {
  hits.clear();
}

/** Tests only: how many wallets are currently tracked. */
export function rateLimitSize(): number {
  return hits.size;
}
```

Run: `npx vitest run src/lib/social/rateLimit.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Run every gate**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green. `grep -rn "market.votes\|market.watchlist" src` matches only `src/lib/social/store.ts` and its test: no other module writes those tables.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260919000000_social.sql src/lib/types.ts \
  src/lib/social/store.ts src/lib/social/store.test.ts \
  src/lib/social/rateLimit.ts src/lib/social/rateLimit.test.ts
git commit -m "Store watchlists and votes in the market store, rank traders from its swaps" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---
### Task 3: The user routes, the public counts route and the counts merge

**Files:**
- Create: `src/app/api/me/watchlist/route.ts`, `src/app/api/me/watchlist/[address]/route.ts`, `src/app/api/me/votes/route.ts`, `src/app/api/me/votes/[address]/route.ts`, `src/app/api/votes/route.ts`, `src/app/api/_lib/counts.ts`, `src/test/session.ts` (test helper, like `src/test/db.ts`)
- Modify: `src/app/api/pairs/route.ts` (one line), `src/app/api/tokens/[address]/route.ts` (two lines)
- Test: `src/app/api/me/watchlist/route.test.ts`, `src/app/api/me/watchlist/[address]/route.test.ts`, `src/app/api/me/votes/route.test.ts`, `src/app/api/me/votes/[address]/route.test.ts`, `src/app/api/votes/route.test.ts`, `src/app/api/_lib/counts.test.ts`, `src/app/api/pairs/route.test.ts` (new: the route had none), `src/app/api/tokens/[address]/route.test.ts` (one new `describe`)

**Interfaces:**
- Consumes: `requireSession` from `src/app/api/_lib/session.ts` and `badRequest`, `cached`, `failure`, `isAddress`, `noStore`, `tooManyRequests` from `src/app/api/_lib/respond.ts` (Task 1); `MAX_VOTE_IDS`, `VoteCount`, `setWatch`, `toggleVote`, `voteCounts`, `votes`, `watchlist` from `src/lib/social/store.ts` and `allowWrite`, `resetRateLimit`, `rateLimitSize`, `WRITE_LIMIT` from `src/lib/social/rateLimit.ts` (Task 2); `getDb`, `hasDb`, `Db` from `src/lib/db/client.ts`; `ttlCache`, `clearTtlCache` from `src/lib/envio/cache.ts`; `getBackend` from `src/lib/market/backend.ts`; `PAIRS_TTL`, `PairsScope` from `src/lib/envio/pairs.ts`; `nowSec` from `src/lib/time.ts`; `TokenPair`, `VoteDir`, `Address` from `src/lib/types.ts`; `testDb()` from `src/test/db.ts` in the tests.
- Produces: `VOTES_TTL`, `voteCountsFor`, `withVoteCounts` from `src/app/api/_lib/counts.ts`; `TEST_SESSION_SECRET`, `sessionHeader` from `src/test/session.ts`; `GET` from `src/app/api/me/watchlist/route.ts`, `src/app/api/me/votes/route.ts` and `src/app/api/votes/route.ts`; `PUT`, `DELETE` from `src/app/api/me/watchlist/[address]/route.ts`; `POST` from `src/app/api/me/votes/[address]/route.ts`. The routes answer exactly the shapes in the contract.

Decisions where the contract is silent (each one line):
- **Order inside a write route is session → budget → address → store**, in that order: a wallet that floods malformed writes still spends its own budget, and a request with no session spends nothing because it never reaches the counter.
- **Every `me` answer is `no-store`.** One wallet's watchlist must never be held by a CDN, a browser cache or a shared proxy; `noStore` is the only answer helper these routes use.
- **`withVoteCounts` leaves the pairs untouched when there is no database.** Both backends already shape `bull` and `bear` as `0` (`src/lib/market/dbShape.ts`, `src/lib/envio/shape.ts`), so "zeros otherwise" is already true and the merge only ever fills in real numbers.
- **The merge copies, never mutates.** `ttlCache` hands every caller the same object, so writing counts into a cached `TokenPair` would poison the pairs memo for the next 30 seconds; each merged pair is a fresh spread.
- **The merge cannot fail a read.** A store outage inside `withVoteCounts` is logged by error name only (a driver error carries the connection string) and the pairs are answered with the zeros they already had — the counts are an ornament on a market table that must render regardless.
- **The counts memo is its own 30-second `ttlCache` entry, keyed by the sorted id list**, so the pairs cache stays backend-agnostic and the public counts route and the merge share one entry when they ask about the same tokens. The key is the joined list: `ttlCache` never evicts, so a caller sending many distinct id sets grows the map — bounded in practice by `MAX_VOTE_IDS` per entry and revisited in M5 along with the rest of the rate limiting.
- **`/api/votes` lowercases each id and then validates it**, exactly as the token route lowercases its path segment, so a checksummed id is accepted and the answer is always keyed by the lowercase id the store uses. Ids are de-duplicated before the cap is applied.
- **`/api/votes` answers zeros rather than 503 without a database**, matching the merge: the client renders `0 / 0` instead of an error banner, and the spec's "without a database they stay 0" holds on every path.
- **`src/test/session.ts` is a test helper with no test of its own**, like `src/test/db.ts` and `src/lib/sync/testRows.ts`. Task 1's own tests deliberately do not use it: they pin the cookie format by writing it out.
- **The route tests run against a real PGlite store** through a hoisted holder that replaces `getDb`/`hasDb`, rather than mocking the store functions: the success paths are then genuine round trips, and `vi.hoisted` keeps the holder visible to the `vi.mock` factory.

- [ ] **Step 1: Write the failing watchlist route tests**

`src/test/session.ts`:

```ts
import { SESSION_COOKIE, SESSION_TTL_SEC, signSession } from "@/lib/session/cookie";
import { nowSec } from "@/lib/time";
import type { Address } from "@/lib/types";

/** 32 characters, the minimum `sessionSecret()` accepts. It exists only in the suite and protects nothing. */
export const TEST_SESSION_SECRET = "0123456789abcdef0123456789abcdef";

/** A `Cookie` header carrying a valid session for `wallet`. */
export function sessionHeader(wallet: Address, over: Partial<{ iat: number; exp: number }> = {}): string {
  const iat = over.iat ?? nowSec();
  return `${SESSION_COOKIE}=${signSession({ address: wallet, iat, exp: over.exp ?? iat + SESSION_TTL_SEC }, TEST_SESSION_SECRET)}`;
}
```

`src/app/api/me/watchlist/route.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { setWatch } from "@/lib/social/store";
import { testDb } from "@/test/db";
import { TEST_SESSION_SECRET, sessionHeader } from "@/test/session";
import type { Address } from "@/lib/types";
import { GET } from "./route";

const { holder } = vi.hoisted(() => ({ holder: { db: null as Db | null } }));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, hasDb: () => holder.db !== null, getDb: () => holder.db as Db };
});

const WALLET = `0x${"a".repeat(40)}` as Address;
const OTHER = `0x${"b".repeat(40)}` as Address;
const T1 = `0x${"1".repeat(40)}`;
const T2 = `0x${"2".repeat(40)}`;
const NOW = 1_789_000_000;

let db: Db;
beforeAll(async () => {
  db = await testDb();
  holder.db = db;
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", TEST_SESSION_SECRET);
  await db.exec("truncate market.watchlist");
});
afterEach(() => vi.unstubAllEnvs());

const call = (cookie?: string) =>
  GET(new Request("http://localhost:3000/api/me/watchlist", { headers: cookie ? { cookie } : {} }));

describe("GET /api/me/watchlist", () => {
  it("answers 401 without a session cookie", async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ error: "not signed in" });
  });

  it("answers 503 while SESSION_SECRET is unset", async () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    const res = await call(sessionHeader(WALLET));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "sessions not configured" });
  });

  it("answers the signed-in wallet's own list, newest first, and never another wallet's", async () => {
    await setWatch(db, WALLET, T1, true, NOW);
    await setWatch(db, WALLET, T2, true, NOW + 10);
    await setWatch(db, OTHER, T1, true, NOW);
    const res = await call(sessionHeader(WALLET));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual([T2, T1]);
    await expect((await call(sessionHeader(OTHER))).json()).resolves.toEqual([T1]);
  });

  it("answers an empty list for a wallet that has starred nothing", async () => {
    await expect((await call(sessionHeader(WALLET))).json()).resolves.toEqual([]);
  });
});
```

`src/app/api/me/watchlist/[address]/route.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { WRITE_LIMIT, rateLimitSize, resetRateLimit } from "@/lib/social/rateLimit";
import { watchlist } from "@/lib/social/store";
import type { Address } from "@/lib/types";
import { testDb } from "@/test/db";
import { TEST_SESSION_SECRET, sessionHeader } from "@/test/session";
import { DELETE, PUT } from "./route";

const { holder } = vi.hoisted(() => ({ holder: { db: null as Db | null } }));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, hasDb: () => holder.db !== null, getDb: () => holder.db as Db };
});

const WALLET = `0x${"a".repeat(40)}` as Address;
const T1 = `0x${"1".repeat(40)}`;
const MIXED = `0x${"A".repeat(40)}`;

let db: Db;
beforeAll(async () => {
  db = await testDb();
  holder.db = db;
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", TEST_SESSION_SECRET);
  resetRateLimit();
  await db.exec("truncate market.watchlist");
});
afterEach(() => vi.unstubAllEnvs());

const req = (address: string, cookie?: string) =>
  [
    new Request(`http://localhost:3000/api/me/watchlist/${address}`, { method: "PUT", headers: cookie ? { cookie } : {} }),
    { params: Promise.resolve({ address }) },
  ] as const;
const put = (address: string, cookie?: string) => PUT(...req(address, cookie));
const del = (address: string, cookie?: string) => DELETE(...req(address, cookie));

describe("PUT|DELETE /api/me/watchlist/[address]", () => {
  it("answers 401 without a session and spends no budget", async () => {
    expect((await put(T1)).status).toBe(401);
    expect((await del(T1)).status).toBe(401);
    expect(rateLimitSize()).toBe(0);
  });

  it("answers 503 while SESSION_SECRET is unset", async () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    expect((await put(T1, sessionHeader(WALLET))).status).toBe(503);
  });

  it("adds and removes, idempotently, answering 204 each time", async () => {
    for (const res of [await put(T1, sessionHeader(WALLET)), await put(T1, sessionHeader(WALLET))]) {
      expect(res.status).toBe(204);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      await expect(res.text()).resolves.toBe("");
    }
    expect(await watchlist(db, WALLET)).toEqual([T1]);
    expect((await del(T1, sessionHeader(WALLET))).status).toBe(204);
    expect((await del(T1, sessionHeader(WALLET))).status).toBe(204);
    expect(await watchlist(db, WALLET)).toEqual([]);
  });

  it("lowercases the path segment, so a checksummed address stars the same token", async () => {
    expect((await put(MIXED, sessionHeader(WALLET))).status).toBe(204);
    expect(await watchlist(db, WALLET)).toEqual([MIXED.toLowerCase()]);
  });

  it("answers 400 for anything that is not an address", async () => {
    for (const bad of ["not-an-address", "0x1234", `0x${"1".repeat(41)}`, `0x${"z".repeat(40)}`]) {
      const res = await put(bad, sessionHeader(WALLET));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "bad address" });
    }
    expect(await watchlist(db, WALLET)).toEqual([]);
  });

  it("answers 429 on the sixty-first write of a minute, before it even looks at the address", async () => {
    for (let i = 0; i < WRITE_LIMIT; i++) expect((await put(T1, sessionHeader(WALLET))).status).toBe(204);
    const res = await put(T1, sessionHeader(WALLET));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.text()).resolves.toBe("too many requests");
    expect((await put("not-an-address", sessionHeader(WALLET))).status).toBe(429); // the budget is checked first
  });
});
```

Run: `npx vitest run src/app/api/me/watchlist`
Expected: FAIL — both files fail to resolve `./route`.

- [ ] **Step 2: Write the two watchlist routes**

`src/app/api/me/watchlist/route.ts`:

```ts
import { getDb } from "@/lib/db/client";
import { watchlist } from "@/lib/social/store";
import { failure, noStore } from "../../_lib/respond";
import { requireSession } from "../../_lib/session";

export const dynamic = "force-dynamic";

/** The signed-in wallet's starred token ids. The client never sends an address: the cookie is the identity. */
export async function GET(req: Request) {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  try {
    return noStore(await watchlist(getDb(), session.address));
  } catch (err) {
    return failure(err);
  }
}
```

`src/app/api/me/watchlist/[address]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { allowWrite } from "@/lib/social/rateLimit";
import { setWatch } from "@/lib/social/store";
import { nowSec } from "@/lib/time";
import { badRequest, failure, isAddress, tooManyRequests } from "../../../_lib/respond";
import { requireSession } from "../../../_lib/session";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ address: string }> };

/**
 * Session, then budget, then address, then the store. The budget is spent before the address is
 * checked on purpose: a client looping malformed writes is exactly what the cap is for. A request
 * with no session never reaches the counter, so nobody can spend another wallet's budget.
 */
async function write(req: Request, ctx: Ctx, on: boolean) {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const now = nowSec();
  if (!allowWrite(session.address, now)) return tooManyRequests();
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  if (!isAddress(id)) return badRequest("bad address");
  try {
    await setWatch(getDb(), session.address, id, on, now);
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return failure(err);
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  return write(req, ctx, true);
}

export async function DELETE(req: Request, ctx: Ctx) {
  return write(req, ctx, false);
}
```

Run: `npx vitest run src/app/api/me/watchlist`
Expected: PASS (4 + 6 tests).

- [ ] **Step 3: Write the failing votes route tests**

`src/app/api/me/votes/route.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { toggleVote } from "@/lib/social/store";
import type { Address } from "@/lib/types";
import { testDb } from "@/test/db";
import { TEST_SESSION_SECRET, sessionHeader } from "@/test/session";
import { GET } from "./route";

const { holder } = vi.hoisted(() => ({ holder: { db: null as Db | null } }));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, hasDb: () => holder.db !== null, getDb: () => holder.db as Db };
});

const WALLET = `0x${"a".repeat(40)}` as Address;
const OTHER = `0x${"b".repeat(40)}` as Address;
const T1 = `0x${"1".repeat(40)}`;
const T2 = `0x${"2".repeat(40)}`;
const NOW = 1_789_000_000;

let db: Db;
beforeAll(async () => {
  db = await testDb();
  holder.db = db;
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", TEST_SESSION_SECRET);
  await db.exec("truncate market.votes");
});
afterEach(() => vi.unstubAllEnvs());

const call = (cookie?: string) => GET(new Request("http://localhost:3000/api/me/votes", { headers: cookie ? { cookie } : {} }));

describe("GET /api/me/votes", () => {
  it("answers 401 without a session cookie", async () => {
    expect((await call()).status).toBe(401);
  });

  it("answers 503 while SESSION_SECRET is unset", async () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    expect((await call(sessionHeader(WALLET))).status).toBe(503);
  });

  it("answers the wallet's own direction per token and nobody else's", async () => {
    await toggleVote(db, WALLET, T1, "bull", NOW);
    await toggleVote(db, WALLET, T2, "bear", NOW);
    await toggleVote(db, OTHER, T1, "bear", NOW);
    const res = await call(sessionHeader(WALLET));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ [T1]: "bull", [T2]: "bear" });
    await expect((await call(sessionHeader(OTHER))).json()).resolves.toEqual({ [T1]: "bear" });
  });

  it("answers an empty map for a wallet that has never voted", async () => {
    await expect((await call(sessionHeader(WALLET))).json()).resolves.toEqual({});
  });
});
```

`src/app/api/me/votes/[address]/route.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { WRITE_LIMIT, allowWrite, rateLimitSize, resetRateLimit } from "@/lib/social/rateLimit";
import { votes } from "@/lib/social/store";
import { nowSec } from "@/lib/time";
import type { Address } from "@/lib/types";
import { testDb } from "@/test/db";
import { TEST_SESSION_SECRET, sessionHeader } from "@/test/session";
import { POST } from "./route";

const { holder } = vi.hoisted(() => ({ holder: { db: null as Db | null } }));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, hasDb: () => holder.db !== null, getDb: () => holder.db as Db };
});

const WALLET = `0x${"a".repeat(40)}` as Address;
const T1 = `0x${"1".repeat(40)}`;
const MIXED = `0x${"A".repeat(40)}`;

let db: Db;
beforeAll(async () => {
  db = await testDb();
  holder.db = db;
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", TEST_SESSION_SECRET);
  resetRateLimit();
  await db.exec("truncate market.votes");
});
afterEach(() => vi.unstubAllEnvs());

const post = (address: string, body: unknown, cookie?: string) =>
  POST(
    new Request(`http://localhost:3000/api/me/votes/${address}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ address }) },
  );

describe("POST /api/me/votes/[address]", () => {
  it("answers 401 without a session and spends no budget", async () => {
    expect((await post(T1, { dir: "bull" })).status).toBe(401);
    expect(rateLimitSize()).toBe(0);
  });

  it("answers 503 while SESSION_SECRET is unset", async () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    expect((await post(T1, { dir: "bull" }, sessionHeader(WALLET))).status).toBe(503);
  });

  it("casts, switches and clears, answering the new direction each time", async () => {
    const cast = await post(T1, { dir: "bull" }, sessionHeader(WALLET));
    expect(cast.status).toBe(200);
    expect(cast.headers.get("Cache-Control")).toBe("no-store");
    await expect(cast.json()).resolves.toEqual({ dir: "bull" });
    await expect((await post(T1, { dir: "bear" }, sessionHeader(WALLET))).json()).resolves.toEqual({ dir: "bear" });
    await expect((await post(T1, { dir: "bear" }, sessionHeader(WALLET))).json()).resolves.toEqual({ dir: null });
    expect(await votes(db, WALLET)).toEqual({});
  });

  it("lowercases the path segment", async () => {
    await post(MIXED, { dir: "bull" }, sessionHeader(WALLET));
    expect(await votes(db, WALLET)).toEqual({ [MIXED.toLowerCase()]: "bull" });
  });

  it("answers 400 for a bad address, a body that is not JSON and a direction that is not bull or bear", async () => {
    await expect((await post("nope", { dir: "bull" }, sessionHeader(WALLET))).json()).resolves.toEqual({ error: "bad address" });
    await expect((await post(T1, "not json", sessionHeader(WALLET))).json()).resolves.toEqual({ error: "bad body" });
    for (const body of [{}, { dir: "up" }, { dir: 1 }, null]) {
      const res = await post(T1, body, sessionHeader(WALLET));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "bad direction" });
    }
    expect(await votes(db, WALLET)).toEqual({});
  });

  it("answers 429 once the wallet's minute is spent, and casts no vote", async () => {
    for (let i = 0; i < WRITE_LIMIT; i++) allowWrite(WALLET, nowSec());
    const res = await post(T1, { dir: "bull" }, sessionHeader(WALLET));
    expect(res.status).toBe(429);
    await expect(res.text()).resolves.toBe("too many requests");
    expect(await votes(db, WALLET)).toEqual({});
  });
});
```

Run: `npx vitest run src/app/api/me/votes`
Expected: FAIL — both files fail to resolve `./route`.

- [ ] **Step 4: Write the two votes routes**

`src/app/api/me/votes/route.ts`:

```ts
import { getDb } from "@/lib/db/client";
import { votes } from "@/lib/social/store";
import { failure, noStore } from "../../_lib/respond";
import { requireSession } from "../../_lib/session";

export const dynamic = "force-dynamic";

/** The signed-in wallet's own direction per token, so the token page renders the voted state after a reload. */
export async function GET(req: Request) {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  try {
    return noStore(await votes(getDb(), session.address));
  } catch (err) {
    return failure(err);
  }
}
```

`src/app/api/me/votes/[address]/route.ts`:

```ts
import { getDb } from "@/lib/db/client";
import { allowWrite } from "@/lib/social/rateLimit";
import { toggleVote } from "@/lib/social/store";
import { nowSec } from "@/lib/time";
import { badRequest, failure, isAddress, noStore, tooManyRequests } from "../../../_lib/respond";
import { requireSession } from "../../../_lib/session";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ address: string }> };

/** The toggle the app already has: the same direction clears, the other switches. Answers the new direction, or null. */
export async function POST(req: Request, ctx: Ctx) {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const now = nowSec();
  if (!allowWrite(session.address, now)) return tooManyRequests();
  const { address } = await ctx.params;
  const id = address.toLowerCase();
  if (!isAddress(id)) return badRequest("bad address");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("bad body");
  }
  const dir = (body as { dir?: unknown } | null)?.dir;
  if (dir !== "bull" && dir !== "bear") return badRequest("bad direction");
  try {
    return noStore({ dir: await toggleVote(getDb(), session.address, id, dir, now) });
  } catch (err) {
    return failure(err);
  }
}
```

Run: `npx vitest run src/app/api/me/votes`
Expected: PASS (4 + 6 tests).

- [ ] **Step 5: Write the failing counts-helper test**

`src/app/api/_lib/counts.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { DbUnavailableError } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import type { VoteCount } from "@/lib/social/store";
import type { TokenPair } from "@/lib/types";
import { VOTES_TTL, voteCountsFor, withVoteCounts } from "./counts";

const { holder, voteCounts } = vi.hoisted(() => ({
  holder: { db: null as Db | null },
  voteCounts: vi.fn<(db: unknown, ids: readonly string[]) => Promise<Record<string, VoteCount>>>(),
}));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, hasDb: () => holder.db !== null, getDb: () => holder.db as Db };
});
vi.mock("@/lib/social/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/social/store")>()),
  voteCounts,
}));

const T1 = `0x${"1".repeat(40)}`;
const T2 = `0x${"2".repeat(40)}`;
const pair = (id: string) => ({ id, ticker: "AI", bull: 0, bear: 0 }) as TokenPair;

beforeEach(() => {
  clearTtlCache();
  voteCounts.mockReset();
  holder.db = {} as Db; // a database is configured; the store itself is mocked
});
afterEach(() => vi.restoreAllMocks());

describe("voteCountsFor", () => {
  it("caches for thirty seconds, keyed by the ids whatever order they arrive in", async () => {
    expect(VOTES_TTL).toBe(30);
    voteCounts.mockResolvedValue({ [T1]: { bull: 3, bear: 1 }, [T2]: { bull: 0, bear: 0 } });
    await expect(voteCountsFor([T1, T2])).resolves.toEqual({ [T1]: { bull: 3, bear: 1 }, [T2]: { bull: 0, bear: 0 } });
    voteCounts.mockResolvedValue({ [T1]: { bull: 99, bear: 99 }, [T2]: { bull: 99, bear: 99 } });
    await expect(voteCountsFor([T2, T1])).resolves.toEqual({ [T1]: { bull: 3, bear: 1 }, [T2]: { bull: 0, bear: 0 } });
    expect(voteCounts).toHaveBeenCalledTimes(1);
  });

  it("answers zeros without a database and never asks the store", async () => {
    holder.db = null;
    await expect(voteCountsFor([T1, T2])).resolves.toEqual({ [T1]: { bull: 0, bear: 0 }, [T2]: { bull: 0, bear: 0 } });
    expect(voteCounts).not.toHaveBeenCalled();
  });

  it("answers an empty map for no ids at all", async () => {
    await expect(voteCountsFor([])).resolves.toEqual({});
    expect(voteCounts).not.toHaveBeenCalled();
  });

  it("lets a store outage travel, so the route can answer 503", async () => {
    voteCounts.mockRejectedValue(new DbUnavailableError("database unavailable (ECONNREFUSED)"));
    await expect(voteCountsFor([T1])).rejects.toBeInstanceOf(DbUnavailableError);
  });
});

describe("withVoteCounts", () => {
  it("fills the real counts in without touching the cached pair objects", async () => {
    voteCounts.mockResolvedValue({ [T1]: { bull: 7, bear: 2 }, [T2]: { bull: 0, bear: 0 } });
    const cached = [pair(T1), pair(T2)];
    const merged = await withVoteCounts(cached);
    expect(merged.map((p) => [p.bull, p.bear])).toEqual([[7, 2], [0, 0]]);
    expect(cached.map((p) => [p.bull, p.bear])).toEqual([[0, 0], [0, 0]]); // the memo's objects are untouched
    expect(merged[0]).not.toBe(cached[0]);
  });

  it("leaves the backend's zeros alone without a database and asks the store nothing", async () => {
    holder.db = null;
    const cached = [pair(T1)];
    await expect(withVoteCounts(cached)).resolves.toEqual(cached);
    expect(voteCounts).not.toHaveBeenCalled();
  });

  it("keeps a pair the counts do not mention exactly as it was", async () => {
    voteCounts.mockResolvedValue({});
    const cached = [pair(T1)];
    await expect(withVoteCounts(cached)).resolves.toEqual(cached);
  });

  it("never fails a market read: a store outage logs an error name and keeps the zeros", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    voteCounts.mockRejectedValue(Object.assign(new DbUnavailableError("database unavailable (ECONNREFUSED)"), { query: "select 1" }));
    const cached = [pair(T1)];
    await expect(withVoteCounts(cached)).resolves.toEqual(cached);
    expect(warn).toHaveBeenCalledWith("vote counts unavailable: DbUnavailableError");
  });

  it("does nothing at all for an empty list", async () => {
    await expect(withVoteCounts([])).resolves.toEqual([]);
    expect(voteCounts).not.toHaveBeenCalled();
  });
});
```

Run: `npx vitest run src/app/api/_lib/counts.test.ts`
Expected: FAIL — `Failed to resolve import "./counts"`.

- [ ] **Step 6: Write `src/app/api/_lib/counts.ts`**

```ts
import { getDb, hasDb } from "@/lib/db/client";
import { ttlCache } from "@/lib/envio/cache";
import { MAX_VOTE_IDS, voteCounts, type VoteCount } from "@/lib/social/store";
import type { TokenPair } from "@/lib/types";

/** Counts move fast and matter little; the client updates its own vote optimistically and the next fetch reconciles. */
export const VOTES_TTL = 30;

const zeros = (ids: readonly string[]): Record<string, VoteCount> =>
  Object.fromEntries(ids.map((id) => [id, { bull: 0, bear: 0 }]));

/**
 * Grouped counts for these token ids, memoised for `VOTES_TTL` per id set so the public counts route
 * and the two market reads share one entry. Zeros without a database, which is what the spec promises
 * on the Envio-only path. A store failure travels: the counts route turns it into a 503.
 */
export async function voteCountsFor(ids: readonly string[]): Promise<Record<string, VoteCount>> {
  if (ids.length === 0) return {};
  if (!hasDb()) return zeros(ids);
  // Sorted, so the same set asked for in any order is one cache entry.
  return ttlCache(`votes:${[...ids].sort().join(",")}`, VOTES_TTL * 1000, () => voteCounts(getDb(), ids));
}

/**
 * The same pairs with real `bull` / `bear` when a store is configured. Called after the backend's own
 * memo has answered, so the pairs cache stays backend-agnostic; each merged pair is a fresh object,
 * because `ttlCache` hands every caller the same one and writing into it would poison the memo.
 * This can never fail a market read: without counts the table still renders, with the zeros both
 * backends already shape.
 */
export async function withVoteCounts(pairs: readonly TokenPair[]): Promise<TokenPair[]> {
  if (pairs.length === 0 || !hasDb()) return [...pairs];
  try {
    // PAIRS_LIMIT and MAX_VOTE_IDS are both 500, so the slice never drops a pair; it is the guard that keeps that true.
    const counts = await voteCountsFor(pairs.slice(0, MAX_VOTE_IDS).map((p) => p.id));
    return pairs.map((p) => {
      const count = counts[p.id];
      return count ? { ...p, bull: count.bull, bear: count.bear } : p;
    });
  } catch (err) {
    // Name only: a driver error carries its query and the connection string.
    console.warn(`vote counts unavailable: ${err instanceof Error ? err.name : "unknown"}`);
    return [...pairs];
  }
}
```

Run: `npx vitest run src/app/api/_lib/counts.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 7: Write the failing public counts route test**

`src/app/api/votes/route.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import { MAX_VOTE_IDS, toggleVote } from "@/lib/social/store";
import type { Address } from "@/lib/types";
import { testDb } from "@/test/db";
import { GET } from "./route";

const { holder } = vi.hoisted(() => ({ holder: { db: null as Db | null } }));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, hasDb: () => holder.db !== null, getDb: () => holder.db as Db };
});

const W1 = `0x${"a".repeat(40)}` as Address;
const W2 = `0x${"b".repeat(40)}` as Address;
const T1 = `0x${"1".repeat(40)}`;
const T2 = `0x${"2".repeat(40)}`;
const NOW = 1_789_000_000;

let db: Db;
beforeAll(async () => {
  db = await testDb();
  holder.db = db;
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  clearTtlCache();
  holder.db = db;
  await db.exec("truncate market.votes");
});

/** Hex letters, so upper-casing it really changes the string — `0x111…1` would not. */
const T3 = `0x${"c".repeat(40)}`;

const call = (ids?: string) =>
  GET(new Request(`http://localhost:3000/api/votes${ids === undefined ? "" : `?ids=${ids}`}`));

describe("GET /api/votes", () => {
  it("counts both directions per token and zeroes the rest, cached for thirty seconds", async () => {
    await toggleVote(db, W1, T1, "bull", NOW);
    await toggleVote(db, W2, T1, "bear", NOW);
    const res = await call(`${T1},${T2}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=30, stale-while-revalidate=60");
    await expect(res.json()).resolves.toEqual({ [T1]: { bull: 1, bear: 1 }, [T2]: { bull: 0, bear: 0 } });
  });

  it("accepts a checksummed id and answers under the lowercase key", async () => {
    await toggleVote(db, W1, T3, "bull", NOW);
    const mixed = T3.toUpperCase().replace("0X", "0x");
    expect(mixed).not.toBe(T3); // the whole case rests on this, which is why T3 carries letters
    await expect((await call(mixed)).json()).resolves.toEqual({ [T3]: { bull: 1, bear: 0 } });
  });

  it("de-duplicates and tolerates whitespace and empty entries", async () => {
    await expect((await call(` ${T1} , ${T1} ,,`)).json()).resolves.toEqual({ [T1]: { bull: 0, bear: 0 } });
  });

  it("answers an empty map when no ids are asked for", async () => {
    await expect((await call()).json()).resolves.toEqual({});
    await expect((await call("")).json()).resolves.toEqual({});
  });

  it("answers 400 above five hundred ids and for anything that is not an address", async () => {
    const many = Array.from({ length: MAX_VOTE_IDS + 1 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`).join(",");
    const tooMany = await call(many);
    expect(tooMany.status).toBe(400);
    await expect(tooMany.json()).resolves.toEqual({ error: "too many ids" });
    for (const bad of ["nope", "0x1234", `${T1},nope`, `0x${"z".repeat(40)}`]) {
      const res = await call(bad);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "bad ids" });
    }
  });

  it("serves exactly five hundred ids", async () => {
    const ids = Array.from({ length: MAX_VOTE_IDS }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    const res = await call(ids.join(","));
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object)).toHaveLength(MAX_VOTE_IDS);
  });

  it("holds its answer for the cache window rather than re-counting every request", async () => {
    await toggleVote(db, W1, T1, "bull", NOW);
    await expect((await call(T1)).json()).resolves.toEqual({ [T1]: { bull: 1, bear: 0 } });
    await toggleVote(db, W2, T1, "bull", NOW);
    await expect((await call(T1)).json()).resolves.toEqual({ [T1]: { bull: 1, bear: 0 } }); // still the memo
    clearTtlCache();
    await expect((await call(T1)).json()).resolves.toEqual({ [T1]: { bull: 2, bear: 0 } });
  });

  it("answers zeros rather than an error without a database", async () => {
    holder.db = null;
    const res = await call(`${T1},${T2}`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ [T1]: { bull: 0, bear: 0 }, [T2]: { bull: 0, bear: 0 } });
  });
});
```

Run: `npx vitest run src/app/api/votes`
Expected: FAIL — `Failed to resolve import "./route"`.

- [ ] **Step 8: Write `src/app/api/votes/route.ts`**

```ts
import { MAX_VOTE_IDS } from "@/lib/social/store";
import { VOTES_TTL, voteCountsFor } from "../_lib/counts";
import { badRequest, cached, failure, isAddress } from "../_lib/respond";

export const dynamic = "force-dynamic";

/**
 * Public bull/bear counts for up to 500 tokens: `?ids=a,b,…`. Ids are lowercased first, exactly as
 * the token route lowercases its path segment, so a checksummed id is accepted and every key in the
 * answer is the lowercase id the store uses. Without a database the counts are zeros, never an error.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0))];
  if (ids.length > MAX_VOTE_IDS) return badRequest("too many ids");
  if (!ids.every((id) => isAddress(id))) return badRequest("bad ids");
  try {
    return cached(await voteCountsFor(ids), VOTES_TTL);
  } catch (err) {
    return failure(err);
  }
}
```

Run: `npx vitest run src/app/api/votes`
Expected: PASS (8 tests).

- [ ] **Step 9: Write the failing merge tests**

`src/app/api/pairs/route.test.ts` (new file — the route had no test):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import { EnvioUnavailableError } from "@/lib/envio/client";
import type { PairsScope } from "@/lib/envio/pairs";
import type { VoteCount } from "@/lib/social/store";
import type { TokenPair } from "@/lib/types";
import { GET } from "./route";

const { holder, pairs, voteCounts } = vi.hoisted(() => ({
  holder: { db: null as Db | null },
  pairs: vi.fn<(scope: PairsScope) => Promise<TokenPair[]>>(),
  voteCounts: vi.fn<(db: unknown, ids: readonly string[]) => Promise<Record<string, VoteCount>>>(),
}));
vi.mock("@/lib/market/backend", () => ({ getBackend: () => ({ kind: "db", pairs }) }));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, hasDb: () => holder.db !== null, getDb: () => holder.db as Db };
});
vi.mock("@/lib/social/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/social/store")>()),
  voteCounts,
}));

const T1 = `0x${"1".repeat(40)}`;
const T2 = `0x${"2".repeat(40)}`;
const pair = (id: string) => ({ id, ticker: "AI", bull: 0, bear: 0 }) as TokenPair;
const call = (scope?: string) => GET(new Request(`http://localhost:3000/api/pairs${scope ? `?scope=${scope}` : ""}`));

beforeEach(() => {
  clearTtlCache();
  pairs.mockReset();
  voteCounts.mockReset();
  pairs.mockResolvedValue([pair(T1), pair(T2)]);
  holder.db = null;
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/pairs", () => {
  it("answers the backend's pairs with the list's cache header, and reads the scope", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=30, stale-while-revalidate=60");
    expect(pairs).toHaveBeenCalledWith("all");
    await call("launchpad");
    expect(pairs).toHaveBeenLastCalledWith("launchpad");
    await call("nonsense");
    expect(pairs).toHaveBeenLastCalledWith("all");
  });

  it("carries real vote counts when a store is configured", async () => {
    holder.db = {} as Db;
    voteCounts.mockResolvedValue({ [T1]: { bull: 5, bear: 2 }, [T2]: { bull: 0, bear: 0 } });
    const body = (await (await call()).json()) as TokenPair[];
    expect(body.map((p) => [p.bull, p.bear])).toEqual([[5, 2], [0, 0]]);
    expect(voteCounts).toHaveBeenCalledWith(expect.anything(), [T1, T2]);
  });

  it("carries zeros, and asks nothing, without a store", async () => {
    const body = (await (await call()).json()) as TokenPair[];
    expect(body.map((p) => [p.bull, p.bear])).toEqual([[0, 0], [0, 0]]);
    expect(voteCounts).not.toHaveBeenCalled();
  });

  it("still answers the table when the counts cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    holder.db = {} as Db;
    voteCounts.mockRejectedValue(new Error("boom"));
    const res = await call();
    expect(res.status).toBe(200);
    expect(((await res.json()) as TokenPair[]).map((p) => p.bull)).toEqual([0, 0]);
  });

  it("answers 503 when the backend's source is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    pairs.mockRejectedValue(new EnvioUnavailableError("indexer responded 503"));
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("15");
  });
});
```

Add to `src/app/api/tokens/[address]/route.test.ts` — the hoisted holder and the store mock next to the existing `pair` mock at the top of the file:

```ts
const { holder, voteCounts } = vi.hoisted(() => ({
  holder: { db: null as import("@/lib/db/client").Db | null },
  voteCounts: vi.fn<(db: unknown, ids: readonly string[]) => Promise<Record<string, { bull: number; bear: number }>>>(),
}));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, hasDb: () => holder.db !== null, getDb: () => holder.db as import("@/lib/db/client").Db };
});
vi.mock("@/lib/social/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/social/store")>()),
  voteCounts,
}));
```

and this `describe` at the end of the same file:

```ts
describe("GET /api/tokens/[address] vote counts", () => {
  beforeEach(() => {
    // This `describe` sits outside the first one, so none of its hooks run here. Without the
    // clear, the 30 s `pair:<addr>` memo the earlier cases filled is still live and the 404 case
    // below would be served a 200 out of it.
    clearTtlCache();
    pair.mockReset();
    holder.db = null;
    voteCounts.mockReset();
  });

  it("carries real counts when a store is configured, without poisoning the pair memo", async () => {
    holder.db = {} as import("@/lib/db/client").Db;
    pair.mockResolvedValue({ ...found, bull: 0, bear: 0 });
    voteCounts.mockResolvedValue({ [ADDR]: { bull: 4, bear: 1 } });
    await expect((await call(ADDR)).json()).resolves.toMatchObject({ bull: 4, bear: 1 });
    expect(pair).toHaveBeenCalledTimes(1);

    // No `clearTtlCache()` here: clearing the memo is exactly what would hide the bug. Taking the
    // store away instead means nothing is merged on the second read, so it answers whatever the
    // memo actually holds — the backend's zeros, unless the first merge wrote into that object.
    holder.db = null;
    await expect((await call(ADDR)).json()).resolves.toMatchObject({ bull: 0, bear: 0 });
    expect(pair).toHaveBeenCalledTimes(1); // served from the memo, not re-fetched
  });

  it("carries zeros, and asks nothing, without a store", async () => {
    pair.mockResolvedValue({ ...found, bull: 0, bear: 0 });
    await expect((await call(ADDR)).json()).resolves.toMatchObject({ bull: 0, bear: 0 });
    expect(voteCounts).not.toHaveBeenCalled();
  });

  it("merges nothing onto a 404", async () => {
    holder.db = {} as import("@/lib/db/client").Db;
    pair.mockResolvedValue(null);
    expect((await call(ADDR)).status).toBe(404);
    expect(voteCounts).not.toHaveBeenCalled();
  });
});
```

Run: `npx vitest run src/app/api/pairs "src/app/api/tokens/[address]/route.test.ts"`
Expected: FAIL — the pairs file's count cases answer zeros with a store configured, and the token file's first case answers `bull: 0`; neither route merges anything yet.

- [ ] **Step 10: Merge the counts into the two market reads**

`src/app/api/pairs/route.ts` — replace the body of the `try` block:

```ts
    // After the backend's own memo, so the pairs cache stays backend-agnostic and one cached list can serve any counts.
    return cached(await withVoteCounts(await getBackend().pairs(scope)), PAIRS_TTL);
```

and add its import next to the existing ones:

```ts
import { withVoteCounts } from "../_lib/counts";
```

`src/app/api/tokens/[address]/route.ts` — replace the final `return cached(pair, TTL);` with:

```ts
    // Merged onto a copy after the memo answered: `ttlCache` hands every caller the same object.
    const [withCounts] = await withVoteCounts([pair]);
    return cached(withCounts, TTL);
```

and add its import next to the existing ones:

```ts
import { withVoteCounts } from "../../_lib/counts";
```

Run: `npx vitest run src/app/api/pairs "src/app/api/tokens/[address]/route.test.ts"`
Expected: PASS (5 pairs tests, and the token file's existing 4 plus 3 new).

- [ ] **Step 11: Run every gate**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green. `npm run build` lists `/api/me/watchlist`, `/api/me/watchlist/[address]`, `/api/me/votes`, `/api/me/votes/[address]` and `/api/votes` as dynamic routes (ƒ). `grep -rn "s-maxage" src/app/api/me` matches nothing: no user's own data is ever cacheable.

- [ ] **Step 12: Commit**

```bash
git add src/app/api/me/watchlist/route.ts src/app/api/me/watchlist/route.test.ts \
  "src/app/api/me/watchlist/[address]/route.ts" "src/app/api/me/watchlist/[address]/route.test.ts" \
  src/app/api/me/votes/route.ts src/app/api/me/votes/route.test.ts \
  "src/app/api/me/votes/[address]/route.ts" "src/app/api/me/votes/[address]/route.test.ts" \
  src/app/api/votes/route.ts src/app/api/votes/route.test.ts \
  src/app/api/_lib/counts.ts src/app/api/_lib/counts.test.ts src/test/session.ts \
  src/app/api/pairs/route.ts src/app/api/pairs/route.test.ts \
  "src/app/api/tokens/[address]/route.ts" "src/app/api/tokens/[address]/route.test.ts"
git commit -m "Serve the signed-in wallet's watchlist and votes, and real vote counts on both market reads" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---
### Task 4: The client: SIWE sign-in, cookie-identified user data

**Files:**
- Create: `src/context/AppState.test.tsx`, `src/components/SignModal.test.tsx`
- Modify: `src/lib/types.ts` (`Hex`, `SignMessage`, the rewritten user-data half of `MarketsDataSource`), `src/lib/data/envio.ts` (the six user methods now call the routes; `signIn` builds the SIWE message), `src/lib/data/mock.ts` (its own session, the address parameters dropped), `src/hooks/useMarketsData.ts` (`useWatchlist`/`useVotes` lose the address, `keys.watchlist`/`keys.votes` become constants), `src/context/AppState.tsx` (session from `ds.session()`, `completeSign` runs the flow), `src/components/SignModal.tsx` (hands its signer to `completeSign`), `src/lib/data/envio.test.ts` (extended)
- Delete: `src/lib/data/localStore.ts`

**Interfaces:**
- Consumes: `GET /api/session/nonce`, `POST|GET|DELETE /api/session`, `GET /api/me/watchlist`, `PUT|DELETE /api/me/watchlist/[address]`, `GET /api/me/votes`, `POST /api/me/votes/[address]` (Tasks 1–3); `createSiweMessage` from **`viem/siwe`**; `robinhoodChain` from `@/lib/chain`; `useSignMessage` from wagmi; `queryHarness` and the Testing Library re-exports from `@/test/dom`.
- Produces: `MarketsDataSource.session()`, `.signIn(sign, address)`, `.signOut()`, and the address-free `.watchlist()`, `.setWatch(id, on)`, `.votes()`, `.vote(id, dir)`; `Hex` and `SignMessage` in `src/lib/types.ts`; `AppState.completeSign(sign, address)`; `useWatchlist(enabled)` and `useVotes(enabled)`.

Decisions where the spec and the contract left room (one line each):

- **`createSiweMessage` is imported from `viem/siwe`, not from `viem`.** Verified against the installed viem 2.56.3 on 18 Sep 2026: `require("viem").createSiweMessage` is `undefined`, and `require("viem/siwe")` exports `createSiweMessage`, `parseSiweMessage`, `validateSiweMessage`, `verifySiweMessage`, `generateSiweNonce`, `SiweInvalidMessageFieldError`. The spec's "viem's `createSiweMessage`" is right about the function and wrong about the entry point; every import in this task and in Tasks 1–3 uses `viem/siwe`.
- **The client never imports `src/lib/session/cookie.ts`.** That module reads `process.env.SESSION_SECRET`; a client bundle must not carry a path that resolves it, even for a constant. The seven-day expiry is `SIGN_IN_TTL_MS` in `src/lib/data/envio.ts`, with a comment naming `SESSION_TTL_SEC` as the server-side twin. One number, two files, both 7 days, asserted in both suites.
- **`session()` answers `null` for 401 *and* 503.** `SESSION_SECRET` unset is "nobody is signed in", not "the app is broken" (spec section 2): reads must keep working and the star gate simply keeps asking for a signature it cannot complete. A signature it cannot complete is the honest state of an unconfigured deployment, and `signIn` surfaces the 503 as a thrown error the modal shows.
- **Reads of the user's own lists answer empty on 401/503; writes throw.** A cookie that lapsed between the page load and a refetch must not put an error card over the markets table — an empty watchlist is exactly what a signed-out user sees. A write that is refused must be loud, because `AppState` has already painted the star optimistically; the `finally` in the gated action invalidates, the refetch answers the server's truth, and the star snaps back.
- **The session address is compared case-insensitively.** The cookie carries a lowercase address (contract: "address lowercase"); wagmi's `useAccount` carries a checksummed one. Today's `session.address === address` compared two values that both came from wagmi, so it worked by accident. `sameAddress()` is a two-line helper and the one place this can go wrong: get it wrong and every signed-in user is asked to sign again on every render.
- **The query keys stop carrying the address.** The cookie is the identity, so `keys.watchlist` and `keys.votes` become plain constants and the hooks take an `enabled` boolean instead of an address — which is what "drop the address argument but keep being disabled until signed in" has to mean once the key can no longer name a wallet. `AppState` drops both caches whenever `signed` is false, so a second wallet in the same tab never sees the first one's stars for a frame.
- **`completeSign(sign, address)` takes both.** The contract writes `completeSign(address)` and the task text says the modal hands over `signMessageAsync`; the modal already holds a non-optional `address` prop, so passing both satisfies each reading literally and spares `AppState` a redundant undefined check inside an async callback.
- **`ds.signOut()` exists and is tested, but nothing calls it in M4.** Wiring it to a wallet disconnect is a trap: `isConnected` is false for the first frames of hydration, and a sign-out fired there would clear a perfectly good cookie on every page load. The cookie expires on its own in seven days and a wallet switch re-signs; a deliberate "sign out" button is M5's if the client asks for one.
- **`src/lib/data/localStore.ts` is deleted.** The contract's rule "the demo data source keeps `LocalWatchStore`" describes a file the demo source never imported: `grep -rn "LocalWatchStore" src` on 18 Sep 2026 matches only `src/lib/data/envio.ts` and the class's own file. `MockDataSource` has always had its own identical `storageKey`/`readStore`/`writeStore` trio plus the in-memory books and the `SUIT`/`AI` default watchlist, and this task leaves all of that untouched — which is the behaviour the rule protects. Once `EnvioDataSource` talks to the routes the class has no importer at all, and an unimported file is worse than no file.
- **The demo source obeys Ruling 1 as well: its reads answer empty, its writes throw.** `MockDataSource` gains a session it did not have, so a behaviour does change — the `SUIT`/`AI` default watchlist now appears once the demo wallet signs rather than to anyone who opens the page, because a watchlist belongs to an address from M4 on. Making the reads throw instead would break Ruling 1 in the one build a reviewer is most likely to open; making them answer `[]` and `{}` costs nothing and keeps both sources the same shape. The spec does not ask the demo to gate reads, so nothing else about it moves.
- **`SignModal` keeps every pixel; its preview stops claiming to be the message.** The exact EIP-4361 text cannot be shown before the button is pressed, because the nonce comes from the server at that moment. The mono box keeps its place and its styling and shows the statement, the short address and the chain — which is what a reader takes from it anyway — and the client-side `makeNonce()` goes.

- [ ] **Step 1: Widen `src/lib/types.ts`**

**Make the two edits bottom-up — the tail replacement first, then the insertion.** Both line numbers
below are of the file as it stands before this step (after Task 2's `TraderRow` append, which is past
both anchors and moves neither); inserting at the top first would shift the tail's numbers by ten.
The text anchors are authoritative either way.

First, replace the whole tail of `MarketsDataSource`, from `  /** token addresses */` (line 150) to
the closing brace of the interface (line 177), with:

```ts
  // --- The signed-in user's own data ------------------------------------
  // None of these takes an address: the `svm_session` cookie is the only identity the user
  // routes trust (spec section 2), and a client-supplied address would be a claim, not a fact.

  /** The token addresses this session has starred. Empty when nobody is signed in. */
  watchlist(): Promise<string[]>;
  setWatch(id: string, on: boolean): Promise<void>;
  /**
   * The caller's current vote per token address. Not in the handoff interface; the token page
   * needs it to render the voted state after a reload.
   */
  votes(): Promise<Record<string, VoteDir>>;
  /**
   * Casting the same direction twice clears the vote; casting the other direction switches it.
   * Answers the direction that now stands, or null when the vote was cleared.
   */
  vote(id: string, dir: VoteDir): Promise<VoteDir | null>;

  // --- Session ----------------------------------------------------------

  /** The signed-in address, or null: nobody signed in, or sessions are not configured. */
  session(): Promise<Address | null>;
  /** Nonce, EIP-4361 message, signature, cookie. Answers the address the server accepted. */
  signIn(sign: SignMessage, address: Address): Promise<Address>;
  signOut(): Promise<void>;
}
```

Then add two types beside `VoteDir` (after line 16, `export type VoteDir = "bull" | "bear";`):

```ts
/** A 0x-prefixed hex string. Spelt here rather than imported from viem, exactly as `Address` is. */
export type Hex = `0x${string}`;

/**
 * Signs an EIP-191 personal message: wagmi's `signMessageAsync` with its options object adapted
 * away, so the data source can run the sign-in flow without importing a React hook.
 */
export type SignMessage = (message: string) => Promise<Hex>;
```

- [ ] **Step 2: Point `src/lib/data/envio.ts` at the routes**

**Apply this step's four edits bottom-up, which is the reverse of the order they are printed in:
the 114–128 replacement first, then the line 33 deletion, then the insertion after line 28, then the
import block.** Every line number here is of `src/lib/data/envio.ts` as it stands today (128 lines,
the class's closing brace on line 128); editing upwards keeps all four numbers true.

Replace the import block at the top (lines 1–4) with:

```ts
import { createSiweMessage } from "viem/siwe";
import type { Address, Candle, Denom, Holder, Interval, MarketsDataSource, Quote, QuoteAsset, Side, SignMessage, TokenPair, Trade, VoteDir } from "@/lib/types";
import type { PriceResult } from "@/lib/quote/price";
import { robinhoodChain } from "@/lib/chain";
import { localQuote, poolFeePctFor } from "@/lib/quote";
```

Delete the `private readonly store = new LocalWatchStore();` line (line 33) and add these two constants under `toRouteAmount` (after line 28):

```ts
/**
 * The ASCII statement the wallet shows above the EIP-4361 fields. Fixed text: a statement that
 * varied per action would train the user to skim the one line that says what they are signing.
 */
const SIWE_STATEMENT = "Sign in to SuitVentures Markets";

/**
 * How long the signed message stays valid. The server's cookie lives exactly as long
 * (`SESSION_TTL_SEC` in `src/lib/session/cookie.ts`); the number is repeated rather than imported
 * because that module reads `SESSION_SECRET` and must never be resolvable from a client bundle.
 */
const SIGN_IN_TTL_MS = 7 * 86_400 * 1000;
```

Replace the four user-data methods at the bottom of the class **together with the class's own
closing brace — lines 114–128, from `  async watchlist(address: Address)` through the final `}` of
the file** — with this block, which ends in that same brace:

```ts
  // --- The signed-in user's own data ------------------------------------
  // Every request below is same-origin, so `fetch` sends and stores `svm_session` on its own;
  // `credentials: "same-origin"` is the default and is written out to say that it is load-bearing.
  //
  // A read answers empty for 401 and 503 instead of throwing: a cookie that lapsed between the
  // page load and a refetch must not put an error card over the markets table, and an empty
  // watchlist is exactly what a signed-out user already sees. A write throws on any refusal,
  // because `AppState` has already painted the star and needs its invalidate to undo it.

  async watchlist(): Promise<string[]> {
    const res = await fetch("/api/me/watchlist", { cache: "no-store", credentials: "same-origin" });
    if (res.status === 401 || res.status === 503) return [];
    if (!res.ok) throw new Error(`/api/me/watchlist: ${res.status}`);
    return (await res.json()) as string[];
  }

  async setWatch(id: string, on: boolean): Promise<void> {
    const res = await fetch(`/api/me/watchlist/${id.toLowerCase()}`, {
      method: on ? "PUT" : "DELETE",
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`/api/me/watchlist: ${res.status}`);
  }

  async votes(): Promise<Record<string, VoteDir>> {
    const res = await fetch("/api/me/votes", { cache: "no-store", credentials: "same-origin" });
    if (res.status === 401 || res.status === 503) return {};
    if (!res.ok) throw new Error(`/api/me/votes: ${res.status}`);
    return (await res.json()) as Record<string, VoteDir>;
  }

  async vote(id: string, dir: VoteDir): Promise<VoteDir | null> {
    const res = await fetch(`/api/me/votes/${id.toLowerCase()}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir }),
    });
    if (!res.ok) throw new Error(`/api/me/votes: ${res.status}`);
    return ((await res.json()) as { dir: VoteDir | null }).dir;
  }

  // --- Session ----------------------------------------------------------

  /**
   * 503 reads as null, not as a failure: `SESSION_SECRET` unset means "nobody can be signed in",
   * and the whole read-only app must keep working around it (spec section 2).
   */
  async session(): Promise<Address | null> {
    const res = await fetch("/api/session", { cache: "no-store", credentials: "same-origin" });
    if (res.status === 401 || res.status === 503) return null;
    if (!res.ok) throw new Error(`/api/session: ${res.status}`);
    return ((await res.json()) as { address: Address }).address;
  }

  /**
   * Sign-In with Ethereum, EIP-4361. The server issues the nonce and holds its HMAC in `svm_nonce`,
   * so a message this client made up cannot be replayed; `domain` and `uri` come from the page the
   * user is actually looking at, which is what the server checks the message against.
   */
  async signIn(sign: SignMessage, address: Address): Promise<Address> {
    const { nonce } = await getJson<{ nonce: string }>("/api/session/nonce");
    const issuedAt = new Date();
    const message = createSiweMessage({
      address,
      chainId: robinhoodChain.id,
      domain: window.location.host,
      uri: window.location.origin,
      statement: SIWE_STATEMENT,
      version: "1",
      nonce,
      issuedAt,
      expirationTime: new Date(issuedAt.getTime() + SIGN_IN_TTL_MS),
    });
    const signature = await sign(message);
    const res = await fetch("/api/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    });
    if (!res.ok) throw new Error(`/api/session: ${res.status}`);
    // The address the server put in the cookie, lowercase — not the one we asked for.
    return ((await res.json()) as { address: Address }).address;
  }

  async signOut(): Promise<void> {
    const res = await fetch("/api/session", { method: "DELETE", credentials: "same-origin" });
    // 401 is "already signed out", which is the state the caller wanted.
    if (!res.ok && res.status !== 401) throw new Error(`/api/session: ${res.status}`);
  }
}
```

Then delete the file that has just lost its only importer:

```bash
git rm src/lib/data/localStore.ts
```

- [ ] **Step 3: Give `src/lib/data/mock.ts` a session of its own**

**Apply this step's five edits bottom-up, the reverse of the order they are printed in: the 265–337
replacement first, then the line 170 insertion, the line 161 insertion, the 145–148 replacement, the
72–74 replacement, and the type import last.** Every number here is of `src/lib/data/mock.ts` as it
stands today (337 lines, the class's closing brace on line 337); the earlier edits add nine lines
between them, so editing downwards would put every later number nine lines out.

Replace `requireSignature` (lines 72–74) with:

```ts
/**
 * The demo's writes are the loud half of Ruling 1: `setWatch` and `vote` throw while nobody has
 * signed in, so an optimistic star rolls back. The reads answer empty instead — see `watchlist()`.
 */
function requireSession(address: Address | null): Address {
  if (!address) throw new Error("Sign in first.");
  return address;
}
```

Replace `MockOptions` (lines 145–148) with:

```ts
export interface MockOptions {
  /** Simulated network latency for list calls, so loading states are visible. */
  latencyMs?: number;
  /**
   * A wallet the demo starts already signed in as. `createDataSource()` passes none, so the demo
   * asks for a signature once per browser session exactly as it did before M4; a test or a
   * storybook-style harness can hand one over and skip the modal.
   */
  address?: Address;
}
```

Add one field to the class, beside `defaultWatchlist` (after line 161):

```ts
  private signedAddress: Address | null;
```

and one line at the end of the constructor (after line 170's `);`):

```ts
    this.signedAddress = opts.address ? (opts.address.toLowerCase() as Address) : null;
```

Replace the six user-data methods **together with the class's own closing brace — lines 265–337,
from `  private loadWatch(address: Address)` through the final `}` of the file** — with this block,
which ends in that same brace:

```ts
  // The demo keeps its watchlist and votes in this browser, keyed by the signed-in address —
  // the local persistence the contract protects. Nothing here talks to a route: a demo build has
  // no market store behind it and every mock token is a generated address no backend knows.
  //
  // Ruling 1 applies to this source too: the two reads answer `[]` and `{}` while nobody has
  // signed in rather than throwing. That is a real behaviour change — before M4 a demo build
  // showed the SUIT/AI default watchlist to anyone who opened it, and from M4 it appears once the
  // wallet signs, because a watchlist now belongs to an address rather than to a browser. The
  // spec does not require the demo to gate reads, so nothing else about it changes: sign in and
  // the same `localStorage` list, defaults and all, is exactly where it was.

  private loadWatch(address: Address): string[] {
    const key = address.toLowerCase();
    let list = this.watchBook.get(key);
    if (!list) {
      list =
        readStore<string[]>(storageKey("watch", address)) ?? [
          ...this.defaultWatchlist,
        ];
      this.watchBook.set(key, list);
    }
    return list;
  }

  /** Empty rather than a throw while nobody is signed in — Ruling 1, the same as the live source. */
  async watchlist(): Promise<string[]> {
    const address = this.signedAddress;
    await this.delay();
    return address ? [...this.loadWatch(address)] : [];
  }

  async setWatch(id: string, on: boolean): Promise<void> {
    const address = requireSession(this.signedAddress);
    const list = this.loadWatch(address);
    const next = on
      ? list.includes(id)
        ? list
        : [...list, id]
      : list.filter((t) => t !== id);
    this.watchBook.set(address.toLowerCase(), next);
    writeStore(storageKey("watch", address), next);
    await this.delay();
  }

  private loadVotes(address: Address): Record<string, VoteDir> {
    const key = address.toLowerCase();
    let book = this.voteBook.get(key);
    if (!book) {
      book = readStore<Record<string, VoteDir>>(storageKey("votes", address)) ?? {};
      this.voteBook.set(key, book);
    }
    return book;
  }

  /** Empty rather than a throw while nobody is signed in — Ruling 1, the same as the live source. */
  async votes(): Promise<Record<string, VoteDir>> {
    const address = this.signedAddress;
    await this.delay();
    return address ? { ...this.loadVotes(address) } : {};
  }

  async vote(id: string, dir: VoteDir): Promise<VoteDir | null> {
    const address = requireSession(this.signedAddress);
    const pair = this.pairOrThrow(id);
    const book = { ...this.loadVotes(address) };
    const prev = book[pair.id];
    if (prev) pair[prev] -= 1;
    let now: VoteDir | null = dir;
    if (prev === dir) {
      delete book[pair.id];
      now = null;
    } else {
      book[pair.id] = dir;
      pair[dir] += 1;
    }
    this.voteBook.set(address.toLowerCase(), book);
    writeStore(storageKey("votes", address), book);
    await this.delay();
    return now;
  }

  // --- Session ----------------------------------------------------------
  // No signature is verified and no message is built: the demo has no server to verify one.
  // `signIn` resolves immediately so the modal closes and the gated action runs, which is the
  // whole of what the demo needs from a sign-in.

  async session(): Promise<Address | null> {
    return this.signedAddress;
  }

  async signIn(_sign: SignMessage, address: Address): Promise<Address> {
    this.signedAddress = address.toLowerCase() as Address;
    return this.signedAddress;
  }

  async signOut(): Promise<void> {
    this.signedAddress = null;
  }
}
```

Finally, the type import at the top is one name per line (lines 1–14): insert `  SignMessage,`
between `  Side,` (line 10) and `  TokenPair,` (line 11).

- [ ] **Step 4: Drop the address from the two user hooks**

In `src/hooks/useMarketsData.ts`, replace the two key entries (lines 15–17):

```ts
  // The session cookie is the identity, so neither key names a wallet. `AppState` drops both
  // caches the moment `signed` goes false, which is what keeps a second wallet in the same tab
  // from seeing the first one's stars.
  watchlist: ["watchlist"] as const,
  votes: ["votes"] as const,
```

and replace both hooks (lines 96–112):

```ts
/** Disabled until the session cookie says who the caller is; the data source sends no address. */
export function useWatchlist(enabled: boolean) {
  const ds = useDataSource();
  return useQuery({ queryKey: keys.watchlist, queryFn: () => ds.watchlist(), enabled });
}

export function useVotes(enabled: boolean) {
  const ds = useDataSource();
  return useQuery({ queryKey: keys.votes, queryFn: () => ds.votes(), enabled });
}
```

`Address` is still imported for `keys` — it is not, after this edit. Change line 5 to:

```ts
import type { Denom, Interval, Side, TokenPair } from "@/lib/types";
```

- [ ] **Step 5: Run the session through `src/context/AppState.tsx`**

Replace the gate's context type and the `GatedAction` alias (lines 44–48):

```ts
interface GateContext {
  /** The signed-in address. M4's two gated actions no longer need it — the cookie is the
   *  identity — but the gate keeps handing it over for the ones that will. */
  address: Address;
}
type GatedAction = (ctx: GateContext) => void | Promise<void>;
```

Replace the `completeSign` line in the `AppState` interface (line 72):

```ts
  completeSign(sign: SignMessage, address: Address): Promise<void>;
```

Add `SignMessage` to the type import on line 25:

```ts
import type { Address, SignMessage, TokenPair, VoteDir } from "@/lib/types";
```

Add this helper just above `const AppStateContext` (line 81):

```ts
/**
 * The session's address comes from the server and is lowercase; wagmi's is checksummed. Comparing
 * them with `===` would call every signed-in wallet a stranger and re-open the modal for ever.
 */
function sameAddress(a?: string, b?: string): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}
```

Replace the whole session-and-gate block (lines 124–177) with:

```ts
  // --- session + gate ---------------------------------------------------
  const [session, setSession] = useState<{ address: Address } | null>(null);
  const signed = sameAddress(session?.address, address);
  const [signModal, setSignModal] = useState<{ kind: GateKind } | null>(null);
  const pendingRef = useRef<{ kind: GateKind; run: GatedAction } | null>(null);

  // On load the cookie says whether this browser is already signed in, so a wallet that signed in
  // on another device sees its watchlist here without signing again. A failed probe means "not
  // signed in"; the functional update keeps a sign-in that raced ahead of it.
  useEffect(() => {
    let alive = true;
    void ds
      .session()
      .then((addr) => {
        if (alive && addr) setSession((s) => s ?? { address: addr });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [ds]);

  // Stars and votes belong to a session, not to a browser tab: the moment this wallet stops being
  // the signed-in one, the previous wallet's answers leave the cache rather than render for a frame.
  useEffect(() => {
    if (signed) return;
    qc.removeQueries({ queryKey: keys.watchlist });
    qc.removeQueries({ queryKey: keys.votes });
  }, [signed, qc]);

  const gate = useCallback(
    (kind: GateKind, run: GatedAction) => {
      if (!isConnected || !address) {
        pendingRef.current = { kind, run };
        openConnectModal?.();
        return;
      }
      if (!sameAddress(session?.address, address)) {
        pendingRef.current = { kind, run };
        setSignModal({ kind });
        return;
      }
      void run({ address });
    },
    [address, isConnected, openConnectModal, session],
  );

  // A wallet connected while an action was waiting: continue to the signature.
  useEffect(() => {
    if (!isConnected || !address || !pendingRef.current) return;
    if (sameAddress(session?.address, address)) {
      const { run } = pendingRef.current;
      pendingRef.current = null;
      void run({ address });
    } else {
      setSignModal({ kind: pendingRef.current.kind });
    }
  }, [isConnected, address, session]);

  /**
   * Nonce, message, signature, cookie — all inside the data source. It throws when the wallet
   * refuses or the server does; `SignModal` catches that and shows its own line, so the modal
   * stays open on a failure and closes only on a session the server actually issued.
   */
  const completeSign = useCallback(
    async (sign: SignMessage, addr: Address) => {
      const signedAddress = await ds.signIn(sign, addr);
      setSession({ address: signedAddress });
      setSignModal(null);
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) void pending.run({ address: signedAddress });
    },
    [ds],
  );

  const cancelSign = useCallback(() => {
    pendingRef.current = null;
    setSignModal(null);
  }, []);
```

Replace the watchlist block (lines 179–203):

```ts
  // --- watchlist -------------------------------------------------------
  const watchlistQuery = useWatchlist(signed);
  const stars = useMemo(
    () => new Set(watchlistQuery.data ?? []),
    [watchlistQuery.data],
  );

  const toggleStar = useCallback(
    (id: string) => {
      gate("star", async () => {
        const current = qc.getQueryData<string[]>(keys.watchlist) ?? [];
        const on = !current.includes(id);
        qc.setQueryData<string[]>(keys.watchlist, (old = []) =>
          on ? [...old.filter((t) => t !== id), id] : old.filter((t) => t !== id),
        );
        try {
          await ds.setWatch(id, on);
        } finally {
          // Also the rollback: a refused write is followed by the server's own answer.
          void qc.invalidateQueries({ queryKey: keys.watchlist });
        }
      });
    },
    [ds, gate, qc],
  );
```

Replace the votes block (lines 205–237):

```ts
  // --- votes -----------------------------------------------------------
  const votesQuery = useVotes(signed);
  const votes = useMemo(() => votesQuery.data ?? {}, [votesQuery.data]);

  const vote = useCallback(
    (id: string, dir: VoteDir) => {
      gate("vote", async () => {
        const book = qc.getQueryData<Record<string, VoteDir>>(keys.votes) ?? {};
        const prev = book[id];
        const next = { ...book };
        if (prev === dir) delete next[id];
        else next[id] = dir;
        qc.setQueryData(keys.votes, next);
        qc.setQueryData<TokenPair[]>(keys.pairs, (old) =>
          old?.map((p) => {
            if (p.id !== id) return p;
            const updated = { ...p };
            if (prev) updated[prev] -= 1;
            if (prev !== dir) updated[dir] += 1;
            return updated;
          }),
        );
        try {
          await ds.vote(id, dir);
        } finally {
          void qc.invalidateQueries({ queryKey: keys.votes });
          void qc.invalidateQueries({ queryKey: keys.pairs });
        }
      });
    },
    [ds, gate, qc],
  );
```

Finally, in the `value` memo, replace line 277 with:

```ts
      watchlistLoading: signed && watchlistQuery.isPending,
```

The memo's dependency array needs no edit: it already lists both `signed` (line 293) and `watchlistQuery.isPending` (line 303), which are the only two values that line reads.

- [ ] **Step 6: Hand `src/components/SignModal.tsx` its signer**

Replace lines 1–51 (imports through `sign`) with:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useSignMessage } from "wagmi";
import { useAppState, type GateKind } from "@/context/AppState";
import { robinhoodChain } from "@/lib/chain";
import type { Address, SignMessage } from "@/lib/types";
import { short } from "@/lib/format";
import { Spinner, SuitsMark } from "./ui";

function SignDialog({
  kind,
  address,
  onSigned,
  onCancel,
}: {
  kind: GateKind;
  address: Address;
  onSigned(sign: SignMessage, address: Address): Promise<void>;
  onCancel(): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { signMessageAsync, isPending } = useSignMessage();
  /**
   * A description of what is about to be signed, not the bytes: the EIP-4361 message is built at
   * sign time around a nonce only the server can issue, so it does not exist yet. The address is
   * shortened for the eye; the message carries it in full.
   */
  const preview = `Sign in to SuitVentures Markets · ${short(address)} · Chain ${robinhoodChain.id}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const sign = async () => {
    setError(null);
    setBusy(true);
    try {
      await onSigned((message: string) => signMessageAsync({ message }), address);
    } catch {
      // One line for both refusals: the wallet's and the server's. Neither may name a host,
      // a cookie or a status code in the UI.
      setError("Sign-in didn't complete. Nothing was saved.");
    } finally {
      setBusy(false);
    }
  };
```

Replace the preview box's contents (line 84) with:

```tsx
          {preview}
```

and the two occurrences of `isPending` on the confirm button (lines 102 and 105) with `busy || isPending`, so the button stays in its waiting state through the wallet signature *and* the POST that follows:

```tsx
            disabled={busy || isPending}
            className="flex h-10 items-center justify-center gap-2 bg-chalk font-mono text-[10px] uppercase tracking-[0.22em] text-void hover:bg-white disabled:cursor-wait disabled:bg-[rgba(244,238,218,0.55)]"
          >
            {busy || isPending ? (
```

The default export at the bottom is unchanged: `onSigned={completeSign}` now type-checks against the new two-parameter signature.

- [ ] **Step 7: Extend `src/lib/data/envio.test.ts`**

Append this block to the end of the file (after the closing `});` of the existing `describe`):

```ts
describe("EnvioDataSource sessions and user data", () => {
  const WALLET = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" as Address;
  /** What the next fetch answers, by path. */
  let routes: Record<string, { status: number; body?: unknown }>;
  const calls: { url: string; init?: RequestInit }[] = [];

  const sessionFetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = `${init?.method ?? "GET"} ${url.split("?")[0]}`;
    const answer = routes[key] ?? { status: 404 };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body,
    } as unknown as Response;
  });

  beforeEach(() => {
    calls.length = 0;
    routes = {
      "GET /api/session/nonce": { status: 200, body: { nonce: "cafebabe" } },
      "GET /api/session": { status: 200, body: { address: WALLET.toLowerCase() } },
      "POST /api/session": { status: 200, body: { address: WALLET.toLowerCase() } },
      "DELETE /api/session": { status: 204 },
      "GET /api/me/watchlist": { status: 200, body: [TOKEN] },
      [`PUT /api/me/watchlist/${TOKEN}`]: { status: 204 },
      [`DELETE /api/me/watchlist/${TOKEN}`]: { status: 204 },
      "GET /api/me/votes": { status: 200, body: { [TOKEN]: "bull" } },
      [`POST /api/me/votes/${TOKEN}`]: { status: 200, body: { dir: "bull" } },
    };
    sessionFetch.mockClear();
    vi.stubGlobal("fetch", sessionFetch);
    // This file runs under the `node` project, which has no `window`; `signIn` reads the page's
    // own host and origin, so the test says what page the user is on.
    vi.stubGlobal("window", {
      location: { host: "markets.suitventures.xyz", origin: "https://markets.suitventures.xyz" },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  function call(url: string): { url: string; init?: RequestInit } {
    const found = calls.find((c) => c.url.split("?")[0] === url);
    if (!found) throw new Error(`${url} was never called`);
    return found;
  }

  it("reads the session from the cookie route", async () => {
    await expect(source().session()).resolves.toBe(WALLET.toLowerCase());
  });

  it.each([401, 503])("answers null when the session route says %i", async (status) => {
    routes["GET /api/session"] = { status };
    await expect(source().session()).resolves.toBeNull();
  });

  it("signs in: nonce, then the signed message, then the cookie", async () => {
    const sign = vi.fn(async () => "0xsig" as Hex);
    await expect(source().signIn(sign, WALLET)).resolves.toBe(WALLET.toLowerCase());
    expect(calls.map((c) => `${c.init?.method ?? "GET"} ${c.url}`)).toEqual([
      "GET /api/session/nonce",
      "POST /api/session",
    ]);
    const body = JSON.parse(String(call("/api/session").init?.body)) as { message: string; signature: string };
    expect(body.signature).toBe("0xsig");
    expect(body.message).toBe(sign.mock.calls[0][0]);
  });

  it("builds an EIP-4361 message with the page's domain, chain 4663 and a seven-day expiry", async () => {
    let signedMessage = "";
    await source().signIn(async (message) => {
      signedMessage = message;
      return "0xsig" as Hex;
    }, WALLET);
    const parsed = parseSiweMessage(signedMessage);
    expect(parsed.domain).toBe("markets.suitventures.xyz");
    expect(parsed.uri).toBe("https://markets.suitventures.xyz");
    expect(parsed.chainId).toBe(4663);
    expect(parsed.version).toBe("1");
    expect(parsed.statement).toBe("Sign in to SuitVentures Markets");
    expect(parsed.nonce).toBe("cafebabe");
    expect(parsed.address?.toLowerCase()).toBe(WALLET.toLowerCase());
    const issuedAt = parsed.issuedAt as Date;
    const expires = parsed.expirationTime as Date;
    expect(expires.getTime() - issuedAt.getTime()).toBe(7 * 86_400 * 1000);
  });

  it("throws when the server refuses the signature, so the modal can stay open", async () => {
    routes["POST /api/session"] = { status: 401, body: { error: "bad signature" } };
    await expect(source().signIn(async () => "0xsig" as Hex, WALLET)).rejects.toThrow("401");
  });

  it("signs out through DELETE, and treats an already-dead cookie as success", async () => {
    await source().signOut();
    expect(call("/api/session").init?.method).toBe("DELETE");
    routes["DELETE /api/session"] = { status: 401 };
    await expect(source().signOut()).resolves.toBeUndefined();
  });

  it("reads the watchlist and the votes without sending an address anywhere", async () => {
    const ds = source();
    await expect(ds.watchlist()).resolves.toEqual([TOKEN]);
    await expect(ds.votes()).resolves.toEqual({ [TOKEN]: "bull" });
    expect(calls.every((c) => !c.url.includes(WALLET.toLowerCase()))).toBe(true);
    expect(call("/api/me/watchlist").init?.credentials).toBe("same-origin");
  });

  it.each([401, 503])("answers an empty watchlist and no votes on %i, never an error", async (status) => {
    routes["GET /api/me/watchlist"] = { status };
    routes["GET /api/me/votes"] = { status };
    const ds = source();
    await expect(ds.watchlist()).resolves.toEqual([]);
    await expect(ds.votes()).resolves.toEqual({});
  });

  it("stars with PUT and unstars with DELETE, on the token's own path", async () => {
    const ds = source();
    await ds.setWatch(TOKEN.toUpperCase().replace("0X", "0x"), true);
    expect(call(`/api/me/watchlist/${TOKEN}`).init?.method).toBe("PUT");
    calls.length = 0;
    await ds.setWatch(TOKEN, false);
    expect(call(`/api/me/watchlist/${TOKEN}`).init?.method).toBe("DELETE");
  });

  it("posts a vote and answers the direction that now stands", async () => {
    routes[`POST /api/me/votes/${TOKEN}`] = { status: 200, body: { dir: null } };
    await expect(source().vote(TOKEN, "bull")).resolves.toBeNull();
    const posted = call(`/api/me/votes/${TOKEN}`);
    expect(posted.init?.method).toBe("POST");
    expect(JSON.parse(String(posted.init?.body))).toEqual({ dir: "bull" });
  });

  it("throws when a write is refused, so the optimistic star can be rolled back", async () => {
    routes[`PUT /api/me/watchlist/${TOKEN}`] = { status: 401 };
    await expect(source().setWatch(TOKEN, true)).rejects.toThrow("401");
  });
});
```

and widen the file's two import lines at the top to:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSiweMessage } from "viem/siwe";
import type { Address, Hex, Quote, SwapCall, TokenPair } from "@/lib/types";
import { EnvioDataSource } from "./envio";
```

Run: `npx vitest run src/lib/data/envio.test.ts`
Expected: PASS, the 20 quote tests unchanged plus 13 new ones — 11 `it`s, of which two are `it.each([401, 503])` tables contributing two cases each — for 33 in the file.

- [ ] **Step 8: Write the `AppState` sign-in test**

`src/context/AppState.test.tsx`:

```tsx
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex, SignMessage, VoteDir } from "@/lib/types";
import { act, fireEvent, queryHarness, render, screen, waitFor } from "@/test/dom";
import { AppStateProvider, useAppState, type AppState } from "./AppState";

/** Checksummed, as wagmi reports it; the server's copy below is lowercase, as the cookie carries it. */
const WALLET = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" as Address;
const LOWER = WALLET.toLowerCase() as Address;
const TOKEN = "0x000000000000000000000000000000000000000a";

const h = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, isConnected: false },
  openConnectModal: vi.fn(),
  ds: {
    session: vi.fn<() => Promise<string | null>>(),
    signIn: vi.fn<(sign: SignMessage, address: string) => Promise<string>>(),
    signOut: vi.fn<() => Promise<void>>(),
    watchlist: vi.fn<() => Promise<string[]>>(),
    setWatch: vi.fn<(id: string, on: boolean) => Promise<void>>(),
    votes: vi.fn<() => Promise<Record<string, VoteDir>>>(),
    vote: vi.fn<(id: string, dir: VoteDir) => Promise<VoteDir | null>>(),
  },
}));

vi.mock("wagmi", () => ({ useAccount: () => h.account }));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: h.openConnectModal }) }));
vi.mock("@/lib/suits", () => ({ useIsSuitHolder: () => false }));
// `AppState.tsx` imports this as "./DataSource"; Vitest keys mocks by resolved path, and the `@/`
// alias resolves to the same file, so the spelling here does not have to match the import's.
vi.mock("@/context/DataSource", () => ({ useDataSource: () => h.ds }));

/** The fake wallet: one signature, always accepted, recorded for the assertion. */
const sign: SignMessage = vi.fn(async () => "0xsignature" as Hex);

/**
 * The live context value, captured after each commit. `completeSign` returns a promise that
 * rejects when the wallet or the server refuses, and a rejection nobody holds is an unhandled
 * error Vitest 4 fails the whole run on — so the refusal case awaits it from here instead of
 * firing it from a click and dropping it.
 */
let api: AppState | null = null;

function Probe() {
  const s = useAppState();
  useEffect(() => {
    api = s;
  });
  return (
    <div>
      <div data-testid="signed">{String(s.signed)}</div>
      <div data-testid="modal">{s.signModal?.kind ?? "none"}</div>
      <div data-testid="stars">{[...s.stars].join(",")}</div>
      <button type="button" onClick={() => s.toggleStar(TOKEN)}>
        star
      </button>
      <button
        type="button"
        // The real `SignModal` awaits inside a try/catch; the button must not float a rejection
        // either, so every path out of a click is handled.
        onClick={() => {
          s.completeSign(sign, WALLET).catch(() => {});
        }}
      >
        complete
      </button>
    </div>
  );
}

function show() {
  const { wrapper: QueryWrapper } = queryHarness();
  return render(
    <QueryWrapper>
      <AppStateProvider>
        <Probe />
      </AppStateProvider>
    </QueryWrapper>,
  );
}

describe("AppStateProvider sign-in", () => {
  beforeEach(() => {
    api = null;
    h.account = { address: WALLET, isConnected: true };
    h.openConnectModal.mockClear();
    h.ds.session.mockReset().mockResolvedValue(null);
    h.ds.signIn.mockReset().mockResolvedValue(LOWER);
    h.ds.watchlist.mockReset().mockResolvedValue([TOKEN]);
    h.ds.votes.mockReset().mockResolvedValue({});
    h.ds.setWatch.mockReset().mockResolvedValue(undefined);
    h.ds.vote.mockReset().mockResolvedValue("bull");
    (sign as ReturnType<typeof vi.fn>).mockClear();
  });

  it("seeds the session from the cookie, matching a lowercase address to a checksummed wallet", async () => {
    h.ds.session.mockResolvedValue(LOWER);
    show();
    await waitFor(() => expect(screen.getByTestId("signed").textContent).toBe("true"));
    // Signed in without a modal: the whole point of the cookie surviving a reload.
    expect(screen.getByTestId("modal").textContent).toBe("none");
    await waitFor(() => expect(h.ds.watchlist).toHaveBeenCalled());
  });

  it("leaves the user's lists alone until a session exists", async () => {
    show();
    await waitFor(() => expect(h.ds.session).toHaveBeenCalled());
    expect(h.ds.watchlist).not.toHaveBeenCalled();
    expect(h.ds.votes).not.toHaveBeenCalled();
  });

  it("opens the modal on a gated action and runs it once the sign-in lands", async () => {
    show();
    await waitFor(() => expect(h.ds.session).toHaveBeenCalled());

    fireEvent.click(screen.getByText("star"));
    expect(screen.getByTestId("modal").textContent).toBe("star");
    expect(h.ds.setWatch).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByText("complete"));
    });

    expect(h.ds.signIn).toHaveBeenCalledWith(sign, WALLET);
    await waitFor(() => expect(screen.getByTestId("signed").textContent).toBe("true"));
    expect(screen.getByTestId("modal").textContent).toBe("none");
    await waitFor(() => expect(h.ds.setWatch).toHaveBeenCalledWith(TOKEN, true));
    // The star is painted before the write settles and stays after the refetch.
    await waitFor(() => expect(screen.getByTestId("stars").textContent).toBe(TOKEN));
  });

  it("keeps the modal open and the session empty when the wallet or the server refuses", async () => {
    h.ds.signIn.mockRejectedValue(new Error("401"));
    show();
    await waitFor(() => expect(h.ds.session).toHaveBeenCalled());
    fireEvent.click(screen.getByText("star"));
    expect(screen.getByTestId("modal").textContent).toBe("star");

    // The rejection is awaited here rather than fired from the button and dropped: `completeSign`
    // must let the failure travel — that is how `SignModal` knows to stay open and show its line —
    // and a floating rejection is an unhandled error Vitest fails the run on.
    await act(async () => {
      await expect(api!.completeSign(sign, WALLET)).rejects.toThrow("401");
    });

    expect(screen.getByTestId("signed").textContent).toBe("false");
    expect(screen.getByTestId("modal").textContent).toBe("star");
    expect(h.ds.setWatch).not.toHaveBeenCalled();
  });

  it("asks for a wallet before a signature when nothing is connected", async () => {
    h.account = { address: undefined, isConnected: false };
    show();
    fireEvent.click(screen.getByText("star"));
    expect(h.openConnectModal).toHaveBeenCalled();
    expect(screen.getByTestId("modal").textContent).toBe("none");
  });
});
```

Run: `npx vitest run src/context/AppState.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 9: Write the `SignModal` test**

`src/components/SignModal.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "@/lib/types";
import { short } from "@/lib/format";
import { act, fireEvent, render, screen, waitFor } from "@/test/dom";
import SignModal from "./SignModal";

const WALLET = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" as Address;

const h = vi.hoisted(() => ({
  state: {
    signModal: { kind: "star" as "star" | "vote" },
    address: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" as string | undefined,
    completeSign: vi.fn<(sign: (m: string) => Promise<string>, address: string) => Promise<void>>(),
    cancelSign: vi.fn(),
  },
  signMessageAsync: vi.fn(async () => "0xsignature"),
}));

vi.mock("@/context/AppState", () => ({ useAppState: () => h.state }));
vi.mock("wagmi", () => ({
  useSignMessage: () => ({ signMessageAsync: h.signMessageAsync, isPending: false }),
}));

describe("SignModal", () => {
  beforeEach(() => {
    h.state.signModal = { kind: "star" };
    h.state.address = WALLET;
    h.state.completeSign.mockReset().mockResolvedValue(undefined);
    h.state.cancelSign.mockReset();
    h.signMessageAsync.mockClear();
  });

  it("shows what is about to be signed without inventing a message", () => {
    render(<SignModal />);
    expect(screen.getByText(`Sign in to SuitVentures Markets · ${short(WALLET)} · Chain 4663`)).toBeTruthy();
    expect(screen.getByText("Sign to save your watchlist")).toBeTruthy();
  });

  it("hands a signer and the address to completeSign, and signs nothing itself", async () => {
    render(<SignModal />);
    await act(async () => {
      fireEvent.click(screen.getByText("Sign message"));
    });
    expect(h.state.completeSign).toHaveBeenCalledTimes(1);
    const [sign, address] = h.state.completeSign.mock.calls[0];
    expect(address).toBe(WALLET);
    // The modal builds no text: the message it signs is the one it is handed.
    expect(h.signMessageAsync).not.toHaveBeenCalled();
    await sign("the server's message");
    expect(h.signMessageAsync).toHaveBeenCalledWith({ message: "the server's message" });
  });

  it("stays open with one plain line when the sign-in fails", async () => {
    h.state.completeSign.mockRejectedValue(new Error("401"));
    render(<SignModal />);
    await act(async () => {
      fireEvent.click(screen.getByText("Sign message"));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Sign-in didn't complete. Nothing was saved."));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("renders nothing without a gate or without a wallet", () => {
    h.state.address = undefined;
    const { container } = render(<SignModal />);
    expect(container.firstChild).toBeNull();
  });
});
```

Run: `npx vitest run src/components/SignModal.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 10: Run the gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green. `grep -rn "signature" src/context/AppState.tsx` matches one line and it is the comment `// A wallet connected while an action was waiting: continue to the signature.` — no signature is carried in client state any more. (The same grep over `src/lib/data` is *not* silent and must not be: `signIn` legitimately has `const signature = await sign(message)` and `JSON.stringify({ message, signature })`, which is the one place a signature exists at all, on its way to the route.) `grep -rn "LocalWatchStore" src` matches nothing; `grep -rn 'from "viem"' src/lib/data/envio.ts` matches nothing (the SIWE helper comes from `viem/siwe`).

- [ ] **Step 11: Commit**

```bash
git add src/lib/types.ts src/lib/data/envio.ts src/lib/data/envio.test.ts src/lib/data/mock.ts \
  src/hooks/useMarketsData.ts src/context/AppState.tsx src/context/AppState.test.tsx \
  src/components/SignModal.tsx src/components/SignModal.test.tsx src/lib/data/localStore.ts
git commit -m "Sign in with Ethereum and read the user's watchlist and votes from the session cookie" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

### Task 5: The top traders board

**Files:**
- Create: `src/app/api/traders/route.ts`, `src/app/api/traders/route.test.ts`, `src/app/traders/page.tsx`, `src/components/TradersBoard.tsx`, `src/components/TradersBoard.test.tsx`, `src/hooks/useMarketsData.test.tsx`
- Modify: `src/lib/types.ts` (`TradersBy` and `MarketsDataSource.traders` only — `TraderRow` is Task 2's and is not touched here), `src/lib/data/envio.ts` (`traders`, `StoreUnavailableError`), `src/lib/data/envio.test.ts` (three more tests), `src/lib/data/mock.ts` (a fixed list), `src/hooks/useMarketsData.ts` (`keys.traders`, `useTraders`), `src/components/TopBar.tsx` (one nav entry)
- Not modified: `src/lib/social/store.ts` — Task 2 already writes the `export type { TraderRow } from "@/lib/types";` re-export this task's board relies on.

**Interfaces:**
- Consumes: `topTraders(db, { sinceTs, by, limit })` from `@/lib/social/store` (Task 3); `hasDb()`, `getDb()` from `@/lib/db/client`; `cached`, `badRequest`, `failure` from `@/app/api/_lib/respond`; `ttlCache`, `clearTtlCache` from `@/lib/envio/cache`; `addressUrl` from `@/lib/chain`; `fmtUsd`, `fmtInt`, `short` from `@/lib/format`.
- Produces: `GET /api/traders?by=volume|trades` → `TraderRow[]`; `TradersBy` in `src/lib/types.ts` (`TraderRow` comes from Task 2); `MarketsDataSource.traders(by)`; `StoreUnavailableError` from `src/lib/data/envio.ts`; `useTraders(by)`; `TradersBoard`; the `/traders` page and its nav link.

Decisions where the spec and the contract left room (one line each):

- **`TraderRow` is declared in `src/lib/types.ts`, and `src/lib/social/store.ts` re-exports it.** The contract declares it in the store module, which sits next to `Db` and the `market` schema and is a server module by neighbourhood; a client component that imported a type from there would pull a `server-only` path into the browser bundle the day someone adds the marker. The type lives where every other shared shape lives and the store keeps its contracted export name with a one-line `export type { TraderRow } from "@/lib/types";`. **Both halves of that are Task 2's work and are already written** (Step 3 declares the interface in `types.ts` and the store module carries the re-export line): this task re-declares nothing and amends nothing, it only adds `TradersBy` and the `traders` method.
- **`volumeUsd` is a `number`, and that is not a Global Constraint 1 violation.** It is a display figure — a sum of quote amounts already multiplied by a USD price — and nothing on any execution path reads it. The contract says so in as many words ("the board's USD is display"); the comment on the field says so too, so nobody later reaches for it as an amount.
- **The 503 is decided before the query, and is not cached.** `hasDb()` is a synchronous environment check, so a build without a store never reaches `getDb()` and never allocates a connection; the answer carries `Cache-Control: no-store` so the CDN does not pin "no store" across the deploy that turns one on.
- **The cache key carries `by`, and the 24-hour window is computed inside the loader.** `ttlCache("traders:volume", …)` and `ttlCache("traders:trades", …)` are separate entries, so one ordering cannot serve the other; `sinceTs` is evaluated where the query is, so each recompute asks for the window ending now rather than the window that existed when the route module loaded.
- **A 503 from the route becomes `StoreUnavailableError` in the data source.** The board must tell "the store is not configured" apart from "the request failed", and matching on an error *message* is the kind of thing that breaks silently. A named class follows the repo's own pattern (`DbUnavailableError`, `EnvioUnavailableError`, `QuoterUnavailableError`) and is exported from `src/lib/data/envio.ts` for the component to test against with `instanceof`.
- **The toggle lives inside `TradersBoard`, the title on the page.** The page is a server component so it can carry `metadata`, exactly like the token page does, and the board is the client component that owns the `by` state — which also makes the DOM test a plain `render(<TradersBoard />)` with no router or page shell.
- **The board is its own table, not `PairsTable`.** `PairsTable` is built around a `TokenPair` row with stars, sparklines and a sort model; a five-column wallet ranking shares its type scale and hairlines and nothing else. The grid is the `HOLDER_COLS` idiom from `ActivityTabs`, which is what a reader of this repo already recognises as "a small ranked table".
- **The mock's list is fixed and small, and re-orders itself.** Three wallets whose volume ranking and trade-count ranking disagree, so a demo build's toggle visibly does something; the mock never throws `StoreUnavailableError`, because a demo build has no store to be missing.

- [ ] **Step 1: Declare the ordering in `src/lib/types.ts`**

`TraderRow` is already in `src/lib/types.ts` — Task 2 Step 3 put it there, with the `volumeUsd`
comment, and Task 2's `src/lib/social/store.ts` already carries the one-line re-export
`export type { TraderRow } from "@/lib/types";`. **Do not declare the interface again** (Ruling 5):
a second `export interface TraderRow` with the same members declaration-merges, so every gate stays
green while the file ends up carrying the type twice under two doc blocks.

So this step adds one type, just below `SignMessage` (added in Task 4):

```ts
/** How the traders board is ranked. */
export type TradersBy = "volume" | "trades";
```

and one method to `MarketsDataSource`, just above the `// --- The signed-in user's own data` comment:

```ts
  /** The top 50 wallets of the last 24 hours. Public: no session is involved. */
  traders(by: TradersBy): Promise<TraderRow[]>;
```

`TraderRow` is declared in this same file — Task 2 Step 3 appended it after `MarketsDataSource` — and
type declarations are hoisted within a module, so the method above may name it and no import line
here changes.

- [ ] **Step 2: Write the route**

`src/app/api/traders/route.ts`:

```ts
import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/envio/cache";
import { getDb, hasDb } from "@/lib/db/client";
import { topTraders } from "@/lib/social/store";
import type { TradersBy } from "@/lib/types";
import { badRequest, cached, failure } from "../_lib/respond";

export const dynamic = "force-dynamic";

const TTL = 60;
/** The board's window. Well inside the store's 10-day trade retention (D39, amended 18 Sep 2026). */
const WINDOW_SEC = 86_400;
const LIMIT = 50;

/**
 * The top 50 wallets of the last 24 hours by USD volume or by trade count. The indexer records a
 * swap's `wallet` as the transaction sender, so a routed trade counts for the person who made it
 * rather than for the router.
 *
 * Without a database there is nothing to rank: 503 with a plain sentence the page can print, and
 * `no-store`, so the CDN does not hold that answer past the deploy that configures the store.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("by") ?? "volume";
  if (raw !== "volume" && raw !== "trades") return badRequest("bad by");
  const by: TradersBy = raw;
  if (!hasDb()) {
    return NextResponse.json(
      { error: "traders board needs the market store" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    // One memo per ordering, and the window ends whenever the memo is refilled, not when this
    // module loaded.
    const rows = await ttlCache(`traders:${by}`, TTL * 1000, () =>
      topTraders(getDb(), { sinceTs: Math.floor(Date.now() / 1000) - WINDOW_SEC, by, limit: LIMIT }),
    );
    return cached(rows, TTL);
  } catch (err) {
    return failure(err);
  }
}
```

- [ ] **Step 3: Write the route test**

`src/app/api/traders/route.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DbUnavailableError } from "@/lib/db/client";
import { clearTtlCache } from "@/lib/envio/cache";
import type { Address, TraderRow } from "@/lib/types";
import { GET } from "./route";

const h = vi.hoisted(() => ({
  hasDb: vi.fn<() => boolean>(),
  topTraders: vi.fn<(db: unknown, opts: { sinceTs: number; by: string; limit: number }) => Promise<TraderRow[]>>(),
}));

// importOriginal, so `DbUnavailableError` stays the very class `failure()` tests against.
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  hasDb: h.hasDb,
  getDb: () => ({ kind: "fake-db" }),
}));
vi.mock("@/lib/social/store", () => ({ topTraders: h.topTraders }));

const ROW: TraderRow = {
  wallet: "0x1111111111111111111111111111111111111111" as Address,
  volumeUsd: 1_250_000,
  trades: 412,
  tokens: 9,
};

const call = (query = "") => GET(new Request(`http://localhost:3000/api/traders${query}`));

describe("GET /api/traders", () => {
  beforeEach(() => {
    clearTtlCache();
    h.hasDb.mockReset().mockReturnValue(true);
    h.topTraders.mockReset().mockResolvedValue([ROW]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("answers 503 with a sentence the page can print when there is no store", async () => {
    h.hasDb.mockReturnValue(false);
    const res = await call();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "traders board needs the market store" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(h.topTraders).not.toHaveBeenCalled();
  });

  it.each(["?by=hype", "?by=", "?by=VOLUME"])("rejects %s before touching the store", async (query) => {
    const res = await call(query);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad by" });
    expect(h.topTraders).not.toHaveBeenCalled();
  });

  it("ranks by volume over the last 24 hours by default, top 50, cached a minute", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([ROW]);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=60, stale-while-revalidate=60");
    const opts = h.topTraders.mock.calls[0][1];
    expect(opts.by).toBe("volume");
    expect(opts.limit).toBe(50);
    expect(Math.floor(Date.now() / 1000) - opts.sinceTs).toBe(86_400);
  });

  it("takes the trades ordering when asked for it", async () => {
    await call("?by=trades");
    expect(h.topTraders.mock.calls[0][1].by).toBe("trades");
  });

  it("memoises each ordering on its own for 60 s", async () => {
    await call("?by=volume");
    await call("?by=volume");
    expect(h.topTraders).toHaveBeenCalledTimes(1);
    await call("?by=trades");
    expect(h.topTraders).toHaveBeenCalledTimes(2);
  });

  it("answers 503 when the database itself is unreachable", async () => {
    h.topTraders.mockRejectedValue(new DbUnavailableError("database unavailable (ECONNREFUSED)"));
    const res = await call();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "database unavailable" });
  });
});
```

Run: `npx vitest run src/app/api/traders/route.test.ts`
Expected: PASS, 5 `it`s plus 3 from the `it.each` table — 8 tests.

- [ ] **Step 4: Add `traders` to both data sources**

In `src/lib/data/envio.ts`, add the error class just above `class EnvioDataSource` (after `toRouteAmount`):

```ts
/**
 * The route answered 503 because no market store is configured. Its own class, not a message to
 * match on: the board prints one sentence for this and a different one for a request that failed,
 * and a string comparison is exactly the kind of thing that stops matching without anyone noticing.
 */
export class StoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreUnavailableError";
  }
}
```

and this method to the class, just above the `// --- The signed-in user's own data` comment:

```ts
  async traders(by: TradersBy): Promise<TraderRow[]> {
    const res = await fetch(`/api/traders?by=${by}`, { cache: "no-store" });
    if (res.status === 503) throw new StoreUnavailableError("traders board needs the market store");
    if (!res.ok) throw new Error(`/api/traders: ${res.status}`);
    return (await res.json()) as TraderRow[];
  }
```

Widen the type import at the top of the file to carry `TraderRow` and `TradersBy`:

```ts
import type { Address, Candle, Denom, Holder, Interval, MarketsDataSource, Quote, QuoteAsset, Side, SignMessage, TokenPair, Trade, TraderRow, TradersBy, VoteDir } from "@/lib/types";
```

In `src/lib/data/mock.ts`, add the fixture above `export class MockDataSource` (after `generateHolders`):

```ts
/**
 * A fixed board for the demo: three wallets whose two rankings disagree, so the toggle visibly
 * does something. The demo has no store behind it, so this never fails the way the live route can.
 */
const MOCK_TRADERS: readonly TraderRow[] = [
  { wallet: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", volumeUsd: 1_284_500, trades: 96, tokens: 7 },
  { wallet: "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544", volumeUsd: 742_300, trades: 318, tokens: 12 },
  { wallet: "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18", volumeUsd: 118_900, trades: 41, tokens: 3 },
] as const;
```

and this method to the class, just above the user-data section:

```ts
  async traders(by: TradersBy): Promise<TraderRow[]> {
    await this.delay();
    return [...MOCK_TRADERS].sort((a, b) =>
      by === "trades" ? b.trades - a.trades : b.volumeUsd - a.volumeUsd,
    );
  }
```

Widen the mock's type import to carry `TraderRow` and `TradersBy` as well.

Append these three tests to `src/lib/data/envio.test.ts`, inside the `describe("EnvioDataSource sessions and user data")` block (the `routes` table and `calls` array are already in scope):

```ts
  it("asks the traders route for the ordering it was given", async () => {
    routes["GET /api/traders"] = { status: 200, body: [{ wallet: TOKEN, volumeUsd: 1, trades: 2, tokens: 3 }] };
    await expect(source().traders("trades")).resolves.toEqual([
      { wallet: TOKEN, volumeUsd: 1, trades: 2, tokens: 3 },
    ]);
    expect(calls.map((c) => c.url)).toEqual(["/api/traders?by=trades"]);
  });

  it("turns the route's 503 into StoreUnavailableError, which the board can tell apart", async () => {
    routes["GET /api/traders"] = { status: 503, body: { error: "traders board needs the market store" } };
    await expect(source().traders("volume")).rejects.toBeInstanceOf(StoreUnavailableError);
  });

  it("throws a plain error for any other traders failure", async () => {
    routes["GET /api/traders"] = { status: 500, body: { error: "internal error" } };
    await expect(source().traders("volume")).rejects.toThrow("500");
    await expect(source().traders("volume")).rejects.not.toBeInstanceOf(StoreUnavailableError);
  });
```

and widen that file's import of the module under test:

```ts
import { EnvioDataSource, StoreUnavailableError } from "./envio";
```

Run: `npx vitest run src/lib/data/envio.test.ts`
Expected: PASS, 36 tests (the 33 the file holds after Task 4, plus these three).

- [ ] **Step 5: Add the hook, and test it**

In `src/hooks/useMarketsData.ts`, add one key beside the others:

```ts
  traders: (by: TradersBy) => ["traders", by] as const,
```

and one hook at the end of the file:

```ts
/** The public traders board. No session: the counts and the ranking are the same for everyone. */
export function useTraders(by: TradersBy) {
  const ds = useDataSource();
  return useQuery({
    queryKey: keys.traders(by),
    queryFn: () => ds.traders(by),
    // The route caches for 60 s; asking more often than that only moves bytes.
    staleTime: 60_000,
  });
}
```

Widen the type import on line 5 to `import type { Denom, Interval, Side, TokenPair, TradersBy } from "@/lib/types";`.

`src/hooks/useMarketsData.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, TraderRow } from "@/lib/types";
import { queryHarness, renderHook, waitFor } from "@/test/dom";
import { keys, useTraders, useVotes, useWatchlist } from "./useMarketsData";

const ROW: TraderRow = {
  wallet: "0x1111111111111111111111111111111111111111" as Address,
  volumeUsd: 10,
  trades: 2,
  tokens: 1,
};

const h = vi.hoisted(() => ({
  ds: {
    traders: vi.fn<(by: string) => Promise<TraderRow[]>>(),
    watchlist: vi.fn<() => Promise<string[]>>(),
    votes: vi.fn<() => Promise<Record<string, never>>>(),
  },
}));

vi.mock("@/context/DataSource", () => ({ useDataSource: () => h.ds }));

describe("useMarketsData", () => {
  beforeEach(() => {
    h.ds.traders.mockReset().mockResolvedValue([ROW]);
    h.ds.watchlist.mockReset().mockResolvedValue([]);
    h.ds.votes.mockReset().mockResolvedValue({});
  });

  it("keys the traders board by its ordering and asks the source for that ordering", async () => {
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => useTraders("trades"), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([ROW]));
    expect(h.ds.traders).toHaveBeenCalledWith("trades");
    expect(keys.traders("trades")).toEqual(["traders", "trades"]);
    expect(keys.traders("volume")).not.toEqual(keys.traders("trades"));
  });

  it("keeps the user's lists unfetched until the caller says a session exists", async () => {
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => ({ w: useWatchlist(false), v: useVotes(false) }), { wrapper });
    // `enabled: false` parks a query as pending with nothing in flight — the one observable
    // difference between "disabled" and "loading".
    await waitFor(() => expect(result.current.w.fetchStatus).toBe("idle"));
    expect(h.ds.watchlist).not.toHaveBeenCalled();
    expect(h.ds.votes).not.toHaveBeenCalled();
  });

  it("fetches them once it does, on keys that name no wallet", async () => {
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => ({ w: useWatchlist(true), v: useVotes(true) }), { wrapper });
    await waitFor(() => expect(result.current.w.data).toEqual([]));
    expect(h.ds.watchlist).toHaveBeenCalledTimes(1);
    expect(keys.watchlist).toEqual(["watchlist"]);
    expect(keys.votes).toEqual(["votes"]);
  });
});
```

Run: `npx vitest run src/hooks/useMarketsData.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 6: Write the board**

`src/components/TradersBoard.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useTraders } from "@/hooks/useMarketsData";
import { addressUrl } from "@/lib/chain";
import { StoreUnavailableError } from "@/lib/data/envio";
import { fmtInt, fmtUsd, short } from "@/lib/format";
import type { TradersBy } from "@/lib/types";

const COLS =
  "grid grid-cols-[32px_minmax(0,1fr)_100px_64px] items-center gap-[10px] tablet:grid-cols-[32px_minmax(0,1fr)_120px_80px_80px]";

const ORDERINGS: ReadonlyArray<readonly [TradersBy, string]> = [
  ["volume", "24h volume"],
  ["trades", "Trades"],
];

function RowsSkeleton() {
  return (
    <div aria-busy>
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="flex h-8 items-center border-b border-hairline-soft">
          <span className="skeleton h-[10px]" style={{ width: 140 + ((i * 37) % 180) }} />
        </div>
      ))}
    </div>
  );
}

function Note({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="border-t border-hairline px-4 py-[72px] text-center">
      <div className="mb-[6px] text-[17px]">{title}</div>
      <div className="text-[12.5px] text-ink-50">{sub}</div>
    </div>
  );
}

export default function TradersBoard() {
  const [by, setBy] = useState<TradersBy>("volume");
  const { data, isPending, isError, error } = useTraders(by);
  const rows = data ?? [];

  return (
    <>
      <div className="mt-[14px] flex gap-[22px] border-b border-hairline" role="group" aria-label="Rank by">
        {ORDERINGS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={by === key}
            onClick={() => setBy(key)}
            className={`-mb-px h-[34px] border-b bg-transparent p-0 font-mono text-[10.5px] uppercase tracking-[0.22em] hover:text-white ${
              by === key ? "border-ink text-ink" : "border-transparent text-ink-50"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {isError ? (
        // The store is a deployment step, not a bug: say which of the two it is in plain words.
        error instanceof StoreUnavailableError ? (
          <Note
            title="The traders board needs the market store."
            sub="It turns on with the project's database. Everything else on the site is unaffected."
          />
        ) : (
          <Note title="Couldn't load the traders board." sub="Reload the page to try again." />
        )
      ) : (
        <div className="font-mono text-[12px] tabular-nums">
          <div className={`${COLS} h-[30px] border-b border-hairline text-[9.5px] uppercase tracking-[0.16em] text-ink-40`}>
            <div>#</div>
            <div>Wallet</div>
            <div className="text-right">24h volume</div>
            <div className="text-right">Trades</div>
            <div className="hidden text-right tablet:block">Tokens</div>
          </div>
          {isPending ? (
            <RowsSkeleton />
          ) : rows.length === 0 ? (
            <Note title="No trades in the last 24 hours." sub="The board fills as the chain does." />
          ) : (
            rows.map((t, i) => (
              <div
                key={t.wallet}
                className={`${COLS} h-8 whitespace-nowrap border-b border-hairline-soft hover:bg-hover-soft`}
              >
                <div className="text-ink-40">{i + 1}</div>
                <a
                  href={addressUrl(t.wallet)}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate text-ink-70 hover:text-ink"
                >
                  {short(t.wallet)}
                </a>
                <div className="text-right">{fmtUsd(t.volumeUsd)}</div>
                <div className="text-right text-ink-70">{fmtInt(t.trades)}</div>
                <div className="hidden text-right text-ink-70 tablet:block">{fmtInt(t.tokens)}</div>
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 7: Add the page and the nav link**

`src/app/traders/page.tsx`:

```tsx
import type { Metadata } from "next";
import TradersBoard from "@/components/TradersBoard";

export const metadata: Metadata = { title: "Traders" };

export default function TradersPage() {
  return (
    <section className="px-4 pb-8 tablet:px-5 desktop:px-6">
      <div className="mt-[18px] flex items-baseline gap-[14px]">
        <h1 className="text-[18px] font-medium tracking-[-0.01em]">Top traders</h1>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-40">
          Last 24 hours
        </span>
      </div>
      <TradersBoard />
    </section>
  );
}
```

In `src/components/TopBar.tsx`, replace the `NAV` constant (lines 10–13):

```tsx
const NAV = [
  { href: "/", label: "Markets" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/traders", label: "Traders" },
] as const;
```

Both navs — the tablet-and-up one in the header and the scrolling phone one below it — map over `NAV`, so this single edit puts the link in both.

- [ ] **Step 8: Write the board test**

`src/components/TradersBoard.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addressUrl } from "@/lib/chain";
import { StoreUnavailableError } from "@/lib/data/envio";
import { fmtInt, fmtUsd, short } from "@/lib/format";
import type { Address, TraderRow } from "@/lib/types";
import { fireEvent, render, screen, within } from "@/test/dom";
import TradersBoard from "./TradersBoard";

/**
 * No figure here may collide with a rank cell (`1`, `2`, `3`) inside its own row, or `getByText`
 * throws "found multiple elements" — which is why the third row's `tokens` is 5 rather than 3.
 */
const ROWS: TraderRow[] = [
  { wallet: "0x1111111111111111111111111111111111111111" as Address, volumeUsd: 1_284_500, trades: 96, tokens: 7 },
  { wallet: "0x2222222222222222222222222222222222222222" as Address, volumeUsd: 742_300, trades: 318, tokens: 12 },
  { wallet: "0x3333333333333333333333333333333333333333" as Address, volumeUsd: 118_900, trades: 41, tokens: 5 },
];

const h = vi.hoisted(() => ({
  rows: [] as TraderRow[],
  isPending: false,
  isError: false,
  error: undefined as unknown,
  seenBy: vi.fn(),
}));

vi.mock("@/hooks/useMarketsData", () => ({
  useTraders: (by: string) => {
    h.seenBy(by);
    return { data: h.rows, isPending: h.isPending, isError: h.isError, error: h.error };
  },
}));

describe("TradersBoard", () => {
  beforeEach(() => {
    h.rows = ROWS;
    h.isPending = false;
    h.isError = false;
    h.error = undefined;
    h.seenBy.mockClear();
  });

  it("ranks three wallets, each linked to the explorer, with its own volume, trades and tokens", () => {
    render(<TradersBoard />);
    for (const [i, row] of ROWS.entries()) {
      const link = screen.getByRole("link", { name: short(row.wallet) });
      expect(link.getAttribute("href")).toBe(addressUrl(row.wallet));
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noreferrer");
      // Every figure is read inside the row this wallet's own link sits in, so a mis-ordered board
      // fails here instead of reading "some 1 is somewhere on the page" — and a board-wide
      // `getByText(fmtInt(tokens))` would anyway throw on a count that some rank cell also renders.
      const rowEl = link.parentElement as HTMLElement;
      expect(rowEl.children[0]?.textContent).toBe(String(i + 1));
      expect(within(rowEl).getByText(fmtUsd(row.volumeUsd))).toBeTruthy();
      expect(within(rowEl).getByText(fmtInt(row.trades))).toBeTruthy();
      expect(within(rowEl).getByText(fmtInt(row.tokens))).toBeTruthy();
    }
  });

  it("starts on volume and switches the ordering it asks for", () => {
    render(<TradersBoard />);
    expect(h.seenBy).toHaveBeenLastCalledWith("volume");
    const trades = screen.getByRole("button", { name: "Trades" });
    expect(trades.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(trades);
    expect(h.seenBy).toHaveBeenLastCalledWith("trades");
    expect(screen.getByRole("button", { name: "Trades" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "24h volume" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("shows a skeleton while loading and keeps the toggle usable", () => {
    h.isPending = true;
    h.rows = [];
    render(<TradersBoard />);
    expect(document.querySelector("[aria-busy]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Trades" })).toBeTruthy();
  });

  it("says the board is empty rather than showing a bare table", () => {
    h.rows = [];
    render(<TradersBoard />);
    expect(screen.getByText("No trades in the last 24 hours.")).toBeTruthy();
  });

  it("explains a missing market store in plain words", () => {
    h.isError = true;
    h.error = new StoreUnavailableError("traders board needs the market store");
    h.rows = [];
    render(<TradersBoard />);
    expect(screen.getByText("The traders board needs the market store.")).toBeTruthy();
    expect(screen.queryByText("Couldn't load the traders board.")).toBeNull();
  });

  it("says something different when the request simply failed", () => {
    h.isError = true;
    h.error = new Error("/api/traders: 500");
    h.rows = [];
    render(<TradersBoard />);
    expect(screen.getByText("Couldn't load the traders board.")).toBeTruthy();
    expect(screen.queryByText("The traders board needs the market store.")).toBeNull();
  });
});
```

Run: `npx vitest run src/components/TradersBoard.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 9: Run the gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green. `npm run build` lists `/api/traders` as a dynamic route (ƒ) and `/traders` as a static page (○); `grep -c "getDb()" src/app/api/traders/route.ts` answers 1, and that call sits after the `hasDb()` guard.

- [ ] **Step 10: Commit**

```bash
git add src/lib/types.ts src/app/api/traders/route.ts src/app/api/traders/route.test.ts \
  src/app/traders/page.tsx src/components/TradersBoard.tsx src/components/TradersBoard.test.tsx \
  src/components/TopBar.tsx src/hooks/useMarketsData.ts src/hooks/useMarketsData.test.tsx \
  src/lib/data/envio.ts src/lib/data/envio.test.ts src/lib/data/mock.ts
git commit -m "Rank the last 24 hours of wallets on a traders board served from the market store" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

---

### Task 6: Documentation and environment

**Files:**
- Modify: `README.md` (frontend), `docs/superpowers/plans/2026-09-16-supabase-market-store.md`, `/Users/kobs/Desktop/SuitVenturesMarket/README.md` (the workspace repo, a level up)
- Not modified: `.env.example` — Task 1 Step 11 owns it (Ruling 17); Step 1 below only verifies the line is there.

**Interfaces:**
- Consumes: nothing at runtime. It records what Tasks 1–5 built.
- Produces: the frontend README's stub table telling the truth; runbook step R4 carrying the one variable and the one migration M4 adds; D35 in the workspace Decision Log amended to what was actually built. (`SESSION_SECRET` reached `.env.example` in Task 1.)

Decisions where the spec and the contract left room (one line each):

- **Two commits, because these are two repositories.** `/Users/kobs/Desktop/SuitVenturesMarket` is the workspace repo and tracks the frontend as a gitlink (its recent history is full of "frontend pointer at …" commits). The frontend's three files commit inside the frontend repo; the workspace README commits in the workspace repo together with the moved pointer, exactly as commit `3fafe9f` did.
- **`SESSION_SECRET` joins the bottom half of `.env.example`, in that half's style — and Task 1 is what writes it.** Everything above the `# Market store (server-only)` heading is a `NEXT_PUBLIC_` variable with a paragraph comment above it; everything below is a server variable with an inline comment beside it. The new one is server-only, so it takes the inline form and gets its own heading, which is also where M5's rate-limit knobs will go. It lands in Task 1's commit beside the module that reads it (Ruling 17), so this task neither appends it a second time nor stages the file.
- **The stub table's "Launchpad links" row is left alone.** It still reads "M3 — Bags dapp URL" and M3 has shipped, so it is stale — but it is stale about a different milestone, and rewriting rows this task did not touch is how a docs commit stops being reviewable. Flagged for Kobe instead.
- **D35's amendment names the three things that changed, and nothing else.** The Decision Log's convention (see D34, D39) is one dated sentence appended inside the existing cell, never a rewrite of the original text, so the original decision stays readable next to what it became.

- [ ] **Step 1: Check `SESSION_SECRET` is in `.env.example` — do not add it again**

Task 1 Step 11 appended it (Ruling 17), so this step writes nothing. Confirm the file ends with:

```
# Social layer (server-only)
SESSION_SECRET=          # 32 random bytes, `openssl rand -hex 32`; unset → sign-in and user data off, reads unaffected
```

Run: `grep -c "^SESSION_SECRET=" .env.example`
Expected: `1`. If it is `0`, Task 1 Step 11 was skipped — append the block above and say so in the
commit; if it is `2`, a second append crept in and one copy must be deleted before Step 5's grep.

- [ ] **Step 2: Tell the truth in the frontend `README.md` stub table**

In the "Stubs still to wire" table, replace this row (line 111):

```
| Watchlist / votes persistence | localStorage, in both sources | M3 — route handlers keyed by address, authorised by the session signature |
```

with these two:

```
| Watchlist / votes persistence | `src/lib/social/store.ts`, `/api/me/*` | **Done (M4)** — Sign-In with Ethereum opens an HttpOnly session cookie; the watchlist and the votes live in the market store, so one wallet sees the same lists on every device. The demo source still keeps them in `localStorage` |
| Top traders board | `src/app/traders`, `/api/traders` | **Done (M4)** — the last 24 hours of `market.swaps` ranked by USD volume or by trade count, 50 wallets, cached a minute |
```

The `Launchpad links for untradeable pools` row below them is untouched: its milestone tag is out of date, which is a separate correction for Kobe, not this commit's business.

- [ ] **Step 3: Carry the variable and the migration in runbook R4**

In `docs/superpowers/plans/2026-09-16-supabase-market-store.md`, inside the `R4` bullet, insert these two sentences immediately after `vercel env add MARKET_DATA_BACKEND production` with value `envio`.` and before `Push main; Vercel deploys with the crons.`:

```
`vercel env add SESSION_SECRET production` (sensitive, `openssl rand -hex 32`) — the social layer's cookie key (M4). Adding it is not a precondition for this step: while it is unset the session routes answer 503, the star and vote gates stay closed and every read on the site is unaffected, so it can land in this pass or a later one.
```

and these two immediately after that:

```
The social tables ship as their own migration, since R0 froze the original file: `npm run db:migrate` applies `supabase/migrations/20260919000000_social.sql` (`market.watchlist`, `market.votes`, index `votes_token`) the first time it runs against this database. Run it before the deploy, not after — the user routes answer 500 rather than 503 against a database that has `DATABASE_URL` but no social tables.
```

- [ ] **Step 4: Amend D35 in the workspace Decision Log**

In `/Users/kobs/Desktop/SuitVenturesMarket/README.md`, the D35 row of the Decision Log table (line 294) currently ends:

```
… Updated Sep 16, 2026 (K): Supabase holds the market data mirror as well as watchlists and votes (D39); the part that is not on-chain is still only the user data. | P, K |
```

Append this sentence inside the same cell, before the closing ` | P, K |`:

```
Amended Sep 18, 2026 (C via K): the signed message is a Sign-In with Ethereum (EIP-4361) message the server verifies, and the session it opens lives in an HttpOnly cookie for seven days rather than in the browser's memory, so one wallet sees the same watchlist and votes on every device; the bull and bear counts are public while each wallet's own list and vote are not; the top traders board ranks the last 24 hours out of the store's 10-day trade window (D39).
```

so the cell ends:

```
… the part that is not on-chain is still only the user data. Amended Sep 18, 2026 (C via K): the signed message is a Sign-In with Ethereum (EIP-4361) message the server verifies, and the session it opens lives in an HttpOnly cookie for seven days rather than in the browser's memory, so one wallet sees the same watchlist and votes on every device; the bull and bear counts are public while each wallet's own list and vote are not; the top traders board ranks the last 24 hours out of the store's 10-day trade window (D39). | P, K |
```

- [ ] **Step 5: Verify the four edits and run the gates**

Run: `npm test && npx tsc --noEmit && npx eslint . && npm run build`
Expected: all green, unchanged from Task 5 — this task touches no code.

Run these five greps from the frontend directory:

```bash
grep -c "^SESSION_SECRET=" .env.example
grep -n "Done (M4)" README.md
grep -n "SESSION_SECRET" docs/superpowers/plans/2026-09-16-supabase-market-store.md
grep -n "20260919000000_social.sql" docs/superpowers/plans/2026-09-16-supabase-market-store.md
grep -c "EIP-4361" ../README.md
```

Expected: `1` for `SESSION_SECRET` in `.env.example` — exactly one key, written by Task 1 and already committed there, so `git status` shows `.env.example` unchanged in this task; two lines carrying `**Done (M4)**` in the README; one line for `SESSION_SECRET` inside the R4 bullet; one line naming the migration, spelt exactly as Task 2 Step 1 created it; `1` from the workspace README. And `grep -rn "SESSION_SECRET" .env.local` must never be run and the file never printed.

- [ ] **Step 6: Commit, in both repositories**

In the frontend repository — `.env.example` is deliberately not staged here; it belongs to Task 1's commit:

```bash
git add README.md docs/superpowers/plans/2026-09-16-supabase-market-store.md
git commit -m "Document the social migration, the session secret's rollout step and the traders board" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```

Then in the workspace repository, which also moves the frontend pointer to that commit:

```bash
cd /Users/kobs/Desktop/SuitVenturesMarket
git add README.md SuitVenturesMarket-frontend
git commit -m "Decision Log: D35 amended for the SIWE session, public counts and the traders board; frontend pointer" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016tofArVnM9erCZUwPku467"
```
