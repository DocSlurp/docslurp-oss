import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { describe, expect, it } from "vitest";

import { applyMigration, readMigrationTags } from "../test/migrated-db.js";

// A fresh database applies migrations in name order. An existing one has already applied whatever is on main, so a
// migration added by a branch runs there AFTER every migration on main, including ones with later names (it "merges
// late"; the runner applies it anyway). This builds main's schema and applies the branch's new migrations on top, so a
// migration that only works in name order fails here instead of in a deploy. migrations.test.ts covers name order.
const BASE_REF = process.env.MIGRATION_BASE_REF ?? "origin/main";
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Migration tags on the base ref, or null when git or the ref is unavailable. */
function tagsOnBase(): string[] | null {
  try {
    const out = execFileSync("git", ["ls-tree", "--name-only", `${BASE_REF}:server/db/migrations`], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter((name) => name.endsWith(".sql")).map((name) => name.slice(0, -".sql".length));
  } catch {
    return null;
  }
}

describe("migrations added by this branch", () => {
  it("apply on top of main's schema, in the order an existing database runs them", async (ctx) => {
    const base = tagsOnBase();
    // CI fetches the base ref for this test (ci.yml); it must not quietly turn itself off there.
    if (base === null && process.env.CI) throw new Error(`${BASE_REF} is not available: fetch it before running the worker tests`);
    // Locally without the ref: shown as skipped, never as passed.
    if (base === null) return ctx.skip();
    const onBase = new Set(base);
    const tags = readMigrationTags();
    const added = tags.filter((tag) => !onBase.has(tag));
    if (added.length === 0) return;
    const db = new PGlite({ extensions: { pgcrypto } });
    try {
      for (const tag of tags.filter((tag) => onBase.has(tag))) await applyMigration(db, tag);
      const problems: string[] = [];
      for (const tag of added) {
        try {
          await applyMigration(db, tag);
        } catch (error) {
          problems.push(`${tag}: does not apply after the migrations on ${BASE_REF}: ${(error as Error).message.split("\n")[0]}`);
        }
      }
      expect(problems, problems.join("\n")).toEqual([]);
    } finally {
      await db.close();
    }
  }, 300_000);
});
