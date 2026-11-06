import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { assertRuntimeDatabaseIdentity, RUNTIME_IDENTITY_SQL, RUNTIME_SECURITY_DEFINER_ALLOWLIST, runtimeIdentityReasons } from "@docslurp/shared/pricing-loader";

// Real Postgres (scripts/run-database-tests.mjs: a fresh migrated database, connected as a superuser): each way council O
// found to slip past the runtime identity check is refused, by the rule the deploy gate and startup share (council O #1).
const url = process.env.RUNTIME_IDENTITY_TEST_DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const runtime = `rt_app_${suffix}`;
const owner = `rt_owner_${suffix}`;
let admin: Client;

/** The check as `role` would run it (SET ROLE changes current_user, which the rule reads). */
async function reasonsAs(role: string): Promise<string[]> {
  await admin.query(`set role ${role}`);
  try {
    const { rows: [row] } = await admin.query(RUNTIME_IDENTITY_SQL, [[runtime], RUNTIME_SECURITY_DEFINER_ALLOWLIST]);
    return runtimeIdentityReasons(row, [runtime]);
  } finally {
    await admin.query("reset role");
  }
}

beforeAll(async () => {
  if (!url) return;
  admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create role ${runtime} nologin`);
  await admin.query(`create role ${owner} nologin`);
  await admin.query(`grant select on public.pricing_provider_state to ${runtime}`);
});

afterAll(async () => {
  if (!url) return;
  for (const statement of [`drop owned by ${runtime}`, `drop owned by ${owner}`, `drop role if exists ${runtime}`, `drop role if exists ${owner}`]) {
    await admin.query(statement).catch(() => {});
  }
  await admin.end();
});

it.skipIf(!url)("a clean runtime role passes", async () => {
  expect(await reasonsAs(runtime)).toEqual([]);
});

it.skipIf(!url)("refuses SET ROLE to the owner or the superuser (granted WITH INHERIT FALSE)", async () => {
  await admin.query(`grant ${owner} to ${runtime} with inherit false`);
  try { expect((await reasonsAs(runtime)).join("\n")).toMatch(new RegExp(`is a member of ${owner}`)); }
  finally { await admin.query(`revoke ${owner} from ${runtime}`); }
  const { rows: [{ current_user: superuser }] } = await admin.query("select current_user");
  await admin.query(`grant ${superuser} to ${runtime} with inherit false`);
  try { expect((await reasonsAs(runtime)).join("\n")).toMatch(new RegExp(`is a member of [^\\n]*${superuser}`)); }
  finally { await admin.query(`revoke ${superuser} from ${runtime}`); }
});

it.skipIf(!url)("refuses an inherited pg_execute_server_program (COPY ... TO PROGRAM)", async () => {
  await admin.query(`create role rt_mid_${suffix} nologin`);
  await admin.query(`grant pg_execute_server_program to rt_mid_${suffix}`);
  await admin.query(`grant rt_mid_${suffix} to ${runtime}`);
  try { expect((await reasonsAs(runtime)).join("\n")).toMatch(/pg_execute_server_program/); }
  finally { await admin.query(`revoke rt_mid_${suffix} from ${runtime}`); await admin.query(`drop role rt_mid_${suffix}`); }
});

it.skipIf(!url)("refuses CREATE on the database (a schema shadowing the owner's search_path)", async () => {
  const { rows: [{ db }] } = await admin.query("select current_database() as db");
  await admin.query(`grant create on database "${db}" to ${runtime}`);
  try { expect((await reasonsAs(runtime)).join("\n")).toMatch(/can CREATE in the database/); }
  finally { await admin.query(`revoke create on database "${db}" from ${runtime}`); }
});

it.skipIf(!url)("refuses owned functions, types and schemas, not only tables", async () => {
  await admin.query(`create schema rt_schema_${suffix} authorization ${runtime}`);
  try { expect((await reasonsAs(runtime)).join("\n")).toMatch(/owns 1 object/); }
  finally { await admin.query(`drop schema rt_schema_${suffix} cascade`); }
  await admin.query(`create function public.rt_fn_${suffix}() returns int language sql as 'select 1'`);
  await admin.query(`alter function public.rt_fn_${suffix}() owner to ${runtime}`);
  try { expect((await reasonsAs(runtime)).join("\n")).toMatch(/owns \d+ object/); }
  finally { await admin.query(`drop function public.rt_fn_${suffix}()`); }
});

it.skipIf(!url)("refuses each direct write privilege and EXECUTE on the raise", async () => {
  for (const privilege of ["insert", "update", "delete", "truncate"]) {
    await admin.query(`grant ${privilege} on public.pricing_provider_state to ${runtime}`);
    try { expect((await reasonsAs(runtime)).join("\n")).toMatch(new RegExp(`can ${privilege} pricing_provider_state`)); }
    finally { await admin.query(`revoke ${privilege} on public.pricing_provider_state from ${runtime}`); }
  }
  await admin.query(`grant execute on function public.pricing_state_raise(text, bigint) to ${runtime}`);
  try { expect((await reasonsAs(runtime)).join("\n")).toMatch(/may execute pricing_state_raise/); }
  finally { await admin.query(`revoke execute on function public.pricing_state_raise(text, bigint) from ${runtime}`); }
});

it.skipIf(!url)("refuses a column-level INSERT or UPDATE, at startup and at the deploy gate (recheck R #1)", async () => {
  const { checkRuntimeIdentity } = await import("../../db/runtime-role-check.mjs");
  const sql = { unsafe: async (query: string, params?: unknown[]) => (await admin.query(query, params as unknown[])).rows };
  // The deploy gate only accepts the real runtime role names: make the fixture role a member of docslurp_app (cluster-wide,
  // so created if missing and never dropped; the database test runner runs one file at a time).
  await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'docslurp_app') then create role docslurp_app nologin; end if; end $$`);
  await admin.query(`grant docslurp_app to ${runtime}`);
  const asRuntime = async <T>(run: () => Promise<T>): Promise<T> => {
    await admin.query(`set role ${runtime}`);
    try { return await run(); } finally { await admin.query("reset role"); }
  };
  try {
    expect(await asRuntime(() => checkRuntimeIdentity(admin, "docslurp_app"))).toEqual([]);
    for (const [privilege, column] of [["update", "value"], ["update", "updated_at"], ["insert", "key"], ["insert", "value"]] as const) {
      await admin.query(`grant ${privilege} (${column}) on public.pricing_provider_state to ${runtime}`);
      try {
        const pattern = new RegExp(`can ${privilege} pricing_provider_state`);
        expect((await reasonsAs(runtime)).join("\n")).toMatch(pattern);
        await asRuntime(() => expect(assertRuntimeDatabaseIdentity(sql, [runtime])).rejects.toThrow(/refusing to start/));
        await asRuntime(() => expect(assertRuntimeDatabaseIdentity(sql, [runtime])).rejects.toThrow(pattern));
        expect((await asRuntime(() => checkRuntimeIdentity(admin, "docslurp_app"))).join("\n")).toMatch(pattern);
      } finally {
        await admin.query(`revoke ${privilege} (${column}) on public.pricing_provider_state from ${runtime}`);
      }
    }
    // A column grant held through another role counts too.
    await admin.query(`create role rt_colwriter_${suffix} nologin`);
    await admin.query(`grant update (value) on public.pricing_provider_state to rt_colwriter_${suffix}`);
    await admin.query(`grant rt_colwriter_${suffix} to ${runtime}`);
    try {
      expect((await asRuntime(() => checkRuntimeIdentity(admin, "docslurp_app"))).join("\n")).toMatch(/can update pricing_provider_state/);
    } finally {
      await admin.query(`revoke rt_colwriter_${suffix} from ${runtime}`);
      await admin.query(`drop owned by rt_colwriter_${suffix}`);
      await admin.query(`drop role rt_colwriter_${suffix}`);
    }
    expect(await asRuntime(() => checkRuntimeIdentity(admin, "docslurp_app"))).toEqual([]);
  } finally {
    await admin.query(`revoke docslurp_app from ${runtime}`);
  }
});

it.skipIf(!url)("evaluates privileges for every role held, so a SET ROLE into the allowed role is covered (recheck Q #5a)", async () => {
  const login = `rt_login_${suffix}`;
  await admin.query(`create role ${login} nologin`);
  await admin.query(`grant ${runtime} to ${login} with inherit false`);
  await admin.query(`grant update (value) on public.pricing_provider_state to ${runtime}`);
  try {
    await admin.query(`set role ${login}`);
    let reasons: string[];
    try {
      const { rows: [row] } = await admin.query(RUNTIME_IDENTITY_SQL, [[runtime], RUNTIME_SECURITY_DEFINER_ALLOWLIST]);
      reasons = runtimeIdentityReasons(row, [runtime]);
    } finally { await admin.query("reset role"); }
    expect(reasons.join("\n")).toMatch(/can update pricing_provider_state/);
  } finally {
    await admin.query(`revoke update (value) on public.pricing_provider_state from ${runtime}`);
    await admin.query(`drop role ${login}`);
  }
});

it.skipIf(!url)("refuses CREATE on any non-system schema, not only public (recheck Q #5b)", async () => {
  await admin.query(`create schema rt_side_${suffix}`);
  await admin.query(`grant create on schema rt_side_${suffix} to ${runtime}`);
  try { expect((await reasonsAs(runtime)).join("\n")).toMatch(new RegExp(`can CREATE in schema rt_side_${suffix}`)); }
  finally { await admin.query(`drop schema rt_side_${suffix} cascade`); }
});

it.skipIf(!url)("refuses an owner SECURITY DEFINER function it can execute or fire, and a writable view over the pricing state (recheck Q #5c)", async () => {
  await admin.query(`create function public.rt_def_${suffix}(bigint) returns void language sql security definer set search_path = pg_catalog
    as $$ update public.pricing_provider_state set value = $1 $$`);
  await admin.query(`revoke all on function public.rt_def_${suffix}(bigint) from public`);
  await admin.query(`grant execute on function public.rt_def_${suffix}(bigint) to ${runtime}`);
  try { expect((await reasonsAs(runtime)).join("\n")).toMatch(new RegExp(`SECURITY DEFINER function\\(s\\) outside the allowlist: rt_def_${suffix}\\(bigint\\)`)); }
  finally { await admin.query(`drop function public.rt_def_${suffix}(bigint)`); }

  // Fired as a trigger on a table the runtime role writes: no EXECUTE needed.
  await admin.query(`create table public.rt_trig_${suffix} (v bigint)`);
  await admin.query(`create function public.rt_trigfn_${suffix}() returns trigger language plpgsql security definer set search_path = pg_catalog
    as $$ begin update public.pricing_provider_state set value = new.v; return new; end $$`);
  await admin.query(`revoke all on function public.rt_trigfn_${suffix}() from public`);
  await admin.query(`create trigger rt_t after insert on public.rt_trig_${suffix} for each row execute function public.rt_trigfn_${suffix}()`);
  await admin.query(`grant insert on public.rt_trig_${suffix} to ${runtime}`);
  try { expect((await reasonsAs(runtime)).join("\n")).toMatch(new RegExp(`rt_trigfn_${suffix}`)); }
  finally { await admin.query(`drop table public.rt_trig_${suffix}`); await admin.query(`drop function public.rt_trigfn_${suffix}()`); }

  await admin.query(`create view public.rt_view_${suffix} as select * from public.pricing_provider_state`);
  await admin.query(`grant update on public.rt_view_${suffix} to ${runtime}`);
  try { expect((await reasonsAs(runtime)).join("\n")).toMatch(new RegExp(`can write rt_view_${suffix}, a view or rule over pricing_provider_state`)); }
  finally { await admin.query(`drop view public.rt_view_${suffix}`); }
  expect(await reasonsAs(runtime)).toEqual([]);
});

it.skipIf(!url)("refuses a grant option on any object, and an owned large object (recheck S #6)", async () => {
  for (const grant of [
    `grant select on public.documents to ${runtime} with grant option`,
    `grant select (id) on public.documents to ${runtime} with grant option`,
    `grant usage on schema public to ${runtime} with grant option`,
  ]) {
    await admin.query(grant);
    try { expect((await reasonsAs(runtime)).join("\n")).toMatch(/holds grant options/); }
    finally { await admin.query(grant.replace(/^grant /, "revoke grant option for ").replace(/ to /, " from ").replace(/ with grant option$/, "")); }
  }
  expect(await reasonsAs(runtime)).toEqual([]);
  const { rows: [{ oid }] } = await admin.query("select lo_create(0)::text as oid");
  await admin.query(`alter large object ${oid} owner to ${runtime}`);
  try { expect((await reasonsAs(runtime)).join("\n")).toMatch(/owns 1 object\(s\) \(relations, functions, types, schemas or large objects\)/); }
  finally { await admin.query(`select lo_unlink(${oid})`); }
  expect(await reasonsAs(runtime)).toEqual([]);
});

it.skipIf(!url)("refuses grant options on types, languages, FDWs, foreign servers and parameters, and ADMIN OPTION on a held role (council U #9)", async () => {
  await admin.query(`create type public.rt_type_${suffix} as (a int)`);
  await admin.query(`create foreign data wrapper rt_fdw_${suffix}`);
  await admin.query(`create server rt_srv_${suffix} foreign data wrapper rt_fdw_${suffix}`);
  try {
    for (const [grant, kind] of [
      [`grant usage on type public.rt_type_${suffix} to ${runtime} with grant option`, "type"],
      [`grant usage on language plpgsql to ${runtime} with grant option`, "language"],
      [`grant usage on foreign data wrapper rt_fdw_${suffix} to ${runtime} with grant option`, "foreign data wrapper"],
      [`grant usage on foreign server rt_srv_${suffix} to ${runtime} with grant option`, "foreign server"],
      [`grant set on parameter work_mem to ${runtime} with grant option`, "parameter"],
    ] as const) {
      await admin.query(grant);
      try { expect((await reasonsAs(runtime)).join("\n")).toMatch(new RegExp(`holds grant options \\(WITH GRANT OPTION\\) on ${kind}`)); }
      finally { await admin.query(grant.replace(/^grant /, "revoke grant option for ").replace(/ to /, " from ").replace(/ with grant option$/, "")); }
    }
    expect(await reasonsAs(runtime)).toEqual([]);
  } finally {
    await admin.query(`revoke all on parameter work_mem from ${runtime}`).catch(() => {});
    await admin.query(`revoke all on language plpgsql from ${runtime}`).catch(() => {});
    await admin.query(`drop server rt_srv_${suffix} cascade`);
    await admin.query(`drop foreign data wrapper rt_fdw_${suffix} cascade`);
    await admin.query(`drop type public.rt_type_${suffix}`);
  }
  // A login that holds the allowed role WITH ADMIN OPTION could hand it to any role it creates or controls.
  const login = `rt_login_${suffix}`;
  await admin.query(`create role ${login} nologin`);
  await admin.query(`grant ${runtime} to ${login} with admin option`);
  try {
    await admin.query(`set role ${login}`);
    const { rows: [row] } = await admin.query(RUNTIME_IDENTITY_SQL, [[runtime], RUNTIME_SECURITY_DEFINER_ALLOWLIST]).finally(() => admin.query("reset role"));
    expect(runtimeIdentityReasons(row, [runtime]).join("\n")).toMatch(new RegExp(`holds ADMIN OPTION on ${runtime}`));
    await admin.query(`revoke admin option for ${runtime} from ${login}`);
    await admin.query(`set role ${login}`);
    const { rows: [clean] } = await admin.query(RUNTIME_IDENTITY_SQL, [[runtime], RUNTIME_SECURITY_DEFINER_ALLOWLIST]).finally(() => admin.query("reset role"));
    expect(runtimeIdentityReasons(clean, [runtime])).toEqual([]);
  } finally {
    await admin.query(`drop role if exists ${login}`).catch(() => {});
  }
});

it.skipIf(!url)("startup refuses the same way (assertRuntimeDatabaseIdentity)", async () => {
  const sql = { unsafe: async (query: string, params?: unknown[]) => (await admin.query(query, params as unknown[])).rows };
  await expect(assertRuntimeDatabaseIdentity(sql, [runtime])).rejects.toThrow(/superuser[\s\S]*refusing to start/);
  await admin.query(`set role ${runtime}`);
  try { await expect(assertRuntimeDatabaseIdentity(sql, [runtime])).resolves.toBeUndefined(); }
  finally { await admin.query("reset role"); }
});

it.skipIf(!url)("pricing_state_raise ignores a shadowing schema on the caller's search_path", async () => {
  await admin.query(`create schema rt_shadow_${suffix}`);
  await admin.query(`create table rt_shadow_${suffix}.pricing_provider_state (key text primary key, value bigint not null, updated_at timestamptz)`);
  await admin.query(`insert into rt_shadow_${suffix}.pricing_provider_state values ('shadow.key', 999999, now())`);
  try {
    await admin.query(`set search_path = rt_shadow_${suffix}, public`);
    const { rows: [{ value }] } = await admin.query("select public.pricing_state_raise('shadow.key', 5)::text as value");
    expect(value).toBe("5"); // the real table, not the shadow's 999999
    const { rows: [{ real }] } = await admin.query("select value::text as real from public.pricing_provider_state where key = 'shadow.key'");
    expect(real).toBe("5");
  } finally {
    await admin.query("reset search_path");
    await admin.query(`drop schema rt_shadow_${suffix} cascade`);
    await admin.query("delete from public.pricing_provider_state where key = 'shadow.key'");
  }
});
