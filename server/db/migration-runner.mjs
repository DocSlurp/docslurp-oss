// The migration runner: applies every file in server/db/migrations that the database has not recorded, in name order,
// one transaction per file, and records each by filename in docslurp_migrations.applied.
//
// There is no journal. Two branches can each add a migration without touching a shared file, and a migration that
// merges late (its name sorts before one already applied) still runs: what is pending is decided per file, never by
// "newer than the newest applied".
//
// File names:
//   NNNN_name.sql            the migrations that existed before 2026-11-18 (server/db/legacy-migrations.json). Frozen:
//                            a new NNNN_ file is refused.
//   YYYYMMDDTHHMM_name.sql   everything since, stamped in UTC (`pnpm db:new <name>`). Legacy names sort first.
//
// The caller (owned-migrations.mjs, under migrate.mjs's advisory lock) owns the connection, the owner role and the
// search_path. This module only creates its ledger, maps the old Drizzle ledger once, and applies files.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LEDGER_SCHEMA = "docslurp_migrations";
export const LEDGER_TABLE = `${LEDGER_SCHEMA}.applied`;
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const LEGACY_NAME = /^\d{4}_[a-z0-9][a-z0-9_]*\.sql$/;
const TIMESTAMP_NAME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})_[a-z0-9][a-z0-9_]*\.sql$/;
// Lock waits a retry can cure: lock_not_available (lock_timeout) and deadlock_detected.
const RETRYABLE = new Set(["55P03", "40P01"]);

/** [file, journal `when`] for every migration Drizzle applied, in order. Frozen at the cutover. */
export const LEGACY_MIGRATIONS = Object.freeze(
  JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "legacy-migrations.json"), "utf8")),
);
const LEGACY_FILES = new Set(LEGACY_MIGRATIONS.map(([file]) => file));

/** Pure: why a migration file name is not acceptable, or null. */
export function migrationNameProblem(file) {
  if (LEGACY_NAME.test(file)) {
    return LEGACY_FILES.has(file) ? null
      : `${file}: numbered names are frozen; name new migrations with a UTC timestamp (pnpm db:new <name>)`;
  }
  const stamp = TIMESTAMP_NAME.exec(file);
  if (!stamp) return `${file}: expected YYYYMMDDTHHMM_snake_case_name.sql (pnpm db:new <name>)`;
  const [year, month, day, hour, minute] = stamp.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute;
  return real ? null : `${file}: ${stamp[0].slice(0, 13)} is not a real UTC date and time`;
}

/** The migration files in a folder, in the order they apply (plain code-unit order). Throws on a bad name. */
export function listMigrationFiles(migrationsFolder) {
  const files = readdirSync(migrationsFolder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const problems = files.map(migrationNameProblem).filter(Boolean);
  if (problems.length > 0) throw new Error(`[migrate] invalid migration file names:\n${problems.join("\n")}`);
  return files;
}

/**
 * Pure: the legacy files a Drizzle ledger counts as applied. Drizzle applied a journal entry only when its `when` was
 * later than the newest recorded created_at, so everything at or before that stamp is what it treated as done.
 */
export function legacyAppliedFiles(newestDrizzleCreatedAt) {
  const newest = Number(newestDrizzleCreatedAt);
  if (!Number.isFinite(newest)) return [];
  return LEGACY_MIGRATIONS.filter(([, when]) => when <= newest).map(([file]) => file);
}

/** Pure: files not yet applied, in order. `applied` is an iterable of recorded file names. */
export function pendingMigrationFiles(files, applied) {
  const done = new Set(applied);
  return files.filter((file) => !done.has(file));
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function positiveInt(value, fallback, max) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) throw new Error(`[migrate] invalid setting ${JSON.stringify(String(value))}: expected an integer from 0 to ${max}`);
  return parsed;
}

async function ensureLedger(client) {
  // Its own schema, so schema-wide grants on public never make the ledger writable by a runtime role.
  await client.query(`create schema if not exists ${LEDGER_SCHEMA}`);
  await client.query(`create table if not exists ${LEDGER_TABLE} (
    filename text primary key,
    sha256 text not null,
    applied_at timestamptz not null default now(),
    source text not null default 'runner'
  )`);
}

async function drizzleLedgerExists(client) {
  const { rows } = await client.query("select to_regclass('drizzle.__drizzle_migrations') is not null as present");
  return rows[0]?.present === true;
}

/**
 * One-time: a database Drizzle migrated has no rows in the new ledger. Record what Drizzle had applied, by file name.
 * Runs in one transaction with the emptiness check, so a second migrator cannot map twice or half.
 */
async function bootstrapFromDrizzle(client, { migrationsFolder, log }) {
  if (!(await drizzleLedgerExists(client))) return 0;
  await client.query("begin");
  try {
    const { rows: [{ empty }] } = await client.query(`select not exists (select 1 from ${LEDGER_TABLE}) as empty`);
    if (!empty) {
      await client.query("commit");
      return 0;
    }
    const { rows: [{ newest }] } = await client.query("select max(created_at)::text as newest from drizzle.__drizzle_migrations");
    const files = newest === null ? [] : legacyAppliedFiles(newest);
    for (const file of files) {
      let hash = "";
      try {
        hash = sha256(readFileSync(path.join(migrationsFolder, file), "utf8"));
      } catch {
        // A legacy file this build no longer ships is still applied; record it without a hash.
      }
      await client.query(
        `insert into ${LEDGER_TABLE} (filename, sha256, source) values ($1, $2, 'drizzle') on conflict (filename) do nothing`,
        [file, hash],
      );
    }
    await client.query("commit");
    if (files.length > 0) log(`[migrate] mapped ${files.length} migration(s) from the Drizzle ledger (through ${files.at(-1)})`);
    return files.length;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

/**
 * A database that has the schema but no record of how it got there (the ledger was dropped or restored empty, and
 * there is no Drizzle ledger to map). Replaying history is not an option: early migrations do not apply to the
 * current schema (tables they alter were since renamed or dropped). Refuse, unless the operator states which
 * migrations the schema already contains with MIGRATION_ASSUME_APPLIED_THROUGH=<file name>: every file up to and
 * including it is recorded as applied without running, and the rest run normally.
 */
async function recoverLostLedger(client, { files, env, log }) {
  const { rows: [{ lost }] } = await client.query(
    `select to_regclass('public.documents') is not null and not exists (select 1 from ${LEDGER_TABLE}) as lost`);
  const through = env.MIGRATION_ASSUME_APPLIED_THROUGH?.trim();
  if (!lost) {
    if (through) log("[migrate] MIGRATION_ASSUME_APPLIED_THROUGH ignored: the migration ledger is not empty");
    return;
  }
  if (!through) {
    throw new Error("the database has tables but no record of applied migrations (docslurp_migrations.applied is empty and there is no Drizzle ledger). "
      + "Restore the ledger, or set MIGRATION_ASSUME_APPLIED_THROUGH=<newest migration file the schema already contains> to record those as applied without running them.");
  }
  if (!files.includes(through)) throw new Error(`MIGRATION_ASSUME_APPLIED_THROUGH=${JSON.stringify(through)} is not a migration file in this build`);
  const assumed = files.filter((file) => file <= through);
  await client.query("begin");
  try {
    for (const file of assumed) {
      await client.query(`insert into ${LEDGER_TABLE} (filename, sha256, source) values ($1, '', 'assumed') on conflict (filename) do nothing`, [file]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
  log(`[migrate] recorded ${assumed.length} migration(s) through ${through} as applied without running them (MIGRATION_ASSUME_APPLIED_THROUGH)`);
}

/**
 * Keep the old Drizzle ledger current for legacy files, so the previous release (which reads it for readiness and
 * skew) still sees its schema as applied during a rollout or after a rollback. Timestamp-named files postdate every
 * release that reads it. Runs inside the file's transaction.
 */
async function mirrorToDrizzle(client, file, hash) {
  const legacy = LEGACY_MIGRATIONS.find(([name]) => name === file);
  if (!legacy) return;
  await client.query(
    `insert into drizzle.__drizzle_migrations (hash, created_at)
     select $1, $2::bigint where not exists (select 1 from drizzle.__drizzle_migrations where created_at = $2::bigint)`,
    [hash, String(legacy[1])],
  );
}

async function applyFile(client, { file, sql, hash, lockTimeoutMs, mirror }) {
  await client.query("begin");
  try {
    // A migration waiting for a table lock queues every later query on that table behind it. Bound the wait; the
    // file is retried, and a migration may still set its own (shorter or longer) lock_timeout.
    if (lockTimeoutMs > 0) await client.query(`set local lock_timeout = '${lockTimeoutMs}ms'`);
    for (const statement of sql.split(STATEMENT_BREAKPOINT)) {
      if (statement.trim()) await client.query(statement);
    }
    await client.query(
      `insert into ${LEDGER_TABLE} (filename, sha256) values ($1, $2)
       on conflict (filename) do update set sha256 = excluded.sha256, applied_at = now(), source = 'runner'`,
      [file, hash],
    );
    if (mirror) await mirrorToDrizzle(client, file, hash);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

/**
 * Apply every unrecorded migration file. The caller holds the migration advisory lock and has set the owner role.
 * Returns { applied, late, changed }: the files applied now, those of them that sorted before an already applied
 * file, and applied files whose contents no longer match what was recorded (reported, never re-run).
 */
export async function applyMigrationFiles(client, {
  migrationsFolder,
  env = process.env,
  log = (line) => console.log(line),
  warn = (line) => console.warn(line),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const lockTimeoutMs = positiveInt(env.MIGRATION_STATEMENT_LOCK_TIMEOUT_MS, 15_000, 3_600_000);
  const attempts = positiveInt(env.MIGRATION_LOCK_RETRIES, 3, 20) + 1;
  const files = listMigrationFiles(migrationsFolder);
  await ensureLedger(client);
  await bootstrapFromDrizzle(client, { migrationsFolder, log });
  await recoverLostLedger(client, { files, env, log });
  const mirror = await drizzleLedgerExists(client);

  const { rows } = await client.query(`select filename, sha256 from ${LEDGER_TABLE}`);
  const recorded = new Map(rows.map((row) => [row.filename, row.sha256]));
  const shipped = new Set(files);
  const unknown = [...recorded.keys()].filter((file) => !shipped.has(file)).sort();
  if (unknown.length > 0) {
    log(`[migrate] the database has ${unknown.length} migration(s) this build does not ship (newest ${unknown.at(-1)}); expected during a rollback`);
  }
  const changed = [];
  for (const file of files) {
    const stored = recorded.get(file);
    if (!stored) continue; // pending, or mapped from Drizzle without a hash
    if (stored !== sha256(readFileSync(path.join(migrationsFolder, file), "utf8"))) changed.push(file);
  }
  if (changed.length > 0) {
    warn(`[migrate] WARNING ${changed.length} applied migration(s) changed since they ran and are not re-run: ${changed.join(", ")}. Put schema changes in a new migration.`);
  }

  const pending = pendingMigrationFiles(files, recorded.keys());
  let newestApplied = [...recorded.keys()].filter((file) => shipped.has(file)).sort().at(-1) ?? null;
  const applied = [];
  const late = [];
  for (const file of pending) {
    const sql = readFileSync(path.join(migrationsFolder, file), "utf8");
    const hash = sha256(sql);
    if (newestApplied !== null && file < newestApplied) {
      late.push(file);
      log(`[migrate] ${file} merged after ${newestApplied} was applied; applying it now`);
    }
    const started = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      try {
        await applyFile(client, { file, sql, hash, lockTimeoutMs, mirror });
        break;
      } catch (error) {
        if (RETRYABLE.has(error?.code) && attempt < attempts) {
          warn(`[migrate] ${file}: ${error.code === "40P01" ? "deadlock" : "lock wait timed out"} (attempt ${attempt} of ${attempts}); retrying`);
          await sleep(1_000 * attempt);
          continue;
        }
        // The files before this one are committed and recorded; a re-run starts here.
        throw new Error(`migration ${file} failed: ${error?.message ?? error}`, { cause: error });
      }
    }
    applied.push(file);
    if (newestApplied === null || file > newestApplied) newestApplied = file;
    log(`[migrate] applied ${file} in ${Date.now() - started}ms`);
  }
  log(applied.length > 0 ? `[migrate] ${applied.length} migration(s) applied` : "[migrate] nothing to apply");
  return { applied, late, changed };
}
