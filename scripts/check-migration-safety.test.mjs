import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FIRST_TIMESTAMP, GRANDFATHERED_THROUGH_IDX, NUMBERED_MIGRATIONS, checkMigrationIdempotency, checkMigrationSession, checkMigrationName, checkMigrationSql, checkMigrations, migrationFiles, stripDollarQuoted, stripSqlNoise } from './check-migration-safety.mjs';

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
    const old = GRANDFATHERED_THROUGH_IDX;
    // The index is the file's position in apply order, so fill the positions before it.
    const tag = (idx) => NUMBERED_MIGRATIONS[idx].replace(/\.sql$/, '');
    for (let idx = 0; idx < old; idx += 1) writeFileSync(join(dir, `${tag(idx)}.sql`), 'SELECT 1;');
    const entries = [
      { idx: old, tag: tag(old) },
      { idx: old + 1, tag: tag(old + 1) },
      { idx: old + 2, tag: '20261118T1443_acked' },
    ];
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
  const [OLD, ACKED] = NUMBERED_MIGRATIONS;
  const dir = mkdtempSync(join(tmpdir(), 'docslurp-migration-idempotency-'));
  try {
    writeFileSync(join(dir, OLD), 'CREATE TABLE runs (id text);');
    writeFileSync(join(dir, ACKED), sql);
    const { problems, acknowledged } = checkMigrations(dir);
    assert.deepEqual(problems.map((problem) => [problem.file, problem.kind, problem.rule, problem.line]), [[OLD, 'idempotency', 'create-without-if-not-exists', 1]]);
    assert.deepEqual(acknowledged.map((item) => [item.file, item.kind]), [[ACKED, 'non-idempotent']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the repository migrations pass the gate', () => {
  const dir = new URL('../server/db/migrations/', import.meta.url).pathname;
  assert.ok(readdirSync(dir).length > 0);
  assert.ok(migrationFiles(dir).length >= 193);
  assert.deepEqual(checkMigrations(dir, { requireNumbered: true }).problems, []);
});

test('numbered names are frozen and new migrations carry a real UTC timestamp', () => {
  assert.equal(checkMigrationName('0200_project_runs_finished_at.sql'), null);
  assert.equal(checkMigrationName('20261118T1443_hot_query_indexes.sql'), null);
  assert.match(checkMigrationName('0201_next.sql'), /numbered names are frozen/);
  // A free number inside the old range and a renamed numbered file are refused too.
  assert.equal(NUMBERED_MIGRATIONS.includes('0149_gap.sql'), false);
  assert.match(checkMigrationName('0149_gap.sql'), /numbered names are frozen/);
  assert.match(checkMigrationName('0200_renamed.sql'), /numbered names are frozen/);
  // A stamp before the cutover would sort among or before the numbered files.
  assert.match(checkMigrationName('01500101T0000_old.sql'), new RegExp(`timestamps start at ${FIRST_TIMESTAMP}`));
  assert.match(checkMigrationName('20261117T2359_day_before.sql'), /timestamps start at/);
  assert.match(checkMigrationName('20261332T1443_bad_date.sql'), /not a real UTC date/);
  assert.match(checkMigrationName('20261118T1443-dashes.sql'), /expected YYYYMMDDTHHMM/);
  const dir = mkdtempSync(join(tmpdir(), 'docslurp-migration-names-'));
  try {
    writeFileSync(join(dir, '0201_numbered.sql'), 'SELECT 1;');
    writeFileSync(join(dir, '20261118T1443_ok.sql'), 'SELECT 1;');
    assert.deepEqual(checkMigrations(dir).problems.map((problem) => [problem.file, problem.kind]), [['0201_numbered.sql', 'name']]);
    // The repository gate also requires every frozen numbered file to be present.
    assert.equal(checkMigrations(dir, { requireNumbered: true }).problems.filter((problem) => problem.rule === 'numbered-migration-missing').length, NUMBERED_MIGRATIONS.length);
    // Apply order is name order: numbered files first, then timestamps.
    assert.deepEqual(migrationFiles(dir), ['0201_numbered.sql', '20261118T1443_ok.sql']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('refuses transaction control, role changes and session-level settings outside function bodies', () => {
  const sessionRules = (sql) => checkMigrationSession(sql).map((finding) => finding.rule);
  assert.deepEqual(sessionRules('CREATE TABLE IF NOT EXISTS a (id int);\nCOMMIT;\nCREATE TABLE IF NOT EXISTS b (id int);'), ['transaction-control']);
  assert.deepEqual(sessionRules('BEGIN;\nSELECT 1;\nROLLBACK;'), ['transaction-control', 'transaction-control']);
  assert.deepEqual(sessionRules('SELECT 1; START TRANSACTION ISOLATION LEVEL SERIALIZABLE;'), ['transaction-control']);
  assert.deepEqual(sessionRules('SET ROLE docslurp_app;'), ['role-change']);
  assert.deepEqual(sessionRules('RESET ROLE;\nSET SESSION AUTHORIZATION other;'), ['role-change', 'role-change']);
  assert.deepEqual(sessionRules('SET search_path = evil, public;'), ['session-search-path']);
  assert.deepEqual(sessionRules("SELECT set_config('search_path', 'evil', false);"), ['session-search-path']);
  // Allowed: transaction-local settings, plpgsql blocks (BEGIN ... END inside a dollar-quoted body), comments and literals.
  assert.deepEqual(sessionRules("SET LOCAL lock_timeout = '10s';\nSET LOCAL search_path = public;\nSELECT set_config('docslurp.x', '1', true);"), []);
  assert.deepEqual(sessionRules('DO $$ BEGIN PERFORM 1; END $$;\nCREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN RETURN; END; $fn$;'), []);
  assert.deepEqual(sessionRules("-- commit;\nSELECT 'rollback;';\nALTER TABLE t ADD COLUMN IF NOT EXISTS begin_at timestamptz;\nCREATE INDEX IF NOT EXISTS t_end ON t (end_at);"), []);
  assert.deepEqual(sessionRules('CREATE OR REPLACE FUNCTION h() RETURNS int LANGUAGE sql SET search_path = public AS $$ SELECT 1 $$;'), []);
});
