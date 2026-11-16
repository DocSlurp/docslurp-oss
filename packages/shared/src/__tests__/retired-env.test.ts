import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RETIRED_ENV_VARS, retiredEnvRefusal, retiredEnvVarsSet } from "../retired-env.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
// The tombstone module itself, and the isolation-floor classifiers, which read a retired profile name only to stay
// stricter (a stale value can only make an environment non-development; startup refuses it anyway).
const ALLOWED = new Set(["packages/shared/src/retired-env.ts", "packages/shared/src/runtime-environment.ts", "scripts/start-worker.sh"]);
const SOURCE_DIRS = ["packages", "server/src", "server/db", "worker/src", "worker/scripts", "scripts"];
const SOURCE = /\.(ts|tsx|mts|js|mjs|cjs|sh|py)$/;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SOURCE.test(name) && !/\.test\.|__tests__|\/test\//.test(full)) yield full;
  }
}

describe("retired environment variables (tombstones)", () => {
  it("refuses any retired variable that is set, naming its replacement", () => {
    for (const entry of RETIRED_ENV_VARS) {
      expect(retiredEnvRefusal({ [entry.name]: "x" })).toContain(entry.name);
      expect(retiredEnvRefusal({ [entry.name]: "x" })).toContain(entry.replacement);
      expect(retiredEnvRefusal({ [entry.name]: "  " })).toBeNull();
    }
    expect(retiredEnvRefusal({})).toBeNull();
    expect(retiredEnvVarsSet({ DOCSLURP_SERVICE_PROFILE: "service" }).map((entry) => entry.name)).toEqual(["DOCSLURP_SERVICE_PROFILE"]);
  });

  it("is never read outside the tombstone module (and the floor classifiers)", () => {
    const offenders: string[] = [];
    for (const dir of SOURCE_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file);
        if (ALLOWED.has(rel)) continue;
        const text = readFileSync(file, "utf8");
        for (const entry of RETIRED_ENV_VARS) {
          // Reads, not prose: env.NAME, env["NAME"], ${NAME, process.env.NAME, os.environ...
          const read = new RegExp(`(\\.|\\[["'\`]|\\$\\{?|environ(\\.get\\()?\\(?["'])${entry.name}\\b`);
          if (read.test(text)) offenders.push(`${rel}: ${entry.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
