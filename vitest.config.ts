import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@smart-db/contracts": resolve(__dirname, "packages/contracts/src/index.ts"),
    },
  },
  test: {
    testTimeout: 30000,
    environmentMatchGlobs: [["apps/frontend/**/*.test.ts?(x)", "jsdom"]],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [
        "packages/contracts/src/**/*.ts",
        "apps/middleware/src/**/*.ts",
        "apps/frontend/src/**/*.ts",
        "apps/frontend/src/**/*.tsx",
      ],
      exclude: [
        "**/*.test.*",
        "apps/frontend/src/vite-env.d.ts",
        "apps/middleware/src/auth/types.ts",
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
