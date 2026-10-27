import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, expect, it } from "vitest";

const url = process.env.MIGRATION_LOCK_TEST_DATABASE_URL;
const clients: Client[] = [];
afterAll(async () => { await Promise.all(clients.map(client => client.end().catch(() => {}))); });
async function connect() { const client = new Client({ connectionString: url }); await client.connect(); clients.push(client); return client; }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waiting(observer: Client, pid: number, relation: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await observer.query("select 1 from pg_locks where pid=$1 and relation=$2::regclass and not granted", [pid, relation]);
    if (rows.length) return;
    await delay(10);
  }
  throw new Error(`Expected lock wait on ${relation}`);
}
const migration = readFileSync(new URL('../../db/migrations/0072_document_text_byte_counters.sql', import.meta.url), 'utf8')
  // Scale lock windows only: preserve every actual migration statement/order.
  .replaceAll("'10s'", "'100ms'").replaceAll("'45s'", "'2s'");

it.skipIf(!url)('drains an existing reader beyond the old lock window, then releases queued readers at commit', async () => {
  const reader = await connect(), migrator = await connect(), observer = await connect(), nextReader = await connect();
  await reader.query('begin');
  await reader.query('select count(*) from documents');
  const pid = (await migrator.query('select pg_backend_pid() as pid')).rows[0].pid;
  await migrator.query('begin');
  const applying = migrator.query(migration).then(() => null, error => error);
  await waiting(observer, pid, 'documents');
  await delay(250);
  await reader.query('commit');
  expect(await applying).toBeNull();
  const nextPid = (await nextReader.query('select pg_backend_pid() as pid')).rows[0].pid;
  const read = nextReader.query('select chunk_text_bytes, stored_page_text_bytes from documents');
  await waiting(observer, nextPid, 'documents');
  await migrator.query('commit');
  await expect(read).resolves.toBeDefined();
}, 10_000);

it.skipIf(!url)('rolls back safely if a document-first writer blocks the lock upgrade', async () => {
  const writer = await connect(), migrator = await connect(), observer = await connect();
  await writer.query('begin');
  await writer.query('lock table documents in row exclusive mode');
  await writer.query("set local lock_timeout='1s'");
  await migrator.query('begin');
  await migrator.query("set local lock_timeout='300ms'");
  await migrator.query('lock table document_chunks, document_pages in share row exclusive mode');
  const writerPid = (await writer.query('select pg_backend_pid() as pid')).rows[0].pid;
  const write = writer.query('lock table document_chunks in row exclusive mode').then(() => null, error => error);
  await waiting(observer, writerPid, 'document_chunks');
  const upgrade = await migrator.query('lock table documents in access exclusive mode').then(() => null, error => error);
  expect(['55P03', '40P01']).toContain(upgrade?.code);
  await migrator.query('rollback');
  expect(await write).toBeNull();
  await writer.query('commit');
  await expect(observer.query('select chunk_text_bytes, stored_page_text_bytes from documents')).resolves.toBeDefined();
}, 10_000);
