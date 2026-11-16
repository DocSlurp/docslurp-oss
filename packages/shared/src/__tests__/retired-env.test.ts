import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RETIRED_ENV_VARS, retiredEnvRefusal, retiredEnvVarsSet } from "../retired-env.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
// The tombstone module itself, and the isolation-floor classifiers, which read a retired profile name only to stay
// stricter (a stale value can only make an environment non-development; startup refuses it anyway).
const ALLOWED = new Set(["packages/shared/src/retired-env.ts", "packages/shared/src/runtime-environment.ts", "scripts/start-worker.sh"]);
const SOURCE_DIRS = ["packages", "server", "worker", "scripts"];
const ROOT_FILES = ["compose.selfhost.yml", "docker-compose.yml"];
const SOURCE = /(\.(ts|tsx|mts|js|mjs|cjs|sh|py|yml|yaml|json|toml)|Dockerfile[\w.-]*)$/;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SOURCE.test(name) && !/\.test\.|(^|\/)(__tests__|test)\//.test(path.relative(ROOT, full))) yield full;
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
    const files = [...SOURCE_DIRS.flatMap((dir) => [...walk(path.join(ROOT, dir))]), ...ROOT_FILES.map((name) => path.join(ROOT, name))];
    {
      for (const file of files) {
        const rel = path.relative(ROOT, file);
        if (ALLOWED.has(rel)) continue;
        const text = readFileSync(file, "utf8");
        for (const entry of RETIRED_ENV_VARS) {
          // Any code mention: accessors (env.NAME, ${NAME}), quoted names (env["NAME"], const K = "NAME", lists) and
          // destructuring ({ NAME }). Comment lines are skipped; prose in comments is allowed.
          const code = text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*|#)/.test(line)).join("\n");
          const read = new RegExp(`(\\.|\\$\\{?|["'\`]|[{,]\\s*)${entry.name}\\b`);
          if (read.test(code)) offenders.push(`${rel}: ${entry.name}`);
          continue;
        }
      }
    }
    // A scan that read nothing proves nothing (a moved tree, an over-broad exclusion).
    expect(files.length).toBeGreaterThan(500);
    expect(offenders).toEqual([]);
  });
});
