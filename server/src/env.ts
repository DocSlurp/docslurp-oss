import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import { findWorkspaceRoot } from "./env-files.js";

let loaded = false;

export { findWorkspaceRoot } from "./env-files.js";

export function loadWorkspaceEnv(fromMetaUrl: string): void {
  if (loaded) {
    return;
  }

  const startDir = dirname(fileURLToPath(fromMetaUrl));
  const workspaceRoot = findWorkspaceRoot(startDir);
  const envPath = resolve(workspaceRoot, ".env");

  if (existsSync(envPath)) {
    loadEnv({ path: envPath, quiet: true });
  } else {
    loadEnv({ quiet: true });
  }

  loaded = true;
}

loadWorkspaceEnv(import.meta.url);
