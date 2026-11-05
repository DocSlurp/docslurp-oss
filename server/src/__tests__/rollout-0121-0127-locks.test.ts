import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The migrator applies every pending migration in one transaction, so the locks of 0121-0128 add up until it commits. Each
 * lock-taking migration of the release starts with the same lock prelude (explained in 0122), so whichever runs first takes
 * every strong lock of the release in one canonical order. This pins that: the prelude is identical and first, and no
 * migration of the release takes a strong lock on a table the prelude does not hold, unless it locks that table itself
 * right after the prelude (0128's vision_run_attempts, which no transaction takes before a prelude table).
 */
const dir = new URL("../../db/migrations/", import.meta.url);
const release = readdirSync(dir).filter((name) => /^012[1-8]_.*\.sql$/.test(name)).sort();
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

describe("0121-0128 lock prelude", () => {
  it("covers the eight migrations of the release", () => {
    expect(release).toHaveLength(8);
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
    // Tables the migration locks itself, in order, straight after the prelude.
    const extra = new Set<string>();
    for (const statement of all.slice(PRELUDE.length)) {
      const lock = /^LOCK TABLE\s+(?:public\.)?"?(\w+)"?\s+IN ACCESS EXCLUSIVE MODE;$/i.exec(statement);
      if (!lock) break;
      extra.add(lock[1]!.toLowerCase());
    }
    for (const table of extra) expect(PRELUDE_TABLES.has(table), `${name} re-locks prelude table ${table}`).toBe(false);
    for (const table of strong) expect(PRELUDE_TABLES.has(table) || extra.has(table), `${name} locks ${table}`).toBe(true);
  });
});
