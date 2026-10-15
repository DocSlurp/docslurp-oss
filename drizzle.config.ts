import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

loadEnv({ quiet: true });

const configDir = dirname(fileURLToPath(import.meta.url));

const defaultDatabaseUrl = "postgres://docslurp:docslurp@localhost:5432/docslurp";

function isContainerRuntime() {
  return existsSync("/.dockerenv");
}

function readEnv(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function rewriteDockerHostname(rawUrl: string | undefined, fromHost: string, toHost: string) {
  if (!rawUrl || isContainerRuntime()) {
    return rawUrl;
  }

  try {
    const url = new URL(rawUrl);
    if (url.hostname !== fromHost) {
      return rawUrl;
    }

    url.hostname = toHost;
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function resolveDatabaseUrl() {
  const selected = readEnv(process.env.DATABASE_URL) ?? defaultDatabaseUrl;

  return rewriteDockerHostname(selected, "postgres", "localhost") ?? defaultDatabaseUrl;
}

export default defineConfig({
  dialect: "postgresql",
  schema: resolve(configDir, "server/db/schema.ts"),
  out: resolve(configDir, "server/db/migrations"),
  dbCredentials: {
    url: resolveDatabaseUrl()
  },
  introspect: {
    casing: "preserve"
  }
});
