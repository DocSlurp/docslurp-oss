import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase, migrationJournalProblems, readMigrationJournal } from "../test/migrated-db.js";

// The figure migrations (storage billing, storage state, the resume runner) are idempotent: applied a second time over a
// fully migrated database they change nothing and raise nothing (the release pipeline may re-run a migration).
const migrationsDir = fileURLToPath(new URL("../../../server/db/migrations/", import.meta.url));
const FIGURE_MIGRATIONS = /_(figure_storage_billing|figure_storage_state|figure_resume_runner)$/;

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
    expect(figures.map((entry) => entry.tag.replace(/^\d+_/, ""))).toEqual(["figure_storage_billing", "figure_storage_state", "figure_resume_runner"]);
    const before = await catalog();
    for (const entry of figures) {
      const sql = readFileSync(`${migrationsDir}${entry.tag}.sql`, "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) if (statement.trim()) await db.exec(statement);
    }
    expect(await catalog()).toEqual(before);
  }, 600_000);
});
