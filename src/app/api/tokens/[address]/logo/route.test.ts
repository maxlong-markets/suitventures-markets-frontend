import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOTAL_BUDGET_MS, resolveLogo, type ResolvedLogo } from "@/lib/logos/resolve";
import { GET } from "./route";

/**
 * Only the resolver is stubbed. `guardedFetch`, `normaliseImageType` and the rest stay real, so
 * these cases exercise the code the browser actually depends on — the redirect guard, the size
 * cap, the media-type gate — against a stubbed network rather than against more mocks.
 */
vi.mock("@/lib/logos/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logos/resolve")>()),
  resolveLogo: vi.fn(),
}));

const resolveLogoMock = vi.mocked(resolveLogo);
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const ADDR = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const A = "https://gateway.pinata.cloud/ipfs/bafyA";
const B = "https://dweb.link/ipfs/bafyB";

const HIT_CACHE = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400";
const HOUR_CACHE = "public, max-age=3600, s-maxage=3600";
const UNAVAILABLE_CACHE = "public, max-age=60, s-maxage=60";

const call = (address = ADDR, search = "") =>
  GET(new Request(`http://localhost:3100/api/tokens/${address}/logo${search}`), {
    params: Promise.resolve({ address }),
  });

const found = (candidates: string[]): { logo: ResolvedLogo; definite: boolean } => ({
  logo: { candidates, source: "long" },
  definite: true,
});

const image = (byteLength: number, contentType = "image/png", extra: Record<string, string> = {}) =>
  new Response(new Uint8Array(byteLength), {
    status: 200,
    headers: { "content-type": contentType, ...extra },
  });

beforeEach(() => {
  resolveLogoMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/tokens/[address]/logo", () => {
  it("rejects a malformed address, and lets the CDN hold that answer", async () => {
    const res = await call("not-an-address");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad address" });
    expect(res.headers.get("Cache-Control")).toBe(HOUR_CACHE);
    expect(resolveLogoMock).not.toHaveBeenCalled();
  });

  it("rejects a query string before doing any work", async () => {
    // Without this, `?x=1`, `?x=2`, ... are all distinct URLs that miss the CDN and land on the
    // gateways behind this route: an open proxy with no rate limit of its own.
    const res = await call(ADDR, "?x=1");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "no query allowed" });
    expect(res.headers.get("Cache-Control")).toBe(HOUR_CACHE);
    expect(resolveLogoMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 404 no logo for an hour when nothing has one", async () => {
    resolveLogoMock.mockResolvedValue({ logo: null, definite: true });
    const res = await call();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "no logo" });
    expect(res.headers.get("Cache-Control")).toBe(HOUR_CACHE);
  });

  it("answers 404 unavailable for a minute when the resolver could not find out", async () => {
    // The distinction that matters: an RPC blip must not blank this token for an hour.
    resolveLogoMock.mockResolvedValue({ logo: null, definite: false });
    const res = await call();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "logo unavailable" });
    expect(res.headers.get("Cache-Control")).toBe(UNAVAILABLE_CACHE);
  });

  it("walks past a failed candidate and serves the next one", async () => {
    resolveLogoMock.mockResolvedValue(found([A, B]));
    fetchMock
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockResolvedValueOnce(image(64, "IMAGE/PNG; charset=binary"));
    const res = await call();
    expect(res.status).toBe(200);
    // The normalised type, not the upstream's casing and parameters.
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe(HIT_CACHE);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await res.arrayBuffer()).byteLength).toBe(64);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([A, B]);
  });

  it("skips a candidate that declares more than 2 MB", async () => {
    resolveLogoMock.mockResolvedValue(found([A, B]));
    fetchMock
      .mockResolvedValueOnce(image(10, "image/png", { "content-length": String(3 * 1024 * 1024) }))
      .mockResolvedValueOnce(image(32));
    const res = await call();
    expect(res.status).toBe(200);
    // Proves the header did the skipping: the oversized response carried a perfectly good
    // 10-byte PNG body, so anything but a content-length check would have served it.
    expect((await res.arrayBuffer()).byteLength).toBe(32);
  });

  it("skips a non-raster type rather than serving script from this origin", async () => {
    resolveLogoMock.mockResolvedValue(found([A, B]));
    fetchMock
      .mockResolvedValueOnce(image(128, "image/svg+xml"))
      .mockResolvedValueOnce(image(32));
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect((await res.arrayBuffer()).byteLength).toBe(32);
  });

  it("skips a 0-byte body", async () => {
    // A gateway answering 200 with nothing would otherwise be cached as a good logo for a day.
    resolveLogoMock.mockResolvedValue(found([A, B]));
    fetchMock.mockResolvedValueOnce(image(0)).mockResolvedValueOnce(image(32));
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(32);
  });

  it("answers 404 unavailable for a minute when every candidate fails", async () => {
    resolveLogoMock.mockResolvedValue(found([A, B]));
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    const res = await call();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "logo unavailable" });
    expect(res.headers.get("Cache-Control")).toBe(UNAVAILABLE_CACHE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops walking candidates once the budget is spent", async () => {
    resolveLogoMock.mockResolvedValue(found([A, B]));
    const t0 = 1_800_000_000_000;
    // First reading sets the deadline; every later one is past it.
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(t0)
      .mockReturnValue(t0 + TOTAL_BUDGET_MS + 1);
    const res = await call();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "logo unavailable" });
    expect(res.headers.get("Cache-Control")).toBe(UNAVAILABLE_CACHE);
  });

  it("hands the resolver the same deadline it uses for the candidates", async () => {
    resolveLogoMock.mockResolvedValue({ logo: null, definite: true });
    const t0 = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(t0);
    await call();
    expect(resolveLogoMock).toHaveBeenCalledWith(ADDR, undefined, t0 + TOTAL_BUDGET_MS);
  });
});
