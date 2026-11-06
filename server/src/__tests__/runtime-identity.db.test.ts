import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { assertRuntimeDatabaseIdentity, RUNTIME_IDENTITY_SQL, runtimeIdentityReasons } from "@docslurp/shared/pricing-loader";

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
    const { rows: [row] } = await admin.query(RUNTIME_IDENTITY_SQL, [[runtime]]);
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
