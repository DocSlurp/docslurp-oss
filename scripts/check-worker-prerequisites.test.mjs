import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
test('fails when pdftotext cannot map CJK text through the predefined CMaps (poppler-data missing)', () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'docslurp-prereq-'));
  try {
    // A pdftotext that behaves like poppler without poppler-data: it runs, but returns only a page break.
    writeFileSync(path.join(bin, 'pdftotext'), '#!/bin/sh\nprintf "\\f"\n');
    chmodSync(path.join(bin, 'pdftotext'), 0o755);
    const result = spawnSync(process.execPath, [script, '--profile=lean'], {
      encoding: 'utf8', env: { ...process.env, PATH: bin, PYTHON_VENV: '/nonexistent-docslurp-venv' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /poppler CJK CMap data unavailable/);
  } finally { rmSync(bin, { recursive: true, force: true }); }
});
