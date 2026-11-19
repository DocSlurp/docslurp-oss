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
