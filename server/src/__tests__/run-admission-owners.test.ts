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
// Each file that inserts runs, and the entry point its insert must sit behind.
const RUN_INSERTERS = new Map([
  ["services/run-creation.ts", "admitRunSpend"],
  ["services/config-change.ts", "admitRunInTransaction"],
  ["services/project-indexing-mode.ts", "admitRunInTransaction"],
  ["search/deferred/materialize-client.ts", "admitOnDemandRun"],
]);
// run-lifecycle's transitions take the caller's admission transaction (runs.ts passes the one `admitRunSpend` opened).
const RUN_REQUEUERS = [MODULE, "services/run-lifecycle.ts"];
// The paused-run resume keeps the lease's own refusal reason for the pause, so it grants the lease itself.
const LEASE_GRANTERS = [MODULE, "services/billing/credit-leases.ts", "services/spend-paused-runs.ts"];

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
    expect(inserters).toEqual([...RUN_INSERTERS.keys()].sort());
    for (const [path, entryPoint] of RUN_INSERTERS) {
      const { text } = sources.find((source) => source.path === path)!;
      expect(text, `${path} must import the run-admission module`).toMatch(/from "(\.\.?\/)+(services\/)?run-admission\.js"/);
      // Every insert sits after a call to its entry point: an insert moved in front of admission, or left behind
      // when the call is deleted, fails here.
      const call = text.indexOf(`${entryPoint}(`);
      expect(call, `${path} must call ${entryPoint}`).toBeGreaterThanOrEqual(0);
      for (const insert of text.matchAll(/insert\s+into\s+project_runs\b/gi)) {
        expect(insert.index, `${path} inserts a run before ${entryPoint}`).toBeGreaterThan(call);
      }
    }
  });

  it("puts a run back to queued only in the module and the run lifecycle it calls into", () => {
    expect(filesMatching(/update\s+project_runs\s+set\s+status\s*=\s*'queued'/i)).toEqual([...RUN_REQUEUERS].sort());
  });

  it("keeps the lease primitive and admission entry points inside the module", () => {
    expect(filesMatching(/\brequireRunCreditLease\b/)).toEqual([MODULE]);
    expect(filesMatching(/\bgrantRunCreditLease\b/)).toEqual([...LEASE_GRANTERS].sort());
    expect(filesMatching(/\badmissionBlock\b/)).toEqual([MODULE]);
    // The transitions-only retry (no spend decision, no lease) is for tests of the lifecycle.
    expect(filesMatching(/\bretryWithoutAdmission\b/)).toEqual(["services/run-lifecycle.ts"]);
    const guard = sources.find((source) => source.path === "services/billing/spend-guard.ts")!.text;
    expect(guard).not.toMatch(/\badmitRunSpend\b|\bgrantRunCreditLease\b/);
  });

  it("names the run in every admitRunSpend call, so the run always holds its own reservation or lease", () => {
    const calls: string[] = [];
    for (const source of sources) {
      if (source.path === MODULE) continue;
      for (const match of source.text.matchAll(/\badmitRunSpend\(/g)) {
        // The options object closes the call: look from this call to the next one (or the end of the file).
        const next = source.text.indexOf("admitRunSpend(", match.index! + 1);
        const call = source.text.slice(match.index!, next < 0 ? undefined : next);
        calls.push(`${source.path}: ${/\bleaseRunId\s*:/.test(call) ? "names its run" : "no leaseRunId"}`);
      }
    }
    expect(calls).toEqual([
      "services/run-creation.ts: names its run",
      "services/runs.ts: names its run",
      "services/runs.ts: names its run",
    ]);
  });

  it("checks more than nothing", () => {
    expect(sources.length).toBeGreaterThan(200);
    expect(sources.some((source) => source.path === MODULE)).toBe(true);
  });
});
