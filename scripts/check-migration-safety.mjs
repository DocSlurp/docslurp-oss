#!/usr/bin/env node
// Expand/contract gate for server/db/migrations (docs/releases.md#schema-changes-expand-and-contract).
//
// The Fly release command migrates before the old app and worker machines are
// replaced, and a rollback runs the previous image against the new schema. So
// a migration must keep release N-1 working: additive changes only. Removing
// or reshaping what N-1 reads (DROP TABLE/COLUMN, RENAME, ALTER ... TYPE,
// SET NOT NULL, TRUNCATE) belongs in a later "contract" release, once no
// running code uses the old shape. Such a migration must say so with a marker
// comment naming why it is safe:
//
//   -- destructive-migration: column unused since <release/commit>; contract step of <expand migration>
//
// Migrations up to GRANDFATHERED_THROUGH_IDX predate this rule and are skipped.
//
// Every migration must also be idempotent: running it a second time is a no-op
// with the same end state (worker/src/test/migrations-idempotent.test.ts runs
// each one twice). This gate flags the usual causes statically, in every
// migration: CREATE TABLE/INDEX/SEQUENCE/SCHEMA/EXTENSION/MATERIALIZED VIEW
// without IF NOT EXISTS, ADD COLUMN without IF NOT EXISTS, DROP ... without IF
// EXISTS, CREATE FUNCTION/PROCEDURE/TRIGGER/VIEW without OR REPLACE, ADD
// CONSTRAINT / CREATE TYPE / CREATE DOMAIN / CREATE POLICY / RENAME outside a
// DO block (which must check the catalog first), ALTER TYPE ... ADD VALUE
// without IF NOT EXISTS, and INSERT without ON CONFLICT or NOT EXISTS.
// Statements inside dollar-quoted bodies (DO blocks, functions) are not
// checked: a DO block is where a catalog guard lives. A migration whose
// second run is a no-op for a reason the gate cannot see says so:
//
//   -- idempotent-migration: <why a second run changes nothing>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GRANDFATHERED_THROUGH_IDX = 32;
export const MARKER = /--[ \t]*destructive-migration:[ \t]*(\S.*)$/im;
export const IDEMPOTENT_MARKER = /--[ \t]*idempotent-migration:[ \t]*(\S.*)$/im;

const RULES = [
  { id: 'drop', pattern: /\bdrop\s+(?:table|column|schema|view|materialized\s+view|type|sequence|domain|extension)\b/gi, why: 'removes something release N-1 may still read or write' },
  { id: 'drop-column-shorthand', pattern: /\balter\s+table\b[^;]*?\bdrop\s+(?!constraint|default|not\s+null|identity|expression|column\b)(?:if\s+exists\s+)?"?[a-z_][\w]*"?\s*(?:,|;|cascade|restrict)/gi, why: 'drops a column (ALTER TABLE ... DROP <column>)' },
  { id: 'rename', pattern: /\brename\b/gi, why: 'renames break release N-1 queries' },
  { id: 'alter-type', pattern: /\balter\s+column\b[^;]*?\b(?:set\s+data\s+)?type\b/gi, why: 'changes a column type under release N-1' },
  { id: 'set-not-null', pattern: /\bset\s+not\s+null\b/gi, why: 'release N-1 may still insert NULLs' },
  { id: 'truncate', pattern: /\btruncate\b/gi, why: 'deletes rows' },
];

const NOT_EXISTS = String.raw`(?!if\s+not\s+exists\b)`;
const IDEMPOTENCY_RULES = [
  { id: 'create-without-if-not-exists', pattern: new RegExp(String.raw`\bcreate\s+(?:unlogged\s+)?(?:table|sequence|schema|extension|materialized\s+view)\s+${NOT_EXISTS}`, 'gi'), why: 'fails with "already exists" on a second run; add IF NOT EXISTS' },
  { id: 'create-index-without-if-not-exists', pattern: new RegExp(String.raw`\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?${NOT_EXISTS}`, 'gi'), why: 'fails with "already exists" on a second run; add IF NOT EXISTS' },
  { id: 'add-column-without-if-not-exists', pattern: new RegExp(String.raw`\badd\s+column\s+${NOT_EXISTS}`, 'gi'), why: 'fails with "already exists" on a second run; add IF NOT EXISTS' },
  { id: 'create-without-or-replace', pattern: /\bcreate\s+(?!or\s+replace\b)(?:constraint\s+)?(?:function|procedure|trigger|view)\b/gi, why: 'fails with "already exists" on a second run; use CREATE OR REPLACE' },
  { id: 'drop-without-if-exists', pattern: /\bdrop\s+(?:table|column|constraint|index|trigger|function|procedure|view|materialized\s+view|type|sequence|schema|domain|policy|extension)\s+(?!if\s+exists\b)/gi, why: 'fails on a second run once the object is gone; add IF EXISTS' },
  { id: 'unguarded-catalog-change', pattern: /\b(?:add\s+(?:constraint|primary\s+key|unique|check|foreign\s+key|exclude)|create\s+(?:type|domain|policy|rule)|rename)\b/gi, why: 'fails on a second run; wrap it in a DO block that checks the catalog first' },
  { id: 'add-enum-value-without-if-not-exists', pattern: new RegExp(String.raw`\badd\s+value\s+${NOT_EXISTS}`, 'gi'), why: 'fails on a second run; use ADD VALUE IF NOT EXISTS' },
];

/** Blank out `--` / block comments and single-quoted literals (keeping newlines) so prose never matches. */
export function stripSqlNoise(sql) {
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  let out = '';
  for (let i = 0; i < sql.length;) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if (sql[i] === "'") {
      // '' inside a literal is an escaped quote.
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      out += `'${blank(sql.slice(i + 1, j))}'`;
      i = j + 1;
    } else {
      out += sql[i++];
    }
  }
  return out;
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?`;
const RECREATABLE = String.raw`constraint|trigger|view|materialized\s+view|policy|type|domain|index`;
// Tables and sequences are absent on purpose: dropping one to recreate it discards rows.
// Functions too: a drop names one signature, and the create may name another.
const objectKind = (keyword) => keyword.toLowerCase().replace(/\s+/g, ' ').replace(/^(?:unique |unlogged )/, '').replace(/^add /, '');
/** Unqualified, unquoted, case-folded name ("public"."Foo" -> Foo, public.foo -> foo). */
const bareName = (ident) => {
  const last = ident.match(/(?:"[^"]+"|[A-Za-z_][\w$]*)$/)[0];
  return last.startsWith('"') ? last.slice(1, -1) : last.toLowerCase();
};
/** The kind and name a flagged CREATE/ADD statement makes, when it names one. */
function recreatedObject(matched, rest) {
  const keyword = /(add\s+constraint|constraint\s+trigger|trigger|function|procedure|materialized\s+view|view|policy|type|domain|index|table|sequence)\s*$/i.exec(matched.replace(/\s+(?:concurrently\s+)?$/i, ' ').trimEnd())
    ?? /(index|table|sequence|materialized\s+view)\s+(?:concurrently\s+)?$/i.exec(matched);
  if (!keyword) return null;
  const name = new RegExp(String.raw`^\s*(${IDENT})`).exec(rest);
  if (!name) return null;
  return { kind: objectKind(keyword[1].replace(/^constraint\s+trigger$/i, 'trigger')), name: bareName(name[1]) };
}

/** Blank the bodies of dollar-quoted strings ($$...$$, $tag$...$tag$), keeping newlines. */
export function stripDollarQuoted(sql) {
  return sql.replace(/(\$[A-Za-z_]*\$)([\s\S]*?)\1/g, (_match, tag, inner) => `${tag}${inner.replace(/[^\n]/g, ' ')}${tag}`);
}

/** Pure: idempotency findings for one migration file (see the header). */
export function checkMigrationIdempotency(sql) {
  const marker = IDEMPOTENT_MARKER.exec(sql);
  const body = stripDollarQuoted(stripSqlNoise(sql));
  const lineAt = (index) => body.slice(0, index).split('\n').length;
  // DROP <kind> IF EXISTS <name> earlier in the file makes recreating <name> idempotent.
  const dropped = new Set();
  for (const match of body.matchAll(new RegExp(String.raw`\bdrop\s+(${RECREATABLE})\s+if\s+exists\s+(${IDENT})`, 'gi'))) {
    dropped.add(`${objectKind(match[1])}:${bareName(match[2])}:${match.index}`);
  }
  const droppedBefore = (kind, name, index) => [...dropped].some((key) => {
    const [k, n, at] = key.split(':');
    return k === kind && n === name && Number(at) < index;
  });
  const findings = [];
  for (const rule of IDEMPOTENCY_RULES) {
    for (const match of body.matchAll(rule.pattern)) {
      const target = recreatedObject(match[0], body.slice(match.index + match[0].length));
      if (target && droppedBefore(target.kind, target.name, match.index)) continue;
      findings.push({ rule: rule.id, line: lineAt(match.index), text: match[0].replace(/\s+/g, ' ').trim().slice(0, 80), why: rule.why });
    }
  }
  let offset = 0;
  for (const statement of body.split(';')) {
    const insert = /\binsert\s+into\b/i.exec(statement);
    if (insert && !/\bon\s+conflict\b|\bnot\s+exists\b/i.test(statement)) {
      findings.push({
        rule: 'insert-without-conflict-guard', line: lineAt(offset + insert.index),
        text: statement.slice(insert.index).replace(/\s+/g, ' ').trim().slice(0, 80),
        why: 'inserts again on a second run; add ON CONFLICT DO NOTHING or a NOT EXISTS guard',
      });
    }
    offset += statement.length + 1;
  }
  findings.sort((a, b) => a.line - b.line);
  return { findings, acknowledged: Boolean(marker?.[1]?.trim()), reason: marker?.[1]?.trim() ?? null };
}

/** Pure: findings for one migration file. */
export function checkMigrationSql(sql) {
  const marker = MARKER.exec(sql);
  const body = stripSqlNoise(sql);
  const findings = [];
  for (const rule of RULES) {
    for (const match of body.matchAll(rule.pattern)) {
      const line = body.slice(0, match.index).split('\n').length;
      findings.push({ rule: rule.id, line, text: match[0].replace(/\s+/g, ' ').trim().slice(0, 80), why: rule.why });
    }
  }
  return { findings, acknowledged: Boolean(marker?.[1]?.trim()), reason: marker?.[1]?.trim() ?? null };
}

export function checkMigrations(dir) {
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8'));
  const problems = [];
  const acknowledged = [];
  for (const entry of journal.entries ?? []) {
    const file = `${entry.tag}.sql`;
    const sql = readFileSync(join(dir, file), 'utf8');
    const idempotency = checkMigrationIdempotency(sql);
    if (idempotency.acknowledged) {
      if (idempotency.findings.length) acknowledged.push({ file, kind: 'non-idempotent', reason: idempotency.reason, findings: idempotency.findings });
    } else {
      for (const finding of idempotency.findings) problems.push({ file, kind: 'idempotency', ...finding });
    }
    if (entry.idx <= GRANDFATHERED_THROUGH_IDX) continue;
    const result = checkMigrationSql(sql);
    if (result.findings.length === 0) continue;
    if (result.acknowledged) {
      acknowledged.push({ file, kind: 'destructive', reason: result.reason, findings: result.findings });
      continue;
    }
    for (const finding of result.findings) problems.push({ file, kind: 'destructive', ...finding });
  }
  return { problems, acknowledged };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2] ?? fileURLToPath(new URL('../server/db/migrations/', import.meta.url));
  const { problems, acknowledged } = checkMigrations(dir);
  for (const item of acknowledged) {
    console.log(`[migration-safety] ${item.file}: ${item.findings.length} ${item.kind} statement(s) acknowledged: ${item.reason}`);
  }
  for (const problem of problems) {
    if (problem.kind === 'idempotency') {
      console.error(`::error file=server/db/migrations/${problem.file},line=${problem.line}::${problem.rule}: "${problem.text}" ${problem.why}. ` +
        'Every migration must be safe to run twice; if this one is for a reason the check cannot see, add ' +
        '"-- idempotent-migration: <why a second run changes nothing>".');
      continue;
    }
    console.error(`::error file=server/db/migrations/${problem.file},line=${problem.line}::${problem.rule}: "${problem.text}" ${problem.why}. ` +
      'Ship the additive (expand) step first and the destructive (contract) step in a later release, then add ' +
      '"-- destructive-migration: <why it is safe now>" (docs/releases.md#schema-changes-expand-and-contract).');
  }
  if (problems.length) process.exitCode = 1;
  else console.log('[migration-safety] ok');
}
