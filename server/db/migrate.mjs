// The one way to create or update the database schema: apply server/db/migrations
// with drizzle-kit. Used by the Fly release command, the compose `migrate`
// service, and API startup (RUN_STARTUP_MIGRATIONS). A session advisory lock
// serializes concurrent migrators (several app instances, release + app), so
// two processes never apply the same migration at once.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { migrationFailureDetail } from "./migration-error.mjs";
import { assertMigrationOwner, reconcileRoleGrants } from "./roles.mjs";

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

// drizzle-kit applies only journal entries whose `when` is later than the
// newest migration a database has recorded, so an entry stamped earlier than
// its predecessor (e.g. from a long-lived branch) would be skipped silently on
// existing databases. Refuse to migrate instead. Same rule as
// worker/src/test/migrated-db.ts, which tests the journal in CI.
function findBin(start, name) {
  for (let dir = start; ; dir = path.dirname(dir)) {
    const bin = path.join(dir, "node_modules", ".bin", name);
    if (existsSync(bin)) return bin;
    if (path.dirname(dir) === dir) throw new Error(`${name} is not installed in any node_modules/.bin at or above ${start}`);
  }
}

const journal = JSON.parse(readFileSync(path.join(repoRoot, "server/db/migrations/meta/_journal.json"), "utf8"));
const journalProblems = journal.entries.flatMap((entry, position) => {
  const previous = journal.entries[position - 1];
  return [
    ...(entry.idx === position ? [] : [`${entry.tag}: idx ${entry.idx}, expected ${position}`]),
    ...(!previous || entry.when > previous.when ? [] : [`${entry.tag}: when ${entry.when} is not after ${previous.tag} (${previous.when})`]),
  ];
});
if (journalProblems.length > 0) {
  throw new Error(`[migrate] server/db/migrations/meta/_journal.json is out of order; restamp the new entry later than the last one:\n${journalProblems.join("\n")}`);
}

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const execFileAsync = promisify(execFile);

const client = new Client({ connectionString: databaseUrl });
await client.connect();
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
  // Fail clearly when the URL is a restricted runtime role (docslurp_app,
  // docslurp_worker) instead of the owner: set MIGRATION_DATABASE_URL.
  const migrator = await assertMigrationOwner(client);
  // Call the installed binary directly: images and hosts may not have pnpm on PATH.
  // It is a root devDependency, so it sits in the nearest node_modules/.bin at or
  // above this repo: /app/core/... in the private app image installs it at /app.
  const drizzleKit = findBin(repoRoot, "drizzle-kit");
  const { stdout, stderr } = await execFileAsync(
    drizzleKit,
    ["migrate", "--config", "drizzle.config.ts"],
    { cwd: repoRoot, env: { ...process.env, DATABASE_URL: databaseUrl }, maxBuffer: 16 * 1024 * 1024 },
  );
  const output = `${stdout}\n${stderr}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
  if (output) console.log(output.split("\n").filter((line) => !/applying migrations\.\.\./.test(line)).join("\n"));
  // Grants for the least-privilege roles, when they exist (server/db/roles.mjs).
  // Still under the migration lock, so the new tables are granted before any
  // runtime role can be handed code that uses them.
  const reconciled = await reconcileRoleGrants(client);
  if (reconciled.length === 0) console.log(`[migrate] no least-privilege roles found; ${migrator} remains the only role in use`);
  console.log(`[migrate] complete in ${Date.now() - started}ms`);
} catch (error) {
  console.error(`[migrate] failed: ${migrationFailureDetail(error)}`);
  process.exitCode = 1;
} finally {
  await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
  await client.end();
}
