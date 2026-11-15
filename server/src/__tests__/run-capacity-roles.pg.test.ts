import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { quoteIdent, reconcileRoleGrants } from "../../db/roles.mjs";

const url = process.env.TEST_DATABASE_URL;
const prefix = `capacity_roles_${randomUUID().replaceAll("-", "")}`;
const app = `${prefix}_app`, worker = `${prefix}_worker`;
let client: Client;
beforeAll(async () => {
  if (!url) return;
  client = new Client({ connectionString: url }); await client.connect();
  const { rows: [owner] } = await client.query("select current_user as name");
  for (const role of [app, worker]) await client.query(`create role ${quoteIdent(role)} nologin`);
  await reconcileRoleGrants(client, { roles: { owner: owner.name, app, worker, backup: `${prefix}_absent` }, log: () => {} });
  await client.query(`insert into "user"(id,name,email) values($1,'Capacity roles','capacity-roles@example.test')`, [prefix]);
  await client.query("insert into organizations(id,name,created_by_user_id) values($1,'Capacity roles',$1)", [prefix]);
  await client.query("insert into projects(id,org_id,user_id,name) values($1,$1,$1,'Capacity roles')", [prefix]);
  await client.query(`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,pipeline,monthly_reservation_cents)
    values($1,$1,$1,$1,'upload','queued','queued','{}',100)`, [prefix]);
});
afterAll(async () => {
  if (!client) return;
  await client.query("reset role");
  for (const role of [app, worker]) {
    await client.query(`drop owned by ${quoteIdent(role)}`);
    await client.query(`drop role ${quoteIdent(role)}`);
  }
  await client.end();
});
async function asRole<T>(role: string, run: () => Promise<T>): Promise<T> {
  await client.query(`set role ${quoteIdent(role)}`);
  try { return await run(); } finally { await client.query("reset role"); }
}
it.skipIf(!url)("denies worker receipt reads and writes, while allowing API receipt access", async () => {
  await asRole(worker, async () => {
    for (const sql of ["select * from intake_request_receipts", "insert into intake_request_receipts default values",
      "update intake_request_receipts set request_hash='forged'", "delete from intake_request_receipts",
      "select * from pending_monthly_capacity"]) {
      await expect(client.query(sql)).rejects.toMatchObject({code:'42501'});
    }
    for (const privilege of ['select','insert','update','delete']) {
      const result = await client.query("select has_table_privilege(current_user,'public.pending_monthly_capacity',$1) as granted",[privilege]);
      expect(result.rows[0].granted).toBe(false);
    }
  });
  await asRole(app, async () => {
    await client.query(`insert into intake_request_receipts(idempotency_key,route_key,request_hash,user_id)
      values($1,'fixture','hash',$1)`,[prefix]);
    expect((await client.query("select user_id from intake_request_receipts where idempotency_key=$1",[prefix])).rows).toEqual([{user_id:prefix}]);
    await client.query("select * from pending_monthly_capacity");
  });
});
it.skipIf(!url)("permits admitted worker init/release/failure but reserves terminal reactivation for API admission", async () => {
  await asRole(worker, async () => {
    // Store.updateProgress(init) and releaseRunLease keep the same capacity.
    for (const [from,to] of [['queued','processing'],['processing','queued']]) {
      const result = await client.query("update project_runs set status=$1 where id=$2 and status=$3 returning status",[to,prefix,from]);
      expect(result.rows).toEqual([{status:to}]);
    }
    await expect(client.query("update project_runs set monthly_reservation_cents=101 where id=$1",[prefix])).rejects.toMatchObject({code:'42501'});
    await client.query("update project_runs set status='failed' where id=$1",[prefix]);
    await expect(client.query("update project_runs set status='queued' where id=$1",[prefix])).rejects.toMatchObject({code:'42501'});
  });
  await asRole(app, async () => {
    const result = await client.query("update project_runs set status='queued' where id=$1 returning status,monthly_reservation_cents",[prefix]);
    expect(result.rows).toEqual([{status:'queued',monthly_reservation_cents:'100'}]);
  });
});
