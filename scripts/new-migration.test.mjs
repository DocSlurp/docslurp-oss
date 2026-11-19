import assert from 'node:assert/strict';
import test from 'node:test';

import { checkMigrationIdempotency, checkMigrationName } from './check-migration-safety.mjs';
import { migrationFileName, TEMPLATE } from './new-migration.mjs';

test('names a migration with the UTC minute and a snake_case slug the gate accepts', () => {
  const name = migrationFileName('Hot Query-Indexes', new Date('2026-11-18T14:43:59Z'));
  assert.equal(name, '20261118T1443_hot_query_indexes.sql');
  assert.equal(checkMigrationName(name), null);
  // UTC, whatever the local zone: 23:30 at -05:00 is the next day.
  assert.equal(migrationFileName('x', new Date('2026-12-31T23:30:00-05:00')), '20270101T0430_x.sql');
  for (const bad of [undefined, '', '../etc', 'a.b', '_lead', 'x'.repeat(81)]) assert.throws(() => migrationFileName(bad), /Usage/);
});

test('the template is comments only and passes the idempotency gate', () => {
  assert.deepEqual(checkMigrationIdempotency(TEMPLATE).findings, []);
});
