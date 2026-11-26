import postgres from "postgres";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startMigratedPostgres } from "../test/migrated-postgres.js";

// server/db is outside the worker package: loaded at run time, as compute-fleet-admission.db.test.ts does.
type ReconcileRoleGrants = (client: unknown, options: { log: () => void }) => Promise<unknown>;
const serverModule = (name: string) => pathToFileURL(path.resolve(import.meta.dirname, `../../../server/db/${name}`)).href;

let sql: ReturnType<typeof postgres>;
let stop: () => Promise<void>;
beforeAll(async () => {
  const db = await startMigratedPostgres();
  stop = db.stop;
  sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
  await sql.unsafe("create role docslurp_app nologin; create role docslurp_worker nologin");
  const client = { query: async (statement: string, params: unknown[] = []) => ({ rows: await sql.unsafe(statement, params as postgres.ParameterOrJSON<never>[]) }) };
  const { reconcileRoleGrants } = (await import(/* @vite-ignore */ serverModule("roles.mjs"))) as { reconcileRoleGrants: ReconcileRoleGrants };
  await reconcileRoleGrants(client, { log: () => {} });
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

describe("pii_page_findings is operator-only in the database", () => {
  it("the API role holds no privilege on it after the schema-wide grant; the worker selects, inserts and deletes", async () => {
    const [grants] = await sql`
      select
        has_table_privilege('docslurp_app', 'public.pii_page_findings', 'SELECT') as app_select,
        has_table_privilege('docslurp_app', 'public.pii_page_findings', 'INSERT') as app_insert,
        has_table_privilege('docslurp_app', 'public.pii_page_findings', 'DELETE') as app_delete,
        has_table_privilege('docslurp_worker', 'public.pii_page_findings', 'SELECT') as worker_select,
        has_table_privilege('docslurp_worker', 'public.pii_page_findings', 'INSERT') as worker_insert,
        has_table_privilege('docslurp_worker', 'public.pii_page_findings', 'DELETE') as worker_delete,
        has_table_privilege('docslurp_worker', 'public.pii_page_findings', 'UPDATE') as worker_update
    `;
    expect(grants).toEqual({ app_select: false, app_insert: false, app_delete: false, worker_select: true, worker_insert: true, worker_delete: true, worker_update: false });
    // The API role reading it is refused by the database, not by convention.
    await sql.unsafe("set role docslurp_app");
    try {
      await expect(sql`select count(*) from pii_page_findings`).rejects.toThrow(/permission denied/);
    } finally {
      await sql.unsafe("reset role");
    }
  });

  it("the predeploy check flags any grant beyond the operator-only rule", async () => {
    const { piiFindingsGrantProblems } = (await import(/* @vite-ignore */ serverModule("predeploy-check.mjs"))) as { piiFindingsGrantProblems: (rows: Array<{ role: string; privileges: string[] }>) => string[] };
    expect(piiFindingsGrantProblems([{ role: "docslurp_app", privileges: [] }, { role: "docslurp_worker", privileges: ["select", "insert", "delete"] }])).toEqual([]);
    expect(piiFindingsGrantProblems([{ role: "docslurp_app", privileges: ["select"] }, { role: "docslurp_worker", privileges: ["update"] }]))
      .toEqual(["docslurp_app: select", "docslurp_worker: update"]);
  });
});
