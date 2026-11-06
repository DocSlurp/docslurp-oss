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

import { RUNTIME_IDENTITY_SQL, runtimeIdentityReasons } from "@docslurp/shared/pricing-loader";

import { DEFAULT_DB_ROLES } from "./roles.mjs";

/** The roles a runtime app may connect as (roles.mjs): the API and executor as `app`, the worker as `worker`. */
export const RUNTIME_ROLES = Object.freeze([DEFAULT_DB_ROLES.app, DEFAULT_DB_ROLES.worker]);

export { RUNTIME_IDENTITY_SQL };

/**
 * Pure: why `row` (RUNTIME_IDENTITY_SQL over [expected]) is not a safe runtime identity for `expected`; empty when it is.
 * The rule itself is @docslurp/shared's runtimeIdentityReasons, shared with every runtime process's startup check
 * (councils P #1, O #1); this adds the owner's name and a pointer when the expected role does not exist yet.
 */
export function runtimeIdentityProblems(row, expected, { expectedExists = true } = {}) {
  if (!RUNTIME_ROLES.includes(expected)) return [`unknown expected role ${JSON.stringify(expected)}; expected one of ${RUNTIME_ROLES.join(", ")}`];
  const role = String(row?.role ?? "?");
  const problems = [];
  if (role === DEFAULT_DB_ROLES.owner) problems.push(`connected as the owner role ${role}`);
  for (const reason of runtimeIdentityReasons(row, [expected])) problems.push(`connected role ${role} ${reason}`);
  if (!expectedExists) problems.push(`role ${expected} does not exist: roll out the least-privilege roles (docs/releases.md#runtime-database-roles)`);
  return problems;
}

/** Run the check over a connected client (pg). Returns the problems. */
export async function checkRuntimeIdentity(client, expected) {
  if (!RUNTIME_ROLES.includes(expected)) return runtimeIdentityProblems({}, expected);
  await client.query("begin read only");
  try {
    await client.query("set local statement_timeout = '15s'");
    const { rows: [row] } = await client.query(RUNTIME_IDENTITY_SQL, [[expected]]);
    const { rows: [exists] } = await client.query("select exists (select 1 from pg_roles where rolname = $1) as exists", [expected]);
    return runtimeIdentityProblems(row, expected, { expectedExists: exists?.exists === true });
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
