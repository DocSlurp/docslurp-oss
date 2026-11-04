import { applyRemainingMigrations, createMigratedDatabase } from "@docslurp/worker/testing";
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
      if (!/permission denied|must be owner|untrusted realtime trigger source/.test(String((error as Error).message))) throw error;
      return true;
    } finally {
      await db.exec("rollback");
    }
  });
}

beforeAll(async () => {
  db = await createMigratedDatabase({ stopBefore: "0120_realtime_nonblocking_revisions" });
  for (const role of [app, worker, backup]) await db.exec(`create role ${role} nologin`);
  await reconcileRoleGrants(db, { log: silent });
  // No reconciliation after migration: live roles must work at commit.
  await applyRemainingMigrations(db, "0120_realtime_nonblocking_revisions");
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
      "mcp_oauth_tokens", "mcp_oauth_clients", "sso_identity_links", "stripe_webhook_events", "project_connectors",
    ]) {
      expect(WORKER_DENIED_TABLES[table], table).toBeTruthy();
    }
  });
});

describe("worker role", () => {
  it("denies chat operations, output and dependency discovery for every DML privilege", async () => {
    for (const table of ["chat_operations", "chat_operation_events", "chat_run_dependencies", "realtime_revisions", "realtime_revision_counters"]) {
      for (const privilege of ["select", "insert", "update", "delete"]) {
        const { rows: [row] } = await db.query<{ granted: boolean }>(
          "select has_table_privilege($1,$2,$3) as granted", [worker, `public.${table}`, privilege]);
        expect(row?.granted, `${privilege} ${table}`).toBe(false);
      }
      expect(await denied(worker, `select * from ${table}`)).toBe(true);
      if(table!=="realtime_revisions") expect(await denied(worker, `delete from ${table}`)).toBe(true);
    }
  });

  it("cannot forge, reset, overflow or directly publish another tenant revision", async () => {
    for (const role of [worker, app]) {
      for (const statement of [
        "select * from public.realtime_revision_counters",
        "delete from public.realtime_revision_counters",
        "update public.realtime_revision_counters set revision=0",
        "insert into public.realtime_revision_counters values('foreign-tenant',9223372036854775807,0)",
        "select public.realtime_record_change('foreign-tenant')",
        "select public.realtime_fold_committed('foreign-tenant')",
      ]) expect(await denied(role, statement), `${role}: ${statement}`).toBe(true);
    }
    expect(await denied(worker, "select * from public.realtime_compact_revisions('')")).toBe(true);
    expect(await denied(worker, "create temp table realtime_attack(org_id text); create trigger realtime_changed after insert on realtime_attack for each row execute function public.realtime_changed()" )).toBe(true);
  });

  it("rejects forged trigger sources even if EXECUTE were accidentally granted", async () => {
    await db.exec(`grant execute on function public.realtime_changed() to ${worker}`);
    try {
      expect(await denied(worker, `create temp table documents(org_id text);
        create trigger realtime_changed after insert on documents for each row execute function public.realtime_changed();
        insert into documents values('foreign-tenant')`)).toBe(true);
    } finally { await db.exec(`revoke execute on function public.realtime_changed() from ${worker}`); }
  });

  it("publishes ingestion revisions through validated triggers immediately after migration", async () => {
    await db.exec(`insert into "user"(id,name,email) values('role-realtime','Test','role-realtime@example.test');
      insert into organizations(id,name,slug,created_by_user_id) values('role-realtime','Test','role-realtime','role-realtime');
      insert into projects(id,org_id,user_id,name) values('role-realtime','role-realtime','role-realtime','Test');
      insert into project_runs(id,org_id,user_id,project_id,kind,status,stage)
        values('role-realtime-run','role-realtime','role-realtime','role-realtime','upload','processing','extract');
      insert into documents(id,org_id,user_id,project_id,run_id,filename,mime_type,source_key,status)
        values('role-realtime-doc','role-realtime','role-realtime','role-realtime','role-realtime-run','test.txt','text/plain','fixture','queued');`);
    const read = async () => (await db.query<{revision:string}>("select revision::text from realtime_revisions where org_id='role-realtime'")).rows[0]!.revision;
    const before = BigInt(await read());
    await as(worker, () => db.exec("update project_runs set stage='index' where id='role-realtime-run'"));
    await as(worker, () => db.exec("update documents set status='processing' where id='role-realtime-doc'"));
    // Exercises the separate deferred-materialization trigger as the worker.
    await as(worker, () => db.exec(`insert into document_page_states(document_id,page_number,state)
      values('role-realtime-doc',1,'indexed')`));
    expect(BigInt(await read())).toBe(before + 3n);
    const { rows } = await db.query<{prosecdef:boolean}>(`select prosecdef from pg_proc where proname in
      ('realtime_changed','realtime_record_change','realtime_materialization_changed','realtime_search_session_changed')`);
    expect(rows).toHaveLength(4);
    expect(rows.filter(row=>row.prosecdef)).toHaveLength(3);
    expect(await denied(app, "select revision from realtime_revisions")).toBe(false);
  });
  it("can read terminal receipts but cannot rewrite or delete them", async () => {
    expect(await denied(worker, "select id from run_terminal_receipts")).toBe(false);
    expect(await denied(worker, "update run_terminal_receipts set outcome = 'completed'")).toBe(true);
    expect(await denied(worker, "delete from run_terminal_receipts")).toBe(true);
  });
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

  it("reads only the granted columns of user, webhooks and project_secrets", async () => {
    expect(await denied(worker, `select id, email from "user"`)).toBe(false);
    expect(await denied(worker, `select name from "user"`)).toBe(true);
    expect(await denied(worker, `update "user" set email = email`)).toBe(true);
    expect(await denied(worker, "select user_id, active, events from webhooks")).toBe(false);
    expect(await denied(worker, "select secret from webhooks")).toBe(true);
    expect(await denied(worker, "select id, project_id, name, type, expires_at from project_secrets")).toBe(false);
    expect(await denied(worker, "select encrypted_value from project_secrets")).toBe(true);
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
  it("uses native chat storage without DDL while ingestion access is denied and revoked", async () => {
    const table="docslurp_mastra.mastra_background_tasks";
    for(const privilege of ["select","insert","update","delete"]) {
      const {rows:[row]}=await db.query<{allowed:boolean;denied:boolean}>(
        "select has_table_privilege($1,$3,$4) as allowed,has_table_privilege($2,$3,$4) as denied",
        [app,worker,table,privilege]);
      expect(row).toEqual({allowed:true,denied:false});
    }
    expect(await denied(app,`select id from ${table}`)).toBe(false);
    expect(await denied(app,"create table docslurp_mastra.app_ddl(id text)")).toBe(true);
    expect(await denied(worker,`select id from ${table}`)).toBe(true);
    await db.exec(`grant usage on schema docslurp_mastra to ${worker}; grant select on ${table} to ${worker}`);
    await reconcileRoleGrants(db,{log:silent});
    expect(await denied(worker,`select id from ${table}`)).toBe(true);
  });
  it("has application-data DML but no DDL", async () => {
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
  it("removes accidental counter and helper grants after broad application reconciliation", async () => {
    await db.exec(`grant select,insert,update,delete on realtime_revision_counters to ${worker},${app};
      grant execute on function realtime_record_change(text),realtime_compact_revisions(text) to ${worker}`);
    await reconcileRoleGrants(db, { log: silent });
    for (const role of [worker, app]) {
      expect(await denied(role, "select * from realtime_revision_counters")).toBe(true);
      expect(await denied(role, "select realtime_record_change('foreign-org')")).toBe(true);
    }
    expect(await denied(worker, "select * from realtime_compact_revisions('')")).toBe(true);
    expect(await denied(app, "select * from realtime_compact_revisions('')")).toBe(false);
  });
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


describe("migration ownership preflight", () => {
  it("does not exempt a foreign-owned table merely named spatial_ref_sys", async () => {
    await db.exec("create role migration_candidate nologin; grant create on schema public to migration_candidate");
    await db.exec("create table spatial_ref_sys (id int)");
    try {
      await expect(as("migration_candidate", () => assertMigrationOwner(db))).rejects.toThrow(/MIGRATION_DATABASE_URL/);
    } finally {
      await db.exec("drop table spatial_ref_sys; revoke create on schema public from migration_candidate; drop role migration_candidate");
    }
  });
});
