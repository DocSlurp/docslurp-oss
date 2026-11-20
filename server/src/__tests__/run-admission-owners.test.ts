import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Run admission has one module (server/src/services/run-admission.ts). A run inserted, a blocked or paused run put
 * back to work, or the organization's admission lock taken somewhere else is an admission path the module does not
 * see: it can skip the lock order, the spend decision or the run's first credit lease.
 *
 *  - The lock key is named in one file, so every caller takes it through `lockOrgAdmission`.
 *  - `project_runs` rows are inserted only by the listed files, and each of them goes through the module.
 *  - The lease primitive and the admission entry points are imported from the module, never rebuilt from the spend guard.
 *
 * Adding a file to RUN_INSERTERS is a decision to add an admission path: give it an entry point in the module first.
 */
const serverSrc = fileURLToPath(new URL("../", import.meta.url));

const LOCK_OWNER = "services/billing/admission-lock.ts";
const MODULE = "services/run-admission.ts";
// Development seed data: fixture runs written straight to a local database, never admitted or started.
const SEED = "lib/seed-users.ts";
const RUN_INSERTERS = new Set([
  "services/run-creation.ts",
  "services/config-change.ts",
  "services/project-indexing-mode.ts",
  "search/deferred/materialize-client.ts",
]);

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|mts|js|mjs)$/.test(entry) && !/\.test\.|\.spec\./.test(entry)) files.push(path);
  }
  return files;
}

const sources = sourceFiles(serverSrc).map((file) => ({
  path: relative(serverSrc, file).split("\\").join("/"),
  text: readFileSync(file, "utf8"),
}));

function filesMatching(pattern: RegExp): string[] {
  return sources.filter((source) => pattern.test(source.text)).map((source) => source.path).sort();
}

describe("run admission owners", () => {
  it("names the organization's admission lock in one file", () => {
    expect(filesMatching(/spend_admission_lock_key/)).toEqual([LOCK_OWNER]);
  });

  it("inserts runs only in files that go through the run-admission module", () => {
    const inserters = filesMatching(/insert\s+into\s+project_runs\b/i).filter((path) => path !== SEED);
    expect(inserters).toEqual([...RUN_INSERTERS].sort());
    for (const path of inserters) {
      const { text } = sources.find((source) => source.path === path)!;
      expect(text, `${path} must import the run-admission module`).toMatch(/from "(\.\.?\/)+(services\/)?run-admission\.js"/);
    }
  });

  it("keeps the lease primitive and admission entry points inside the module", () => {
    expect(filesMatching(/\brequireRunCreditLease\b/)).toEqual([MODULE]);
    expect(filesMatching(/\badmissionBlock\b/)).toEqual([MODULE]);
    const guard = sources.find((source) => source.path === "services/billing/spend-guard.ts")!.text;
    expect(guard).not.toMatch(/\badmitRunSpend\b|\bgrantRunCreditLease\b/);
  });

  it("checks more than nothing", () => {
    expect(sources.length).toBeGreaterThan(200);
    expect(sources.some((source) => source.path === MODULE)).toBe(true);
  });
});
