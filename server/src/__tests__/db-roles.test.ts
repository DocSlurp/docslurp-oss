import { createMigratedDatabase } from "@docslurp/worker/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_DB_ROLES,
  WORKER_DENIED_TABLES,
  WORKER_TABLES,
  assertMigrationOwner,
  reconcileRoleGrants,
} from "../../db/roles.mjs";

// Least-privilege roles (server/db/roles.mjs) against a database built from the
// migrations. The first test is the drift guard: a migration that adds a table
// must classify it for the worker before CI passes.

let db: Awaited<ReturnType<typeof createMigratedDatabase>>;
const { app, worker, backup } = DEFAULT_DB_ROLES;
const silent = () => {};

async function publicRelations(): Promise<string[]> {
  const { rows } = await db.query<{ relname: string }>(
    "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v','m','f') order by 1",
  );
  return rows.map((row) => row.relname);
}

async function as<T>(role: string, run: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await run();
  } finally {
    await db.exec("reset role");
  }
}

async function denied(role: string, statement: string): Promise<boolean> {
  return as(role, async () => {
    await db.exec("begin");
    try {
      await db.exec(statement);
      return false;
    } catch (error) {
      if (!/permission denied|must be owner/.test(String((error as Error).message))) throw error;
      return true;
    } finally {
      await db.exec("rollback");
    }
  });
}

beforeAll(async () => {
  db = await createMigratedDatabase();
  for (const role of [app, worker, backup]) await db.exec(`create role ${role} nologin`);
  await reconcileRoleGrants(db, { log: silent });
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("worker table classification", () => {
  it("classifies every relation in schema public exactly once", async () => {
    const relations = await publicRelations();
    const allowed = Object.keys(WORKER_TABLES);
    const deniedNames = Object.keys(WORKER_DENIED_TABLES);
    const unclassified = relations.filter((name) => !allowed.includes(name) && !deniedNames.includes(name));
    expect(unclassified, "add new tables to WORKER_TABLES or WORKER_DENIED_TABLES in server/db/roles.mjs").toEqual([]);
    expect(allowed.filter((name) => deniedNames.includes(name))).toEqual([]);
    expect([...allowed, ...deniedNames].filter((name) => !relations.includes(name) && !WORKER_TABLES[name]?.optional), "remove dropped tables").toEqual([]);
  });

  it("keeps auth, credential and billing tables out of the worker's reach", () => {
    for (const table of [
      "account", "session", "verification", "api_keys", "oauth_accounts", "credit_grants",
      "mcp_oauth_tokens", "mcp_oauth_clients", "sso_identity_links", "stripe_webhook_events", "workspace_connectors",
    ]) {
      expect(WORKER_DENIED_TABLES[table], table).toBeTruthy();
    }
  });
});

describe("worker role", () => {
  it("is denied select and update on every denied table", async () => {
    for (const table of Object.keys(WORKER_DENIED_TABLES)) {
      expect(await denied(worker, `select 1 from public."${table}" limit 1`), `select ${table}`).toBe(true);
    }
    const { rows } = await db.query<{ relname: string }>(
      "select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind = 'r' and relname = any($1::text[])",
      [Object.keys(WORKER_DENIED_TABLES)],
    );
    for (const { relname } of rows) {
      const { rows: [column] } = await db.query<{ attname: string }>(
        "select attname from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped order by attnum limit 1",
        [`public."${relname}"`],
      );
      expect(await denied(worker, `update public."${relname}" set "${column!.attname}" = "${column!.attname}"`), `update ${relname}`).toBe(true);
    }
  });

  it("reads only the granted columns of user, webhooks and workspace_secrets", async () => {
    expect(await denied(worker, `select id, email from "user"`)).toBe(false);
    expect(await denied(worker, `select name from "user"`)).toBe(true);
    expect(await denied(worker, `update "user" set email = email`)).toBe(true);
    expect(await denied(worker, "select user_id, active, events from webhooks")).toBe(false);
    expect(await denied(worker, "select secret from webhooks")).toBe(true);
    expect(await denied(worker, "select id, workspace_id, name, type, expires_at from workspace_secrets")).toBe(false);
    expect(await denied(worker, "select encrypted_value from workspace_secrets")).toBe(true);
  });

  it("has exactly the declared privileges on allowed tables", async () => {
    const relations = await publicRelations();
    for (const [table, spec] of Object.entries(WORKER_TABLES)) {
      if (spec.optional && !relations.includes(table)) continue;
      for (const privilege of ["select", "insert", "update", "delete"]) {
        const { rows: [row] } = await db.query<{ granted: boolean }>(
          "select has_table_privilege($1, $2, $3) as granted",
          [worker, `public."${table}"`, privilege],
        );
        expect(row?.granted, `${privilege} on ${table}`).toBe(spec.privileges.includes(privilege));
      }
    }
  });

  it("cannot create objects or run migrations", async () => {
    expect(await denied(worker, "create table worker_ddl (id int)")).toBe(true);
    await expect(as(worker, () => assertMigrationOwner(db))).rejects.toThrow(/MIGRATION_DATABASE_URL/);
  });
});

describe("app role", () => {
  it("has DML on every table but no DDL", async () => {
    expect(await denied(app, "select count(*) from api_keys")).toBe(false);
    expect(await denied(app, `update "user" set name = name`)).toBe(false);
    expect(await denied(app, "create table app_ddl (id int)")).toBe(true);
    expect(await denied(app, "drop table documents")).toBe(true);
    expect(await denied(app, "alter table documents add column x int")).toBe(true);
    expect(await denied(app, "truncate documents")).toBe(true);
    await expect(as(app, () => assertMigrationOwner(db))).rejects.toThrow(/MIGRATION_DATABASE_URL/);
  });

  it("gets grants on tables created later through default privileges; the worker does not", async () => {
    await db.exec("create table later_table (id serial primary key, note text)");
    try {
      expect(await denied(app, "insert into later_table (note) values ('x')")).toBe(false);
      expect(await denied(worker, "select 1 from later_table")).toBe(true);
    } finally {
      await db.exec("drop table later_table");
    }
  });
});

describe("reconcileRoleGrants", () => {
  it("is idempotent and returns the roles it found", async () => {
    expect(await reconcileRoleGrants(db, { log: silent })).toEqual(expect.arrayContaining([app, worker, backup]));
    expect(await denied(worker, "select 1 from api_keys")).toBe(true);
    expect(await denied(worker, "select 1 from documents")).toBe(false);
  });

  it("revokes a worker grant that is no longer declared", async () => {
    await db.exec(`grant select on api_keys to ${worker}`);
    await reconcileRoleGrants(db, { log: silent });
    expect(await denied(worker, "select 1 from api_keys")).toBe(true);
  });
});
