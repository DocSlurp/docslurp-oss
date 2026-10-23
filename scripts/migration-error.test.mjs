import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrationFailureDetail } from '../server/db/migration-error.mjs';

test('retains the actual SQL failure emitted only on stdout', () => {
  const error = Object.assign(new Error('Command failed'), { stdout: '\x1b[31merror: canceling statement due to lock timeout\x1b[0m', stderr: '' });
  assert.equal(migrationFailureDetail(error), 'Command failed\nerror: canceling statement due to lock timeout');
});
test('redacts database credentials in either output stream', () => {
  const detail = migrationFailureDetail(Object.assign(new Error('Command failed'), { stdout: 'postgres://user:password@db/app', stderr: 'postgresql://user:other@db/app?sslmode=require' }));
  assert.ok(!detail.includes('password'));
  assert.ok(!detail.includes('user:'));
  assert.equal(detail.match(/redacted database URL/g).length, 2);
});
