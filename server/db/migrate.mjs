// The one way to create or update the database schema: apply server/db/migrations
// with our runner (migration-runner.mjs: every unrecorded file, in name order, one
// transaction per file) on the same locked connection. Used by the Fly release command, the compose `migrate`
// service, and API startup (RUN_STARTUP_MIGRATIONS). A session advisory lock
// serializes concurrent migrators (several app instances, release + app), so
// two processes never apply the same migration at once.
import path from "node:path";
import { applyOwnedMigrations } from "./owned-migrations.mjs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { migrationFailureDetail } from "./migration-error.mjs";

const MIGRATION_LOCK_KEY = 7_142_771_001; // arbitrary, stable app-wide key

const pooledUrl = process.env.DATABASE_URL;
if (!pooledUrl) {
  throw new Error("DATABASE_URL is required to run migrations");
}
// Session advisory locks need one server session. Through a transaction-mode
// pooler (Neon's "-pooler" host, pgbouncer) the lock and unlock can run on
// different backends, leaking the lock onto a pooled connection and stalling
// every later migrator until that backend is recycled. Migrate over a direct
// connection: MIGRATION_DATABASE_URL if set, else the Neon direct host.
export function directDatabaseUrl(url, env = process.env) {
  if (env.MIGRATION_DATABASE_URL?.trim()) return env.MIGRATION_DATABASE_URL.trim();
  try {
    const parsed = new URL(url);
    if (/-pooler\./.test(parsed.hostname)) parsed.hostname = parsed.hostname.replace("-pooler.", ".");
    return parsed.toString();
  } catch {
    return url;
  }
}
const databaseUrl = directDatabaseUrl(pooledUrl);
const LOCK_WAIT_MS = Number.parseInt(process.env.MIGRATION_LOCK_WAIT_MS ?? "", 10) || 240_000;

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const client = new Client({ connectionString: databaseUrl });
await client.connect();
// The owner's session resolves names only in public (where migrations create objects) and pg_catalog, never "$user": a
// schema another role created (one named after the owner, say) cannot shadow a table or function a migration or the
// role reconciliation uses (council O #1). Only the owner can create in public: runtime roles are refused CREATE in every
// non-system schema (the runtime identity rule, recheck Q #5). public stays first on purpose (recheck Q #7): migrations
// create unqualified objects in the first schema listed, and "pg_catalog, public" fails each with "permission denied to
// create pg_catalog.<name>".
await client.query("set search_path = public, pg_catalog");
try {
  const started = Date.now();
  // Bounded wait: fail with a clear message instead of hanging a deploy.
  for (let attempt = 0; ; attempt += 1) {
    const { rows } = await client.query("select pg_try_advisory_lock($1) as locked", [MIGRATION_LOCK_KEY]);
    if (rows[0]?.locked) break;
    const waited = Date.now() - started;
    if (waited >= LOCK_WAIT_MS) {
      const { rows: holders } = await client.query(
        "select a.pid, a.application_name, a.client_addr, now() - a.backend_start as age from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.locktype = 'advisory' and l.objid = $1::bigint % 4294967296 and l.granted",
        [MIGRATION_LOCK_KEY],
      ).catch(() => ({ rows: [] }));
      throw new Error(`migration lock still held after ${waited}ms (holders: ${JSON.stringify(holders)})`);
    }
    if (attempt % 10 === 0) console.log(`[migrate] waiting for the migration lock (${Math.round(waited / 1000)}s)`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  console.log(`[migrate] lock acquired after ${Date.now() - started}ms; applying server/db/migrations`);
  await applyOwnedMigrations(client, { migrationsFolder: path.join(repoRoot, "server/db/migrations") });
  console.log(`[migrate] complete in ${Date.now() - started}ms`);
} catch (error) {
  console.error(`[migrate] failed: ${migrationFailureDetail(error)}`);
  process.exitCode = 1;
} finally {
  await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
  await client.end();
}
