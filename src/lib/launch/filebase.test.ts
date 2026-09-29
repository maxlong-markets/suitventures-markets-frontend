import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilebaseError, deleteObject, filebaseConfig, headObject, putObject, storageStatus, type FilebaseConfig } from "./filebase";

const CFG: FilebaseConfig = { accessKey: "test-access", secretKey: "test-secret", bucket: "test-bucket" };
const CID = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";
const seen: Request[] = [];
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  seen.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    seen.push(req);
    return req.method === "PUT" ? new Response(null, { status: 200, headers: { "x-amz-meta-cid": CID } }) : new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("filebaseConfig", () => {
  it("is null unless all three server-side names are set, and never needs the gateway", () => {
    vi.stubEnv("FILEBASE_ACCESS_KEY", "a");
    vi.stubEnv("FILEBASE_SECRET_KEY", "s");
    vi.stubEnv("FILEBASE_BUCKET", "");
    expect(filebaseConfig()).toBeNull();
    vi.stubEnv("FILEBASE_BUCKET", "b");
    vi.stubEnv("FILEBASE_GATEWAY_URL", "");
    expect(filebaseConfig()).toEqual({ accessKey: "a", secretKey: "s", bucket: "b" });
  });

  it("ignores whitespace pasted around a value, and treats a whitespace-only value as unset", () => {
    vi.stubEnv("FILEBASE_ACCESS_KEY", " a ");
    vi.stubEnv("FILEBASE_SECRET_KEY", "s\n");
    vi.stubEnv("FILEBASE_BUCKET", "\nb");
    expect(filebaseConfig()).toEqual({ accessKey: "a", secretKey: "s", bucket: "b" });
    vi.stubEnv("FILEBASE_BUCKET", " \n");
    expect(filebaseConfig()).toBeNull();
  });
});

describe("putObject and deleteObject (spec 6 step 11 and the orphan phase)", () => {
  it("signs a PUT to the bucket's key with SigV4 and answers the CID Filebase returns", async () => {
    await expect(putObject(CFG, "launch/img/abc.webp", new Uint8Array([1, 2, 3]), "image/webp")).resolves.toBe(CID);
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect([req.method, req.url]).toEqual(["PUT", "https://s3.filebase.com/test-bucket/launch/img/abc.webp"]);
    expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=test-access\/\d{8}\/us-east-1\/s3\/aws4_request/);
    expect(req.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await req.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("fails with FilebaseError on a refusal, a missing CID header, or no answer, and never retries", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("no", { status: 500 }));
    await expect(putObject(CFG, "k", new Uint8Array([1]), "image/webp")).rejects.toBeInstanceOf(FilebaseError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 200 }));
    await expect(putObject(CFG, "k", new Uint8Array([1]), "image/webp")).rejects.toThrow(/no CID/);
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 200, headers: { "x-amz-meta-cid": '"},"x":"javascript:1' } }));
    await expect(putObject(CFG, "k", new Uint8Array([1]), "image/webp")).rejects.toThrow(/no CID/);
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 200, headers: { "x-amz-meta-cid": "bafyTooShort" } }));
    await expect(putObject(CFG, "k", new Uint8Array([1]), "image/webp")).rejects.toThrow(/no CID/);
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(putObject(CFG, "k", new Uint8Array([1]), "image/webp")).rejects.toBeInstanceOf(FilebaseError);
  });

  it("accepts a CIDv0 and a base32 CIDv1", async () => {
    const v0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 200, headers: { "x-amz-meta-cid": v0 } }));
    await expect(putObject(CFG, "k", new Uint8Array([1]), "image/webp")).resolves.toBe(v0);
    await expect(putObject(CFG, "k", new Uint8Array([1]), "image/webp")).resolves.toBe(CID);
  });

  it("reports the bucket check for health: ok, Filebase's own answer, no answer, or unset, with the configuration's shape", async () => {
    fetchMock.mockImplementationOnce(async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      seen.push(req);
      return new Response(null, { status: 200 });
    });
    await expect(storageStatus(CFG)).resolves.toEqual({ status: "ok", accessKeyLength: 11, secretKeyLength: 11, bucketLength: 11 });
    expect([seen[0]!.method, seen[0]!.url]).toEqual(["HEAD", "https://s3.filebase.com/test-bucket"]);
    expect(seen[0]!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=test-access\//);
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 403 }));
    await expect(storageStatus(CFG)).resolves.toMatchObject({ status: "answered 403", bucketLength: 11 });
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(storageStatus(CFG)).resolves.toMatchObject({ status: "no answer" });
    await expect(storageStatus(null)).resolves.toEqual({ status: "unset" });
  });

  it("deletes a key, treating an already-missing object as deleted", async () => {
    await deleteObject(CFG, "launch/meta/abc.json");
    expect([seen[0]!.method, seen[0]!.url]).toEqual(["DELETE", "https://s3.filebase.com/test-bucket/launch/meta/abc.json"]);
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 404 }));
    await expect(deleteObject(CFG, "gone")).resolves.toBeUndefined();
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 403 }));
    await expect(deleteObject(CFG, "k")).rejects.toBeInstanceOf(FilebaseError);
  });

  it("heads a key with the same signing: Last-Modified in unix seconds, null once the object is gone, an error otherwise", async () => {
    fetchMock.mockImplementationOnce(async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      seen.push(req);
      return new Response(null, { status: 200, headers: { "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT" } });
    });
    await expect(headObject(CFG, "launch/img/abc.webp")).resolves.toBe(Date.UTC(2026, 9, 21, 7, 28, 0) / 1000);
    expect([seen[0]!.method, seen[0]!.url]).toEqual(["HEAD", "https://s3.filebase.com/test-bucket/launch/img/abc.webp"]);
    expect(seen[0]!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=test-access\//);
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 404 }));
    await expect(headObject(CFG, "gone")).resolves.toBeNull();
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 200 }));
    await expect(headObject(CFG, "k")).rejects.toThrow(/Last-Modified/);
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    await expect(headObject(CFG, "k")).rejects.toBeInstanceOf(FilebaseError);
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(headObject(CFG, "k")).rejects.toBeInstanceOf(FilebaseError);
  });
});
