import "server-only";

export class EnvioUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvioUnavailableError";
  }
}

/** The only place the app talks to the indexer. Server-only: reads ENVIO_* env vars. */
export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const url = process.env.ENVIO_GRAPHQL_URL;
  if (!url) throw new EnvioUnavailableError("ENVIO_GRAPHQL_URL is not set");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.ENVIO_GRAPHQL_KEY) headers.Authorization = `Bearer ${process.env.ENVIO_GRAPHQL_KEY}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ query, variables }), cache: "no-store" });
  } catch (err) {
    throw new EnvioUnavailableError(`indexer unreachable: ${String(err)}`);
  }
  if (!res.ok) throw new EnvioUnavailableError(`indexer responded ${res.status}`);
  // A gateway can answer 200 with an HTML error page; every indexer failure has to
  // surface as EnvioUnavailableError so the routes can answer 503, not 500.
  let body: { data?: T; errors?: { message: string }[] };
  try {
    body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  } catch (err) {
    throw new EnvioUnavailableError(`indexer returned a non-JSON body: ${String(err)}`);
  }
  if (body.errors?.length || !body.data) {
    throw new EnvioUnavailableError(`indexer query failed: ${body.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
  }
  return body.data;
}
