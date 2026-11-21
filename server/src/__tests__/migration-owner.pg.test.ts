import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { LEGACY_MIGRATIONS, listMigrationFiles } from "../../db/migration-runner.mjs";
import { applyOwnedMigrations } from "../../db/owned-migrations.mjs";

const url = process.env.TEST_DATABASE_URL;
const folder = resolve("db/migrations");
const owner = `migration_owner_${process.pid}`;
const outsider = `migration_outsider_${process.pid}`;
/** Databases this file created and has not dropped yet; only these are ever dropped. */
const databases: string[] = [];
const ownedPrefix = `migration_owner_db_${process.pid}_`;
let created = 0;
let admin: Client, scratch: string;
const attested = { GENERATION_ROLLOUT_DRAINED: "all-executions-and-activities-stopped" };
async function connect(database: string, runtime = false) {
  const target = new URL(url!); target.pathname = `/${database}`;
  if (runtime) { target.username = owner; target.password = "local-owner-fixture"; }
  const c = new Client({ connectionString: target.toString(), connectionTimeoutMillis: 2_000 });
  try { await c.connect(); return c; } catch (error) { await c.end(); throw error; }
}
beforeAll(async () => {
  if (!url) return;
  admin = await connect("postgres");
  await admin.query(`create role ${owner} login password 'local-owner-fixture'; create role ${outsider} nologin;
    do $$ begin if not exists(select 1 from pg_roles where rolname='docslurp_app') then
      create role docslurp_app nologin; end if; end $$;
    do $$ begin if not exists(select 1 from pg_roles where rolname='docslurp_realtime_publisher') then
      create role docslurp_realtime_publisher nologin noinherit; end if; end $$;
    grant docslurp_realtime_publisher to ${owner}`);
  scratch = mkdtempSync(resolve(tmpdir(), "owner-migration-")); mkdirSync(resolve(scratch, "meta"));
  // "Old" databases are Drizzle-migrated, as production was before the runner: migrate.mjs then maps that ledger.
  const journal = { version: "7", dialect: "postgresql", entries: LEGACY_MIGRATIONS.slice(0, 112).map(([file, when], idx) => ({ idx, version: "7", when, tag: file.replace(/\.sql$/, ""), breakpoints: true })) };
  writeFileSync(resolve(scratch, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) copyFileSync(resolve(folder, `${entry.tag}.sql`), resolve(scratch, `${entry.tag}.sql`));
});
/*
 * Drop each test's databases when it ends, not all of them in afterAll. Every DROP DATABASE waits for an immediate
 * checkpoint, and that checkpoint flushes every dirty buffer the earlier tests' migrations left. Dropping all eight at
 * the end made the first drop pay for all of them (measured locally: 10,417 buffers and 7,959 fsynced files, 3.7 s of
 * a 4.0 s teardown), which went past the 10 s hook timeout on CI's slower disks. Dropped right away, a database's own
 * dirty buffers are discarded, so each checkpoint has almost nothing to flush: 8 drops, 0.27 s total, 48 ms at most,
 * and no hook needs a longer timeout. Each test's clients have already
 * ended here (pg_stat_activity showed no sessions on these databases), so FORCE terminates nothing that is still in use.
 */
async function dropOwnedDatabases() {
  while (databases.length) {
    const name = databases.shift()!;
    if (!name.startsWith(ownedPrefix)) throw new Error(`refusing to drop ${name}: not created by this test file`);
    await admin.query(`drop database if exists ${name} with (force)`);
  }
}
afterEach(async () => { if (admin) await dropOwnedDatabases(); });
afterAll(async () => {
  if (!admin) return;
  await dropOwnedDatabases();
  await admin.query(`drop role ${owner}; drop role ${outsider}`);
  await admin.end(); if (scratch) rmSync(scratch, { recursive: true });
});
async function database(old = true, postgis = false) {
  const name = `${ownedPrefix}${created++}`;
  databases.push(name); await admin.query(`create database ${name} owner ${owner} template template0`);
  const c = await connect(name);
  if (postgis) await c.query("create extension postgis");
  if (old) { await c.query(`set role ${owner}`); await migrate(drizzle(c), { migrationsFolder: scratch }); await c.query("reset role"); }
  await c.end(); return name;
}

it.skipIf(!url)("keeps a closed pre-generation database on one superuser session while preserving owner DDL, ledgers and runtime access", async () => {
  const name = await database();
  await admin.query(`alter database ${name} connection limit 0`);
  await expect(connect(name, true)).rejects.toMatchObject({ code: "53300" });
  const c = await connect(name);
  try {
    const pid = (await c.query("select pg_backend_pid() as pid")).rows[0].pid;
    await applyOwnedMigrations(c, { migrationsFolder: folder, env: attested });
    expect((await c.query("select pg_backend_pid() as pid")).rows[0].pid).toBe(pid);
    expect((await c.query("select count(*)::int n from pg_stat_activity where datname=current_database()")).rows[0].n).toBe(1);
    const { rows } = await c.query("select distinct tableowner from pg_tables where schemaname in ('public','drizzle','docslurp_migrations','docslurp_mastra')");
    expect(rows).toEqual([{ tableowner: owner }]);
    // The fixture was migrated by Drizzle through the first 112 files: those are mapped, not re-run; the rest ran.
    const ledger = (await c.query("select source, count(*)::int n, max(filename) newest from docslurp_migrations.applied group by source order by source")).rows;
    expect(ledger).toEqual([
      { source: "drizzle", n: 112, newest: LEGACY_MIGRATIONS[111]![0] },
      { source: "runner", n: listMigrationFiles(folder).length - 112, newest: listMigrationFiles(folder).at(-1) },
    ]);
    // The previous release reads the Drizzle ledger: it stays current for the numbered files.
    expect((await c.query("select count(*)::int n, max(created_at)::text newest from drizzle.__drizzle_migrations")).rows[0])
      .toEqual({ n: LEGACY_MIGRATIONS.length, newest: String(LEGACY_MIGRATIONS.at(-1)![1]) });
    // A rollback: the previous release's Drizzle migrator, given every numbered file, finds nothing to apply
    // (a replay would fail at 0000 on this schema) and leaves the schema as it is.
    const previous = mkdtempSync(resolve(tmpdir(), "previous-release-")); mkdirSync(resolve(previous, "meta"));
    try {
      const all = { version: "7", dialect: "postgresql", entries: LEGACY_MIGRATIONS.map(([file, when], idx) => ({ idx, version: "7", when, tag: file.replace(/\.sql$/, ""), breakpoints: true })) };
      writeFileSync(resolve(previous, "meta/_journal.json"), JSON.stringify(all));
      for (const [file] of LEGACY_MIGRATIONS) copyFileSync(resolve(folder, file), resolve(previous, file));
      const shape = "select count(*)::int n from information_schema.columns where table_schema = 'public'";
      const before = (await c.query(shape)).rows[0].n;
      await c.query(`set role ${owner}`);
      try { await migrate(drizzle(c), { migrationsFolder: previous }); } finally { await c.query("reset role"); }
      expect((await c.query(shape)).rows[0].n).toBe(before);
      expect((await c.query("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n).toBe(LEGACY_MIGRATIONS.length);
    } finally { rmSync(previous, { recursive: true }); }
    // Runtime roles read the ledger and can never write it or create beside it.
    const access = (await c.query(`select has_table_privilege('docslurp_app', 'docslurp_migrations.applied', 'select') as reads,
      has_table_privilege('docslurp_app', 'docslurp_migrations.applied', 'insert, update, delete, truncate') as writes,
      has_schema_privilege('docslurp_app', 'docslurp_migrations', 'create') as creates,
      has_table_privilege('public', 'docslurp_migrations.applied', 'select') as public_reads`)).rows[0];
    expect(access).toEqual({ reads: true, writes: false, creates: false, public_reads: false });
    const defaults = await c.query(`select a.privilege_type from pg_default_acl d,
      lateral aclexplode(d.defaclacl) a where d.defaclrole=$1::regrole
      and d.defaclnamespace='public'::regnamespace and d.defaclobjtype='r'
      and a.grantee='docslurp_app'::regrole order by 1`, [owner]);
    expect(defaults.rows.map(r => r.privilege_type)).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    expect((await c.query("select rolsuper,rolcreaterole from pg_roles where rolname=$1", [owner])).rows[0]).toEqual({ rolsuper: false, rolcreaterole: false });
    expect((await c.query("select pg_has_role($1,session_user,'MEMBER') as inherited_admin", [owner])).rows[0].inherited_admin).toBe(false);
    await expect(connect(name, true)).rejects.toMatchObject({ code: "53300" });
  } finally { await c.end(); }
  await admin.query(`alter database ${name} connection limit -1`);
  const runtime = await connect(name, true);
  try {
    await runtime.query(`select * from chat_operations limit 1;
      insert into "user"(id,name,email) values('owner-test','Test','owner-test@example.test');
      insert into organizations(id,name,slug,created_by_user_id) values('owner-test','Test','owner-test','owner-test');
      insert into projects(id,org_id,user_id,name) values('owner-test','owner-test','owner-test','Test');
      select * from realtime_revisions;`);
    // A normal subsequent owner migration must remain supported and idempotent.
    await applyOwnedMigrations(runtime, { migrationsFolder: folder, env: {} });
  } finally { await runtime.end(); }
}, 60_000);

it.skipIf(!url)("refuses missing attestation, an open barrier, competing sessions and a non-superuser", async () => {
  const name = await database(); const c = await connect(name);
  try {
    await expect(applyOwnedMigrations(c, { migrationsFolder: folder, env: {} })).rejects.toThrow("attestation missing");
    await expect(applyOwnedMigrations(c, { migrationsFolder: folder, env: attested })).rejects.toThrow("CONNECTION LIMIT 0");
    const other = await connect(name); await admin.query(`alter database ${name} connection limit 0`);
    await expect(applyOwnedMigrations(c, { migrationsFolder: folder, env: attested })).rejects.toThrow("no other sessions");
    await other.end();
    await c.query(`insert into "user"(id,name,email) values('unfinished','Test','unfinished@example.test');
      insert into organizations(id,name,slug,created_by_user_id) values('unfinished','Test','unfinished','unfinished');
      insert into workspaces(id,org_id,user_id,name) values('unfinished','unfinished','unfinished','Test');
      insert into workspace_runs(id,org_id,user_id,workspace_id,kind,status,stage)
        values('unfinished','unfinished','unfinished','unfinished','upload','queued','queued')`);
    await expect(applyOwnedMigrations(c, { migrationsFolder: folder, env: attested })).rejects.toThrow("unfinished SQL runs");
    await c.query(`set session authorization ${owner}`);
    await expect(applyOwnedMigrations(c, { migrationsFolder: folder, env: attested })).rejects.toThrow("superuser migrator");
  } finally { await c.end(); }
}, 60_000);

it.skipIf(!url)("rejects wrong owners and unsafe identifiers before creating the migration ledger", async () => {
  const name = await database(false); const c = await connect(name);
  try {
    for (const candidate of [outsider, 'bad"; RESET ROLE;--', "x".repeat(64)]) {
      await expect(applyOwnedMigrations(c, { migrationsFolder: folder, env: { MIGRATION_OWNER_ROLE: candidate } })).rejects.toThrow(/owner/);
    }
    expect((await c.query("select to_regclass('docslurp_migrations.applied') as ledger, to_regnamespace('docslurp_migrations') as ledger_schema")).rows[0]).toEqual({ ledger: null, ledger_schema: null });
    await c.query(`set session authorization ${outsider}`);
    await expect(applyOwnedMigrations(c, { migrationsFolder: folder, env: {} })).rejects.toThrow(/cannot run migrations/);
  } finally { await c.end(); }
});

it.skipIf(!url)("supports fresh owner migrations without an attestation", async () => {
  const name = await database(false); const c = await connect(name, true);
  try { await applyOwnedMigrations(c, { migrationsFolder: folder, env: {} }); }
  finally { await c.end(); }
}, 60_000);

it.skipIf(!url)("refuses an elevated delegated owner or a preconfigured role override", async () => {
  const name = await database(false); const c = await connect(name);
  try {
    await admin.query(`alter role ${owner} createrole`);
    await expect(applyOwnedMigrations(c, { migrationsFolder: folder, env: {} })).rejects.toThrow("elevated role attributes");
    await admin.query(`alter role ${owner} nocreaterole`);
    await c.query(`set role ${owner}`);
    await expect(applyOwnedMigrations(c, { migrationsFolder: folder, env: {} })).rejects.toThrow("without a role override");
  } finally { await c.end(); await admin.query(`alter role ${owner} nocreaterole`); }
});

it.skipIf(!url)("runs the actual supported CLI against the closed database and preserves ownership", async () => {
  const name = await database(); await admin.query(`alter database ${name} connection limit 0`);
  const target = new URL(url!); target.pathname = `/${name}`;
  const migrateCli = () => spawnSync(process.execPath, ["db/migrate.mjs"], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, DATABASE_URL: target.toString(), MIGRATION_DATABASE_URL: target.toString(),
      MIGRATION_OWNER_ROLE: owner, POSTGIS_MIGRATIONS: "0", ...attested },
  });
  // CONNECTION LIMIT 0 blocks ordinary connections, but an autovacuum worker
  // can still be finishing on this newly migrated fixture. The CLI must refuse
  // while it is present. Retry once after the fixture is actually drained.
  let result = migrateCli();
  if (result.stderr?.includes("database must have CONNECTION LIMIT 0, a superuser migrator, and no other sessions")) {
    await expect.poll(async () => (await admin.query(
      "select backend_type from pg_stat_activity where datname = $1", [name],
    )).rows, { timeout: 2_000 }).toEqual([]);
    result = migrateCli();
  }
  expect(result.status, result.stderr).toBe(0);
  const c = await connect(name);
  try {
    expect((await c.query("select tableowner from pg_tables where schemaname='public' and tablename='chat_operations'")).rows[0].tableowner).toBe(owner);
    expect((await c.query("select datconnlimit from pg_database where datname=current_database()")).rows[0].datconnlimit).toBe(0);
  } finally { await c.end(); }
}, 60_000);

it.skipIf(!url)("refuses missing publisher membership and rolls back pending schema changes", async () => {
  const name = await database(); await admin.query(`alter database ${name} connection limit 0`);
  await admin.query(`revoke docslurp_realtime_publisher from ${owner}`);
  const c = await connect(name);
  try {
    await expect(applyOwnedMigrations(c, { migrationsFolder: folder, env: attested })).rejects.toThrow();
    expect((await c.query("select exists(select 1 from information_schema.columns where table_name='project_runs' and column_name='execution_generation') as applied")).rows[0].applied).toBe(false);
    expect((await c.query("select current_user=session_user as restored")).rows[0].restored).toBe(true);
  } finally { await c.end(); await admin.query(`grant docslurp_realtime_publisher to ${owner}`); }
}, 60_000);

it.skipIf(!url)("keeps optional PostGIS ledgers and application projections under the same owner", async () => {
  const name = await database(true, true); await admin.query(`alter database ${name} connection limit 0`);
  const c = await connect(name);
  try {
    await applyOwnedMigrations(c, { migrationsFolder: folder, env: { ...attested, POSTGIS_MIGRATIONS: "1" } });
    expect((await c.query("select tableowner from pg_tables where tablename='postgis_migration_ledger'")).rows[0].tableowner).toBe(owner);
    expect((await c.query("select count(*)::int n from postgis_migration_ledger")).rows[0].n).toBe(2);
  } finally { await c.end(); }
}, 60_000);
