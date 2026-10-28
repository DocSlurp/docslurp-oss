import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

// The migrations live in the server package (server/db/migrations), which owns the
// schema. The worker only reads the SQL files by relative path for its test
// databases; it never imports server code (see scripts/lib/server-boundary.mjs).
const migrationsDir = fileURLToPath(new URL("../../../server/db/migrations/", import.meta.url));

export type MigrationJournalEntry = { idx: number; when: number; tag: string };

export function readMigrationJournal(): MigrationJournalEntry[] {
  return (JSON.parse(readFileSync(`${migrationsDir}meta/_journal.json`, "utf8")) as {
    entries: MigrationJournalEntry[];
  }).entries;
}

/**
 * drizzle-kit migrate (server/db/migrate.mjs) applies only entries whose `when` is
 * later than the newest one a database has already recorded, so an entry
 * stamped earlier than its predecessor is silently skipped on existing
 * databases while fresh ones apply it. Entries must therefore have contiguous
 * `idx` values and strictly increasing `when` stamps; server/db/migrate.mjs runs the
 * same check before migrating.
 */
export function migrationJournalProblems(entries: MigrationJournalEntry[]): string[] {
  const problems: string[] = [];
  entries.forEach((entry, position) => {
    if (entry.idx !== position) problems.push(`${entry.tag}: idx ${entry.idx}, expected ${position}`);
    const previous = entries[position - 1];
    if (previous && !(entry.when > previous.when)) {
      problems.push(`${entry.tag}: when ${entry.when} is not after ${previous.tag} (${previous.when})`);
    }
  });
  return problems;
}

/** A tag, or its name without the number prefix (survives renumbering at merge). */
function findTag(tags: string[], name: string): number {
  return tags.findIndex((tag) => tag === name || tag.replace(/^\d+_/, "") === name);
}

/**
 * One transaction per migration, as drizzle-kit migrate runs them, so
 * transaction-scoped statements (LOCK TABLE, SET LOCAL, ON COMMIT DROP temp
 * tables) behave here as they do in production.
 */
async function applyMigration(db: PGlite, tag: string): Promise<void> {
  const sql = readFileSync(`${migrationsDir}${tag}.sql`, "utf8");
  await db.transaction(async (tx) => {
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await tx.exec(statement);
    }
  });
}

/**
 * An in-memory Postgres (PGlite) built exactly as every real
 * database is: by applying server/db/migrations in journal order. server/db/migrations is the
 * only schema source; there is no snapshot to drift from it. Fails loudly on a
 * journal drizzle-kit would apply differently to an existing database.
 *
 * `stopBefore` (a migration tag or its unnumbered name, e.g.
 * "usage_event_tenant_columns") stops before that migration, so a test can
 * seed rows in the older shape and apply the rest with
 * `applyRemainingMigrations` to check a backfill.
 */
export async function createMigratedDatabase(options: { stopBefore?: string } = {}): Promise<PGlite> {
  const journal = readMigrationJournal();
  const problems = migrationJournalProblems(journal);
  if (problems.length > 0) {
    throw new Error(`server/db/migrations/meta/_journal.json is out of order:\n${problems.join("\n")}`);
  }
  const tags = journal.map((entry) => entry.tag);
  const stop = options.stopBefore ? findTag(tags, options.stopBefore) : tags.length;
  if (stop < 0) throw new Error(`Unknown migration ${options.stopBefore}`);
  const db = new PGlite({ extensions: { pgcrypto } });
  for (const tag of tags.slice(0, stop)) await applyMigration(db, tag);
  return db;
}

/** Apply the migrations from `from` (a tag or its unnumbered name) onwards. */
export async function applyRemainingMigrations(db: PGlite, from: string): Promise<void> {
  const tags = readMigrationJournal().map((entry) => entry.tag);
  const start = findTag(tags, from);
  if (start < 0) throw new Error(`Unknown migration ${from}`);
  for (const tag of tags.slice(start)) await applyMigration(db, tag);
}
