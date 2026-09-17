import "server-only";

export class EnvioUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvioUnavailableError";
  }
}

/**
 * Every request is bounded: the sync's lease (120 s) must outlive any request plus its retries, and undici's own
 * header timeout (300 s) would not. The signal covers the body read as well as the connection.
 */
export const GQL_TIMEOUT_MS = 20_000;

/** An abort by our own timeout signal (TimeoutError), or an external abort; either way the indexer did not answer in time. */
const isAbort = (err: unknown) => {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
};

/** The only place the app talks to the indexer. Server-only: reads ENVIO_* env vars. `timeoutMs` (default GQL_TIMEOUT_MS) bounds the whole request; a timeout is "indexer unreachable: timeout", which the sync's retry rule covers. */
export async function gql<T>(query: string, variables: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
  const url = process.env.ENVIO_GRAPHQL_URL;
  if (!url) throw new EnvioUnavailableError("ENVIO_GRAPHQL_URL is not set");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.ENVIO_GRAPHQL_KEY) headers.Authorization = `Bearer ${process.env.ENVIO_GRAPHQL_KEY}`;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? GQL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ query, variables }), cache: "no-store", signal });
  } catch (err) {
    throw new EnvioUnavailableError(isAbort(err) ? "indexer unreachable: timeout" : `indexer unreachable: ${String(err)}`);
  }
  if (!res.ok) throw new EnvioUnavailableError(`indexer responded ${res.status}`);
  // A gateway can answer 200 with an HTML error page; every indexer failure has to
  // surface as EnvioUnavailableError so the routes can answer 503, not 500.
  let body: { data?: T; errors?: { message: string }[] };
  try {
    body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  } catch (err) {
    if (isAbort(err)) throw new EnvioUnavailableError("indexer unreachable: timeout");
    throw new EnvioUnavailableError(`indexer returned a non-JSON body: ${String(err)}`);
  }
  if (body.errors?.length || !body.data) {
    throw new EnvioUnavailableError(`indexer query failed: ${body.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
  }
  return body.data;
}
