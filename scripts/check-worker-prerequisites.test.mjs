import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check-worker-prerequisites.mjs', import.meta.url));
// Keeps a developer's own OCR install or mode out of tests that do not set them.
const noOcr = { DOCSLURP_OCR_PYTHON: '/nonexistent-docslurp-ocr/python3', DOCSLURP_OCR_MODEL_DIR: '/nonexistent-docslurp-ocr/models', DOCSLURP_OCR_MODE: '', PYTHON_VENV: '/nonexistent-docslurp-venv' };
test('reports all missing executables and exits nonzero before worker execution', () => {
  const result = spawnSync(process.execPath, [script, '--profile=lean'], {
    encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent-docslurp-path', PYTHON_VENV: '/nonexistent-docslurp-venv' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing executable: pdftotext/);
  assert.match(result.stderr, /missing executable: pandoc/);
  assert.match(result.stderr, /missing executable: clamdscan/);
  assert.match(result.stderr, /missing executable: cwebp/);
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
test('passes the CMap probe with a pdftotext that maps the predefined CMap', () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'docslurp-prereq-'));
  try {
    // A pdftotext that returns the probe text, as poppler with poppler-data does.
    writeFileSync(path.join(bin, 'pdftotext'), '#!/bin/sh\nprintf "\\344\\270\\255\\346\\226\\207\\n\\f"\n');
    chmodSync(path.join(bin, 'pdftotext'), 0o755);
    const result = spawnSync(process.execPath, [script, '--profile=lean'], {
      encoding: 'utf8', env: { ...process.env, PATH: bin, PYTHON_VENV: '/nonexistent-docslurp-venv' },
    });
    assert.doesNotMatch(result.stderr, /CMap/);
  } finally { rmSync(bin, { recursive: true, force: true }); }
});
test('reports a pdftotext that cannot run instead of blaming poppler-data', () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'docslurp-prereq-'));
  try {
    writeFileSync(path.join(bin, 'pdftotext'), '#!/bin/sh\nexit 3\n');
    chmodSync(path.join(bin, 'pdftotext'), 0o755);
    const result = spawnSync(process.execPath, [script, '--profile=lean'], {
      encoding: 'utf8', env: { ...process.env, PATH: bin, PYTHON_VENV: '/nonexistent-docslurp-venv' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CMap probe could not run pdftotext: exit 3/);
  } finally { rmSync(bin, { recursive: true, force: true }); }
});
test('no profile requires a system OCR binary', () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'docslurp-prereq-'));
  try {
    for (const profile of ['lean', 'full', 'test']) {
      const result = spawnSync(process.execPath, [script, `--profile=${profile}`], { encoding: 'utf8', env: { ...process.env, PATH: bin, ...noOcr } });
      assert.doesNotMatch(result.stderr, /tesseract|ocrmypdf|OCR self-test|OCR runtime|DOCSLURP_OCR/i);
    }
  } finally { rmSync(bin, { recursive: true, force: true }); }
});
test('DOCSLURP_OCR_MODE=local fails without the OCR venv and models, and outside self-hosting', () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'docslurp-prereq-'));
  try {
    let result = spawnSync(process.execPath, [script, '--profile=lean'], {
      encoding: 'utf8', env: { ...process.env, PATH: bin, ...noOcr, DOCSLURP_OCR_MODE: 'local', DOCSLURP_SERVICE_PROFILE: 'self-hosted' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DOCSLURP_OCR_MODE=local needs the OCR venv/);
    assert.doesNotMatch(result.stderr, /requires DOCSLURP_SERVICE_PROFILE/);
    result = spawnSync(process.execPath, [script, '--profile=lean'], {
      encoding: 'utf8', env: { ...process.env, PATH: bin, ...noOcr, DOCSLURP_OCR_MODE: 'local', DOCSLURP_SERVICE_PROFILE: 'service' },
    });
    assert.match(result.stderr, /DOCSLURP_OCR_MODE=local requires DOCSLURP_SERVICE_PROFILE=self-hosted/);
  } finally { rmSync(bin, { recursive: true, force: true }); }
});
const cli = fileURLToPath(new URL('../worker/scripts/docslurp_ocr.py', import.meta.url));
const ocrManifest = fileURLToPath(new URL('../worker/ocr-models.json', import.meta.url));
test('runs the OCR self-test when the OCR venv and models exist', { skip: !(existsSync(cli) && existsSync(ocrManifest)) && 'docslurp_ocr.py or ocr-models.json not present' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'docslurp-prereq-'));
  try {
    const python = path.join(dir, 'python3');
    const models = path.join(dir, 'models');
    mkdirSync(models);
    // A fake OCR interpreter: records its arguments and exits with FAKE_OCR_EXIT (3 = missing or mismatched model).
    writeFileSync(python, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\necho "model rec_korean.onnx sha256 mismatch" >&2\nexit "\${FAKE_OCR_EXIT:-0}"\n`);
    chmodSync(python, 0o755);
    const env = { ...process.env, PATH: path.join(dir, 'empty'), DOCSLURP_OCR_PYTHON: python, DOCSLURP_OCR_MODEL_DIR: models, DOCSLURP_OCR_MODE: '' };
    let result = spawnSync(process.execPath, [script, '--profile=lean'], { encoding: 'utf8', env });
    assert.doesNotMatch(result.stderr, /OCR self-test failed/);
    assert.deepEqual(readFileSync(path.join(dir, 'args'), 'utf8').trim().split('\n'), ['-I', cli, '--self-test', '--models', models, '--manifest', ocrManifest]);
    result = spawnSync(process.execPath, [script, '--profile=lean'], { encoding: 'utf8', env: { ...env, FAKE_OCR_EXIT: '3' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OCR self-test failed .*sha256 mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
