import { Client } from "pg";
import { afterAll, expect, it } from "vitest";

const url = process.env.MIGRATION_LOCK_TEST_DATABASE_URL;
const clients: Client[] = [];
afterAll(async () => { await Promise.all(clients.map(client => client.end().catch(() => {}))); });
async function connect() {
  const client = new Client({ connectionString: url });
  await client.connect(); clients.push(client);
  await client.query("set statement_timeout='3s'");
  return client;
}
async function seed(client: Client, prefix: string) {
  await client.query(`insert into "user" (id,name,email) values ($1,'Test',$2)`, [prefix, `${prefix}@example.test`]);
  await client.query(`insert into organizations (id,name,slug,created_by_user_id) values ($1,'Test',$1,$1)`, [prefix]);
  await client.query(`insert into workspaces (id,org_id,user_id,name) values ($1,$1,$1,'Test')`, [prefix]);
  await client.query(`insert into workspace_runs (id,org_id,user_id,workspace_id,kind,status,stage,pipeline)
    values ($1,$2,$2,$2,'upload','failed','embed','{}'),($3,$2,$2,$2,'upload','processing','index','{}')`, [`${prefix}-old`, prefix, `${prefix}-new`]);
  await client.query(`insert into documents (id,org_id,user_id,workspace_id,run_id,filename,mime_type,source_key,status,canonical_id,created_at)
    values ($1,$2,$2,$2,$3,'a.txt','text/plain','old','queued','/a','2026-01-01'),
      ($4,$2,$2,$2,$5,'a.txt','text/plain','new','queued','/a','2026-01-02')`,
  [`${prefix}-old-doc`, prefix, `${prefix}-old`, `${prefix}-new-doc`, `${prefix}-new`]);
}

it.skipIf(!url)("retry-first skips the locked Run and preserves its active pending document without a deadlock", async () => {
  const retry = await connect(), retire = await connect();
  await seed(retry, 'retry-first');
  await retry.query('begin');
  await retry.query("update workspace_runs set status='processing' where id='retry-first-old'");
  await retire.query("update documents set status='completed' where id='retry-first-new-doc'");
  await retry.query("update documents set status='queued' where run_id='retry-first-old' and superseded_at is null and status <> 'cancelled'");
  await retry.query('commit');
  expect((await retire.query("select status,superseded_at from documents where id='retry-first-old-doc'")).rows)
    .toEqual([{ status: 'queued', superseded_at: null }]);
  // A later terminal transition can safely repair the skipped history.
  await retry.query("update workspace_runs set status='failed' where id='retry-first-old'");
  await retire.query("select retire_replaced_pending_documents('retry-first-old')");
  expect((await retire.query("select status from documents where id='retry-first-old-doc'")).rows[0].status).toBe('cancelled');
});

it.skipIf(!url)("retirement-first holds the Run claim through commit so retry cannot revive retired documents", async () => {
  const retire = await connect(), retry = await connect(), observer = await connect();
  await seed(retire, 'retire-first');
  await retire.query('begin');
  await retire.query("update documents set status='completed' where id='retire-first-new-doc'");
  const pid = (await retry.query('select pg_backend_pid() as pid')).rows[0].pid;
  await retry.query('begin');
  const starting = retry.query("update workspace_runs set status='processing' where id='retire-first-old'");
  let waiting = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    waiting = (await observer.query('select 1 from pg_locks where pid=$1 and not granted', [pid])).rowCount! > 0;
    if (waiting) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(waiting).toBe(true);
  await retire.query('commit');
  await starting;
  const revived = await retry.query("update documents set status='queued' where run_id='retire-first-old' and superseded_at is null and status <> 'cancelled' returning id");
  expect(revived.rows).toEqual([]);
  await retry.query('commit');
  expect((await observer.query("select status,superseded_by_document_id from documents where id='retire-first-old-doc'")).rows)
    .toEqual([{ status: 'cancelled', superseded_by_document_id: 'retire-first-new-doc' }]);
});
