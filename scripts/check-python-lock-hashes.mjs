#!/usr/bin/env node
// Fail when a tracked Python lock file cannot be installed with --require-hashes.
//
//   node scripts/check-python-lock-hashes.mjs [lock files...]
//
// With no arguments, checks every worker/*.lock.txt and scripts/*.lock.txt.
// Each requirement must be an exact `name==version` pin from an index with at
// least one sha256 hash. Direct URLs, VCS, editable and local-path requirements
// are rejected because their artifacts are not covered by the lock's hashes.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Requirements of a pip/uv lock file, with continuation lines joined. */
export function lockRequirements(text) {
  const requirements = [];
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (current !== null) {
      current += ` ${line.trim().replace(/\\$/, '').trim()}`;
      if (!line.endsWith('\\')) { requirements.push(current.trim()); current = null; }
      continue;
    }
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (line.endsWith('\\')) { current = line.replace(/\\$/, ''); continue; }
    requirements.push(line.trim());
  }
  if (current !== null) requirements.push(current.trim());
  return requirements;
}

/** Problems that would stop `pip install --require-hashes -r <lock>` from verifying every artifact. */
export function lockHashProblems(text) {
  const problems = [];
  const requirements = lockRequirements(text);
  if (requirements.length === 0) problems.push('no requirements');
  for (const requirement of requirements) {
    const name = requirement.split(/[\s=<>!~;@[]/)[0];
    if (/^-(e|-editable)\b/.test(requirement) || /^(-r|-c|--requirement|--constraint)\b/.test(requirement)) {
      problems.push(`${requirement.split(/\s/)[0]} is not allowed in a hashed lock: ${requirement.slice(0, 80)}`);
      continue;
    }
    if (/^--?[a-z]/.test(requirement)) continue; // global options such as --index-url
    if (/\s@\s|^(\.|\/|file:|git\+|https?:)/.test(requirement)) {
      problems.push(`${name}: direct URL or local path requirement`);
      continue;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*(\[[^\]]+\])?==[^\s;]+/.test(requirement)) {
      problems.push(`${name}: not pinned with ==`);
    }
    if (!/--hash=sha256:[0-9a-f]{64}\b/.test(requirement)) problems.push(`${name}: missing --hash=sha256`);
  }
  return problems;
}

function defaultLockFiles() {
  return ['worker', 'scripts'].flatMap(dir => readdirSync(join(root, dir)).filter(file => file.endsWith('.lock.txt')).map(file => join(root, dir, file)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = process.argv.length > 2 ? process.argv.slice(2) : defaultLockFiles();
  let failed = false;
  for (const file of files) {
    const problems = lockHashProblems(readFileSync(file, 'utf8'));
    const label = relative(process.cwd(), file) || file;
    if (problems.length === 0) {
      console.log(`ok ${label}: ${lockRequirements(readFileSync(file, 'utf8')).length} hashed pins`);
      continue;
    }
    failed = true;
    console.error(`${label}: regenerate with uv pip compile --generate-hashes (command at the top of the file)`);
    for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
    if (problems.length > 20) console.error(`  ... ${problems.length - 20} more`);
  }
  if (files.length === 0) { console.error('no lock files found'); failed = true; }
  process.exit(failed ? 1 : 0);
}
