import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The worker reads the organization's spend status and takes its admission lock in one module (db/spend-check.ts),
 * which decides through the shared spend rule. A second reader is a second copy of the rule: it drifts from what the
 * API admits by, and from the dev skip switch.
 */
const workerSrc = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const OWNER = "db/spend-check.ts";

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (["__tests__", "node_modules", "test", "testdata"].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|mts|js|mjs)$/.test(entry) && !/\.test\.|\.spec\./.test(entry)) files.push(path);
  }
  return files;
}

function filesMatching(root: string, pattern: RegExp): string[] {
  return sourceFiles(root)
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(root, file).split("\\").join("/"))
    .sort();
}

describe("worker spend owners", () => {
  it("reads org_spend_status in one file", () => {
    expect(filesMatching(workerSrc, /\borg_spend_status\b/)).toEqual([OWNER]);
  });

  it("names the admission lock in one file", () => {
    expect(filesMatching(workerSrc, /\bspend_admission_lock_key\b/)).toEqual([OWNER]);
  });

  it("has one definition of the dev skip switch, in the shared spend rule", () => {
    const owners = [...new Set(["server/src", "worker/src", "packages/shared/src"].flatMap((root) =>
      filesMatching(join(repoRoot, root), /SKIP_RUN_BUDGET_GUARDS_IN_DEV\s*!==/).map((file) => `${root}/${file}`)))];
    expect(owners).toEqual(["packages/shared/src/spend-rule.ts"]);
  });

  it("reads a run's spend headroom only after taking the organization's admission lock", () => {
    const readers = filesMatching(workerSrc, /\brunSpendHeadroom\(/).filter((file) => file !== OWNER);
    expect(readers).toEqual(["media/capacity/store.ts", "media/journal.ts"]);
    for (const file of readers) {
      const text = readFileSync(join(workerSrc, file), "utf8");
      const lock = text.indexOf("lockOrgAdmission(");
      expect(lock, `${file} must take the admission lock`).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("runSpendHeadroom("), `${file} reads spend before its lock`).toBeGreaterThan(lock);
    }
  });

  it("checks more than nothing", () => {
    expect(sourceFiles(workerSrc).length).toBeGreaterThan(300);
  });
});
