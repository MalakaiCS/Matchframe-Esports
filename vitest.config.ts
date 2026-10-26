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
    pool: "forks",
  },
});
