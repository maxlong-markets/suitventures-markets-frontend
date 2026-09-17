import { describe, it, expect, vi, beforeEach } from "vitest";
import { GQL_TIMEOUT_MS, gql, EnvioUnavailableError } from "./client";

describe("gql", () => {
  beforeEach(() => {
    process.env.ENVIO_GRAPHQL_URL = "https://indexer.test/v1/graphql";
    process.env.ENVIO_GRAPHQL_KEY = "tok";
  });
  it("posts the query with the bearer token and returns data", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ data: { Pool: [{ id: "0x1" }] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const data = await gql<{ Pool: { id: string }[] }>("query { Pool { id } }");
    expect(data.Pool[0]?.id).toBe("0x1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://indexer.test/v1/graphql");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
  });
  it("throws EnvioUnavailableError on GraphQL errors and non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 200 })));
    await expect(gql("query { x }")).rejects.toBeInstanceOf(EnvioUnavailableError);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 502 })));
    await expect(gql("query { x }")).rejects.toBeInstanceOf(EnvioUnavailableError);
  });
  it("throws EnvioUnavailableError when a 200 carries a non-JSON body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>gateway</html>", { status: 200 })));
    await expect(gql("query { x }")).rejects.toBeInstanceOf(EnvioUnavailableError);
  });
  it("hands fetch a 20 s timeout signal", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await gql("query { x }");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(false);
    expect(GQL_TIMEOUT_MS).toBe(20_000);
  });
  it("aborts a request that outlives the timeout and reports it as unreachable, which the sync's retry rule covers", async () => {
    // A fetch that never answers on its own and settles only when its signal fires, as undici's does.
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
    }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await gql("query { x }", {}, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvioUnavailableError);
    expect((err as Error).message).toBe("indexer unreachable: timeout");
  });
  it("reports a body read cut off by the timeout the same way", async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} }); // never closes
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const res = new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      // Reading the body after the abort rejects with the signal's reason, as undici's body stream does.
      res.json = () => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
      return res;
    }));
    const err = await gql("query { x }", {}, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvioUnavailableError);
    expect((err as Error).message).toBe("indexer unreachable: timeout");
  });
});
