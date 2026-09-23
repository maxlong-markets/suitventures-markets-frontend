import { fileURLToPath } from "node:url";
import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));
const alias = [{ find: /^@\//, replacement: `${src}/` }];

/**
 * Two projects, because the suite needs two environments and Vitest 4 dropped both
 * `environmentMatchGlobs` and the `@vitest-environment` docblock.
 *
 * `node` is every `*.test.ts`: server code, route handlers, PGlite. It inherits the root
 * config, whose `react-server` condition is what Next.js resolves server code under —
 * without it the `server-only` marker in the Envio and Db clients resolves to its throwing
 * client build. It is prepended to Vite's own server conditions rather than replacing them.
 *
 * `dom` is every `*.test.tsx`: hooks and components under jsdom. It does NOT extend the
 * root, on purpose. Vite merges config arrays by concatenation, so an extending project
 * could not drop `react-server` again, and under that condition `react` exports no client
 * hooks at all. It repeats the `@/` alias, which is the only root option it wants.
 */
export default defineConfig({
  resolve: { alias },
  ssr: { resolve: { conditions: ["react-server", ...defaultServerConditions] } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          environment: "node",
          // Ten PGlite instances booting at once exceeded the 10 s hook default twice on a
          // loaded laptop; the boot is real work.
          hookTimeout: 60_000,
          // A few files (seed.test.ts, dbBackend.test.ts) boot PGlite inside a test body rather than a
          // hook, and the top-holder tasks add more; the same boot cost applies, so the same allowance.
          testTimeout: 60_000,
        },
      },
      {
        resolve: { alias },
        test: { name: "dom", include: ["src/**/*.test.tsx"], environment: "jsdom" },
      },
    ],
  },
});
