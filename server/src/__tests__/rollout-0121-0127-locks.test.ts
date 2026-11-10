import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The migrator applies every pending migration in one transaction, so the locks of 0121-0131 add up until it commits. Each
 * lock-taking migration of the release starts with the same lock prelude (explained in 0122), so whichever runs first takes
 * every strong lock of the release in one canonical order. This pins that: the prelude is identical and first, and no
 * migration of the release takes a strong lock on a table the prelude does not hold, unless it locks that table itself
 * right after the prelude (0128's vision_run_attempts, which no transaction takes before a prelude table).
 */
const dir = new URL("../../db/migrations/", import.meta.url);
const release = readdirSync(dir).filter((name) => /^(012[1-9]|013[01])_.*\.sql$/.test(name)).sort();
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

describe("0121-0131 lock prelude", () => {
  it("covers the eleven migrations of the release", () => {
    expect(release).toHaveLength(11);
  });

  it.each(release)("%s takes no strong lock before or outside the prelude", (name) => {
    const all = statements(name);
    const altered = all.flatMap((statement) => [...statement.matchAll(/\bALTER TABLE\s+(?:IF EXISTS\s+)?(?:public\.)?"?(\w+)"?/gi)].map((match) => match[1]!.toLowerCase()));
    const indexed = all.flatMap((statement) => [...statement.matchAll(/\bCREATE (?:UNIQUE )?INDEX (?!CONCURRENTLY)[^;]*?\bON\s+(?:public\.)?"?(\w+)"?/gi)].map((match) => match[1]!.toLowerCase()));
    // A foreign key locks the table it references (SHARE ROW EXCLUSIVE) when the constraint is created.
    const referenced = all.flatMap((statement) => [...statement.matchAll(/\bREFERENCES\s+(?:public\.)?"?(\w+)"?/gi)].map((match) => match[1]!.toLowerCase()));
    const strong = [...altered, ...indexed, ...referenced];
    if (strong.length === 0) {
      // 0121 and 0124 define functions only; 0131 creates its own table and function.
      expect(all.some((statement) => /^LOCK TABLE/i.test(statement))).toBe(false);
      return;
    }
    expect(all.slice(0, PRELUDE.length)).toEqual(PRELUDE);
    // Tables the migration locks itself, in order, straight after the prelude.
    const extra = new Set<string>();
    for (const statement of all.slice(PRELUDE.length)) {
      const lock = /^LOCK TABLE\s+(?:public\.)?"?(\w+)"?\s+IN [A-Z ]+ MODE;$/i.exec(statement);
      if (!lock) break;
      extra.add(lock[1]!.toLowerCase());
    }
    for (const table of extra) expect(PRELUDE_TABLES.has(table), `${name} re-locks prelude table ${table}`).toBe(false);
    for (const table of strong) expect(PRELUDE_TABLES.has(table) || extra.has(table), `${name} locks ${table}`).toBe(true);
  });

  it("0127 also locks the historical workspaces and runs its plan reads, right after the prelude", () => {
    const all = statements(release.find((name) => name.startsWith("0127_"))!);
    expect(all[PRELUDE.length]).toBe("LOCK TABLE workspaces, workspace_runs IN SHARE ROW EXCLUSIVE MODE;");
  });

  it("0129 locks historical workspace_runs, which its foreign key references, right after the prelude", () => {
    const all = statements(release.find((name) => name.startsWith("0129_"))!);
    expect(all[PRELUDE.length]).toBe("LOCK TABLE workspace_runs IN SHARE ROW EXCLUSIVE MODE;");
  });

  it("0130 alters only documents and document_page_facts (defaults, nullable columns, a trigger), under the prelude", () => {
    const all = statements(release.find((name) => name.startsWith("0130_"))!).slice(PRELUDE.length);
    // document_page_facts (its equivalents columns) is locked right after the prelude.
    expect(all[0]).toBe("LOCK TABLE document_page_facts IN ACCESS EXCLUSIVE MODE;");
    expect(all[1]).toBe("ALTER TABLE documents ALTER COLUMN page_count_source SET DEFAULT 'assumed';");
    expect(all[2]).toMatch(/^ALTER TABLE documents ADD COLUMN IF NOT EXISTS intake_page_count integer CHECK/);
    for (const statement of all) expect(statement).not.toMatch(/\b(?:UPDATE|DELETE|INSERT)\s+(?:INTO\s+|FROM\s+)?(?!.*\bTG_OP\b)\w+\s+SET\b/i);
    expect(all.some((statement) => /CREATE TRIGGER documents_intake_page_count BEFORE INSERT OR UPDATE OF intake_page_count ON documents/.test(statement))).toBe(true);
  });

  it("0131 creates only its own table and function and locks nothing that exists", () => {
    const all = statements(release.find((name) => name.startsWith("0131_"))!);
    expect(all.some((statement) => /^LOCK TABLE/i.test(statement))).toBe(false);
    expect(all[0]).toMatch(/^CREATE TABLE IF NOT EXISTS pricing_provider_state \(/);
    expect(all[1]).toMatch(/^CREATE OR REPLACE FUNCTION pricing_state_raise\(p_key text, p_candidate bigint\) RETURNS bigint\s+LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public/);
    for (const statement of all) expect(statement).not.toMatch(/\b(?:ALTER TABLE|REFERENCES|CREATE (?:UNIQUE )?INDEX)\b/i);
  });
});
