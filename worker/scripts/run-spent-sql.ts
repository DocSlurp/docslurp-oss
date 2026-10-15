import { readFile } from "node:fs/promises";
import type { Sql } from "postgres";

/**
 * Install the usage_events -> workspace_runs.spent_cents trigger from
 * migration 0056 into a scratch schema (verification scripts build minimal
 * tables instead of applying every migration, so the migration's lock and
 * usage_attribution backfill are skipped).
 */
export async function installRunSpentTrigger(sql: Sql<Record<string, unknown>>): Promise<void> {
  const migration = await readFile(new URL("../../server/db/migrations/0056_run_spent_cents.sql", import.meta.url), "utf8");
  const fn = migration.split("--> statement-breakpoint")
    .find((statement) => /CREATE OR REPLACE FUNCTION add_usage_events_to_run_spent_cents/.test(statement));
  const trigger = /CREATE TRIGGER usage_events_run_spent_cents[\s\S]*?;/.exec(migration)?.[0];
  if (!fn || !trigger) throw new Error("migration 0056 no longer defines the run spent trigger");
  await sql.unsafe(fn);
  await sql.unsafe(trigger);
}
