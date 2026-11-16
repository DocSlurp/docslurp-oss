import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import { initializeOperatorConfig } from "@docslurp/shared/operator-config";

let loaded = false;

/**
 * The outermost ancestor holding pnpm-workspace.yaml. When this repository is
 * checked out as a submodule of a larger project (the private app repo pins it
 * at core/), the shared .env lives at that outer root, not at core/.
 */
export function findProjectRoot(startDir: string): string {
  let root = startDir;
  let found = false;

  for (let currentDir = startDir; ; currentDir = resolve(currentDir, "..")) {
    if (existsSync(resolve(currentDir, "pnpm-workspace.yaml"))) {
      root = currentDir;
      found = true;
    }

    if (resolve(currentDir, "..") === currentDir) {
      return found ? root : startDir;
    }
  }
}

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
  // The operator config file (DOCSLURP_OPERATOR_CONFIG) sets its variables now, before anything reads them; an invalid
  // or unreadable file, or one that disagrees with the environment, stops the process here.
  initializeOperatorConfig("worker");
}

loadProjectEnv(import.meta.url);
