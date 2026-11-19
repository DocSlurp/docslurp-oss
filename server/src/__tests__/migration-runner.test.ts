import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LEDGER_TABLE,
  LEGACY_MIGRATIONS,
  applyMigrationFiles,
  legacyAppliedFiles,
  listMigrationFiles,
  migrationNameProblem,
  pendingMigrationFiles,
} from "../../db/migration-runner.mjs";

/** pg.Client's query shape over PGlite: parameterless text may hold several statements. */
function clientFor(db: PGlite) {
  const calls: string[] = [];
  return {
    calls,
    async query(text: string, params?: unknown[]) {
      calls.push(text);
      if (params && params.length > 0) return db.query(text, params);
      const results = await db.exec(text);
      return { rows: (results.at(-1)?.rows ?? []) as any[] };
    },
  };
}

const FIRST = LEGACY_MIGRATIONS[0]![0];
const SECOND = LEGACY_MIGRATIONS[1]![0];
const THIRD = LEGACY_MIGRATIONS[2]![0];
const quiet = { log: () => {}, warn: () => {}, sleep: async () => {} };

let dir: string;
let db: PGlite;
let client: ReturnType<typeof clientFor>;
const write = (file: string, sql: string) => writeFileSync(join(dir, file), sql);
const ledger = async () => (await db.query<{ filename: string; source: string }>(`select filename, source from ${LEDGER_TABLE} order by filename`)).rows;
const tables = async () => (await db.query<{ t: string }>("select table_name as t from information_schema.tables where table_schema = 'public' order by 1")).rows.map((row) => row.t);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "migration-runner-"));
  db = new PGlite();
  client = clientFor(db);
});
afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("migration file names", () => {
  it("accepts the frozen numbered files and UTC timestamp names, and nothing else", () => {
    expect(migrationNameProblem(FIRST)).toBeNull();
    expect(migrationNameProblem("20261118T1443_hot_query_indexes.sql")).toBeNull();
    expect(migrationNameProblem("0999_new_numbered.sql")).toMatch(/numbered names are frozen/);
    expect(migrationNameProblem("20261340T1443_bad_month.sql")).toMatch(/not a real UTC date/);
    expect(migrationNameProblem("20261118T2460_bad_time.sql")).toMatch(/not a real UTC date/);
    expect(migrationNameProblem("20261118_no_time.sql")).toMatch(/expected YYYYMMDDTHHMM/);
    // A stamp before the cutover would sort among or before the numbered files.
    expect(migrationNameProblem("01500101T0000_ancient.sql")).toMatch(/timestamps start at 20261118T0000/);
    expect(migrationNameProblem("20261117T2359_day_before.sql")).toMatch(/timestamps start at/);
    expect(migrationNameProblem(FIRST.replace(/_.*/, "_renamed.sql"))).toMatch(/numbered names are frozen/);
    expect(migrationNameProblem("20261118T1443_Upper.sql")).toMatch(/expected YYYYMMDDTHHMM/);
  });

  it("lists files in apply order, numbered before timestamps, ignoring folders and other files", () => {
    for (const file of ["20261118T1443_b.sql", SECOND, "20261118T0900_a.sql", FIRST]) write(file, "select 1;");
    writeFileSync(join(dir, "README.md"), "");
    mkdirSync(join(dir, "postgis"));
    writeFileSync(join(dir, "postgis", "0001_x.sql"), "");
    expect(listMigrationFiles(dir)).toEqual([FIRST, SECOND, "20261118T0900_a.sql", "20261118T1443_b.sql"]);
    write("0999_new_numbered.sql", "select 1;");
    expect(() => listMigrationFiles(dir)).toThrow(/numbered names are frozen/);
  });

  it("decides pending per file, not by position", () => {
    expect(pendingMigrationFiles(["a", "b", "c"], ["a", "c"])).toEqual(["b"]);
  });

  it("maps a Drizzle ledger to the files it counted as applied", () => {
    expect(legacyAppliedFiles(LEGACY_MIGRATIONS[1]![1])).toEqual([FIRST, SECOND]);
    expect(legacyAppliedFiles(String(LEGACY_MIGRATIONS[1]![1] + 1))).toEqual([FIRST, SECOND]);
    expect(legacyAppliedFiles(0)).toEqual([]);
    expect(legacyAppliedFiles(Number.MAX_SAFE_INTEGER)).toHaveLength(LEGACY_MIGRATIONS.length);
  });
});

describe("applyMigrationFiles", () => {
  it("applies every file once, in order, and records it by name", async () => {
    write(FIRST, "create table if not exists a (id int);");
    write("20261118T1443_b.sql", "create table if not exists b (id int);--> statement-breakpoint\ncreate table if not exists c (id int);");
    expect((await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).applied).toEqual([FIRST, "20261118T1443_b.sql"]);
    expect(await tables()).toEqual(["a", "b", "c"]);
    expect(await ledger()).toEqual([{ filename: FIRST, source: "runner" }, { filename: "20261118T1443_b.sql", source: "runner" }]);
    expect(await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).toEqual({ applied: [], late: [], changed: [] });
  });

  it("applies a migration that merged late, after a later-named one was applied", async () => {
    write("20261118T1500_later.sql", "create table if not exists later (id int);");
    await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet });
    write("20261118T0900_earlier.sql", "create table if not exists earlier (id int);");
    const result = await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet });
    expect(result).toMatchObject({ applied: ["20261118T0900_earlier.sql"], late: ["20261118T0900_earlier.sql"] });
    expect(await tables()).toEqual(["earlier", "later"]);
  });

  it("commits each file on its own: a failure keeps the files before it and records nothing for the failed one", async () => {
    write("20261118T0900_ok.sql", "create table if not exists ok (id int);");
    write("20261118T1000_bad.sql", "create table if not exists half (id int);--> statement-breakpoint\nselect * from missing_table;");
    write("20261118T1100_after.sql", "create table if not exists after_bad (id int);");
    await expect(applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).rejects.toThrow(/migration 20261118T1000_bad\.sql failed: .*missing_table/);
    expect(await tables()).toEqual(["ok"]);
    expect((await ledger()).map((row) => row.filename)).toEqual(["20261118T0900_ok.sql"]);
    // Fixed and re-run: it continues from the failed file.
    write("20261118T1000_bad.sql", "create table if not exists half (id int);");
    expect((await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).applied).toEqual(["20261118T1000_bad.sql", "20261118T1100_after.sql"]);
  });

  it("maps a Drizzle-migrated database once and applies only what Drizzle had not", async () => {
    await db.exec(`create table a (id int); create schema drizzle;
      create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
      insert into drizzle.__drizzle_migrations (hash, created_at) values ('h0', ${LEGACY_MIGRATIONS[0]![1]}), ('h1', ${LEGACY_MIGRATIONS[1]![1]});`);
    write(FIRST, "create table a (id int);"); // would fail if re-run
    write(SECOND, "create table a (id int);");
    write(THIRD, "create table if not exists third (id int);");
    write("20261118T1443_new.sql", "create table if not exists fresh (id int);");
    const result = await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet });
    expect(result.applied).toEqual([THIRD, "20261118T1443_new.sql"]);
    expect(await ledger()).toEqual([
      { filename: FIRST, source: "drizzle" }, { filename: SECOND, source: "drizzle" },
      { filename: THIRD, source: "runner" }, { filename: "20261118T1443_new.sql", source: "runner" },
    ]);
    // The previous release reads the Drizzle ledger: legacy files stay mirrored there, new ones do not.
    const mirrored = (await db.query<{ created_at: string }>("select created_at::text from drizzle.__drizzle_migrations order by created_at")).rows.map((row) => Number(row.created_at));
    expect(mirrored).toEqual(LEGACY_MIGRATIONS.slice(0, 3).map(([, when]) => when));
    expect((await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).applied).toEqual([]);
  });

  it("does not map again once the ledger has rows, whatever the Drizzle ledger says", async () => {
    write("20261118T1443_new.sql", "create table if not exists fresh (id int);");
    await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet });
    await db.exec(`create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
      insert into drizzle.__drizzle_migrations (hash, created_at) values ('h', ${LEGACY_MIGRATIONS[0]![1]});`);
    write(FIRST, "create table if not exists a (id int);");
    expect((await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).applied).toEqual([FIRST]);
  });

  it("reports an applied file whose contents changed, without re-running it", async () => {
    write("20261118T1443_new.sql", "create table if not exists fresh (id int);");
    await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet });
    write("20261118T1443_new.sql", "create table if not exists other (id int);");
    const warnings: string[] = [];
    const result = await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet, warn: (line) => warnings.push(line) });
    expect(result).toEqual({ applied: [], late: [], changed: ["20261118T1443_new.sql"] });
    expect(warnings.join("\n")).toMatch(/changed since they ran/);
    expect(await tables()).toEqual(["fresh"]);
  });

  it("tolerates ledger rows for files this build does not ship (a rollback)", async () => {
    write("20261118T1443_new.sql", "create table if not exists fresh (id int);");
    await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet });
    await db.exec(`insert into ${LEDGER_TABLE} (filename, sha256) values ('20270101T0000_future.sql', 'x')`);
    const lines: string[] = [];
    expect((await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet, log: (line) => lines.push(line) })).applied).toEqual([]);
    expect(lines.join("\n")).toMatch(/1 migration\(s\) this build does not ship/);
  });

  it("refuses a database with tables and no ledger instead of replaying history, until told what it contains", async () => {
    write(FIRST, "create table documents (id int);"); // not re-runnable: a replay would fail here
    write(SECOND, "create table if not exists b (id int);");
    write("20261118T1443_new.sql", "create table if not exists fresh (id int);");
    await db.exec("create table documents (id int); create table b (id int);");
    await expect(applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).rejects.toThrow(/no record of applied migrations/);
    expect(await tables()).toEqual(["b", "documents"]);
    await expect(applyMigrationFiles(client, { migrationsFolder: dir, ...quiet, env: { MIGRATION_ASSUME_APPLIED_THROUGH: "0999_nope.sql" } })).rejects.toThrow(/not a migration file/);
    const result = await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet, env: { MIGRATION_ASSUME_APPLIED_THROUGH: SECOND } });
    expect(result.applied).toEqual(["20261118T1443_new.sql"]);
    expect(await ledger()).toEqual([
      { filename: FIRST, source: "assumed" }, { filename: SECOND, source: "assumed" }, { filename: "20261118T1443_new.sql", source: "runner" },
    ]);
    // Once the ledger has rows the setting does nothing.
    expect((await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet, env: { MIGRATION_ASSUME_APPLIED_THROUGH: FIRST } })).applied).toEqual([]);
  });

  const DRIZZLE = `create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);`;

  it("refuses a ledger lost after the cutover instead of mapping Drizzle again and re-running newer migrations", async () => {
    await db.exec(`${DRIZZLE} create table documents (id int); create table counter (n int);
      insert into drizzle.__drizzle_migrations (hash, created_at) values ('h0', ${LEGACY_MIGRATIONS[0]![1]});`);
    write(FIRST, "create table documents (id int);");
    write("20261118T1443_count.sql", "insert into counter values (1);"); // not idempotent: a re-run would show
    await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet });
    await db.exec(`truncate ${LEDGER_TABLE}`);
    await expect(applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).rejects.toThrow(/no record of applied migrations/);
    await db.exec("drop schema docslurp_migrations cascade");
    await expect(applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).rejects.toThrow(/no record of applied migrations/);
    expect((await db.query<{ n: number }>("select count(*)::int as n from counter")).rows[0]!.n).toBe(1);
    // The operator says what the schema contains; nothing runs again.
    expect((await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet, env: { MIGRATION_ASSUME_APPLIED_THROUGH: "20261118T1443_count.sql" } })).applied).toEqual([]);
    expect((await db.query<{ n: number }>("select count(*)::int as n from counter")).rows[0]!.n).toBe(1);
  });

  it("refuses a Drizzle ledger whose newest stamp it does not know, instead of mapping everything or nothing", async () => {
    write(FIRST, "create table documents (id int);");
    for (const stamp of [LEGACY_MIGRATIONS.at(-1)![1] + 1_000_000, LEGACY_MIGRATIONS[0]![1] + 1]) {
      await db.exec(`drop schema if exists drizzle cascade; drop table if exists documents; ${DRIZZLE} create table documents (id int);
        insert into drizzle.__drizzle_migrations (hash, created_at) values ('h', ${stamp});`);
      await expect(applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).rejects.toThrow(/not a known migration stamp/);
      expect(await ledger()).toEqual([]);
    }
    expect((await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet, env: { MIGRATION_ASSUME_APPLIED_THROUGH: FIRST } })).applied).toEqual([]);
    expect(await ledger()).toEqual([{ filename: FIRST, source: "assumed" }]);
  });

  it("refuses a ledger someone else owns or has attached code to", async () => {
    write("20261118T1443_new.sql", "create table if not exists fresh (id int);");
    await db.exec(`create role intruder; create schema docslurp_migrations authorization intruder;
      create table docslurp_migrations.applied (filename text primary key, sha256 text not null, applied_at timestamptz not null default now(), source text not null default 'runner');
      alter table docslurp_migrations.applied owner to intruder;`);
    await expect(applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).rejects.toThrow(/refusing the migration ledger docslurp_migrations\.applied: its schema is not owned by the migration owner; it is not owned by the migration owner/);
    await db.exec(`drop schema docslurp_migrations cascade; create schema docslurp_migrations;
      create table docslurp_migrations.applied (filename text primary key, sha256 text not null, applied_at timestamptz not null default now(), source text not null default 'runner');
      create function public.swallow() returns trigger language plpgsql as $$ begin return null; end $$;
      create trigger swallow before insert on docslurp_migrations.applied for each row execute function public.swallow();`);
    await expect(applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).rejects.toThrow(/it has triggers/);
    await db.exec(`drop trigger swallow on docslurp_migrations.applied; alter table docslurp_migrations.applied enable row level security;`);
    await expect(applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).rejects.toThrow(/row-level security/);
    await db.exec(`drop schema docslurp_migrations cascade; create schema docslurp_migrations; create view docslurp_migrations.applied as select 'x'::text as filename, ''::text as sha256, now() as applied_at, ''::text as source;`);
    await expect(applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).rejects.toThrow(/refusing the migration ledger/);
    // The Drizzle ledger is trusted on the same terms before it is read or written.
    await db.exec(`drop schema docslurp_migrations cascade; ${DRIZZLE} alter table drizzle.__drizzle_migrations owner to intruder;`);
    await expect(applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).rejects.toThrow(/refusing the migration ledger drizzle\.__drizzle_migrations/);
    expect(await tables()).not.toContain("fresh");
  });

  it("refuses a migration that ends its transaction or changes role, and records nothing for it", async () => {
    write("20261118T1443_commits.sql", "create table if not exists half (id int);--> statement-breakpoint\ncommit;--> statement-breakpoint\ncreate table if not exists rest (id int);");
    await expect(applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).rejects.toThrow(/ended its transaction/);
    expect(await ledger()).toEqual([]);
    write("20261118T1443_commits.sql", "create role other_actor;--> statement-breakpoint\nset role other_actor;");
    await expect(applyMigrationFiles(client, { migrationsFolder: dir, ...quiet })).rejects.toThrow(/changed the session role/);
    await db.exec("reset role");
    expect(await ledger()).toEqual([]);
  });

  it("skips a file another migrator recorded after this one listed it", async () => {
    write("20261118T1443_new.sql", "create table fresh (id int);"); // would fail if run twice
    const racing = { async query(text: string, params?: unknown[]) {
      // The other migrator finishes the file just before this one starts its transaction.
      if (text === "begin") await db.exec(`create table if not exists fresh (id int); insert into ${LEDGER_TABLE} (filename, sha256) values ('20261118T1443_new.sql', 'theirs') on conflict do nothing`);
      return client.query(text, params);
    } };
    const lines: string[] = [];
    const result = await applyMigrationFiles(racing, { migrationsFolder: dir, ...quiet, log: (line) => lines.push(line) });
    expect(result.applied).toEqual([]);
    expect(lines.join("\n")).toMatch(/recorded by another migrator; skipped/);
  });

  it("atomic mode applies the pending set all or nothing", async () => {
    write("20261118T0900_ok.sql", "create table if not exists ok (id int);");
    write("20261118T1000_bad.sql", "select * from missing_table;");
    const error = await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet, atomic: true }).catch((caught) => caught);
    expect(error.message).toMatch(/20261118T1000_bad\.sql failed/);
    expect(error.appliedFiles).toEqual([]);
    expect(await tables()).toEqual([]);
    expect(await ledger()).toEqual([]);
    write("20261118T1000_bad.sql", "create table if not exists fixed (id int);");
    expect((await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet, atomic: true })).applied).toEqual(["20261118T0900_ok.sql", "20261118T1000_bad.sql"]);
    // Per file, the failure reports what was committed before it (the caller reconciles grants for those).
    write("20261118T1100_bad_again.sql", "select * from missing_table;");
    write("20261118T1050_fine.sql", "create table if not exists fine (id int);");
    const partial = await applyMigrationFiles(client, { migrationsFolder: dir, ...quiet }).catch((caught) => caught);
    expect(partial.appliedFiles).toEqual(["20261118T1050_fine.sql"]);
  });

  it("bounds lock waits and retries a file that timed out waiting for a lock", async () => {
    write("20261118T1443_new.sql", "create table if not exists fresh (id int);");
    let failures = 2;
    const flaky = {
      async query(text: string, params?: unknown[]) {
        if (/create table if not exists fresh/.test(text) && failures-- > 0) throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
        return client.query(text, params);
      },
    };
    const warnings: string[] = [];
    const result = await applyMigrationFiles(flaky, { migrationsFolder: dir, ...quiet, warn: (line) => warnings.push(line), env: { MIGRATION_STATEMENT_LOCK_TIMEOUT_MS: "2500" } });
    expect(result.applied).toEqual(["20261118T1443_new.sql"]);
    expect(warnings).toHaveLength(2);
    expect(client.calls).toContain("set local lock_timeout = '2500ms'");
    // Out of retries: the error surfaces with the file name and the database error as its cause.
    write("20261118T1500_next.sql", "create table if not exists next_one (id int);");
    const stuck = { async query(text: string, params?: unknown[]) {
      if (/next_one/.test(text)) throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
      return client.query(text, params);
    } };
    await expect(applyMigrationFiles(stuck, { migrationsFolder: dir, ...quiet, env: { MIGRATION_LOCK_RETRIES: "1" } })).rejects.toThrow(/20261118T1500_next\.sql failed/);
    await expect(applyMigrationFiles(client, { migrationsFolder: dir, ...quiet, env: { MIGRATION_STATEMENT_LOCK_TIMEOUT_MS: "soon" } })).rejects.toThrow(/invalid setting/);
  });
});
