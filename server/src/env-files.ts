import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

/** The outermost workspace owns .env, including when core/ is a submodule. */
export function findWorkspaceRoot(startDir: string): string {
  let root = startDir;
  for (let current = startDir; ; current = resolve(current, "..")) {
    if (existsSync(resolve(current, "pnpm-workspace.yaml"))) root = current;
    if (resolve(current, "..") === current) return root;
  }
}

/** Existing process values win, then the production overlay, then the baseline. */
export function loadWorkspaceEnvFiles(
  fromMetaUrl: string,
  production = false,
  processEnv: NodeJS.ProcessEnv = process.env,
): void {
  const root = findWorkspaceRoot(dirname(fileURLToPath(fromMetaUrl)));
  const baseline = resolve(root, ".env");
  const overlay = resolve(root, ".env.production");
  if (production && !existsSync(overlay)) {
    throw new Error(`Production environment file not found: ${overlay}`);
  }
  // dotenv keeps the first value found and does not replace existing process values.
  loadEnv({ path: production ? [overlay, baseline] : baseline, processEnv, quiet: true });
}
