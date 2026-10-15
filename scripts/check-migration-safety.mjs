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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GRANDFATHERED_THROUGH_IDX = 32;
export const MARKER = /--[ \t]*destructive-migration:[ \t]*(\S.*)$/im;

const RULES = [
  { id: 'drop', pattern: /\bdrop\s+(?:table|column|schema|view|materialized\s+view|type|sequence|domain|extension)\b/gi, why: 'removes something release N-1 may still read or write' },
  { id: 'drop-column-shorthand', pattern: /\balter\s+table\b[^;]*?\bdrop\s+(?!constraint|default|not\s+null|identity|expression|column\b)(?:if\s+exists\s+)?"?[a-z_][\w]*"?\s*(?:,|;|cascade|restrict)/gi, why: 'drops a column (ALTER TABLE ... DROP <column>)' },
  { id: 'rename', pattern: /\brename\b/gi, why: 'renames break release N-1 queries' },
  { id: 'alter-type', pattern: /\balter\s+column\b[^;]*?\b(?:set\s+data\s+)?type\b/gi, why: 'changes a column type under release N-1' },
  { id: 'set-not-null', pattern: /\bset\s+not\s+null\b/gi, why: 'release N-1 may still insert NULLs' },
  { id: 'truncate', pattern: /\btruncate\b/gi, why: 'deletes rows' },
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
    if (entry.idx <= GRANDFATHERED_THROUGH_IDX) continue;
    const file = `${entry.tag}.sql`;
    const result = checkMigrationSql(readFileSync(join(dir, file), 'utf8'));
    if (result.findings.length === 0) continue;
    if (result.acknowledged) {
      acknowledged.push({ file, reason: result.reason, findings: result.findings });
      continue;
    }
    for (const finding of result.findings) problems.push({ file, ...finding });
  }
  return { problems, acknowledged };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2] ?? fileURLToPath(new URL('../server/db/migrations/', import.meta.url));
  const { problems, acknowledged } = checkMigrations(dir);
  for (const item of acknowledged) {
    console.log(`[migration-safety] ${item.file}: ${item.findings.length} destructive statement(s) acknowledged: ${item.reason}`);
  }
  for (const problem of problems) {
    console.error(`::error file=server/db/migrations/${problem.file},line=${problem.line}::${problem.rule}: "${problem.text}" ${problem.why}. ` +
      'Ship the additive (expand) step first and the destructive (contract) step in a later release, then add ' +
      '"-- destructive-migration: <why it is safe now>" (docs/releases.md#schema-changes-expand-and-contract).');
  }
  if (problems.length) process.exitCode = 1;
  else console.log('[migration-safety] ok');
}
