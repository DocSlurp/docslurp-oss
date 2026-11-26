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
export const FIRST_TIMESTAMP = "20261118T0000";
// Serializes "is this file still unrecorded?" with recording it, for callers that do not hold migrate.mjs's session lock.
const FILE_LOCK_KEY = 7_142_771_002;
// Left on drizzle.__drizzle_migrations when it is mapped: that ledger alone no longer says what is applied.
const CUTOVER_MARKER = "docslurp: mapped to docslurp_migrations.applied";
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
  if (!real) return `${file}: ${stamp[0].slice(0, 13)} is not a real UTC date and time`;
  // Before the cutover a stamp would sort among (or before) the numbered files.
  return stamp[0].slice(0, 13) >= FIRST_TIMESTAMP ? null : `${file}: timestamps start at ${FIRST_TIMESTAMP} (the day numbered names were frozen)`;
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
  await assertTrustedLedger(client, LEDGER_SCHEMA, "applied", ["filename", "sha256", "applied_at", "source"]);
}

/**
 * The ledgers decide what the owner runs, and the owner writes to them. Trust one only if the migration owner owns it
 * and nothing is attached that could run someone else's code as the owner or hide rows: a role that could create the
 * schema or table first (CREATE on the database) must not be able to plant it. Fails closed.
 */
async function assertTrustedLedger(client, schema, table, columns) {
  const { rows: [found] } = await client.query(
    `select pg_get_userbyid(n.nspowner) = current_user as owns_schema, pg_get_userbyid(c.relowner) = current_user as owns_table,
       c.relkind::text as kind, c.relrowsecurity as rls, c.relpersistence::text as persistence,
       exists (select 1 from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal) as triggers,
       exists (select 1 from pg_rewrite r where r.ev_class = c.oid) as rules,
       exists (select 1 from pg_inherits i where i.inhrelid = c.oid or i.inhparent = c.oid) as inherits,
       (select coalesce(array_agg(a.attname::text order by a.attnum), '{}') from pg_attribute a
          where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns
     from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2`,
    [schema, table]);
  const name = `${schema}.${table}`;
  const problems = !found ? ["it does not exist"] : [
    found.owns_schema ? null : "its schema is not owned by the migration owner",
    found.owns_table ? null : "it is not owned by the migration owner",
    found.kind === "r" && found.persistence === "p" ? null : "it is not an ordinary permanent table",
    found.rls ? "row-level security is enabled on it" : null,
    found.triggers ? "it has triggers" : null,
    found.rules ? "it has rules" : null,
    found.inherits ? "it takes part in inheritance" : null,
    columns.every((column) => found.columns.includes(column)) ? null : `it lacks the expected columns (${columns.join(", ")})`,
  ].filter(Boolean);
  if (problems.length > 0) throw new Error(`refusing the migration ledger ${name}: ${problems.join("; ")}`);
}

async function drizzleLedgerExists(client) {
  const { rows } = await client.query("select to_regclass('drizzle.__drizzle_migrations') is not null as present");
  return rows[0]?.present === true;
}

/**
 * One-time: a database Drizzle migrated has no rows in the new ledger. Record what Drizzle had applied, by file name.
 * Runs in one transaction with the emptiness check, so a second migrator cannot map twice or half.
 */
async function bootstrapFromDrizzle(client, { migrationsFolder, env, log, warn, mirror }) {
  if (!mirror) return 0;
  await client.query("begin");
  try {
    const { rows: [{ empty, mapped }] } = await client.query(`select not exists (select 1 from ${LEDGER_TABLE}) as empty,
      obj_description('drizzle.__drizzle_migrations'::regclass, 'pg_class') = '${CUTOVER_MARKER}' as mapped`);
    // Mapped before and empty now: the ledger was lost. Mapping again would re-run every migration added since
    // the cutover, so leave it empty for recoverLostLedger to refuse.
    if (!empty || mapped === true) {
      await client.query("commit");
      return 0;
    }
    const { rows: [{ newest, entries }] } = await client.query(
      "select max(created_at)::text as newest, count(distinct created_at)::int as entries from drizzle.__drizzle_migrations");
    // The mapping is only as good as that newest stamp. One we do not know (restamped by hand, from a fork, or newer
    // than every numbered file) cannot say what is applied: refuse rather than guess, unless the operator says.
    if (newest !== null && !LEGACY_MIGRATIONS.some(([, when]) => when === Number(newest))) {
      if (env.MIGRATION_ASSUME_APPLIED_THROUGH?.trim()) {
        await client.query("commit");
        return 0;
      }
      throw new Error(`the Drizzle ledger's newest entry (created_at ${newest}) is not a known migration stamp, so it cannot be mapped. `
        + "Set MIGRATION_ASSUME_APPLIED_THROUGH=<newest migration file the schema already contains> to record those as applied without running them.");
    }
    const files = newest === null ? [] : legacyAppliedFiles(newest);
    if (entries !== files.length) {
      warn(`[migrate] WARNING the Drizzle ledger has ${entries} entr${entries === 1 ? "y" : "ies"} but its newest stamp covers ${files.length} migration(s); mapping by the newest stamp, as Drizzle did`);
    }
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
    await client.query(`comment on table drizzle.__drizzle_migrations is '${CUTOVER_MARKER}'`);
    await client.query("commit");
    if (files.length > 0) log(`[migrate] mapped ${files.length} migration(s) from the Drizzle ledger (${files[0]} through ${files.at(-1)})`);
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
async function recoverLostLedger(client, { files, env, log, mirror }) {
  const { rows: [{ lost }] } = await client.query(
    `select to_regclass('public.documents') is not null and not exists (select 1 from ${LEDGER_TABLE}) as lost`);
  const through = env.MIGRATION_ASSUME_APPLIED_THROUGH?.trim();
  if (!lost) {
    if (through) log("[migrate] MIGRATION_ASSUME_APPLIED_THROUGH ignored: the migration ledger is not empty");
    return;
  }
  if (!through) {
    throw new Error("the database has tables but no record of applied migrations (docslurp_migrations.applied is empty and there is no unmapped Drizzle ledger). "
      + "Restore the ledger, or set MIGRATION_ASSUME_APPLIED_THROUGH=<newest migration file the schema already contains> to record those as applied without running them.");
  }
  if (!files.includes(through)) throw new Error(`MIGRATION_ASSUME_APPLIED_THROUGH=${JSON.stringify(through)} is not a migration file in this build`);
  const assumed = files.filter((file) => file <= through);
  await client.query("begin");
  try {
    for (const file of assumed) {
      await client.query(`insert into ${LEDGER_TABLE} (filename, sha256, source) values ($1, '', 'assumed') on conflict (filename) do nothing`, [file]);
      if (mirror) await mirrorToDrizzle(client, file, "assumed");
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
  log(`[migrate] recorded ${assumed.length} migration(s) through ${through} as applied without running them (MIGRATION_ASSUME_APPLIED_THROUGH); unset it now. `
    + "A migration that sorts before it and was never applied is now skipped for good: check the list against the schema.");
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

/** Statements, the ledger row and the Drizzle mirror for one file, inside the caller's transaction. False: already recorded. */
async function applyFileInTransaction(client, { file, sql, hash, lockTimeoutMs, mirror, actor }) {
  const { rows: [{ started }] } = await client.query("select now()::text as started");
  // Callers that do not hold migrate.mjs's session lock (or lost it through a pooler) must still never run a file twice.
  await client.query("select pg_advisory_xact_lock($1)", [FILE_LOCK_KEY]);
  const { rows: [{ recorded }] } = await client.query(`select exists (select 1 from ${LEDGER_TABLE} where filename = $1) as recorded`, [file]);
  if (recorded) return false;
  // A migration waiting for a table lock queues every later query on that table behind it. Bound the wait; the
  // file is retried, and a migration may still set its own (shorter or longer) lock_timeout.
  if (lockTimeoutMs > 0) await client.query(`set local lock_timeout = '${lockTimeoutMs}ms'`);
  for (const statement of sql.split(STATEMENT_BREAKPOINT)) {
    if (statement.trim()) await client.query(statement);
  }
  // A file must not end its transaction or change who it runs as (the CI gate refuses both): what follows, and the
  // files after it, would otherwise run outside the transaction or as someone else.
  const { rows: [state] } = await client.query("select current_user::text as actor, now()::text as started");
  if (state.actor !== actor) throw new Error(`${file} changed the session role (to ${state.actor}); migrations must not SET or RESET ROLE`);
  // now() is fixed for a transaction: a different value means the file ended the one it was given.
  if (state.started !== started) throw new Error(`${file} ended its transaction; migrations must not BEGIN, COMMIT or ROLLBACK`);
  const inserted = await client.query(`insert into ${LEDGER_TABLE} (filename, sha256) values ($1, $2) returning filename`, [file, hash]);
  if (inserted.rows.length !== 1) throw new Error(`${file} ran but could not be recorded in ${LEDGER_TABLE}`);
  if (mirror) await mirrorToDrizzle(client, file, hash);
  return true;
}

async function applyFile(client, options) {
  await client.query("begin");
  try {
    const applied = await applyFileInTransaction(client, options);
    await client.query("commit");
    return applied;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

/**
 * Apply every unrecorded migration file. The caller holds the migration advisory lock and has set the owner role.
 * Returns { applied, late, changed }: the files applied now, those of them that sorted before an already applied
 * file, and applied files whose contents no longer match what was recorded (reported, never re-run). A failure
 * carries `appliedFiles`: what was committed before it.
 *
 * `atomic` applies the whole pending set in one transaction (all or nothing, no retries): for an upgrade that is only
 * safe as a unit, where a half-applied state must not be left behind for a later run to finish.
 */
export async function applyMigrationFiles(client, {
  migrationsFolder,
  env = process.env,
  atomic = false,
  log = (line) => console.log(line),
  warn = (line) => console.warn(line),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const lockTimeoutMs = positiveInt(env.MIGRATION_STATEMENT_LOCK_TIMEOUT_MS, 15_000, 3_600_000);
  const attempts = positiveInt(env.MIGRATION_LOCK_RETRIES, 3, 20) + 1;
  const files = listMigrationFiles(migrationsFolder);
  const { rows: [{ actor }] } = await client.query("select current_user::text as actor");
  await ensureLedger(client);
  const mirror = await drizzleLedgerExists(client);
  if (mirror) await assertTrustedLedger(client, "drizzle", "__drizzle_migrations", ["hash", "created_at"]);
  await bootstrapFromDrizzle(client, { migrationsFolder, env, log, warn, mirror });
  await recoverLostLedger(client, { files, env, log, mirror });

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
    if (!stored) continue; // pending, or recorded without a hash
    if (stored !== sha256(readFileSync(path.join(migrationsFolder, file), "utf8"))) changed.push(file);
  }
  if (changed.length > 0) {
    warn(`[migrate] WARNING ${changed.length} applied migration(s) changed since they ran and are not re-run: ${changed.join(", ")}. Put schema changes in a new migration.`);
  }

  const pending = pendingMigrationFiles(files, recorded.keys());
  let newestApplied = [...recorded.keys()].filter((file) => shipped.has(file)).sort().at(-1) ?? null;
  const applied = [];
  const late = [];
  const failure = (file, error) => Object.assign(
    new Error(`migration ${file} failed: ${error?.message ?? error}`, { cause: error }),
    { appliedFiles: atomic ? [] : [...applied] },
  );
  if (atomic && pending.length > 0) await client.query("begin");
  for (const file of pending) {
    const sql = readFileSync(path.join(migrationsFolder, file), "utf8");
    const options = { file, sql, hash: sha256(sql), lockTimeoutMs, mirror, actor };
    if (newestApplied !== null && file < newestApplied) {
      late.push(file);
      log(`[migrate] ${file} merged after ${newestApplied} was applied; applying it now`);
    }
    const started = Date.now();
    let ran = true;
    for (let attempt = 1; ; attempt += 1) {
      try {
        ran = atomic ? await applyFileInTransaction(client, options) : await applyFile(client, options);
        break;
      } catch (error) {
        if (atomic) {
          await client.query("rollback").catch(() => {});
          throw failure(file, error);
        }
        if (RETRYABLE.has(error?.code) && attempt < attempts) {
          warn(`[migrate] ${file}: ${error.code === "40P01" ? "deadlock" : "lock wait timed out"} (attempt ${attempt} of ${attempts}); retrying`);
          await sleep(1_000 * attempt);
          continue;
        }
        // The files before this one are committed and recorded; a re-run starts here.
        throw failure(file, error);
      }
    }
    if (newestApplied === null || file > newestApplied) newestApplied = file;
    if (!ran) {
      log(`[migrate] ${file} was recorded by another migrator; skipped`);
      continue;
    }
    applied.push(file);
    log(`[migrate] applied ${file} in ${Date.now() - started}ms`);
  }
  if (atomic && pending.length > 0) await client.query("commit");
  log(applied.length > 0 ? `[migrate] ${applied.length} migration(s) applied${atomic ? " in one transaction" : ""}` : "[migrate] nothing to apply");
  return { applied, late, changed };
}
