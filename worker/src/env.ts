import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";

let loaded = false;

/**
 * The outermost ancestor holding pnpm-workspace.yaml. When this repository is
 * checked out as a submodule of a larger workspace (the private app repo pins it
 * at core/), the shared .env lives at that outer root, not at core/.
 */
export function findWorkspaceRoot(startDir: string): string {
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
