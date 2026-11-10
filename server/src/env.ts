import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import { findProjectRoot } from "./env-files.js";

let loaded = false;

export { findProjectRoot } from "./env-files.js";

export function loadProjectEnv(fromMetaUrl: string): void {
  if (loaded) {
    return;
  }

  const startDir = dirname(fileURLToPath(fromMetaUrl));
  const projectRoot = findProjectRoot(startDir);
  const envPath = resolve(projectRoot, ".env");

  if (existsSync(envPath)) {
    loadEnv({ path: envPath, quiet: true });
  } else {
    loadEnv({ quiet: true });
  }

  loaded = true;
}

loadProjectEnv(import.meta.url);
