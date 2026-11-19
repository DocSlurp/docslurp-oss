import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

// The migrations live in the server package (server/db/migrations), which owns the
// schema. The worker only reads the SQL files by relative path for its test
// databases; it never imports server code (see scripts/lib/server-boundary.mjs).
const migrationsDir = fileURLToPath(new URL("../../../server/db/migrations/", import.meta.url));

const MIGRATION_NAME = /^(?:\d{4}|\d{8}T\d{4})_[a-z0-9][a-z0-9_]*$/;

/**
 * The migration tags (file names without .sql) in the order they apply: plain name order, the numbered files before
 * the UTC-timestamp ones. server/db/migration-runner.mjs is the production runner and owns the naming rules; this
 * helper only reads the same directory the same way.
 */
export function readMigrationTags(): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name.slice(0, -".sql".length))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Tags whose names the production runner would refuse to list. */
export function migrationNameProblems(tags: string[]): string[] {
  return tags.filter((tag) => !MIGRATION_NAME.test(tag)).map((tag) => `${tag}: expected NNNN_name (frozen) or YYYYMMDDTHHMM_name`);
}

/** A tag, or its name without the number or timestamp prefix. */
function findTag(tags: string[], name: string): number {
  return tags.findIndex((tag) => tag === name || tag.replace(/^\d+(?:T\d+)?_/, "") === name);
}

/**
 * One transaction per migration, as production applies them
 * (server/db/migration-runner.mjs): a lock a migration takes is released when
 * that migration commits, and a SET LOCAL or an ON COMMIT DROP temp table ends
 * with it.
 */
export async function applyMigration(db: PGlite, tag: string): Promise<void> {
  const sql = readFileSync(`${migrationsDir}${tag}.sql`, "utf8");
  await db.transaction(async (tx) => {
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await tx.exec(statement);
    }
  });
}

const LEDGER = `create schema if not exists docslurp_migrations;
  create table if not exists docslurp_migrations.applied (filename text primary key, sha256 text not null,
    applied_at timestamptz not null default now(), source text not null default 'runner')`;

/** Record tags in the runner's ledger (same shape as migration-runner.mjs), so code that reads it sees a real database. */
async function recordApplied(db: PGlite, tags: string[]): Promise<void> {
  await db.exec(LEDGER);
  for (const tag of tags) {
    await db.query("insert into docslurp_migrations.applied (filename, sha256, source) values ($1, '', 'test') on conflict do nothing", [`${tag}.sql`]);
  }
}

/**
 * An in-memory Postgres (PGlite) built exactly as every real database is: by
 * applying server/db/migrations in name order and recording each file in
 * docslurp_migrations.applied. server/db/migrations is the only schema source;
 * there is no snapshot to drift from it.
 *
 * `stopBefore` (a migration tag or its unprefixed name, e.g.
 * "usage_event_tenant_columns") stops before that migration, so a test can
 * seed rows in the older shape and apply the rest with
 * `applyRemainingMigrations` to check a backfill.
 */
export async function createMigratedDatabase(options: { stopBefore?: string } = {}): Promise<PGlite> {
  const tags = readMigrationTags();
  const problems = migrationNameProblems(tags);
  if (problems.length > 0) throw new Error(`server/db/migrations has invalid file names:\n${problems.join("\n")}`);
  const stop = options.stopBefore ? findTag(tags, options.stopBefore) : tags.length;
  if (stop < 0) throw new Error(`Unknown migration ${options.stopBefore}`);
  const db = new PGlite({ extensions: { pgcrypto } });
  for (const tag of tags.slice(0, stop)) await applyMigration(db, tag);
  await recordApplied(db, tags.slice(0, stop));
  return db;
}

/** Apply the migrations from `from` (a tag or its unprefixed name) onwards. */
export async function applyRemainingMigrations(db: PGlite, from: string): Promise<void> {
  const tags = readMigrationTags();
  const start = findTag(tags, from);
  if (start < 0) throw new Error(`Unknown migration ${from}`);
  for (const tag of tags.slice(start)) await applyMigration(db, tag);
  await recordApplied(db, tags.slice(start));
}
