import { describe, it, expect, vi, beforeEach } from "vitest";
import { gql, EnvioUnavailableError } from "./client";

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
});
