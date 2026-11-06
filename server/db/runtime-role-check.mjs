#!/usr/bin/env node
// Runtime database identity gate (council N #1): a long-running app (API, worker, chat executor) must connect as its
// least-privilege role, never as the owner. Run check-only, on a one-off machine in each app, with that app's own
// DATABASE_URL, before anything migrates or rolls:
//
//   DATABASE_URL=... node server/db/runtime-role-check.mjs --expect-role docslurp_app
//
// Exit 0 when the connected role is a member of the expected role and holds none of the owner's powers; 1 with the
// reasons (never the URL or a password) otherwise; 2 when the check could not run.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { PRICING_STATE_WRITER_SQL, pricingStateWriterReasons } from "@docslurp/shared/pricing-loader";

import { DEFAULT_DB_ROLES } from "./roles.mjs";

/** The roles a runtime app may connect as (roles.mjs): the API and executor as `app`, the worker as `worker`. */
export const RUNTIME_ROLES = Object.freeze([DEFAULT_DB_ROLES.app, DEFAULT_DB_ROLES.worker]);

/** What the connected role can do; one row, read-only. */
export const RUNTIME_IDENTITY_SQL = `
  select current_user as role,
    coalesce((select rolsuper from pg_roles where rolname = current_user), false) as superuser,
    coalesce((select rolcreaterole or rolcreatedb or rolreplication or rolbypassrls from pg_roles where rolname = current_user), false) as elevated,
    (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S') and pg_has_role(current_user, c.relowner, 'USAGE')) as owned_relations,
    has_schema_privilege(current_user, 'public', 'CREATE') as can_create,
    exists (select 1 from pg_roles where rolname = $1::text) as expected_exists,
    case when exists (select 1 from pg_roles where rolname = $1::text) then pg_has_role(current_user, $1::text, 'MEMBER') else false end as member_of_expected
`;

/** Pure: why `row` (RUNTIME_IDENTITY_SQL) is not a safe runtime identity for `expected`; empty when it is. */
export function runtimeIdentityProblems(row, expected) {
  if (!RUNTIME_ROLES.includes(expected)) return [`unknown expected role ${JSON.stringify(expected)}; expected one of ${RUNTIME_ROLES.join(", ")}`];
  const problems = [];
  const role = String(row.role);
  if (role === DEFAULT_DB_ROLES.owner) problems.push(`connected as the owner role ${role}`);
  if (row.superuser) problems.push(`connected role ${role} is a superuser`);
  if (row.elevated) problems.push(`connected role ${role} can create roles or databases, replicate or bypass row security`);
  if (row.owned_relations > 0) problems.push(`connected role ${role} owns ${row.owned_relations} relation(s) in schema public`);
  if (row.can_create) problems.push(`connected role ${role} can create objects in schema public`);
  if (!row.expected_exists) problems.push(`role ${expected} does not exist: roll out the least-privilege roles (docs/releases.md#runtime-database-roles)`);
  else if (!row.member_of_expected) problems.push(`connected role ${role} is not a member of ${expected}`);
  // The pricing-state rule is shared with the startup check (council P #1): ownership, any write, pg_write_all_data, the raise.
  if (row.pricing) for (const reason of pricingStateWriterReasons(row.pricing)) if (reason !== "is a superuser") problems.push(`connected role ${role} ${reason}`);
  return problems;
}

/** Run the check over a connected client (pg). Returns the problems. */
export async function checkRuntimeIdentity(client, expected) {
  if (!RUNTIME_ROLES.includes(expected)) return runtimeIdentityProblems({}, expected);
  await client.query("begin read only");
  try {
    await client.query("set local statement_timeout = '15s'");
    const { rows: [row] } = await client.query(RUNTIME_IDENTITY_SQL, [expected]);
    const { rows: [pricing] } = await client.query(PRICING_STATE_WRITER_SQL);
    return runtimeIdentityProblems({ ...row, pricing }, expected);
  } finally {
    await client.query("rollback");
  }
}

async function main() {
  const index = process.argv.indexOf("--expect-role");
  const expected = index >= 0 ? process.argv[index + 1] : undefined;
  if (!expected) throw new Error("usage: runtime-role-check.mjs --expect-role <docslurp_app|docslurp_worker>");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const { Client } = createRequire(import.meta.url)("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const problems = await checkRuntimeIdentity(client, expected);
    for (const problem of problems) console.error(`[runtime-role] REFUSED: ${problem}`);
    if (problems.length) { process.exitCode = 1; return; }
    console.log(`[runtime-role] ok: DATABASE_URL connects as a member of ${expected} with no owner powers`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`[runtime-role] could not run: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; });
}
