import { describe, expect, it, vi } from "vitest";
import type { LaunchFields } from "./fields";
import { UPLOAD_MESSAGES, UPLOAD_REUSE_MS, UploadError, uploadKey, uploadLaunchAssets } from "./client";

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
