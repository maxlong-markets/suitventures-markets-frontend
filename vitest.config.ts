import { defineConfig } from "vitest/config";

/** Scope the suite to this package's own tests; the default glob also walks node_modules copies. */
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
