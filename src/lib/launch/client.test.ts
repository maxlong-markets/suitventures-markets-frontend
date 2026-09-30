import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchFields } from "./fields";
import {
  UNSETTLED_KEY, UPLOAD_MESSAGES, UPLOAD_REUSE_MS, UploadError, forgetUnsettled, parseUnsettled, readUnsettled, rememberUnsettled,
  subscribeUnsettled, uploadKey, uploadLaunchAssets,
} from "./client";

const FIELDS: LaunchFields = { name: "Tailor's Chalk", symbol: "CHALK", description: "", website: "", x: "@chalk", telegram: "" };
const WALLET = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" as `0x${string}`;
const OTHER_WALLET = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const IMAGE = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", { type: "image/png", lastModified: 1 });
const answer = { imageCid: "bafyimg", metadataCid: "bafymeta", metadataUri: "ipfs://bafymeta" };
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("uploadLaunchAssets (spec 7.2, submit step 2)", () => {
  it("POSTs the image and the six fields as multipart to the upload route, with the session cookie, and answers the CIDs", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json(answer, 200));
    await expect(uploadLaunchAssets(FIELDS, IMAGE, fetchImpl)).resolves.toEqual(answer);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/launch/upload");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    const body = init!.body as FormData;
    expect([...body.keys()].sort()).toEqual(["description", "image", "name", "symbol", "telegram", "website", "x"]);
    expect(body.get("x")).toBe("@chalk");
    expect(body.get("image")).toBeInstanceOf(File);
  });

  it("turns each refusal into one plain sentence", async () => {
    const cases: ReadonlyArray<[number, unknown, string]> = [
      [401, { error: "not signed in" }, UPLOAD_MESSAGES.signIn],
      [429, { error: "upload-limit", code: "upload-limit" }, UPLOAD_MESSAGES.limit],
      [429, "too many requests", UPLOAD_MESSAGES.limit],
      [403, { error: "x", code: "not-allowed" }, UPLOAD_MESSAGES.notAllowed],
      [503, { error: "x", code: "not-live" }, UPLOAD_MESSAGES.notLive],
      [413, { error: "too-large", code: "too-large" }, UPLOAD_MESSAGES.tooLarge],
      [415, { error: "bad-image", code: "bad-image" }, UPLOAD_MESSAGES.badImage],
      [422, { error: "unreadable-image", code: "unreadable-image" }, UPLOAD_MESSAGES.badImage],
      [400, { error: "x", code: "bad-field" }, "Check the X field."],
      [400, { error: "telegram", code: "bad-field" }, "Check the Telegram field."],
      [502, { error: "storage-failed", code: "storage-failed" }, UPLOAD_MESSAGES.failed],
      [503, { error: "x", code: "gate-unavailable" }, UPLOAD_MESSAGES.failed],
    ];
    for (const [status, body, message] of cases) {
      const fetchImpl = vi.fn(async () => (typeof body === "string" ? new Response(body, { status }) : json(body, status)));
      const err = await uploadLaunchAssets(FIELDS, IMAGE, fetchImpl).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UploadError);
      expect((err as Error).message).toBe(message);
    }
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(uploadLaunchAssets(FIELDS, IMAGE, offline)).rejects.toThrow(UPLOAD_MESSAGES.failed);
  });

  it("keys an answer to this image and these fields, so a retry reuses it and any change uploads again", () => {
    expect(UPLOAD_REUSE_MS).toBe(12 * 3600 * 1000);
    const key = uploadKey(FIELDS, IMAGE, WALLET);
    expect(uploadKey({ ...FIELDS }, IMAGE, WALLET)).toBe(key);
    expect(uploadKey({ ...FIELDS, website: "https://chalk.test" }, IMAGE, WALLET)).not.toBe(key);
    expect(uploadKey(FIELDS, new File([new Uint8Array([1])], "logo.png", { type: "image/png", lastModified: 1 }), WALLET)).not.toBe(key);
  });

  // UX review, should fix 15: the store links an upload to a launch only when the same wallet made both, so another
  // wallet's upload would launch the coin with no image, description or links.
  it("keys an answer to the wallet too, so another wallet never reuses it, whatever the address's letter case", () => {
    const key = uploadKey(FIELDS, IMAGE, WALLET);
    expect(uploadKey(FIELDS, IMAGE, OTHER_WALLET)).not.toBe(key);
    expect(uploadKey(FIELDS, IMAGE, WALLET.toUpperCase().replace("0X", "0x") as typeof WALLET)).toBe(key);
  });

  // UX review, blocker B2: the form drops the session on this code, so the next press of Launch asks for the signature.
  it("answers a 401 with the not-signed-in code and a line that says what the next press does", async () => {
    const err = await uploadLaunchAssets(FIELDS, IMAGE, vi.fn(async () => json({ error: "not signed in" }, 401))).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "UploadError", code: "not-signed-in" });
    expect((err as Error).message).toBe("Your sign-in has expired. Press Launch to sign in again.");
  });
});

// Fix round 1, ruling 6: a reload must not turn a launch that may have landed into a blank form, one press from a second coin.
describe("the tab's memory of a launch whose outcome is not known", () => {
  const TOKEN = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as `0x${string}`;
  const TX = `0x${"11".repeat(32)}` as `0x${string}`;
  let items: Map<string, string>;
  const storage = (o: { get?: () => never; set?: () => never; remove?: () => never } = {}) => ({
    getItem: o.get ?? ((k: string) => items.get(k) ?? null),
    setItem: o.set ?? ((k: string, v: string) => void items.set(k, v)),
    removeItem: o.remove ?? ((k: string) => void items.delete(k)),
  });
  const refuse = (): never => {
    throw new Error("The operation is insecure.");
  };

  beforeEach(() => {
    items = new Map();
    vi.stubGlobal("window", { sessionStorage: storage() });
  });
  afterEach(() => {
    forgetUnsettled();
    vi.unstubAllGlobals();
  });

  it("remembers the wallet, the predicted token, the hash when known and the time, and forgets it on request", () => {
    rememberUnsettled({ wallet: WALLET, token: TOKEN, hash: TX, at: 1_790_000_000_000 });
    expect(parseUnsettled(readUnsettled())).toEqual({ wallet: WALLET.toLowerCase(), token: TOKEN, hash: TX, at: 1_790_000_000_000 });
    expect(JSON.parse(items.get(UNSETTLED_KEY)!)).toMatchObject({ wallet: WALLET.toLowerCase(), token: TOKEN, hash: TX });
    forgetUnsettled();
    expect(readUnsettled()).toBeNull();
    expect(items.has(UNSETTLED_KEY)).toBe(false);
    rememberUnsettled({ wallet: WALLET, token: TOKEN, at: 5 }); // no hash: the wallet erred after it was asked to send
    expect(parseUnsettled(readUnsettled())).toEqual({ wallet: WALLET.toLowerCase(), token: TOKEN, at: 5 });
  });

  it("tells its listeners about every change, until they stop listening", () => {
    const listener = vi.fn();
    const stop = subscribeUnsettled(listener);
    rememberUnsettled({ wallet: WALLET, token: TOKEN, at: 1 });
    forgetUnsettled();
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    rememberUnsettled({ wallet: WALLET, token: TOKEN, at: 2 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("reads nothing and throws nothing when the storage refuses, and never reads back a record it was told to forget", () => {
    vi.stubGlobal("window", { sessionStorage: storage({ get: refuse, set: refuse, remove: refuse }) });
    expect(readUnsettled()).toBeNull();
    expect(() => rememberUnsettled({ wallet: WALLET, token: TOKEN, at: 1 })).not.toThrow();
    expect(() => forgetUnsettled()).not.toThrow();
    // A storage that reads but will not remove: the forgotten record stays on disk and must not come back.
    items.set(UNSETTLED_KEY, JSON.stringify({ wallet: WALLET.toLowerCase(), token: TOKEN, at: 1 }));
    vi.stubGlobal("window", { sessionStorage: storage({ remove: refuse }) });
    expect(readUnsettled()).not.toBeNull();
    forgetUnsettled();
    expect(readUnsettled()).toBeNull();
    rememberUnsettled({ wallet: WALLET, token: TOKEN, at: 2 }); // a newer record is read again
    expect(parseUnsettled(readUnsettled())).toMatchObject({ at: 2 });
  });

  it("reads nothing where there is no window, as on the server", () => {
    vi.unstubAllGlobals();
    expect(readUnsettled()).toBeNull();
    expect(() => rememberUnsettled({ wallet: WALLET, token: TOKEN, at: 1 })).not.toThrow();
  });

  it("ignores anything that is not one of its own records", () => {
    const bad = [
      "", "{", "null", "[]", "42",
      JSON.stringify({ wallet: "0x12", token: TOKEN, at: 1 }),
      JSON.stringify({ wallet: WALLET, token: "not an address", at: 1 }),
      JSON.stringify({ wallet: WALLET, token: TOKEN, hash: "0x12", at: 1 }),
      JSON.stringify({ wallet: WALLET, token: TOKEN, at: "soon" }),
    ];
    for (const raw of bad) expect(parseUnsettled(raw)).toBeNull();
    expect(parseUnsettled(null)).toBeNull();
  });
});
