import { existsSync } from "node:fs";
import path from "node:path";

export function resolveScriptsDir(): string {
  const explicit = process.env.DOCSLURP_WORKER_SCRIPTS_DIR;
  if (explicit) {
    return explicit;
  }

  const candidates = [
    path.join(process.cwd(), "worker", "scripts"),
    path.join(process.cwd(), "scripts"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
