import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    // CI stops at the first failing test; local runs report every failure.
    bail: process.env.CI ? 1 : 0,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
  },
  resolve: {
    alias: {
      "@docslurp/shared/error-reporting": path.resolve(__dirname, "../packages/shared/src/error-reporting.ts"),
      "@docslurp/shared/observability": path.resolve(__dirname, "../packages/shared/src/observability.ts"),
      "@docslurp/shared/lancedb-s3-cache": path.resolve(__dirname, "../packages/shared/src/lancedb-s3-cache.ts"),
      "@docslurp/shared/lancedb-s3-trace": path.resolve(__dirname, "../packages/shared/src/lancedb-s3-trace.ts"),
      "@docslurp/shared/lancedb-session": path.resolve(__dirname, "../packages/shared/src/lancedb-session.ts"),
      "@docslurp/shared/lancedb-hydration": path.resolve(__dirname, "../packages/shared/src/lancedb-hydration.ts"),
      "@docslurp/shared/lancedb-ddb": path.resolve(__dirname, "../packages/shared/src/lancedb-ddb.ts"),
      "@docslurp/shared": path.resolve(__dirname, "../packages/shared/src/index.ts"),
    },
  },
});
