import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migratePostgis } from './migrate-postgis.mjs';

function client({ extension = true, fail = false, applied = false, projects = false } = {}) {
  const calls = [];
  return { calls, async query(sql) {
    calls.push(sql);
    if (sql.includes("to_regclass('public.projects')")) return { rowCount: 1, rows: [{ projects }] };
    if (sql.includes('pg_extension')) return { rowCount: extension ? 1 : 0 };
    if (sql.startsWith('SELECT digest')) return { rowCount: applied ? 1 : 0, rows: [{ digest: 'tampered' }] };
    if (fail && sql.startsWith('CREATE TABLE geo_projection_generations')) throw new Error('DDL failure');
    return { rowCount: 0, rows: [] };
  } };
}
test('absent extension refuses without creating ledger', async () => {
  const db = client({ extension: false });
  await assert.rejects(migratePostgis(db), /already installed/);
  assert.equal(db.calls.at(-1), 'ROLLBACK');
  assert.ok(!db.calls.some(sql => sql.startsWith('CREATE')));
});
test('DDL failure rolls back and never records success', async () => {
  const db = client({ fail: true });
  await assert.rejects(migratePostgis(db), /DDL failure/);
  assert.equal(db.calls.at(-1), 'ROLLBACK');
  assert.ok(!db.calls.some(sql => sql.startsWith('INSERT')));
});
test('changed applied migration refuses', async () => {
  const db = client({ applied: true });
  await assert.rejects(migratePostgis(db), /migration changed/);
  assert.equal(db.calls.at(-1), 'ROLLBACK');
});
test('fresh migration records success only after DDL', async () => {
  const db = client();
  await migratePostgis(db);
  assert.equal(db.calls.at(-1), 'COMMIT');
  assert.ok(db.calls.findIndex(sql => sql.startsWith('INSERT')) > db.calls.findIndex(sql => sql.startsWith('CREATE TABLE geo_projection_generations')));
});

test('new project schema bootstraps PostGIS without legacy tenant identifiers', async () => {
  const db = client({ projects: true });
  await migratePostgis(db);
  const ddl = db.calls.filter(sql => sql.startsWith('CREATE TABLE geo_') || sql.startsWith('CREATE FUNCTION publish_'));
  assert.ok(ddl.length > 0);
  assert.ok(ddl.every(sql => !sql.includes('workspace_id') && !sql.includes('workspaces')));
  assert.ok(ddl.some(sql => sql.includes('project_id')));
});
