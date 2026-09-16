import { defineConfig } from "vitest/config";

/**
 * Scope the suite to this package's own tests; the default glob also walks node_modules copies.
 * `react-server` is the condition Next.js resolves server code under: without it the
 * `server-only` marker in the Envio client resolves to its throwing client build.
 */
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
  ssr: { resolve: { conditions: ["react-server"] } },
});
