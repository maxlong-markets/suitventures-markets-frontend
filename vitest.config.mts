import { fileURLToPath } from "node:url";
import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

/**
 * Scope the suite to this package's own tests; the default glob also walks node_modules copies.
 *
 * `@/` mirrors the tsconfig path alias. Until now every `@/` import under test was type-only and
 * erased at transform time, so nothing had to resolve it; a value import does.
 *
 * `react-server` is the condition Next.js resolves server code under: without it the `server-only`
 * marker in the Envio client resolves to its throwing client build. It is prepended to Vite's own
 * server conditions rather than replacing them.
 */
export default defineConfig({
  // Ten PGlite instances booting at once exceeded the 10 s hook default twice on a loaded laptop; the boot is real work.
  test: { include: ["src/**/*.test.ts"], hookTimeout: 60_000 },
  resolve: { alias: [{ find: /^@\//, replacement: `${src}/` }] },
  ssr: { resolve: { conditions: ["react-server", ...defaultServerConditions] } },
});
