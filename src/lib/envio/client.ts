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
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length || !body.data) {
    throw new EnvioUnavailableError(`indexer query failed: ${body.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
  }
  return body.data;
}
