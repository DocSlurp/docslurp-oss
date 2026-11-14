import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase, migrationJournalProblems, readMigrationJournal } from "../test/migrated-db.js";

// The figure migrations (storage billing, storage state, the resume runner and its budgets) are idempotent: applied a second time over a
// fully migrated database they change nothing and raise nothing (the release pipeline may re-run a migration).
const migrationsDir = fileURLToPath(new URL("../../../server/db/migrations/", import.meta.url));
const FIGURE_MIGRATIONS = /_(figure_storage_billing|figure_storage_state|figure_resume_runner|figure_resume_budgets)$/;

let db: PGlite;
beforeAll(async () => { db = await createMigratedDatabase(); }, 900_000);
afterAll(async () => { await db?.close(); });

const catalog = async () => (await db.query<{ item: string }>(`
  select 'col:' || table_name || '.' || column_name || ':' || data_type || ':' || coalesce(column_default, '') as item
    from information_schema.columns where table_schema = 'public'
      and table_name in ('document_assets', 'document_extraction_levels', 'storage_meter_days', 'figure_resume_org_days', 'figure_resume_proposal_uses', 'storage_cleanup_queue')
  union all select 'con:' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
  union all select 'idx:' || indexname || ':' || indexdef from pg_indexes where schemaname = 'public'
  order by 1`)).rows.map((row) => row.item);

describe("figure migrations", () => {
  it("are in the journal in order, and a second run changes nothing", async () => {
    const journal = readMigrationJournal();
    expect(migrationJournalProblems(journal)).toEqual([]);
    const figures = journal.filter((entry) => FIGURE_MIGRATIONS.test(entry.tag));
    expect(figures.map((entry) => entry.tag.replace(/^\d+_/, ""))).toEqual(["figure_storage_billing", "figure_storage_state", "figure_resume_runner", "figure_resume_budgets"]);
    const before = await catalog();
    for (const entry of figures) {
      const sql = readFileSync(`${migrationsDir}${entry.tag}.sql`, "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) if (statement.trim()) await db.exec(statement);
    }
    expect(await catalog()).toEqual(before);
  }, 600_000);

  it("F4: a database that applied an earlier figure_resume_runner migration (resume_blocked CHECK without 'unscanned') converges on a re-run", async () => {
    await db.exec(`alter table document_extraction_levels drop constraint if exists document_extraction_levels_resume_blocked_check;
      alter table document_extraction_levels add constraint document_extraction_levels_resume_blocked_check
        check (resume_blocked in ('attempts', 'figures-off', 'resume-off', 'stale', 'refused'))`);
    const runner = readMigrationJournal().find((entry) => /_figure_resume_runner$/.test(entry.tag))!;
    for (const statement of readFileSync(`${migrationsDir}${runner.tag}.sql`, "utf8").split("--> statement-breakpoint")) if (statement.trim()) await db.exec(statement);
    const def = (await db.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'document_extraction_levels_resume_blocked_check'`)).rows[0]!.def;
    expect(def).toContain("unscanned");
  }, 600_000);

  it("a database that applied an earlier figure_resume_budgets migration (grants CHECK at 100, no resume_unit_stalls) converges on a re-run", async () => {
    await db.exec(`alter table document_extraction_levels drop constraint if exists document_extraction_levels_resume_grants_check;
      alter table document_extraction_levels add constraint document_extraction_levels_resume_grants_check check (resume_grants between 0 and 100);
      alter table document_extraction_levels drop column if exists resume_unit_stalls`);
    const budgets = readMigrationJournal().find((entry) => /_figure_resume_budgets$/.test(entry.tag))!;
    for (const statement of readFileSync(`${migrationsDir}${budgets.tag}.sql`, "utf8").split("--> statement-breakpoint")) if (statement.trim()) await db.exec(statement);
    const defs = (await db.query<{ name: string; def: string }>(`select conname as name, pg_get_constraintdef(oid) as def from pg_constraint
      where conname in ('document_extraction_levels_resume_grants_check', 'document_extraction_levels_resume_blocked_check') order by conname`)).rows;
    // Re-running it after 0159 also restores the budget reasons 0159's own re-run narrowed away (F4 above).
    expect(defs.find((row) => row.name.endsWith("blocked_check"))!.def).toMatch(/vm-budget.*no-progress/);
    expect(defs.find((row) => row.name.endsWith("grants_check"))!.def).toContain("10");
    expect((await db.query(`select 1 from information_schema.columns where table_name = 'document_extraction_levels' and column_name = 'resume_unit_stalls'`)).rows).toHaveLength(1);
  }, 600_000);
});
