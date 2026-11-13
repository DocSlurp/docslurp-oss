import { Client } from "pg";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { reconcileRoleGrants } from "../../db/roles.mjs";
import { startRevisionMaintenance, revisionMaintenanceMetrics } from "./revision-maintenance.js";

const url = process.env.REALTIME_PUBLICATION_TEST_DATABASE_URL;
const clients: Client[] = [];
let owner: Client;
let stop: (() => Promise<void>) | undefined;
async function connect(role?: string) {
  const client = new Client({ connectionString: url });
  await client.connect(); clients.push(client);
  await client.query("set statement_timeout='3s'");
  if (role) await client.query(`set session authorization ${role}`);
  return client;
}
beforeAll(async () => {
  if (!url) return;
  owner = await connect();
  await owner.query(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='docslurp_worker') then create role docslurp_worker nologin; end if;
    if not exists(select 1 from pg_roles where rolname='docslurp_app') then create role docslurp_app nologin; end if;
  end $$`);
  await reconcileRoleGrants(owner, { log: () => {} });
  await owner.query(`insert into "user"(id,name,email) values('publication','Test','publication@example.test');
    insert into organizations(id,name,slug,created_by_user_id) values('publication','Test','publication','publication');
    insert into projects(id,org_id,user_id,name) values
      ('publication-holder','publication','publication','Test'),('publication-writer','publication','publication','Test')`);
});
afterAll(async () => { await stop?.(); await Promise.all(clients.map(c => c.end())); });

it.skipIf(!url)("keeps already-connected restricted sessions working at migration commit before grant reconciliation", async () => {
  const name = `publication_upgrade_${process.pid}`;
  await owner.query(`create database ${name} template template0`);
  const target = new URL(url!); target.pathname = `/${name}`;
  const migration = new Client({ connectionString: target.toString() });
  const app = new Client({ connectionString: target.toString() });
  const worker = new Client({ connectionString: target.toString() });
  try {
    await migration.connect();
    const dir = new URL("../../db/migrations/", import.meta.url);
    const entries = JSON.parse(readFileSync(new URL("meta/_journal.json", dir), "utf8")).entries as Array<{ idx: number; tag: string }>;
    for (const entry of entries.filter(e => e.idx < 120)) {
      await migration.query("begin");
      await migration.query(readFileSync(new URL(`${entry.tag}.sql`, dir), "utf8"));
      await migration.query("commit");
    }
    // Bootstrap the historical grant policy before the project rename.
    await reconcileRoleGrants({ query: async (statement: string, params?: unknown[]) => {
      const result = await migration.query(statement.replaceAll("project", "workspace"), params);
      return { ...result, rows: result.rows.map((row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
        // The old schema reports column arrays as well as relation names.
        if (key === "columns" && Array.isArray(value)) return [key, value.map(column => typeof column === "string" ? column.replaceAll("workspace", "project") : column)];
        return [key, ["relname", "table", "sequence"].includes(key) && typeof value === "string" ? value.replaceAll("workspace", "project") : value];
      }))) };
    } }, { log: () => {} });
    await migration.query(`insert into "user"(id,name,email) values('upgrade','Test','upgrade@example.test');
      insert into organizations(id,name,slug,created_by_user_id) values('upgrade','Test','upgrade','upgrade');
      insert into workspaces(id,org_id,user_id,name) values('upgrade','upgrade','upgrade','Test')`);
    await app.connect(); await worker.connect();
    await app.query("set session authorization docslurp_app");
    await worker.query("set session authorization docslurp_worker");
    await migration.query("begin");
    await migration.query(readFileSync(new URL("0120_realtime_nonblocking_revisions.sql", dir), "utf8"));
    await migration.query("commit");
    // Deliberately no post-migration reconcileRoleGrants call.
    const before = BigInt((await app.query("select revision from realtime_revisions where org_id='upgrade'")).rows[0].revision);
    await worker.query("update workspaces set name='after-upgrade' where id='upgrade'");
    expect(BigInt((await app.query("select revision from realtime_revisions where org_id='upgrade'")).rows[0].revision)).toBe(before + 1n);
    await expect(worker.query("select realtime_record_change('foreign-org')")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("delete from realtime_revision_counters")).rejects.toMatchObject({ code: "42501" });
  } finally {
    await Promise.all([migration.end(), app.end(), worker.end()]);
    // Cleanup, not the behaviour under test: dropping a fully migrated database can outlast the session's 3 s statement
    // timeout on a busy runner (it failed CI on 2f1fbafa), so the drop alone gets a longer one.
    await owner.query("set statement_timeout = '60s'");
    try {
      await owner.query(`drop database ${name} with (force)`);
    } finally {
      await owner.query("set statement_timeout = '3s'");
    }
  }
}, 30_000);

it.skipIf(!url)("denies direct and arbitrary-tenant mutation under the actual ingestion role", async () => {
  const worker = await connect("docslurp_worker");
  for (const statement of [
    "select * from public.realtime_revision_counters",
    "update public.realtime_revision_counters set revision=0",
    "delete from public.realtime_revision_counters",
    "insert into public.realtime_revision_counters values('other-tenant',9223372036854775807,0)",
    "select public.realtime_record_change('other-tenant')",
    "select public.realtime_fold_committed('other-tenant')",
    "select * from public.realtime_compact_revisions('')",
    "set role docslurp_realtime_publisher",
  ]) await expect(worker.query(statement)).rejects.toMatchObject({ code: "42501" });
  await worker.query("update projects set name='published' where id='publication-writer'");
});

it.skipIf(!url)("drains a long-transaction burst without further writes and bounds reader work", async () => {
  const holder = await connect("docslurp_worker"), writer = await connect("docslurp_worker");
  const read = async () => (await owner.query("select revision from realtime_revisions where org_id='publication'")).rows[0].revision;
  const before = BigInt(await read());
  await holder.query("begin");
  await holder.query("update projects set name='holding' where id='publication-holder'");
  for (let i = 0; i < 300; i++) await writer.query("update projects set name='burst' where id='publication-writer'");
  const rows = async () => Number((await owner.query("select count(*) from realtime_revision_counters where org_id='publication'")).rows[0].count);
  expect(await rows()).toBeGreaterThanOrEqual(300);
  const planRows = async () => {
    const result = await owner.query("explain (analyze,format json) select revision from realtime_revisions where org_id='publication'");
    const scans: number[] = [];
    const walk = (node: Record<string, unknown>) => {
      if (node["Relation Name"] === "realtime_revision_counters") scans.push(Number(node["Actual Rows"]));
      for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) walk(child);
    };
    walk(result.rows[0]["QUERY PLAN"][0].Plan);
    return scans.reduce((a, b) => a + b, 0);
  };
  expect(await planRows()).toBeGreaterThanOrEqual(300);
  const appUrl = new URL(url!); appUrl.searchParams.set("options", "-c role=docslurp_app");
  const queriesBefore = revisionMaintenanceMetrics.queries;
  stop = startRevisionMaintenance(appUrl.toString(), 20);
  // The compactor cannot fold this org while the publishing transaction holds
  // its advisory lock, but its attempts do not wait or block other publishers.
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(await rows()).toBeGreaterThanOrEqual(300);
  await holder.query("commit");
  // Each scope folds to one row: the organization ('') and the two projects written (0152's per-resource scopes).
  const scopes = async () => (await owner.query("select scope, count(*)::int as n from realtime_revision_counters where org_id='publication' group by scope order by scope")).rows;
  const deadline = Date.now() + 5_000;
  while (await rows() > 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  await stop(); stop = undefined;
  expect(await scopes()).toEqual([
    { scope: "", n: 1 }, { scope: "project:publication-holder", n: 1 }, { scope: "project:publication-writer", n: 1 },
  ]);
  expect(BigInt(await read())).toBe(before + 301n);
  expect(await planRows()).toBe(1);
  expect(revisionMaintenanceMetrics.queries - queriesBefore).toBeLessThan(100);
  expect(revisionMaintenanceMetrics.failures).toBe(0);
}, 20_000);

it.skipIf(!url)("advances across multiple organization pages without relying on new writes", async () => {
  for (let i = 0; i < 35; i++) await owner.query(`insert into organizations(id,name,slug,created_by_user_id)
    values($1,'Test',$1,'publication')`, [`publication-page-${String(i).padStart(2, "0")}`]);
  let cursor = "";
  const folded: number[] = [];
  do {
    const { rows: [row] } = await owner.query("select * from realtime_compact_revisions($1)", [cursor]);
    folded.push(row.folded_rows); cursor = row.next_org;
    expect(folded.length).toBeLessThan(6);
    expect(row.folded_rows).toBeLessThanOrEqual(16 * 256);
  } while (cursor);
  expect(folded.length).toBeGreaterThanOrEqual(3);
  expect(Number((await owner.query("select count(*) from realtime_revision_counters where transaction_id<>0")).rows[0].count)).toBe(0);
});

it.skipIf(!url)("reconnects after an idle maintenance connection is terminated", async () => {
  const before = { ...revisionMaintenanceMetrics };
  stop = startRevisionMaintenance(url!, 100);
  let pid: number | undefined;
  const deadline = Date.now() + 3_000;
  while (!pid && Date.now() < deadline) {
    pid = (await owner.query(`select pid from pg_stat_activity where datname=current_database()
      and application_name='docslurp-revision-maintenance' and state='idle' limit 1`)).rows[0]?.pid;
    if (!pid) await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(pid).toBeDefined();
  await owner.query("select pg_terminate_backend($1)", [pid]);
  while ((revisionMaintenanceMetrics.failures === before.failures || revisionMaintenanceMetrics.queries < before.queries + 3)
    && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  await stop(); stop = undefined;
  expect(revisionMaintenanceMetrics.failures).toBeGreaterThan(before.failures);
  expect(revisionMaintenanceMetrics.queries).toBeGreaterThanOrEqual(before.queries + 3);
});
