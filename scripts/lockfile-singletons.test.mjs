import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Auth code relies on instanceof across these packages (better-auth's APIError
// checks in plugins). Two resolved copies, e.g. after a jose bump splits their
// peer sets, silently turn 403s into 500s. Keep exactly one snapshot of each.
const SINGLETONS = ['better-auth', '@better-auth/core', 'better-call'];

const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
const snapshots = lock.slice(lock.indexOf('\nsnapshots:\n'));

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const name of SINGLETONS) {
  test(`pnpm-lock.yaml resolves one copy of ${name}`, () => {
    const entries = snapshots.match(new RegExp(`^  '?${escape(name)}@[^:]*'?:`, 'gm')) ?? [];
    assert.equal(entries.length, 1, `${name} snapshots:\n${entries.join('\n')}\nAdd a pnpm override for the peer that split them.`);
  });
}
