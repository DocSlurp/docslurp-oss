import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CI stops at the first failing test; local runs report every failure.
    bail: process.env.CI ? 1 : 0,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
