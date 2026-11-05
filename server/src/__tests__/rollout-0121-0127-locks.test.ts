import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The migrator applies every pending migration in one transaction, so the locks of 0121-0127 add up until it commits. Each
 * lock-taking migration of the release starts with the same lock prelude (explained in 0122), so whichever runs first takes
 * every strong lock of the release in one canonical order. This pins that: the prelude is identical and first, and no
 * migration of the release takes a strong lock on a table the prelude does not hold.
 */
const dir = new URL("../../db/migrations/", import.meta.url);
const release = readdirSync(dir).filter((name) => /^012[1-7]_.*\.sql$/.test(name)).sort();
const statements = (name: string) =>
  readFileSync(new URL(name, dir), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
const PRELUDE = [
  "SET LOCAL lock_timeout = '10s';",
  "LOCK TABLE documents IN ACCESS EXCLUSIVE MODE;",
  "LOCK TABLE upload_session_files IN ACCESS EXCLUSIVE MODE;",
  "LOCK TABLE organizations, org_memberships IN SHARE ROW EXCLUSIVE MODE;",
  "SET LOCAL lock_timeout = '3s';",
  "LOCK TABLE api_keys IN ACCESS EXCLUSIVE MODE;",
  "SET LOCAL lock_timeout = '10s';",
  "LOCK TABLE webhooks IN ACCESS EXCLUSIVE MODE;",
];
const PRELUDE_TABLES = new Set(["documents", "upload_session_files", "organizations", "org_memberships", "api_keys", "webhooks"]);

describe("0121-0127 lock prelude", () => {
  it("covers the seven migrations of the release", () => {
    expect(release).toHaveLength(7);
  });

  it.each(release)("%s takes no strong lock before or outside the prelude", (name) => {
    const all = statements(name);
    const altered = all.flatMap((statement) => [...statement.matchAll(/\bALTER TABLE\s+(?:IF EXISTS\s+)?(?:public\.)?"?(\w+)"?/gi)].map((match) => match[1]!.toLowerCase()));
    const indexed = all.flatMap((statement) => [...statement.matchAll(/\bCREATE (?:UNIQUE )?INDEX (?!CONCURRENTLY)[^;]*?\bON\s+(?:public\.)?"?(\w+)"?/gi)].map((match) => match[1]!.toLowerCase()));
    const strong = [...altered, ...indexed];
    if (strong.length === 0) {
      // 0121 and 0124 define functions only.
      expect(all.some((statement) => /^LOCK TABLE/i.test(statement))).toBe(false);
      return;
    }
    expect(all.slice(0, PRELUDE.length)).toEqual(PRELUDE);
    for (const table of strong) expect(PRELUDE_TABLES, `${name} locks ${table}`).toContain(table);
  });

  it("0127 also locks the workspaces and runs its plan reads, right after the prelude", () => {
    const all = statements(release.find((name) => name.startsWith("0127_"))!);
    expect(all[PRELUDE.length]).toBe("LOCK TABLE workspaces, workspace_runs IN SHARE ROW EXCLUSIVE MODE;");
  });
});
