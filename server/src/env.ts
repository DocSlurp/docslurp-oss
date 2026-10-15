import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";

let loaded = false;

function findWorkspaceRoot(startDir: string): string {
  let currentDir = startDir;

  while (true) {
    if (existsSync(resolve(currentDir, "pnpm-workspace.yaml"))) {
      return currentDir;
    }

    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) {
      return startDir;
    }

    currentDir = parentDir;
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
