import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/worker-supply-chain.yml', import.meta.url), 'utf8');
const step = workflow.split('      - name: Build and verify every worker image\n')[1].split('\n      - name:')[0];
const command = step.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');

function exercise(scenario) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-worker-images-'));
  try {
    // No Docker daemon or download: exercise the workflow shell's decisions.
    writeFileSync(join(directory, 'docker'), `#!/usr/bin/env bash
set -eu
if [ "$1" = build ]; then
  profile=unknown
  for arg in "$@"; do
    case "$arg" in docslurp-worker:ci-*) profile="\${arg#docslurp-worker:ci-}";; esac
  done
  counter="$RUNNER_TEMP/$profile.count"
  n=0
  if [ -f "$counter" ]; then n=$(cat "$counter"); fi
  n=$((n + 1))
  echo "$n" > "$counter"
  case "$SCENARIO" in
    network) if [ "$n" = 1 ]; then echo 'Error: read ECONNRESET'; exit 1; fi;;
    permanent-network) echo 'Error: read ECONNRESET'; exit 1;;
    compiler) echo 'TypeScript error TS2345'; exit 1;;
  esac
elif [ "$1" = image ]; then
  if [ "$SCENARIO" = oversize ]; then echo 9999999999; else echo 100; fi
elif [ "$1" = history ]; then
  echo '1\tRUN true'
elif [ "$1" = run ]; then
  if [ "$SCENARIO" = assertion ]; then exit 1; fi
else
  exit 99
fi
`, { mode: 0o755 });
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', command], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RUNNER_TEMP: directory, SCENARIO: scenario },
    });
    if (result.error) throw result.error;
    const attempts = Object.fromEntries(readdirSync(directory).filter(file => file.endsWith('.count')).map(file => [file.replace('.count', ''), Number(readFileSync(join(directory, file), 'utf8'))]));
    return { status: result.status, attempts, output: result.stdout + result.stderr };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('all three image profiles are checked and transient downloads reuse one retry', () => {
  for (const [scenario, count] of [['success', 1], ['network', 2]]) {
    const result = exercise(scenario);
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.attempts, { full: count, default: count, lean: count });
  }
});
test('an oversized image fails its profile budget', () => {
  {
    const result = exercise('oversize');
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.attempts, { full: 1 });
  }
});
test('persistent download failures stop after two attempts', () => {
  const result = exercise('permanent-network');
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.attempts, { full: 2 });
});
test('compiler errors and image assertion failures are not retried', () => {
  for (const scenario of ['compiler', 'assertion']) {
    const result = exercise(scenario);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.attempts, { full: 1 });
  }
});
