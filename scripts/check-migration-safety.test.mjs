import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GRANDFATHERED_THROUGH_IDX, checkMigrationSql, checkMigrations, stripSqlNoise } from './check-migration-safety.mjs';

const rules = (sql) => checkMigrationSql(sql).findings.map((finding) => finding.rule);

test('flags destructive statements', () => {
  assert.deepEqual(rules('ALTER TABLE runs DROP COLUMN legacy;'), ['drop']);
  assert.deepEqual(rules('DROP TABLE IF EXISTS old_things;'), ['drop']);
  assert.deepEqual(rules('ALTER TABLE runs DROP legacy;'), ['drop-column-shorthand']);
  assert.deepEqual(rules('ALTER TABLE runs RENAME COLUMN a TO b;'), ['rename']);
  assert.deepEqual(rules('ALTER TABLE runs ALTER COLUMN cost TYPE numeric;'), ['alter-type']);
  assert.deepEqual(rules('ALTER TABLE runs ALTER COLUMN cost SET DATA TYPE numeric;'), ['alter-type']);
  assert.deepEqual(rules('ALTER TABLE runs ALTER COLUMN org_id SET NOT NULL;'), ['set-not-null']);
  assert.deepEqual(rules('TRUNCATE perf_log;'), ['truncate']);
});

test('additive and replace-in-place statements pass', () => {
  assert.deepEqual(rules(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS budget numeric;
CREATE INDEX IF NOT EXISTS runs_budget_idx ON runs (budget);
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_budget_check;
ALTER TABLE runs ALTER COLUMN budget DROP DEFAULT;
ALTER TABLE runs ALTER COLUMN budget DROP NOT NULL;
DROP TRIGGER IF EXISTS runs_touch ON runs;
DROP INDEX IF EXISTS runs_old_idx;`), []);
});

test('comments and string literals never match, even with apostrophes', () => {
  assert.deepEqual(rules(`-- don't drop table runs here
COMMENT ON TABLE runs IS 'we never rename or truncate; it''s fine';
/* DROP TABLE nope; */
SELECT 1;`), []);
  assert.equal(stripSqlNoise("a -- x\nb").split('\n').length, 2);
});

test('a marker with a reason acknowledges a contract migration', () => {
  const result = checkMigrationSql('-- destructive-migration: unused since v0.3 (expand in 0040)\nALTER TABLE runs DROP COLUMN legacy;');
  assert.equal(result.acknowledged, true);
  assert.match(result.reason, /unused since v0\.3/);
  assert.equal(checkMigrationSql('-- destructive-migration:\nDROP TABLE x;').acknowledged, false);
});

test('only migrations after the grandfathered index are enforced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docslurp-migration-safety-'));
  try {
    mkdirSync(join(dir, 'meta'));
    const old = GRANDFATHERED_THROUGH_IDX;
    const entries = [
      { idx: old, tag: `${String(old).padStart(4, '0')}_old` },
      { idx: old + 1, tag: `${String(old + 1).padStart(4, '0')}_contract` },
      { idx: old + 2, tag: `${String(old + 2).padStart(4, '0')}_acked` },
    ];
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ entries }));
    writeFileSync(join(dir, `${entries[0].tag}.sql`), 'DROP TABLE legacy;');
    writeFileSync(join(dir, `${entries[1].tag}.sql`), 'ALTER TABLE runs\n  DROP COLUMN legacy;');
    writeFileSync(join(dir, `${entries[2].tag}.sql`), '-- destructive-migration: unused since 0033\nDROP TABLE legacy2;');
    const { problems, acknowledged } = checkMigrations(dir);
    assert.deepEqual(problems.map((problem) => [problem.file, problem.rule, problem.line]), [[`${entries[1].tag}.sql`, 'drop', 2]]);
    assert.equal(acknowledged.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the repository migrations pass the gate', () => {
  const dir = new URL('../server/db/migrations/', import.meta.url).pathname;
  assert.ok(readdirSync(dir).length > 0);
  assert.ok(JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')).entries.length > 0);
  assert.deepEqual(checkMigrations(dir).problems, []);
});
