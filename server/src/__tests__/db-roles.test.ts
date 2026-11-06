import { applyRemainingMigrations, createMigratedDatabase } from "@docslurp/worker/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
      "mcp_oauth_tokens", "mcp_oauth_clients", "sso_identity_links", "stripe_webhook_events", "workspace_connectors",
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
      insert into workspaces(id,org_id,user_id,name) values('role-realtime','role-realtime','role-realtime','Test');
      insert into workspace_runs(id,org_id,user_id,workspace_id,kind,status,stage)
        values('role-realtime-run','role-realtime','role-realtime','role-realtime','upload','processing','extract');
      insert into documents(id,org_id,user_id,workspace_id,run_id,filename,mime_type,source_key,status)
        values('role-realtime-doc','role-realtime','role-realtime','role-realtime','role-realtime-run','test.txt','text/plain','fixture','queued');`);
    const read = async () => (await db.query<{revision:string}>("select revision::text from realtime_revisions where org_id='role-realtime'")).rows[0]!.revision;
    const before = BigInt(await read());
    await as(worker, () => db.exec("update workspace_runs set stage='index' where id='role-realtime-run'"));
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

  it("reads only the granted columns of user, webhooks and workspace_secrets", async () => {
    expect(await denied(worker, `select id, email from "user"`)).toBe(false);
    expect(await denied(worker, `select name from "user"`)).toBe(true);
    expect(await denied(worker, `update "user" set email = email`)).toBe(true);
    expect(await denied(worker, "select org_id, active, events from webhooks")).toBe(false);
    // Kept for N-1 workers during the 0125 rollout (roles.mjs); a later release drops it.
    expect(await denied(worker, "select user_id from webhooks")).toBe(false);
    expect(await denied(worker, "select url from webhooks")).toBe(true);
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

describe("ocr_escalation_reads (migration 0129)", () => {
  // The exact statements worker/src/db/store.ts runs (recordOcrEscalationRead, ocrEscalationReads).
  const insert = (attempt: number) => `insert into ocr_escalation_reads (run_id, document_id, page_number, attempt, status, text, model, usage_events)
    values ('esc-roles-run', 'doc-1', 3, ${attempt}, 'completed', 'Hosted transcription', 'qwen', '[{"id":"ocr-escalation:esc-roles-run:doc-1:3:${attempt}"}]'::jsonb)
    on conflict (run_id, document_id, page_number, attempt) do nothing`;
  const read = "select attempt, status, text, model, usage_events from ocr_escalation_reads where run_id = 'esc-roles-run' and document_id = 'doc-1' and page_number = 3 order by attempt";

  beforeAll(async () => {
    await db.exec(`
      insert into "user" (id, name, email) values ('esc-roles-u', 'U', 'esc-roles@example.com') on conflict do nothing;
      insert into organizations (id, name, slug, created_by_user_id) values ('esc-roles-org', 'O', 'esc-roles-org', 'esc-roles-u') on conflict do nothing;
      insert into workspaces (id, org_id, user_id, name) values ('esc-roles-ws', 'esc-roles-org', 'esc-roles-u', 'W') on conflict do nothing;
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
        values ('esc-roles-run', 'esc-roles-org', 'esc-roles-u', 'esc-roles-ws', 'bulk-upload', 'processing', 'extract-markdown', '{}') on conflict do nothing;`);
  });

  it("lets the worker write a read, read it back and replay the write on retry, as the store does", async () => {
    await as(worker, async () => {
      await db.exec(insert(1));
      await db.exec(insert(1)); // a retried activity re-sends the same attempt: no error, no second row
      const { rows } = await db.query<{ attempt: number; text: string }>(read);
      expect(rows).toEqual([expect.objectContaining({ attempt: 1, text: "Hosted transcription" })]);
    });
  });

  it("denies the worker every operation it does not need", async () => {
    expect(WORKER_TABLES.ocr_escalation_reads?.privileges).toEqual(["select", "insert"]);
    expect(await denied(worker, "update ocr_escalation_reads set text = 'x'")).toBe(true);
    expect(await denied(worker, "delete from ocr_escalation_reads")).toBe(true);
    expect(await denied(worker, "truncate ocr_escalation_reads")).toBe(true);
  });

  it("denies the backup role every write (it reads through pg_read_all_data in ops); the app role deletes it with its run", async () => {
    for (const statement of [insert(2), "update ocr_escalation_reads set text = 'x'", "delete from ocr_escalation_reads"]) {
      expect(await denied(backup, statement), statement).toBe(true);
    }
    await as(app, async () => {
      await db.exec("delete from workspace_runs where id = 'esc-roles-run'");
      const { rows } = await db.query(read);
      expect(rows).toEqual([]);
    });
  });
});

describe("pricing_provider_state (migration 0131)", () => {
  // The read-only seam the pricing plugin receives, and the operator's admin seam (packages/shared/src/pricing-loader.ts).
  const sqlAs = (role: string | null) => ({ unsafe: async (query: string, params?: unknown[]) =>
    (role ? await as(role, () => db.query<Record<string, unknown>>(query, params as unknown[])) : await db.query<Record<string, unknown>>(query, params as unknown[])).rows });
  const stateAs = async (role: string) => (await import("@docslurp/shared/pricing-loader")).pricingDurableStateFromSql(sqlAs(role));
  /** The admin seam over a runtime role's connection: what a compromised runtime role could try. */
  const adminAs = async (role: string) => (await import("@docslurp/shared/pricing-loader")).pricingStateAdminFromSql(sqlAs(role));
  /** The admin seam as the table owner (this test database's migration connection): the operator's activation path. */
  const owner = async () => (await import("@docslurp/shared/pricing-loader")).pricingStateAdminFromSql(sqlAs(null));

  it("runtime seam is read-only: the API and worker read a value the owner raised and get no raise at all", async () => {
    await (await owner()).raise("card.sequence.read", 5n);
    for (const role of [app, worker]) {
      const state = await stateAs(role);
      expect(await state.read("card.sequence.read")).toBe(5n);
      expect(await state.read(`never.${role}`)).toBeNull();
      expect((state as unknown as { raise?: unknown }).raise).toBeUndefined();
    }
  });

  it("no runtime role can execute pricing_state_raise, however often it tries (council J)", async () => {
    for (const role of [app, worker, backup]) {
      for (const value of [1000n, 2000n, 3000n]) {
        expect(await denied(role, `select pricing_state_raise('wedge.${role}', ${value})`), `${role} ${value}`).toBe(true);
      }
      if (role !== backup) await expect((await adminAs(role)).raise(`wedge.${role}`, 1n)).rejects.toThrow(/permission denied/);
      expect(await (await owner()).read(`wedge.${role}`)).toBeNull();
    }
  });

  it("the owner raises strictly: above the stored value, at most 1000 per raise of an existing key (council K #6)", async () => {
    const admin = await owner();
    expect(await admin.read("card.sequence.owner")).toBeNull();
    expect(await admin.raise("card.sequence.owner", 5n)).toBe(5n);
    await expect(admin.raise("card.sequence.owner", 3n)).rejects.toThrow(/not above the stored value 5/);
    await expect(admin.raise("card.sequence.owner", 5n)).rejects.toThrow(/not above the stored value 5/);
    expect(await admin.raise("card.sequence.owner", 9n)).toBe(9n);
    await expect(admin.raise("card.sequence.owner", 1010n)).rejects.toThrow(/more than 1000/);
    expect(await admin.raise("card.sequence.owner", 1009n)).toBe(1009n);
    expect(await admin.read("card.sequence.owner")).toBe(1009n);
  });

  it("a second raise to the same value is refused, for a seeded key and a raised one (council K #6; the real race: pricing-state-raise.db.test.ts)", async () => {
    const admin = await owner();
    expect(await admin.raise("card.race", 7n)).toBe(7n);
    await expect(admin.raise("card.race", 7n)).rejects.toThrow(/not above the stored value 7/);
    expect(await admin.raise("card.race", 8n)).toBe(8n);
    await expect(admin.raise("card.race", 8n)).rejects.toThrow(/not above the stored value 8/);
  });

  it("refuses candidates below 1 and negative values; seeds a missing key at any value, as after a reset (council I #3)", async () => {
    const admin = await owner();
    for (const candidate of [0n, -1n, -(2n ** 62n)]) {
      await expect(admin.raise("card.low", candidate)).rejects.toThrow(/at least 1/);
      await expect(admin.raise("card.sequence.owner", candidate)).rejects.toThrow(/at least 1/);
    }
    expect(await admin.read("card.low")).toBeNull();
    await expect(db.query("insert into pricing_provider_state (key, value) values ('neg', -1)")).rejects.toThrow(/check constraint/);
    expect(await admin.raise("card.reset.seed", 4_321n)).toBe(4_321n);
    await expect(admin.raise("card.reset.seed", 4_321n)).rejects.toThrow(/not above/);
    await expect(admin.raise("card.reset.seed", 5_322n)).rejects.toThrow(/more than 1000/);
    expect(await admin.raise("card.reset.seed", 5_321n)).toBe(5_321n);
  });

  it("concurrent owner raises never lower the value: each success returns its own candidate, the rest are refused", async () => {
    const admin = await owner();
    const candidates = Array.from({ length: 40 }, (_, index) => BigInt(((index * 7919) % 1000) + 1));
    const results = await Promise.allSettled(candidates.map((candidate) => admin.raise("concurrent.key", candidate)));
    const won = results.flatMap((result, index) => (result.status === "fulfilled" ? [[result.value, candidates[index]!] as const] : []));
    expect(won.length).toBeGreaterThan(0);
    for (const [value, candidate] of won) expect(value).toBe(candidate);
    for (const result of results) if (result.status === "rejected") expect(String(result.reason)).toMatch(/not above the stored value/);
    expect(await admin.read("concurrent.key")).toBe(won.reduce((max, [value]) => (value > max ? value : max), 0n));
  });

  it("denies runtime roles every direct write: no INSERT, UPDATE, DELETE or TRUNCATE", async () => {
    expect(WORKER_TABLES.pricing_provider_state?.privileges).toEqual(["select"]);
    for (const role of [app, worker, backup]) {
      for (const statement of [
        "insert into pricing_provider_state (key, value) values ('forged', 1)",
        "update pricing_provider_state set value = 0",
        "delete from pricing_provider_state",
        "truncate pricing_provider_state",
      ]) expect(await denied(role, statement), `${role}: ${statement}`).toBe(true);
    }
  });

  it("keeps those grants after reconciliation, despite the app's schema-wide DML and default privileges", async () => {
    await reconcileRoleGrants(db, { log: silent });
    for (const role of [app, worker]) {
      expect(await denied(role, "update pricing_provider_state set value = 0")).toBe(true);
      expect(await denied(role, "select pricing_state_raise('after.reconcile', 2)")).toBe(true);
      expect(await (await stateAs(role)).read("card.sequence.owner")).toBe(1009n);
    }
  });

  it("refuses keys outside the neutral key shape and values outside int8", async () => {
    const admin = await owner();
    await expect(admin.raise("Bad Key", 1n)).rejects.toThrow(/invalid key/);
    await expect(admin.raise("ok.key", 2n ** 63n)).rejects.toThrow(/64-bit/);
    await expect(db.query("select pricing_state_raise('Bad Key', 1)")).rejects.toThrow(/check constraint/);
  });
});

describe("runtime database identity gate (council N #1)", () => {
  const check = async (role: string | null, expected: string) => {
    const { checkRuntimeIdentity } = await import("../../db/runtime-role-check.mjs");
    const client = { query: (query: string, params?: unknown[]) => db.query<Record<string, unknown>>(query, params) };
    return role ? as(role, () => checkRuntimeIdentity(client, expected)) : checkRuntimeIdentity(client, expected);
  };

  it("passes the API and executor role and the worker role as themselves", async () => {
    expect(await check(app, app)).toEqual([]);
    expect(await check(worker, worker)).toEqual([]);
  });

  it("refuses the owner or a superuser, whatever role it claims", async () => {
    const problems = (await check(null, app)).join("\n");
    expect(problems).toMatch(/superuser/);
    expect(problems).toMatch(/owns \d+ relation/);
  });

  it("refuses a role that is not the expected least-privilege role", async () => {
    expect((await check(worker, app)).join("\n")).toMatch(/not a member of docslurp_app/);
    expect((await check(backup, worker)).join("\n")).toMatch(/not a member of docslurp_worker/);
    expect((await check(app, "docslurp")).join("\n")).toMatch(/unknown expected role/);
  });

  it("refuses a runtime role that can raise or write the pricing high-water mark", async () => {
    await db.exec(`grant execute on function public.pricing_state_raise(text, bigint) to ${app}`);
    await db.exec(`grant insert on public.pricing_provider_state to ${worker}`);
    try {
      expect((await check(app, app)).join("\n")).toMatch(/can execute pricing_state_raise/);
      expect((await check(worker, worker)).join("\n")).toMatch(/can write pricing_provider_state/);
    } finally {
      await db.exec(`revoke execute on function public.pricing_state_raise(text, bigint) from ${app}`);
      await db.exec(`revoke insert on public.pricing_provider_state from ${worker}`);
    }
    expect(await check(app, app)).toEqual([]);
  });

  it("refuses a runtime role that owns a table", async () => {
    await db.exec(`create table public.runtime_owned_probe (id int)`);
    await db.exec(`alter table public.runtime_owned_probe owner to ${worker}`);
    try {
      expect((await check(worker, worker)).join("\n")).toMatch(/owns 1 relation/);
    } finally {
      await db.exec(`drop table public.runtime_owned_probe`);
    }
  });
});

describe("runtime database identity gate before the role rollout", () => {
  it("refuses with a rollout pointer when the least-privilege role does not exist", async () => {
    const { runtimeIdentityProblems } = await import("../../db/runtime-role-check.mjs");
    expect(runtimeIdentityProblems({ role: "docslurp", superuser: false, owned_relations: 40, expected_exists: false }, app).join("\n"))
      .toMatch(/owner role docslurp[\s\S]*role docslurp_app does not exist: roll out the least-privilege roles/);
  });
});

describe("runtime processes refuse to start as a pricing-state writer (council M #1)", () => {
  const sqlAs = (role: string | null) => ({ unsafe: async (query: string, params?: unknown[]) =>
    (role ? await as(role, () => db.query<Record<string, unknown>>(query, params as unknown[])) : await db.query<Record<string, unknown>>(query, params as unknown[])).rows });

  it("passes the least-privilege runtime roles", async () => {
    const { assertRuntimeCannotMovePricingState } = await import("@docslurp/shared/pricing-loader");
    await expect(assertRuntimeCannotMovePricingState(sqlAs(app))).resolves.toBeUndefined();
    await expect(assertRuntimeCannotMovePricingState(sqlAs(worker))).resolves.toBeUndefined();
  });

  it("refuses the owner or superuser, and a runtime role granted EXECUTE on the raise", async () => {
    const { assertRuntimeCannotMovePricingState } = await import("@docslurp/shared/pricing-loader");
    await expect(assertRuntimeCannotMovePricingState(sqlAs(null))).rejects.toThrow(/superuser.*owns pricing_provider_state|superuser, owns pricing_provider_state/);
    await db.exec(`grant execute on function public.pricing_state_raise(text, bigint) to ${app}`);
    try {
      await expect(assertRuntimeCannotMovePricingState(sqlAs(app))).rejects.toThrow(/may execute pricing_state_raise; .*refusing to start|may execute pricing_state_raise/);
    } finally {
      await db.exec(`revoke execute on function public.pricing_state_raise(text, bigint) from ${app}`);
    }
  });

  it("is on by default wherever pricing is required, and loadPricingProvider refuses before loading any plugin", async () => {
    const { loadPricingProvider, refusePricingStateWriter, resetPricingLoaderForTests } = await import("@docslurp/shared/pricing-loader");
    expect(refusePricingStateWriter({ DOCSLURP_SERVICE_PROFILE: "service" })).toBe(true);
    expect(refusePricingStateWriter({ DOCSLURP_PRICING_REQUIRED: "1" })).toBe(true);
    expect(refusePricingStateWriter({})).toBe(false);
    expect(refusePricingStateWriter({ DOCSLURP_SERVICE_PROFILE: "service", DOCSLURP_REFUSE_PRICING_STATE_WRITER: "0" })).toBe(false);
    expect(refusePricingStateWriter({ DOCSLURP_REFUSE_PRICING_STATE_WRITER: "1" })).toBe(true);
    const importModule = vi.fn();
    resetPricingLoaderForTests();
    await expect(loadPricingProvider({ DOCSLURP_SERVICE_PROFILE: "service", DOCSLURP_PRICING_PLUGIN: "/p.mjs" }, { sql: sqlAs(null), importModule })).rejects.toThrow(/refusing to start/);
    expect(importModule).not.toHaveBeenCalled();
    resetPricingLoaderForTests();
  });
});
