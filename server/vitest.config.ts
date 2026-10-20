import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const shared = (name: string) => resolve(__dirname, `../packages/shared/src/${name}.ts`);

export default defineConfig({
  test: {
    // CI stops at the first failing test; local runs report every failure.
    bail: process.env.CI ? 1 : 0,
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
  },
  resolve: {
    alias: {
      "@docslurp/shared/error-reporting": shared("error-reporting"),
      "@docslurp/shared/error-response": shared("error-response"),
      "@docslurp/shared/file-token-path": shared("file-token-path"),
      "@docslurp/shared/observability": shared("observability"),
      "@docslurp/shared/lancedb-s3-trace": shared("lancedb-s3-trace"),
      "@docslurp/shared/lancedb-ddb": shared("lancedb-ddb"),
      "@docslurp/shared/temporal-connection": shared("temporal-connection"),
      "@docslurp/shared/temporal-security": shared("temporal-security"),
      "@docslurp/shared/auth-security": shared("auth-security"),
      "@docslurp/shared/client-ip": shared("client-ip"),
      "@docslurp/shared/workspace-chat-models": shared("workspace-chat-models"),
      "@docslurp/shared/chat-voice": shared("chat-voice"),
      "@docslurp/shared/workspace-chat-ui": shared("workspace-chat-ui"),
      "@docslurp/shared": shared("index"),
      "@docslurp/sdk/search-adapters": resolve(__dirname, "../packages/sdk/src/search-adapters.ts"),
      "@docslurp/sdk": resolve(__dirname, "../packages/sdk/src/index.ts"),
    },
  },
});
