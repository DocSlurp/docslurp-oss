import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check-worker-prerequisites.mjs', import.meta.url));
test('reports all missing executables and exits nonzero before worker execution', () => {
  const result = spawnSync(process.execPath, [script, '--profile=lean'], {
    encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent-docslurp-path', PYTHON_VENV: '/nonexistent-docslurp-venv' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing executable: pdftotext/);
  assert.match(result.stderr, /missing executable: pandoc/);
  assert.match(result.stderr, /missing executable: clamdscan/);
  assert.match(result.stdout, /status=failed/);
});
test('rejects unknown profiles instead of silently checking a partial runtime', () => {
  const result = spawnSync(process.execPath, [script, '--profile=typo'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});
