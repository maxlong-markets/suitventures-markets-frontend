import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Testing Library's automatic unmount only runs when Vitest's globals are enabled; this
 * suite imports its API explicitly, so every file that imports this module registers the
 * unmount once, exactly as `@testing-library/react` does for itself under globals.
 */
afterEach(cleanup);

export * from "@testing-library/react";

/**
 * A QueryClientProvider wrapper plus the client behind it, so a test can spy on the client
 * a hook or a component reaches through `useQueryClient`. Retries off and `gcTime` zero:
 * a test must never wait on a retry, and nothing may leak into the next one.
 */
export function queryHarness(): {
  client: QueryClient;
  wrapper: (props: { children: ReactNode }) => ReactElement;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, wrapper: Wrapper };
}
