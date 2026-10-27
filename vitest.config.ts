import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "services/*/src/**/*.test.ts",
      "services/*/test/**/*.test.ts",
      "apps/*/src/**/*.test.{ts,tsx}",
      "apps/*/test/**/*.test.{ts,tsx}",
    ],
    environment: "node",
    testTimeout: 20000,
    // In-process Postgres (PGlite, WebAssembly) can take >10 s to start when several test files run at once.
    hookTimeout: 30000,
    pool: "forks",
  },
});
