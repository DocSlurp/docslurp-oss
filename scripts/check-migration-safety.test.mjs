import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GRANDFATHERED_THROUGH_IDX, checkMigrationIdempotency, checkMigrationSql, checkMigrations, stripDollarQuoted, stripSqlNoise } from './check-migration-safety.mjs';

const rules = (sql) => checkMigrationSql(sql).findings.map((finding) => finding.rule);
const idempotencyRules = (sql) => checkMigrationIdempotency(sql).findings.map((finding) => finding.rule);

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
    writeFileSync(join(dir, `${entries[0].tag}.sql`), 'DROP TABLE IF EXISTS legacy;');
    writeFileSync(join(dir, `${entries[1].tag}.sql`), 'ALTER TABLE runs\n  DROP COLUMN IF EXISTS legacy;');
    writeFileSync(join(dir, `${entries[2].tag}.sql`), '-- destructive-migration: unused since 0033\nDROP TABLE IF EXISTS legacy2;');
    const { problems, acknowledged } = checkMigrations(dir);
    assert.deepEqual(problems.map((problem) => [problem.file, problem.rule, problem.line]), [[`${entries[1].tag}.sql`, 'drop', 2]]);
    assert.equal(acknowledged.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('flags statements that fail or double-apply on a second run', () => {
  assert.deepEqual(idempotencyRules('CREATE TABLE runs (id text);'), ['create-without-if-not-exists']);
  assert.deepEqual(idempotencyRules('CREATE UNLOGGED TABLE scratch (id text);'), ['create-without-if-not-exists']);
  assert.deepEqual(idempotencyRules('CREATE SEQUENCE run_seq;'), ['create-without-if-not-exists']);
  assert.deepEqual(idempotencyRules('CREATE EXTENSION pgcrypto;'), ['create-without-if-not-exists']);
  assert.deepEqual(idempotencyRules('CREATE UNIQUE INDEX runs_key ON runs (key);'), ['create-index-without-if-not-exists']);
  assert.deepEqual(idempotencyRules('CREATE INDEX CONCURRENTLY runs_key ON runs (key);'), ['create-index-without-if-not-exists']);
  assert.deepEqual(idempotencyRules('ALTER TABLE runs ADD COLUMN budget numeric;'), ['add-column-without-if-not-exists']);
  assert.deepEqual(idempotencyRules('CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;'), ['create-without-or-replace']);
  assert.deepEqual(idempotencyRules('CREATE TRIGGER t AFTER INSERT ON runs FOR EACH ROW EXECUTE FUNCTION f();'), ['create-without-or-replace']);
  assert.deepEqual(idempotencyRules('CREATE VIEW v AS SELECT 1;'), ['create-without-or-replace']);
  assert.deepEqual(idempotencyRules('DROP INDEX runs_old_idx;'), ['drop-without-if-exists']);
  assert.deepEqual(idempotencyRules('ALTER TABLE runs DROP CONSTRAINT runs_check;'), ['drop-without-if-exists']);
  assert.deepEqual(idempotencyRules('ALTER TABLE runs ADD CONSTRAINT runs_check CHECK (n > 0);'), ['unguarded-catalog-change']);
  assert.deepEqual(idempotencyRules('ALTER TABLE runs ADD PRIMARY KEY (id);'), ['unguarded-catalog-change']);
  assert.deepEqual(idempotencyRules("CREATE TYPE mood AS ENUM ('ok');"), ['unguarded-catalog-change']);
  assert.deepEqual(idempotencyRules('CREATE POLICY p ON runs USING (true);'), ['unguarded-catalog-change']);
  assert.deepEqual(idempotencyRules('ALTER TABLE runs RENAME TO jobs;'), ['unguarded-catalog-change']);
  assert.deepEqual(idempotencyRules("ALTER TYPE mood ADD VALUE 'sad';"), ['add-enum-value-without-if-not-exists']);
  assert.deepEqual(idempotencyRules("INSERT INTO settings (id) VALUES (true);"), ['insert-without-conflict-guard']);
  assert.deepEqual(idempotencyRules("INSERT INTO grants SELECT org_id, 100 FROM orgs;"), ['insert-without-conflict-guard']);
});

test('idempotent forms pass', () => {
  assert.deepEqual(idempotencyRules(`CREATE TABLE IF NOT EXISTS runs (id text, CONSTRAINT runs_pkey PRIMARY KEY (id));
CREATE UNIQUE INDEX IF NOT EXISTS runs_key ON runs (key);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS budget numeric CHECK (budget >= 0);
CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
CREATE OR REPLACE TRIGGER t AFTER INSERT ON runs FOR EACH ROW EXECUTE FUNCTION f();
CREATE OR REPLACE VIEW v AS SELECT 1;
DROP INDEX IF EXISTS runs_old_idx;
ALTER TYPE mood ADD VALUE IF NOT EXISTS 'sad';
INSERT INTO settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
INSERT INTO grants SELECT o.id FROM orgs o WHERE NOT EXISTS (SELECT 1 FROM grants g WHERE g.org_id = o.id);
UPDATE runs SET budget = 0 WHERE budget IS NULL;`), []);
});

test('a DO block is where a catalog guard lives, and its body is not checked', () => {
  assert.deepEqual(idempotencyRules(`DO $idem$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_check' AND conrelid = 'runs'::regclass) THEN
    ALTER TABLE runs ADD CONSTRAINT runs_check CHECK (n > 0);
  END IF;
END $idem$;
CREATE OR REPLACE FUNCTION g() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO log VALUES (1); RETURN NEW; END $$;`), []);
  assert.equal(stripDollarQuoted('a $$x\ny$$ b').split('\n').length, 2);
});

test('dropping a named object first makes recreating it idempotent, except tables and functions', () => {
  assert.deepEqual(idempotencyRules(`ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_check;
ALTER TABLE runs ADD CONSTRAINT runs_check CHECK (n > 0);
DROP TRIGGER IF EXISTS "t" ON runs;
CREATE TRIGGER t AFTER INSERT ON runs FOR EACH ROW EXECUTE FUNCTION f();
DROP INDEX IF EXISTS public.runs_key;
CREATE INDEX runs_key ON runs (key);
DROP POLICY IF EXISTS p ON runs;
CREATE POLICY p ON runs USING (true);`), []);
  assert.deepEqual(idempotencyRules('ALTER TABLE runs ADD CONSTRAINT runs_check CHECK (n > 0);\nALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_check;'), ['unguarded-catalog-change']);
  assert.deepEqual(idempotencyRules('ALTER TABLE runs DROP CONSTRAINT IF EXISTS other;\nALTER TABLE runs ADD CONSTRAINT runs_check CHECK (n > 0);'), ['unguarded-catalog-change']);
  assert.deepEqual(idempotencyRules('DROP TABLE IF EXISTS scratch;\nCREATE TABLE scratch (a int);'), ['create-without-if-not-exists']);
  assert.deepEqual(idempotencyRules('DROP FUNCTION IF EXISTS f(int);\nCREATE FUNCTION f(text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;'), ['create-without-or-replace']);
});

test('an idempotent-migration marker with a reason acknowledges a migration, in every index', () => {
  const sql = '-- idempotent-migration: the plan is empty once applied\nINSERT INTO backup SELECT * FROM plan;';
  assert.equal(checkMigrationIdempotency(sql).acknowledged, true);
  assert.equal(checkMigrationIdempotency('-- idempotent-migration:\nINSERT INTO backup SELECT * FROM plan;').acknowledged, false);
  const dir = mkdtempSync(join(tmpdir(), 'docslurp-migration-idempotency-'));
  try {
    mkdirSync(join(dir, 'meta'));
    const entries = [{ idx: 0, tag: '0000_old' }, { idx: 1, tag: '0001_acked' }];
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ entries }));
    writeFileSync(join(dir, '0000_old.sql'), 'CREATE TABLE runs (id text);');
    writeFileSync(join(dir, '0001_acked.sql'), sql);
    const { problems, acknowledged } = checkMigrations(dir);
    assert.deepEqual(problems.map((problem) => [problem.file, problem.kind, problem.rule, problem.line]), [['0000_old.sql', 'idempotency', 'create-without-if-not-exists', 1]]);
    assert.deepEqual(acknowledged.map((item) => [item.file, item.kind]), [['0001_acked.sql', 'non-idempotent']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the repository migrations pass the gate', () => {
  const dir = new URL('../server/db/migrations/', import.meta.url).pathname;
  assert.ok(readdirSync(dir).length > 0);
  assert.ok(JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')).entries.length > 0);
  assert.deepEqual(checkMigrations(dir).problems, []);
});
